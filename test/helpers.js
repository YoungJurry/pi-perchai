import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
// Use the installed host SDK without bundling or installing another copy.
const agent = process.env.PI_CODING_AGENT_DIR ?? homedir() + "/.pi/agent";
const installedAi = () => agent + "/install/releases/" + readFileSync(agent + "/install/current-version", "utf8").trim() + "/node_modules/@earendil-works/pi-ai";
export const aiDir = process.env.PI_TEST_AI_DIR ?? installedAi();
export const ai = await import(pathToFileURL(aiDir + "/dist/index.js"));
export const { openAICompletionsApi } = await import(pathToFileURL(aiDir + "/dist/api/openai-completions.lazy.js"));
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const completion = (extra = {}) => ({ type: "done", ok: true, text: "ok", usage: { inputTokens: 10, outputTokens: 2 }, ...extra });
export function sse(list, { eol = "\n", fragment = 0, finalBlank = true } = {}) {
  const encoder = new TextEncoder();
  const raw = list.map(event => "data: " + JSON.stringify(event)).join(eol + eol) + (finalBlank ? eol + eol : "");
  const bytes = encoder.encode(raw); let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + (fragment || bytes.length));
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
export function backend(list, override, time = () => Date.now()) {
  const calls = [], fetch = async (url, init) => {
    init.signal?.throwIfAborted();
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const result = await override?.(call);
    if (result !== undefined) return result;
    if (call.url.endsWith("/turn-ticket")) return json({ ok: true, ticket: "TICKET", ticketId: "T1", runId: "RUN1", expiresAt: new Date(time() + 300000).toISOString() });
    if (call.url.endsWith("/model-call")) return sse(list ?? [completion()]);
    throw new Error("Unexpected request in offline test: " + call.url);
  };
  return { fetch, calls };
}
export const transcript = messages => ai.normalizeContext({ systemPrompt: "Test system prompt", tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }], messages: messages ?? [{ role: "user", content: "Hello" }] });
export async function run(provider, { model = provider.getModels()[0], context = transcript(), ...options } = {}) {
  const stream = provider.streamSimple(model, context, { apiKey: "TOKEN", ...options });
  const events = [];
  for await (const event of stream) events.push(structuredClone(event));
  return { result: await stream.result(), events };
}
