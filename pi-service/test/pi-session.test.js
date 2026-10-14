import test from "node:test";
import assert from "node:assert/strict";
import { answer, createPiSession, makeModel } from "../src/pi.js";

const env = { BIFROST_BASE_URL: "http://localhost:18789/v1", BIFROST_API_KEY: "test-secret", BIFROST_MODEL: "pistache-chat" };

test("uses Pi 0.84 AgentSession with exact fixed prompt, only two tools, and session-manager history", async () => {
  const state = await createPiSession({
    env,
    systemPrompt: "Only this parent-controlled prompt.",
    messages: [{ role: "assistant", content: "Bonjour Pistache." }, { role: "user", content: "Répète le mot éléphant." }]
  });
  try {
    assert.equal(state.session.agent.state.systemPrompt, "Only this parent-controlled prompt.");
    assert.deepEqual(state.session.agent.state.tools.map((tool) => tool.name).sort(), ["calculate", "show_word"]);
    assert.equal(state.session.messages[0].content[0].text, "Bonjour Pistache.");
    assert.equal(state.model.baseUrl, "http://localhost:18789/v1");
  } finally { state.session.dispose(); }
});

test("Bifrost model alias and base URL are normalized without exposing credentials", () => {
  const result = makeModel(env);
  assert.equal(result.model.id, "pistache-chat");
  assert.equal(result.model.baseUrl, "http://localhost:18789/v1");
  assert.equal(JSON.stringify(result.model).includes("test-secret"), false);
  assert.equal(result.apiKey, "test-secret");
});

test("actual Pi request receives reconstructed history, complete fixed prompt, and only domain tools", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  let requestUrl;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    payload = JSON.parse(init.body);
    const events = [
      { id: "fake", object: "chat.completion.chunk", created: 1, model: "pistache-chat", choices: [{ index: 0, delta: { content: "Bonjour !" }, finish_reason: null }] },
      { id: "fake", object: "chat.completion.chunk", created: 1, model: "pistache-chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.004 } }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await answer({ env, systemPrompt: "FIXED PARENT PROMPT", messages: [
      { role: "assistant", content: "Salut Pistache" }, { role: "user", content: "On joue ?" }
    ] }).catch((error) => { throw new Error(`${error.message} url=${requestUrl} payload=${JSON.stringify(payload)}`); });
    assert.equal(result.text, "Bonjour !");
    assert.equal(result.usage.cost_usd, 0.004);
    assert.equal(result.usage.requests, 1);
    assert.equal(payload.messages[0].role, "system");
    assert.equal(payload.messages[0].content, "FIXED PARENT PROMPT");
    assert.deepEqual(payload.messages.slice(1).map(({ role, content }) => [role, content]), [
      ["assistant", "Salut Pistache"], ["user", [{ type: "text", text: "On joue ?" }]]
    ]);
    assert.deepEqual(payload.tools.map((tool) => tool.function.name), ["show_word", "calculate"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("six invalid tool attempts exhaust the budget and prevent a seventh gateway turn", async () => {
  const originalFetch = globalThis.fetch;
  let gatewayTurns = 0;
  globalThis.fetch = async () => {
    gatewayTurns += 1;
    const call = { id: `call_${gatewayTurns}`, type: "function", function: { name: "calculate", arguments: JSON.stringify({ a: 1, operation: "eval", b: 2 }) } };
    const events = [
      { id: "fake", object: "chat.completion.chunk", created: 1, model: "pistache-chat", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] },
      { id: "fake", object: "chat.completion.chunk", created: 1, model: "pistache-chat", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await assert.rejects(answer({ env, systemPrompt: "Fixed test prompt", messages: [{ role: "user", content: "Do a calculation" }] }), /aborted/iu);
    assert.equal(gatewayTurns, 6);
  } finally { globalThis.fetch = originalFetch; }
});
