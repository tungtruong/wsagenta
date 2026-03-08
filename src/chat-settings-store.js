import fs from "node:fs/promises";
import path from "node:path";

function normalizeState(input) {
  if (!input || typeof input !== "object") {
    return {};
  }

  const state = {};
  if (typeof input.previousResponseId === "string" && input.previousResponseId) {
    state.previousResponseId = input.previousResponseId;
  }
  if (typeof input.model === "string" && input.model) {
    state.model = input.model;
  }
  if (typeof input.researchDepth === "string" && input.researchDepth) {
    state.researchDepth = input.researchDepth;
  }
  if (input.resumeState != null) {
    state.resumeState = input.resumeState;
  }

  return state;
}

function toChatId(rawChatId) {
  const numeric = Number(rawChatId);
  return Number.isNaN(numeric) ? rawChatId : numeric;
}

export async function loadChatState(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    const chats = parsed?.chats;
    const stateMap = new Map();

    if (!chats || typeof chats !== "object") {
      return stateMap;
    }

    for (const [chatId, state] of Object.entries(chats)) {
      stateMap.set(toChatId(chatId), normalizeState(state));
    }

    return stateMap;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function saveChatState(filePath, chatState) {
  const chats = {};
  for (const [chatId, state] of chatState.entries()) {
    chats[String(chatId)] = normalizeState(state);
  }

  const payload = JSON.stringify({ version: 1, chats }, null, 2);
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp`;

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, filePath);
}
