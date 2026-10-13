import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answer, readBifrostKey } from "./pi.js";
import { fixedSystemPrompt, MAX_BODY_BYTES, MAX_TOOL_CALLS, normalizeHistory, toolsForPi } from "./core.js";

const CONTEXT_DIR = process.env.CONTEXT_DIR || "/context";
const CONTEXT_FILES = ["SYSTEM.md", "SOUL.md", "USER.md", "MEMORY.md"];

export function loadContext(dir = CONTEXT_DIR, requiredFiles = (process.env.REQUIRED_CONTEXT_FILES || "").split(",").map((name) => name.trim()).filter(Boolean)) {
  const pieces = [];
  const loaded = new Set();
  for (const name of CONTEXT_FILES) {
    try { pieces.push(`## ${name}\n${readFileSync(join(dir, name), "utf8").slice(0, 8_000)}`); loaded.add(name); } catch (error) {
      if (requiredFiles.includes(name)) throw new Error(`Required context file unavailable: ${name}`);
    }
  }
  try { pieces.push(`## PROFILE.json\n${readFileSync(join(dir, "profile.json"), "utf8").slice(0, 8_000)}`); loaded.add("profile.json"); } catch {}
  const missing = requiredFiles.filter((name) => !loaded.has(name));
  if (missing.length) throw new Error(`Required context file unavailable: ${missing.join(", ")}`);
  const context = pieces.join("\n\n");
  if (requiredFiles.length && context.length > 24_000) throw new Error("Required imported context exceeds the supported prompt size");
  return context.slice(0, 24_000);
}

export function contextFilesPresent(dir = CONTEXT_DIR) {
  return [...CONTEXT_FILES, "profile.json"].filter((name) => {
    try { readFileSync(join(dir, name)); return true; } catch { return false; }
  });
}

async function bodyJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

export function readCallerKey() {
  if (process.env.PI_SERVICE_API_KEY) return process.env.PI_SERVICE_API_KEY;
  if (process.env.PI_SERVICE_API_KEY_FILE) {
    // A configured secret file is an explicit auth requirement. Fail startup
    // when it cannot be read or is empty; never silently expose the endpoint.
    let key;
    try { key = readFileSync(process.env.PI_SERVICE_API_KEY_FILE, "utf8").trim(); }
    catch { throw new Error("PI_SERVICE_API_KEY_FILE cannot be read"); }
    if (!key) throw new Error("PI_SERVICE_API_KEY_FILE is empty");
    return key;
  }
  return "";
}

export function createServer({ respond = answer, context = loadContext(), apiKey = readCallerKey() } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (req.method === "GET" && req.url === "/health") {
      const contextText = context || "";
      let keyConfigured = false;
      try { keyConfigured = Boolean(readBifrostKey()); } catch {}
      const configured = Boolean(process.env.BIFROST_BASE_URL && keyConfigured);
      const readiness = configured ? "configured_unverified" : "not_configured";
      return void (res.writeHead(200), res.end(JSON.stringify({ status: "ok", readiness, upstream: { gateway: process.env.BIFROST_BASE_URL ? "configured" : "missing", model: process.env.BIFROST_MODEL || "pistache-chat" }, activeTools: toolsForPi().map((tool) => tool.name), promptChars: fixedSystemPrompt(contextText).length, importedContextFiles: contextFilesPresent(), requestLimits: { bodyBytes: MAX_BODY_BYTES, historyMessages: 40, toolCalls: MAX_TOOL_CALLS, timeoutMs: 30_000 }, liveGatewayVerified: false })));
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return void (res.writeHead(404), res.end(JSON.stringify({ error: { message: "Not found" } })));
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) return void (res.writeHead(401), res.end(JSON.stringify({ error: { message: "Unauthorized" } })));
    try {
      const body = await bodyJson(req);
      const messages = normalizeHistory(body.messages);
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
      const onDisconnect = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", onDisconnect);
      let result;
      try {
        result = await Promise.race([
          respond({ messages, systemPrompt: fixedSystemPrompt(context), signal: controller.signal }),
          new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error(timedOut ? "Request timed out" : "Request aborted")), { once: true }))
        ]);
      } finally {
        clearTimeout(timeout);
        res.off("close", onDisconnect);
      }
      const id = `chatcmpl-${Date.now()}`;
      res.writeHead(200);
      res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: result.model || "pistache-chat", choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }], pistache: { cards: result.cards || [], toolCalls: result.toolCalls || [] } }));
    } catch (error) {
      const status = error.status || (error.message === "Request timed out" ? 504 : error.message === "Request aborted" ? 499 : error.message === "Invalid JSON" || /messages|history|text|last message|too large|Only text/u.test(error.message) ? 400 : 502);
      if (!res.destroyed && !res.headersSent) res.writeHead(status);
      if (!res.destroyed) res.end(JSON.stringify({ error: { message: status === 400 ? error.message : status === 504 ? "Upstream request timed out" : status === 499 ? "Request cancelled" : "Upstream request failed" } }));
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8788);
  createServer().listen(port, process.env.HOST || "127.0.0.1", () => console.log(`Pistache Pi service listening on ${port}`));
}
