import test from "node:test";
import assert from "node:assert/strict";
import { createPerchProvider } from "../src/provider.js";
import { events, usage } from "../src/stream.js";
import { backend, openAICompletionsApi, ai, json, sse, completion, transcript, run } from "./helpers.js";

function provider(b) { return createPerchProvider({ api: openAICompletionsApi(), fetch: b.fetch }); }
function balanced(list) {
  const open = new Map();
  for (const event of list) {
    if (/_start$/.test(event.type)) {
      assert(!open.has(event.contentIndex), "block cannot start twice"); open.set(event.contentIndex, event.type);
    } else if (/_end$/.test(event.type)) {
      assert(open.has(event.contentIndex), "block must start before end"); open.delete(event.contentIndex);
    }
  }
  assert.equal(open.size, 0, "all blocks close");
  assert.equal(list.filter(e => e.type === "done" || e.type === "error").length, 1);
}

test("initialization and model management perform no IO; native auth only", async () => {
  let calls = 0;
  const p = createPerchProvider({ api: openAICompletionsApi(), fetch() { calls++; throw new Error("network"); } });
  assert.equal(p.id, "perch"); assert.equal(p.refreshModels, undefined);
  assert.equal(p.auth.apiKey, undefined); assert.equal(p.auth.oauth.name, "Perch AI");
  assert(p.getModels().every(m => m.input.join() === "text"));
  assert.equal(calls, 0);
});

test("native Pi registration/authentication/overrides and available models", async () => {
  const b = backend(), p = provider(b);
  const credentials = new ai.InMemoryCredentialStore();
  const models = ai.createModels({ credentials });
  models.setProvider(p);
  assert.equal((await models.getAvailable("perch")).length, 0);
  await credentials.modify("perch", async () => ({ type: "oauth", origin: p.baseUrl, access: "AUTH", refresh: "REFRESH", expires: Date.now() + 3600000 }));
  assert.equal((await models.getAvailable("perch")).length, p.getModels().length);
  const resolution = await models.getAuth(p.getModels()[0]);
  assert.equal(resolution.auth.apiKey, "AUTH");
  const result = await models.streamSimple(p.getModels()[0], { messages: [{ role: "user", content: "hi" }] }, { maxTokens: 10 }).result();
  assert.equal(result.stopReason, "stop"); assert.equal(b.calls.length, 2);
});

test("wire envelope / output cap / tools / system prompt and effort", async () => {
  const b = backend(); const p = provider(b);
  const { result, events: list } = await run(p, { maxTokens: 999999, reasoning: "high", toolChoice: "none" });
  assert.equal(result.stopReason, "stop"); balanced(list);
  assert.equal(b.calls[0].body.surface, "cli");
  const c = b.calls[1];
  assert.equal(c.init.headers.get("User-Agent"), "perchai-cli/2.4.125");
  assert.equal(c.init.headers.get("Authorization"), "Bearer TOKEN");
  assert.equal(c.init.headers.get("x-perch-turn-ticket"), "TICKET");
  assert.equal(c.body.clientSurface, "cli"); assert.equal(c.body.runId, "RUN1");
  assert.equal(c.body.manualModelOptionId, p.getModels()[0].id);
  assert.deepEqual(c.body.effort, { level: "high", orchestration: false });
  assert.equal(c.body.roostReasoning, true);
  assert.equal(c.body.request.maxTokens, p.getModels()[0].maxTokens);
  assert.equal(c.body.request.toolChoice, "none");
  assert.equal(c.body.request.maxOutputTokens, undefined);
  assert.equal(c.body.request.reasoning, undefined);
  assert.equal(c.body.request.messages[0].content, "Test system prompt");
  assert.equal(c.body.request.tools[0].function.name, "read");
  assert.equal(c.body.promoOverflowAccepted, undefined);
});

test("Perch full stream uses the same scoped protocol bridge", async () => {
  const b = backend(), p = provider(b);
  const r = await p.stream(p.getModels()[0], transcript(), { apiKey: "TOKEN", reasoningEffort: "low", maxTokens: 12 }).result();
  assert.equal(r.stopReason, "stop"); assert.equal(b.calls[1].body.effort.level, "low");
});

