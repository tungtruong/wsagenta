import TelegramBot from "node-telegram-bot-api";
import {
  attachAgentLogs,
  buildRuntimeConfig,
  createWorkspaceAgent,
  loadEnv,
  runTask,
} from "./agent-runtime.js";
import { loadChatState, saveChatState } from "./chat-settings-store.js";

const chatState = new Map();
const agentByModel = new Map();
let shuttingDownForConflict = false;
const VALID_RESEARCH_DEPTHS = ["basic", "advanced"];

function buildHelpMessage(runtimeConfig, state = {}) {
  const currentModel = pickChatModel(state, runtimeConfig);
  const currentDepth = pickResearchDepth(state, runtimeConfig);

  return [
    "Workspace Agent is ready.",
    "",
    "How to configure this chat:",
    "- /model list : show allowed models",
    "- /model show : show current model for this chat",
    "- /model <name> : switch model for this chat",
    "- /depth show : show current research depth",
    "- /depth <basic|advanced> : switch Tavily research depth",
    "- /settings : show effective settings for this chat",
    "- /reset : clear conversation context for this chat",
    "- /continue : resume if run stopped due to max turns",
    "",
    "Examples:",
    "- /model gpt-4.1-mini",
    "- /depth advanced",
    "",
    `Current model: ${currentModel}`,
    `Current depth: ${currentDepth}`,
    `Default model: ${runtimeConfig.model}`,
    `Default depth: ${runtimeConfig.defaultResearchDepth}`,
    "",
    "Notes:",
    "- Model/depth are per-chat and are persisted after restart.",
    "- Switching model does not reset your chat context.",
  ].join("\n");
}

function pickChatModel(state, runtimeConfig) {
  const selected = normalizeModelInput(state?.model, runtimeConfig.allowedModels);
  return selected || runtimeConfig.model;
}

function pickResearchDepth(state, runtimeConfig) {
  const depth = String(state?.researchDepth || "").toLowerCase();
  if (VALID_RESEARCH_DEPTHS.includes(depth)) {
    return depth;
  }
  return runtimeConfig.defaultResearchDepth;
}

function updateChatState(chatId, patch) {
  const current = chatState.get(chatId) || {};
  const next = { ...current, ...patch };
  if (next.resumeState === undefined) {
    delete next.resumeState;
  }
  chatState.set(chatId, next);
  return next;
}

function getAgentForModel(runtimeConfig, model) {
  const selectedModel = model || runtimeConfig.model;
  const cached = agentByModel.get(selectedModel);
  if (cached) {
    return cached;
  }

  const agent = createWorkspaceAgent(runtimeConfig, { model: selectedModel });
  attachAgentLogs(agent, runtimeConfig);
  agentByModel.set(selectedModel, agent);
  return agent;
}

function normalizeModelInput(input, allowedModels) {
  const lowered = String(input || "").trim().toLowerCase();
  return allowedModels.find((item) => item.toLowerCase() === lowered);
}

