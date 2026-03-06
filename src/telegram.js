import TelegramBot from "node-telegram-bot-api";
import {
  attachAgentLogs,
  buildRuntimeConfig,
  createWorkspaceAgent,
  loadEnv,
  runTask,
} from "./agent-runtime.js";

const chatState = new Map();
let shuttingDownForConflict = false;

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
  const agent = createWorkspaceAgent(runtimeConfig);
  attachAgentLogs(agent, runtimeConfig);

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
  console.log(`Workspace: ${runtimeConfig.workspaceDir}`);

  bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      "Bot da san sang. Gui yeu cau de chay Autonomous Agent."
    );
  });

  bot.onText(/\/reset/, async (msg) => {
    chatState.delete(msg.chat.id);
    await bot.sendMessage(msg.chat.id, "Da reset context hoi thoai cho chat nay.");
  });

  bot.onText(/\/continue/, async (msg) => {
    const chatId = msg.chat.id;
    const state = chatState.get(chatId) || {};
    if (!state.resumeState) {
      await bot.sendMessage(chatId, "Khong co tien trinh dang doi de tiep tuc.");
      return;
    }

    let typingInterval;
    try {
      await bot.sendMessage(chatId, "Dang tiep tuc phien truoc...");
      typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);

      const progress = createProgressReporter(bot, chatId);
      const result = await runTask(agent, state.resumeState, runtimeConfig, {
        context: { chatId, progress },
      });

      chatState.set(chatId, {
        previousResponseId: result.lastResponseId,
      });

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
        chatState.set(chatId, {
          ...state,
          resumeState: error.resumeState,
        });
      }
      await bot.sendMessage(chatId, `Loi: ${message}`);
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
      msg.text.startsWith("/reset") ||
      msg.text.startsWith("/continue")
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

      await bot.sendMessage(chatId, "Dang xu ly yeu cau...");

      const state = chatState.get(chatId) || {};
      const options = state.previousResponseId
        ? { previousResponseId: state.previousResponseId }
        : {};
      const progress = createProgressReporter(bot, chatId);

      console.log(`[telegram] chat ${chatId}: received message`);

      const result = await runTask(agent, msg.text, runtimeConfig, {
        ...options,
        context: {
          chatId,
          progress,
        },
      });
      const output = String(result.finalOutput ?? "(No text output)");

      // Keep server-side conversation continuity for this chat.
      chatState.set(chatId, { previousResponseId: result.lastResponseId });

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
        const state = chatState.get(chatId) || {};
        chatState.set(chatId, {
          ...state,
          resumeState: error.resumeState,
        });
        await bot.sendMessage(chatId, "Dung max turns. Gui /continue de tiep tuc.");
      }
      await bot.sendMessage(chatId, `Loi: ${message}`);
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