test("multi-turn tools and current system/tool patches are delegated to Pi", async () => {
  const b = backend(), p = provider(b);
  const context = ai.normalizeContext({ messages: [
    { role: "system", content: "First prompt", toolsAdded: [{ name: "old", description: "Old", parameters: { type: "object" } }] },
    { role: "user", content: "task" },
    { role: "assistant", provider: "other", model: "other", api: "openai-completions", stopReason: "toolUse", timestamp: 1,
      content: [{ type: "toolCall", id: "call_1", name: "old", arguments: { path: "a" } }] },
    { role: "toolResult", toolCallId: "call_1", toolName: "old", content: [{ type: "text", text: "found" }], isError: false },
    { role: "system", content: "New instruction", toolsRemoved: [{ name: "old" }], toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }] },
    { role: "user", content: "go on" },
  ] });
  await run(p, { context });
  const req = b.calls[1].body.request;
  assert(req.messages[0].content.includes("New instruction"));
  assert(req.messages.some(m => m.role === "tool" && m.tool_call_id && m.content === "found"));
  assert(req.tools.some(t => t.function.name === "read"));
});

test("callbacks receive the actual Perch payload, response, and raw events once", async () => {
  const b = backend([completion()]), p = provider(b), observations = [];
  const { result } = await run(p, {
    onPayload(payload) { observations.push("payload"); return { ...payload, request: { ...payload.request, temperature: .25 } }; },
    onResponse(response) { observations.push("response"); assert.equal(response.status, 200); },
    onProviderStreamEvent(event) { observations.push(event.type); assert.equal(event.type, "done"); },
    headers: { "X-Pi-Test": "yes", "x-perch-locale": "zh-CN" },
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(observations, ["payload", "response", "done"]);
  assert.equal(b.calls[1].body.request.temperature, .25);
  assert.equal(b.calls[1].init.headers.get("x-pi-test"), "yes");
});

test("onPayload undefined retains payload; null is not silently ignored", async () => {
  const b = backend(), p = provider(b);
  await run(p, { onPayload: () => null });
  assert.equal(b.calls[1].body, null);
});

test("per-request injected fetch, not global fetch, covers ticket and model", async () => {
  const b = backend(), p = createPerchProvider({ api: openAICompletionsApi() });
  await run(p, { fetch: b.fetch });
  assert.equal(b.calls.length, 2);
});

test("SSE supports one-byte UTF-8 chunks, CRLF, and final no-blank frame", async () => {
  const b = backend(undefined, c => c.url.endsWith("/model-call") ? sse([
    { type: "answer_delta", text: "中文🦜" }, completion({ text: "中文🦜" }),
  ], { fragment: 1, eol: "\r\n", finalBlank: false }) : undefined);
  const { result, events: list } = await run(provider(b));
  assert.equal(result.content[0].text, "中文🦜"); assert.equal(result.stopReason, "stop"); balanced(list);
});

test("SSE comments and multiline JSON data", async () => {
  const response = new Response(': keepalive\r\ndata: {"type":"done",\r\ndata: "ok":true}\r\n\r\n');
  const values = []; for await (const e of events(response)) values.push(e);
  assert.deepEqual(values, [{ type: "done", ok: true }]);
});

test("thinking, final text tail, reported usage and catalog cost", async () => {
  const b = backend([
    { type: "reasoning_delta", text: "think" }, { type: "answer_delta", text: "hel" },
    completion({ text: "hello", usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 200, cacheCreationInputTokens: 30, reasoningTokens: 5 } }),
  ]);
  const { result, events: list } = await run(provider(b)); balanced(list);
  assert.equal(result.content.find(v => v.type === "thinking").thinking, "think");
  assert.equal(result.content.find(v => v.type === "text").text, "hello");
  assert.equal(result.usage.input, 100); assert.equal(result.usage.cacheRead, 200); assert.equal(result.usage.cacheWrite, 30);
  assert.equal(result.usage.totalTokens, 350); assert.equal(result.usage.output, 20);
  assert.equal(result.usage.reasoning, 5); assert(result.usage.cost.total > 0);
});

test("OpenAI raw usage deducts cache, while Perch inputTokens is already fresh", () => {
  assert.equal(usage({ prompt_tokens: 50, completion_tokens: 10, cacheReadInputTokens: 20 }).prompt_tokens, 50);
  assert.equal(usage({ inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 20 }).prompt_tokens, 50);
  assert.equal(usage({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 65, completion_tokens_details: { reasoning_tokens: 5 } }).completion_tokens, 15);
});

test("complete tool snapshots produce valid balanced Pi tool events", async () => {
  const call = { id: "a", name: "read", arguments: { path: "文件" }, sealed: true };
  const b = backend([{ type: "tool_call_delta", toolCalls: [call] }, completion({ text: "", toolCalls: [call] })]);
  const { result, events: list } = await run(provider(b)); balanced(list);
  assert.equal(result.stopReason, "toolUse"); assert.deepEqual(result.content[0].arguments, { path: "文件" });
  assert.equal(result.content.filter(c => c.type === "toolCall").length, 1);
});

test("done empty tools override abandoned snapshots", async () => {
  const b = backend([{ type: "tool_call_delta", toolCalls: [{ id: "a", name: "read", arguments: {} }] }, completion({ toolCalls: [] })]);
  const { result } = await run(provider(b));
  assert.equal(result.stopReason, "stop"); assert(!result.content.some(c => c.type === "toolCall"));
});

for (const [label, list, message] of [
  ["malformed tool JSON", [completion({ text: "", toolCalls: [{ id: "a", name: "read", arguments: '{"path":' }] })], "not valid JSON"],
  ["array tool JSON", [completion({ text: "", toolCalls: [{ id: "a", name: "read", arguments: [] }] })], "must be an object"],
  ["unsealed tool", [completion({ text: "", toolCalls: [{ id: "a", name: "read", arguments: {}, sealed: false }] })], "Incomplete"],
  ["empty", [completion({ text: "" })], "empty response"],
  ["thinking only", [{ type: "reasoning_delta", text: "no answer" }, completion({ text: "" })], "empty response"],
  ["truncated", [{ type: "answer_delta", text: "partial" }], "without a completion"],
  ["restart after text", [{ type: "answer_delta", text: "old" }, { type: "stream_restart" }, completion()], "restarted"],
  ["different final answer", [{ type: "answer_delta", text: "old" }, completion()], "differs"],
  ["output limit in tools", [completion({ text: "", finishReason: "length", toolCalls: [{ id: "a", name: "read", arguments: {} }] })], "interrupted"],
]) test(label + " fails without executing tools", async () => {
  const { result } = await run(provider(backend(list)));
  assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, new RegExp(message));
  assert(!result.content.some(c => c.type === "toolCall"));
});