async function persistChatState(runtimeConfig) {
  try {
    await saveChatState(runtimeConfig.chatStateFile, chatState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram] failed to persist chat state: ${message}`);
  }
}

function createProgressReporter(bot, chatId) {
  let lastSentAt = 0;
  return async (message) => {
    const now = Date.now();
    if (now - lastSentAt < 1500) {
      return;
    }
    lastSentAt = now;
    await bot.sendMessage(chatId, `[progress] ${message}`);
  };
}

async function main() {
  await loadEnv();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env");
    process.exit(1);
  }

  const runtimeConfig = buildRuntimeConfig();

  try {
    const persisted = await loadChatState(runtimeConfig.chatStateFile);
    for (const [chatId, state] of persisted.entries()) {
      chatState.set(chatId, state);
    }
    console.log(`[telegram] loaded ${persisted.size} chat state record(s)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telegram] failed to load chat state: ${message}`);
  }

  getAgentForModel(runtimeConfig, runtimeConfig.model);

  const bot = new TelegramBot(token, { polling: true });

  bot.on("polling_error", (err) => {
    const message = err?.message || String(err);
    console.error(`[telegram:polling_error] ${message}`);
    if (message.includes("409 Conflict") && !shuttingDownForConflict) {
      shuttingDownForConflict = true;
      console.error(
        "Another bot instance is already polling this token. Stop old process, then run again."
      );
      // Avoid flooding logs forever; stop this instance and exit.
      bot
        .stopPolling({ cancel: true })
        .catch(() => {})
        .finally(() => {
          process.exit(1);
        });
    }
  });

  console.log("Telegram bot is running (polling mode).");
  console.log(`Model: ${runtimeConfig.model}`);
  console.log(`Allowed models: ${runtimeConfig.allowedModels.join(", ")}`);
  console.log(`Default research depth: ${runtimeConfig.defaultResearchDepth}`);
  console.log(`Chat state file: ${runtimeConfig.chatStateFile}`);
  console.log(`Workspace: ${runtimeConfig.workspaceDir}`);

  bot.onText(/^\/start(?:\s|$)/, async (msg) => {
    const state = chatState.get(msg.chat.id) || {};
    await bot.sendMessage(msg.chat.id, buildHelpMessage(runtimeConfig, state));
  });

  bot.onText(/^\/help(?:\s|$)/, async (msg) => {
    const state = chatState.get(msg.chat.id) || {};
    await bot.sendMessage(
      msg.chat.id,
      buildHelpMessage(runtimeConfig, state)
    );
  });

  bot.onText(/^\/reset(?:\s|$)/, async (msg) => {
    chatState.delete(msg.chat.id);
    await persistChatState(runtimeConfig);
    await bot.sendMessage(msg.chat.id, "Conversation context was reset for this chat.");
  });

  bot.onText(/^\/model(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const arg = String(match?.[1] || "").trim();
    const state = chatState.get(chatId) || {};

    if (!arg || arg.toLowerCase() === "show") {
      const currentModel = pickChatModel(state, runtimeConfig);
      await bot.sendMessage(chatId, `Current model: ${currentModel}`);
      return;
    }

    if (arg.toLowerCase() === "list") {
      await bot.sendMessage(
        chatId,
        `Allowed models: ${runtimeConfig.allowedModels.join(", ")}`
      );
      return;
    }

    const selectedModel = normalizeModelInput(arg, runtimeConfig.allowedModels);
    if (!selectedModel) {
      await bot.sendMessage(
        chatId,
        "Invalid model. Use /model list to see allowed values."
      );
      return;
    }

    updateChatState(chatId, { model: selectedModel });
    await persistChatState(runtimeConfig);
    getAgentForModel(runtimeConfig, selectedModel);

    await bot.sendMessage(chatId, `Model updated to: ${selectedModel}`);
  });

  bot.onText(/^\/depth(?:\s+(.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const arg = String(match?.[1] || "").trim();
    const state = chatState.get(chatId) || {};

    if (!arg || arg.toLowerCase() === "show") {
      const depth = pickResearchDepth(state, runtimeConfig);
      await bot.sendMessage(chatId, `Current research depth: ${depth}`);
      return;
    }

    const selectedDepth = arg.toLowerCase();
    if (!VALID_RESEARCH_DEPTHS.includes(selectedDepth)) {
      await bot.sendMessage(
        chatId,
        `Invalid depth. Use one of: ${VALID_RESEARCH_DEPTHS.join(", ")}.`
      );
      return;
    }

    updateChatState(chatId, { researchDepth: selectedDepth });
    await persistChatState(runtimeConfig);
    await bot.sendMessage(chatId, `Research depth updated to: ${selectedDepth}`);
  });

  bot.onText(/^\/settings(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    const state = chatState.get(chatId) || {};
    const currentModel = pickChatModel(state, runtimeConfig);
    const currentDepth = pickResearchDepth(state, runtimeConfig);

    await bot.sendMessage(
      chatId,
      [
        `Current model: ${currentModel}`,
        `Research depth: ${currentDepth}`,
        `Default model: ${runtimeConfig.model}`,
        `Default depth: ${runtimeConfig.defaultResearchDepth}`,
        `Allowed models: ${runtimeConfig.allowedModels.join(", ")}`,
      ].join("\n")
    );
  });

  bot.onText(/^\/continue(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    const state = chatState.get(chatId) || {};
    if (!state.resumeState) {
      await bot.sendMessage(chatId, "No pending run to continue.");
      return;
    }

    let typingInterval;
    try {
      await bot.sendMessage(chatId, "Resuming previous run...");
      typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);

      const progress = createProgressReporter(bot, chatId);
      const selectedModel = pickChatModel(state, runtimeConfig);
      const selectedDepth = pickResearchDepth(state, runtimeConfig);
      const agent = getAgentForModel(runtimeConfig, selectedModel);

      const result = await runTask(agent, state.resumeState, runtimeConfig, {
        context: { chatId, progress, researchDepth: selectedDepth },
      });

      updateChatState(chatId, {
        previousResponseId: result.lastResponseId,
        resumeState: undefined,
      });
      await persistChatState(runtimeConfig);

      const output = String(result.finalOutput ?? "(No text output)");
      const maxLen = 3900;
      if (output.length <= maxLen) {
        await bot.sendMessage(chatId, output);
      } else {
        for (let i = 0; i < output.length; i += maxLen) {
          await bot.sendMessage(chatId, output.slice(i, i + maxLen));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error && error.resumeState) {
        updateChatState(chatId, {
          resumeState: error.resumeState,
        });
        await persistChatState(runtimeConfig);
      }
      await bot.sendMessage(chatId, `Error: ${message}`);
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  });

  bot.on("message", async (msg) => {
    if (!msg.text) return;
    if (
      msg.text.startsWith("/start") ||
      msg.text.startsWith("/help") ||
      msg.text.startsWith("/reset") ||
      msg.text.startsWith("/continue") ||
      msg.text.startsWith("/model") ||
      msg.text.startsWith("/depth") ||
      msg.text.startsWith("/settings")
    ) {
      return;
    }

    const chatId = msg.chat.id;
    let typingInterval;

    try {
      await bot.sendChatAction(chatId, "typing");
      typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);

      await bot.sendMessage(chatId, "Processing your request...");

      const state = chatState.get(chatId) || {};
      const options = state.previousResponseId
        ? { previousResponseId: state.previousResponseId }
        : {};
      const progress = createProgressReporter(bot, chatId);
      const selectedModel = pickChatModel(state, runtimeConfig);
      const selectedDepth = pickResearchDepth(state, runtimeConfig);
      const agent = getAgentForModel(runtimeConfig, selectedModel);

      console.log(`[telegram] chat ${chatId}: received message`);

      const result = await runTask(agent, msg.text, runtimeConfig, {
        ...options,
        context: {
          chatId,
          progress,
          researchDepth: selectedDepth,
        },
      });
      const output = String(result.finalOutput ?? "(No text output)");

      // Keep server-side conversation continuity for this chat.
      updateChatState(chatId, {
        previousResponseId: result.lastResponseId,
        resumeState: undefined,
      });
      await persistChatState(runtimeConfig);

      const maxLen = 3900;
      if (output.length <= maxLen) {
        await bot.sendMessage(chatId, output);
      } else {
        for (let i = 0; i < output.length; i += maxLen) {
          await bot.sendMessage(chatId, output.slice(i, i + maxLen));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error && error.resumeState) {
        updateChatState(chatId, {
          resumeState: error.resumeState,
        });
        await persistChatState(runtimeConfig);
        await bot.sendMessage(chatId, "Reached max turns. Send /continue to resume.");
      }
      await bot.sendMessage(chatId, `Error: ${message}`);
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
