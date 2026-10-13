import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, loadContext, readCallerKey } from "../src/server.js";

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("health and OpenAI completion plus Pistache cards contract work with a fake provider", async () => {
  await withServer({ context: "fixed context", respond: async ({ messages, systemPrompt }) => {
    assert.match(messages.at(-1).content, /Fais un calcul|éléphant 🐟/u);
    assert.match(systemPrompt, /fixed context/u);
    return { text: "Le résultat est 4.", model: "pistache-chat", cards: [{ type: "math", a: 2, operation: "add", b: 2, result: 4 }], toolCalls: [{ name: "calculate", arguments: { a: 2, operation: "add", b: 2 } }] };
  } }, async (url) => {
    const health = await fetch(`${url}/health`);
    const healthJson = await health.json();
    assert.equal(healthJson.status, "ok");
    assert.deepEqual(healthJson.activeTools, ["show_word", "calculate"]);
    assert.equal(healthJson.liveGatewayVerified, false);
    assert.equal(healthJson.requestLimits.toolCalls, 6);
    const response = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Fais un calcul" }] }) });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.choices[0].message.content, "Le résultat est 4.");
    assert.equal(json.pistache.cards[0].result, 4);

    const body = Buffer.from(JSON.stringify({ messages: [{ role: "system", content: "caller override" }, { role: "user", content: "Quel est le mot éléphant 🐟 ?" }] }));
    const split = body.indexOf(Buffer.from("🐟")) + 2;
    const chunked = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: new URL(url).port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.write(body.subarray(0, split));
      req.end(body.subarray(split));
    });
    assert.equal(chunked.status, 200);
  });
});

test("optional bearer key protects chat while health remains available", async () => {
  await withServer({ apiKey: "local-only", respond: async () => ({ text: "ok" }) }, async (url) => {
    assert.equal((await fetch(`${url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Salut" }] }) })).status, 401);
    const response = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer local-only", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Salut" }] }) });
    assert.equal(response.status, 200);
  });
});

test("imported context helper can read an empty directory without failing", () => {
  assert.equal(typeof loadContext("C:/a/path/that/does/not/exist"), "string");
});

test("required context files fail closed when absent", () => {
  assert.throws(() => loadContext("C:/a/path/that/does/not/exist", ["SYSTEM.md", "SOUL.md", "USER.md"]), /Required context file unavailable/u);
});

test("configured API key file fails closed when missing or empty", () => {
  const priorKey = process.env.PI_SERVICE_API_KEY;
  const priorFile = process.env.PI_SERVICE_API_KEY_FILE;
  const dir = mkdtempSync(join(tmpdir(), "pistache-auth-test-"));
  try {
    delete process.env.PI_SERVICE_API_KEY;
    process.env.PI_SERVICE_API_KEY_FILE = join(dir, "missing-secret");
    assert.throws(() => readCallerKey(), /cannot be read/u);
    const empty = join(dir, "empty-secret");
    writeFileSync(empty, "  \n");
    process.env.PI_SERVICE_API_KEY_FILE = empty;
    assert.throws(() => readCallerKey(), /is empty/u);
  } finally {
    if (priorKey === undefined) delete process.env.PI_SERVICE_API_KEY; else process.env.PI_SERVICE_API_KEY = priorKey;
    if (priorFile === undefined) delete process.env.PI_SERVICE_API_KEY_FILE; else process.env.PI_SERVICE_API_KEY_FILE = priorFile;
    rmSync(dir, { recursive: true, force: true });
  }
});