test("malformed SSE is an error, not silently skipped", async () => {
  const b = backend(undefined, c => c.url.endsWith("/model-call") ? new Response('data: {bad}\n\n', { headers: { "content-type": "text/event-stream" } }) : undefined);
  const { result } = await run(provider(b)); assert.equal(result.stopReason, "error"); assert.match(result.errorMessage, /Malformed/);
});

test("backend output limit produces Pi length", async () => {
  const { result } = await run(provider(backend([completion({ finishReason: "length" })])));
  assert.equal(result.stopReason, "length");
});

test("transient model_call_failed may recover; terminal error preserves provider code", async () => {
  const b = backend([{ type: "model_call_failed", error: "upstream busy" }, completion()]);
  assert.equal((await run(provider(b))).result.stopReason, "stop");
  const failed = await run(provider(backend([{ type: "done", ok: false, error: "context_length_exceeded", errorCode: "overflow" }])));
  assert.match(failed.result.errorMessage, /context_length_exceeded/); assert.match(failed.result.errorMessage, /overflow/);
});

test("HTTP 403/429 never fallback or bypass errors; secret strings are masked", async () => {
  for (const status of [403, 429]) {
    const b = backend(undefined, c => c.url.endsWith("/model-call") ? json({ ok: false, error: "TOKEN TICKET denied", errorCode: status === 403 ? "perch_surface_required" : "usage_limit_reached" }, status, { "retry-after": "60" }) : undefined);
    const { result } = await run(provider(b));
    assert.equal(result.stopReason, "error"); assert(!result.errorMessage.includes("TOKEN")); assert(!result.errorMessage.includes("TICKET"));
    assert.match(result.errorMessage, new RegExp(String(status))); assert.equal(b.calls.length, 2);
  }
});

test("aborted request sends nothing; image history is rejected, not discarded", async () => {
  const b = backend(), p = provider(b);
  const controller = new AbortController(); controller.abort();
  const r = await run(p, { signal: controller.signal });
  assert.equal(r.result.stopReason, "aborted"); assert.equal(b.calls.length, 0);
  assert.throws(() => p.streamSimple(p.getModels()[0], transcript([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }]), { apiKey: "TOKEN" }), /image input/);
  assert.equal(b.calls.length, 0);
});

test("stream abort cancels the actual reader, not just caller waiting", async () => {
  const controller = new AbortController(); let cancelled = false;
  const b = backend(undefined, c => {
    if (!c.url.endsWith("/model-call")) return undefined;
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  });
  const pending = run(provider(b), { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 30);
  try { const { result } = await pending; assert.equal(result.stopReason, "aborted"); assert(cancelled); }
  finally { clearTimeout(timer); }
});

test("credential origin binding prevents endpoint override", async () => {
  const p = provider(backend());
  await assert.rejects(p.auth.oauth.toAuth({ type: "oauth", origin: "https://elsewhere.invalid", access: "secret" }), /another endpoint/);
  assert.throws(() => p.streamSimple({ ...p.getModels()[0], baseUrl: "https://elsewhere.invalid" }, transcript(), { apiKey: "TOKEN" }), /overridden endpoint/);
});
