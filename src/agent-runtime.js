import { Agent, run, setDefaultOpenAIKey, tool } from "@openai/agents";
import fs from "node:fs/promises";
import path from "node:path";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execCallback);

async function reportProgress(runContext, message) {
  const progressFn = runContext?.context?.progress;
  if (typeof progressFn === "function") {
    await progressFn(message);
  }
}

export async function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  try {
    const content = await fs.readFile(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional; process.env still works.
  }
}

function resolveSafePath(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside of WORKSPACE_DIR");
  }
  return resolvedTarget;
}

async function listFiles(baseDir, relativePath = ".") {
  const fullPath = resolveSafePath(baseDir, relativePath);
  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function readFileLocal(baseDir, relativePath) {
  const fullPath = resolveSafePath(baseDir, relativePath);
  return fs.readFile(fullPath, "utf8");
}

async function writeFileLocal(baseDir, relativePath, content) {
  const fullPath = resolveSafePath(baseDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
  return "ok";
}

async function runShell(baseDir, command, enabled) {
  if (!enabled) {
    throw new Error("run_shell is disabled. Set ENABLE_SHELL_TOOL=true to enable.");
  }
  const { stdout, stderr } = await exec(command, {
    cwd: baseDir,
    timeout: 60_000,
    windowsHide: true,
  });
  return { stdout, stderr };
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function htmlToText(html) {
  const withoutScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutStyle = withoutScript.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutStyle.replace(/<[^>]+>/g, " ");
  return normalizeText(withoutTags);
}

function shortText(text, maxLength = 12000) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

async function zyteExtract(zyteApiKey, body) {
  const auth = Buffer.from(`${zyteApiKey}:`).toString("base64");
  const response = await fetch("https://api.zyte.com/v1/extract", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = json?.detail || json?.problem || JSON.stringify(json);
    throw new Error(`Zyte API error ${response.status}: ${detail}`);
  }
  return json;
}

async function tavilySearch(tavilyApiKey, query, maxResults) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tavilyApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: "basic",
      include_raw_content: false,
      topic: "general",
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = json?.detail || json?.error || JSON.stringify(json);
    throw new Error(`Tavily API error ${response.status}: ${detail}`);
  }
  return json;
}

export function buildRuntimeConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Set it in environment or .env file.");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const maxTurns = Number(process.env.MAX_TURNS || 20);
  const autoContinueOnMaxTurns =
    String(process.env.AUTO_CONTINUE_ON_MAX_TURNS || "true").toLowerCase() === "true";
  const maxRunSegments = Number(process.env.MAX_RUN_SEGMENTS || 3);
  const workspaceDir = path.resolve(process.cwd(), process.env.WORKSPACE_DIR || ".");
  const shellEnabled = String(process.env.ENABLE_SHELL_TOOL || "false").toLowerCase() === "true";
  const tavilySearchEnabled =
    String(process.env.ENABLE_TAVILY_SEARCH_TOOL || "true").toLowerCase() === "true";
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  const zyteWebEnabled =
    String(process.env.ENABLE_ZYTE_WEB_TOOL || "false").toLowerCase() === "true";
  const zyteApiKey = process.env.ZYTE_API_KEY;
  const verboseAgentLog = String(process.env.VERBOSE_AGENT_LOG || "true").toLowerCase() === "true";

  if (tavilySearchEnabled && !tavilyApiKey) {
    throw new Error("ENABLE_TAVILY_SEARCH_TOOL=true but TAVILY_API_KEY is missing.");
  }

  if (zyteWebEnabled && !zyteApiKey) {
    throw new Error("ENABLE_ZYTE_WEB_TOOL=true but ZYTE_API_KEY is missing.");
  }

  const systemPrompt = [
    "You are an autonomous coding agent.",
    "Work step-by-step and use tools when needed.",
    "Minimize risky changes and explain final result clearly.",
    "Do not access paths outside WORKSPACE_DIR.",
    shellEnabled
      ? "run_shell is enabled; use it only when truly necessary."
      : "run_shell is disabled; do not rely on shell execution.",
    tavilySearchEnabled
      ? "You can search the internet with web_search_tavily."
      : "Internet search is disabled unless ENABLE_TAVILY_SEARCH_TOOL=true.",
    zyteWebEnabled
      ? "Use web_open_zyte to open/crawl URLs with anti-block rendering."
      : "Web crawling is disabled unless ENABLE_ZYTE_WEB_TOOL=true.",
  ].join(" ");

  return {
    apiKey,
    model,
    maxTurns,
    autoContinueOnMaxTurns,
    maxRunSegments,
    workspaceDir,
    shellEnabled,
    tavilySearchEnabled,
    tavilyApiKey,
    zyteWebEnabled,
    zyteApiKey,
    verboseAgentLog,
    systemPrompt,
  };
}

