import test from "node:test";
import assert from "node:assert/strict";
import { createPerchProvider } from "../src/provider.js";
import { backend, openAICompletionsApi, ai, json, completion, transcript, run } from "./helpers.js";
const provider = b => createPerchProvider({ api: openAICompletionsApi(), fetch: b.fetch });

test("HTTP 200 business error/non-SSE response remains an error", async () => {
  const b = backend(undefined, c => c.url.endsWith("/model-call") ? json({ ok: false, error: "plan restricted", errorCode: "plan_model_blocked" }) : undefined);
  const { result } = await run(provider(b));
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, /plan_model_blocked/);
});

test("payload hooks cannot enlarge output budget", async () => {
  const b = backend(), p = provider(b);
  await run(p, { maxTokens: 20, onPayload: value => ({ ...value, request: { ...value.request, maxTokens: 999999 } }) });
  assert.equal(b.calls[1].body.request.maxTokens, 20);
});

test("invalid caller budgets fail before IO", async () => {
  const b = backend(), p = provider(b);
  for (const maxTokens of [0, -1, NaN, Infinity]) {
    assert.throws(() => p.streamSimple(p.getModels()[0], transcript(), { apiKey: "TOKEN", maxTokens }), /budget/);
  }
  assert.equal(b.calls.length, 0);
});

test("completion without an ok field matches the official CLI consumer", async () => {
  const b = backend([{ type: "done", text: "valid final", usage: { inputTokens: 2, outputTokens: 2 } }]);
  const { result } = await run(provider(b));
  assert.equal(result.stopReason, "stop"); assert.equal(result.content[0].text, "valid final");
});

test("context overflow stays recognizable to Pi compaction without message_end hook", async () => {
  const b = backend([{ type: "done", ok: false, error: "context_length_exceeded: maximum context length exceeded" }]);
  const { result } = await run(provider(b));
  assert.equal(ai.isContextOverflow(result), true);
});

test("user-turn boundaries do not require global hooks or merge distinct prompts", async () => {
  const b = backend(), p = provider(b);
  const user = { role: "user", content: "Hello" };
  await run(p, { sessionId: "session", context: transcript([user]) });
  const withTools = transcript([user,
    { role: "assistant", provider: "perch", model: p.getModels()[0].id, api: "openai-completions", stopReason: "toolUse", timestamp: 1,
      content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "found" }], isError: false },
  ]);
  await run(p, { sessionId: "session", context: withTools });
  assert.equal(b.calls.filter(call => call.url.endsWith("/turn-ticket")).length, 1, "tool iteration reuses turn ticket");
  await run(p, { sessionId: "session", context: transcript([user, { role: "assistant", content: [{ type: "text", text: "ok" }] }, user]) });
  assert.equal(b.calls.filter(call => call.url.endsWith("/turn-ticket")).length, 2, "even a repeated prompt is a new user turn");
});

test("stateless calls are separate Perch turns", async () => {
  const b = backend(), p = provider(b);
  await run(p); await run(p);
  assert.equal(b.calls.filter(call => call.url.endsWith("/turn-ticket")).length, 2);
});

test("a final whitespace trim is not a false restart/mismatch", async () => {
  const b = backend([{ type: "answer_delta", text: "hello\n" }, completion({ text: "hello" })]);
  const { result } = await run(provider(b)); assert.equal(result.stopReason, "stop");
});
