import { Type } from "@sinclair/typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { MAX_REPLY_TOKENS, MAX_TOOL_CALLS, assertPiSessionSafety, fixedSystemPrompt, runTool } from "./core.js";
import { readFileSync } from "node:fs";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function readBifrostKey(env = process.env) {
  if (env.BIFROST_API_KEY) return env.BIFROST_API_KEY;
  if (env.BIFROST_API_KEY_FILE) return readFileSync(env.BIFROST_API_KEY_FILE, "utf8").trim();
  return "";
}

export function makeModel(env = process.env) {
  const apiKey = readBifrostKey(env);
  if (!env.BIFROST_BASE_URL || !apiKey) throw new Error("Bifrost is not configured");
  const id = env.BIFROST_MODEL || "pistache-chat";
  return {
    apiKey,
    model: {
      id, name: id, api: "openai-completions", provider: "pistache-bifrost",
      baseUrl: `${env.BIFROST_BASE_URL.replace(/\/$/, "").replace(/\/v1$/i, "")}/v1`, reasoning: false,
      input: ["text"], cost, contextWindow: 8192, maxTokens: MAX_REPLY_TOKENS,
      compat: { requiresToolResultName: true }
    }
  };
}

function minimalResources(systemPrompt) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
}

function customTools(cards, calls) {
  return [
    {
      name: "show_word", label: "Show word", description: "Show a word card with its letters.",
      executionMode: "sequential",
      parameters: Type.Object({ word: Type.String({ minLength: 1, maxLength: 40 }) }, { additionalProperties: false }),
      execute: async (_id, args, signal) => executeCard("show_word", args, signal, cards, calls)
    },
    {
      name: "calculate", label: "Calculate", description: "Calculate one addition, subtraction, multiplication, or division.",
      executionMode: "sequential",
      parameters: Type.Object({ a: Type.Number(), operation: Type.Union([Type.Literal("add"), Type.Literal("subtract"), Type.Literal("multiply"), Type.Literal("divide")]), b: Type.Number() }, { additionalProperties: false }),
      execute: async (_id, args, signal) => executeCard("calculate", args, signal, cards, calls)
    }
  ];
}

async function executeCard(name, args, signal, cards, calls) {
  if (signal?.aborted) throw new Error("Request aborted");
  const card = runTool(name, args);
  cards.push(card);
  calls.push({ name, arguments: card.type === "word" ? { word: card.word } : { a: card.a, operation: card.operation, b: card.b } });
  return { content: [{ type: "text", text: JSON.stringify(card) }], details: card };
}

function appendHistory(sessionManager, history, model) {
  for (const entry of history.slice(0, -1)) {
    if (entry.role === "user") {
      sessionManager.appendMessage({ role: "user", content: entry.content, timestamp: Date.now() });
    } else {
      sessionManager.appendMessage({
        role: "assistant", content: [{ type: "text", text: entry.content }], api: model.api,
        provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } },
        stopReason: "stop", timestamp: Date.now()
      });
    }
  }
}

export async function createPiSession({ messages, systemPrompt, env = process.env, signal } = {}) {
  const { model, apiKey } = makeModel(env);
  const cwd = process.cwd();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal });
  modelRuntime.registerProvider("pistache-bifrost", {
    name: "Pistache Bifrost", baseUrl: model.baseUrl, api: "openai-completions", apiKey,
    streamSimple,
    models: [{ id: model.id, name: model.name, api: "openai-completions", baseUrl: model.baseUrl, reasoning: false, input: ["text"], cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens, compat: model.compat }]
  });
  await modelRuntime.setRuntimeApiKey("pistache-bifrost", apiKey);
  const sessionRef = { session: undefined };
  const cards = [];
  const calls = [];
  const prompt = systemPrompt || fixedSystemPrompt("");
  const sessionManager = SessionManager.inMemory(cwd);
  appendHistory(sessionManager, messages, model);
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, model, modelRuntime,
    thinkingLevel: "off", noTools: "all", tools: ["show_word", "calculate"],
    customTools: customTools(cards, calls),
    resourceLoader: minimalResources(prompt), sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
  });
  sessionRef.session = session;
  const toolBudget = { attempts: 0 };
  const unsubscribeBudget = session.agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolBudget.attempts += 1;
      if (toolBudget.attempts > MAX_TOOL_CALLS) queueMicrotask(() => void session.abort());
    } else if (event.type === "tool_execution_end" && toolBudget.attempts >= MAX_TOOL_CALLS) {
      // Sequential tool execution guarantees the sixth result (including a
      // schema/domain validation error) settles before the agent can request a seventh.
      queueMicrotask(() => void session.abort());
    }
  });
  // Pi may append cwd or default context during session construction; force the
  // server-owned prompt to be the complete system prompt for this request.
  session._rebuildSystemPrompt = () => prompt;
  session._baseSystemPrompt = prompt;
  session.agent.state.systemPrompt = prompt;
  assertPiSessionSafety(session, prompt);
  return { session, cards, toolCalls: calls, model, modelRuntime, toolBudget, unsubscribeBudget };
}

export async function answer({ messages, systemPrompt, env = process.env, signal }) {
  const state = await createPiSession({ messages, systemPrompt, env, signal });
  const abort = () => void state.session.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await state.session.prompt(messages.at(-1).content, { expandPromptTemplates: false, source: "rpc" });
    const last = [...state.session.messages].reverse().find((item) => item.role === "assistant");
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last?.stopReason === "aborted" ? "Request aborted" : `Model request failed: ${last?.errorMessage || "no assistant response"}`);
    const text = last?.content?.filter((part) => part.type === "text").map((part) => part.text).join("").slice(0, 4_000) || "Je peux t’aider avec un mot ou un calcul !";
    return { text, cards: state.cards, toolCalls: state.toolCalls, model: state.model.id };
  } finally {
    signal?.removeEventListener("abort", abort);
    state.unsubscribeBudget();
    state.session.dispose();
  }
}