export function createWorkspaceAgent(runtimeConfig) {
  const {
    apiKey,
    model,
    workspaceDir,
    shellEnabled,
    tavilySearchEnabled,
    tavilyApiKey,
    zyteWebEnabled,
    zyteApiKey,
    verboseAgentLog,
    systemPrompt,
  } = runtimeConfig;

  setDefaultOpenAIKey(apiKey);

  const listFilesTool = tool({
    name: "list_files",
    description: "List files and directories inside WORKSPACE_DIR",
    parameters: z.object({
      path: z.string().default(".").describe("Relative directory path from WORKSPACE_DIR"),
    }),
    execute: async ({ path: target }, runContext) => {
      await reportProgress(runContext, `Calling list_files on ${target}`);
      return listFiles(workspaceDir, target);
    },
  });

  const readFileTool = tool({
    name: "read_file",
    description: "Read a UTF-8 text file inside WORKSPACE_DIR",
    parameters: z.object({
      path: z.string().describe("Relative file path from WORKSPACE_DIR"),
    }),
    execute: async ({ path: target }, runContext) => {
      await reportProgress(runContext, `Calling read_file on ${target}`);
      return readFileLocal(workspaceDir, target);
    },
  });

  const writeFileTool = tool({
    name: "write_file",
    description: "Write a UTF-8 text file inside WORKSPACE_DIR",
    parameters: z.object({
      path: z.string().describe("Relative file path from WORKSPACE_DIR"),
      content: z.string().describe("Content to write"),
    }),
    execute: async ({ path: target, content }, runContext) => {
      await reportProgress(runContext, `Calling write_file on ${target}`);
      return writeFileLocal(workspaceDir, target, content);
    },
  });

  const tools = [listFilesTool, readFileTool, writeFileTool];

  if (shellEnabled) {
    const runShellTool = tool({
      name: "run_shell",
      description: "Run a shell command in WORKSPACE_DIR",
      parameters: z.object({
        command: z.string().describe("Command to execute"),
      }),
      execute: async ({ command }, runContext) => {
        await reportProgress(runContext, `Calling run_shell: ${command}`);
        return runShell(workspaceDir, command, shellEnabled);
      },
    });
    tools.push(runShellTool);
  }

  if (tavilySearchEnabled) {
    const webSearchTavilyTool = tool({
      name: "web_search_tavily",
      description: "Search the public web via Tavily and return top relevant results.",
      parameters: z.object({
        query: z.string().describe("Search query"),
        topK: z.number().int().min(1).max(10).default(5).describe("Number of results to return"),
      }),
      execute: async ({ query, topK }, runContext) => {
        await reportProgress(runContext, `Searching web with Tavily: ${query}`);
        const data = await tavilySearch(tavilyApiKey, query, topK);

        const results = Array.isArray(data?.results)
          ? data.results.slice(0, topK)
          : [];

        return {
          query,
          answer: data?.answer || "",
          results: results.map((item) => ({
            title: item.title || "",
            url: item.url || "",
            description: item.description || "",
            content: shortText(String(item.content || ""), 1200),
            score: item.score,
          })),
        };
      },
    });

    tools.push(webSearchTavilyTool);
  }

  if (zyteWebEnabled) {
    const webOpenZyteTool = tool({
      name: "web_open_zyte",
      description: "Open a URL via Zyte browser rendering and return cleaned page text snippet.",
      parameters: z.object({
        url: z.string().describe("Absolute URL to open, must start with http:// or https://"),
      }),
      execute: async ({ url }, runContext) => {
        await reportProgress(runContext, `Opening page with Zyte: ${url}`);
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error("Invalid URL. Provide a full URL, e.g. https://example.com");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Invalid URL protocol. Only http and https are supported.");
        }

        const data = await zyteExtract(zyteApiKey, {
          url: parsed.toString(),
          browserHtml: true,
          pageContent: true,
        });

        const rawHtml = String(data.browserHtml || "");
        const text = rawHtml ? htmlToText(rawHtml) : "";
        const pageHeadline = data?.pageContent?.headline || "";

        return {
          url: data.url || url,
          statusCode: data.statusCode,
          headline: pageHeadline,
          textSnippet: shortText(text, 12000),
        };
      },
    });

    tools.push(webOpenZyteTool);
  }

  return new Agent({
    name: "Workspace Autonomous Agent",
    instructions: systemPrompt,
    model,
    tools,
  });
}

export function attachAgentLogs(agent, runtimeConfig) {
  if (!runtimeConfig.verboseAgentLog) {
    return;
  }

  agent.on("agent_start", (_ctx, currentAgent) => {
    console.log(`[agent:start] ${currentAgent.name}`);
  });

  agent.on("agent_end", (_ctx) => {
    console.log("[agent:end] completed");
  });

  agent.on("agent_tool_start", (_ctx, usedTool) => {
    console.log(`[tool:start] ${usedTool.name}`);
  });

  agent.on("agent_tool_end", (_ctx, usedTool) => {
    console.log(`[tool:end] ${usedTool.name}`);
  });
}

export async function runTask(agent, input, runtimeConfig, options = {}) {
  const maxTurns = options.maxTurns ?? runtimeConfig.maxTurns;
  const autoContinue = runtimeConfig.autoContinueOnMaxTurns;
  const maxSegments = Math.max(1, runtimeConfig.maxRunSegments || 1);
  let currentInput = input;
  let lastMaxTurnsError = null;

  for (let segment = 1; segment <= maxSegments; segment += 1) {
    try {
      const result = await run(agent, currentInput, {
        maxTurns,
        ...options,
      });
      return result;
    } catch (error) {
      const isMaxTurns = error && error.name === "MaxTurnsExceededError";
      const canResume = isMaxTurns && error.state;

      if (!canResume) {
        throw error;
      }

      lastMaxTurnsError = error;

      const progressFn = options?.context?.progress;
      if (typeof progressFn === "function") {
        await progressFn(`Reached max_turns in segment ${segment}.`);
      }

      if (!autoContinue || segment >= maxSegments) {
        break;
      }

      if (typeof progressFn === "function") {
        await progressFn(`Auto-continuing to segment ${segment + 1}/${maxSegments}...`);
      }

      currentInput = error.state;
    }
  }

  const exhaustedError = new Error(
    `Reached max turns after ${maxSegments} segment(s). Send /continue to resume.`
  );
  if (lastMaxTurnsError?.state) {
    exhaustedError.resumeState = lastMaxTurnsError.state;
  }
  throw exhaustedError;
}
