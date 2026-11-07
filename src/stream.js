import { failure, redact } from "./http.js";

// UTF-8, LF/CRLF, multiline data, comments, and a final unterminated frame.
// Never swallow malformed JSON or accept EOF without Perch's terminal event.
export async function* events(response, signal) {
  if (!response.body) throw new Error("Perch response has no body");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  let buffer = "", data = [], dataSize = 0;
  const parse = () => {
    if (!data.length) return undefined;
    const raw = data.join("\n"); data = []; dataSize = 0;
    if (raw === "[DONE]") return undefined;
    let event; try { event = JSON.parse(raw); } catch { throw new Error("Malformed Perch SSE JSON"); }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") throw new Error("Invalid Perch SSE event");
    return event;
  };
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length + dataSize > 16 * 1024 * 1024) {
        throw new Error("Perch SSE frame exceeds the size limit");
      }
      if (done && buffer) buffer += "\n";
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, ""); buffer = buffer.slice(cut + 1);
        if (!line) { const event = parse(); if (event) yield event; }
        else if (line.startsWith("data:")) { const value = line.slice(5).replace(/^ /, ""); data.push(value); dataSize += value.length; }
      }
      if (done) { const event = parse(); if (event) yield event; return; }
    }
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function usage(raw = {}) {
  const cache = number(raw.cacheReadInputTokens ?? raw.cache_read_input_tokens ?? raw.prompt_tokens_details?.cached_tokens);
  const write = number(raw.cacheCreationInputTokens ?? raw.cache_creation_input_tokens);
  const prompt = raw.prompt_tokens === undefined ? number(raw.inputTokens ?? raw.input_tokens) + cache + write : number(raw.prompt_tokens);
  let output = number(raw.outputTokens ?? raw.completion_tokens ?? raw.output_tokens);
  const reasoning = number(raw.reasoningTokens ?? raw.completion_tokens_details?.reasoning_tokens);
  // Some servers report separate reasoning tokens outside completion_tokens.
  if (reasoning && raw.total_tokens === prompt + output + reasoning) output += reasoning;
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cache, cache_write_tokens: write },
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) };
}

function toolCalls(raw) {
  const ids = new Set();
  return raw.map((call, index) => {
    const id = call.id, name = call.name ?? call.function?.name;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name || ids.has(id) || call.sealed === false) throw new Error("Incomplete or duplicate Perch tool call");
    ids.add(id);
    let args = call.arguments ?? call.function?.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { throw new Error("Perch tool arguments are not valid JSON"); }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Perch tool arguments must be an object");
    return { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  });
}

// Normalize only this provider's wire events. Pi's existing OpenAI adapter owns
// assistant blocks, tool JSON parsing, balanced events, usage costs, and errors.
async function* chunks(response, model, options, signal, secrets) {
  let answer = "", thinking = "", snapshots = [], terminal = false;
  const chunk = (delta, reason = null, extra = {}) => ({
    object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
    model: model.id, choices: [{ index: 0, delta, finish_reason: reason }], ...extra,
  });
  for await (const event of events(response, signal)) {
    signal?.throwIfAborted();
    await options.onProviderStreamEvent?.(event, model);
    signal?.throwIfAborted();
    if (event.type === "answer_delta" || event.type === "reasoning_delta") {
      if (typeof event.text !== "string") throw new Error("Invalid Perch text delta");
      if (event.type === "answer_delta") { answer += event.text; yield chunk({ content: event.text }); }
      else { thinking += event.text; yield chunk({ reasoning_content: event.text }); }
    } else if (event.type === "tool_call_delta" || event.type === "tool_use_end") {
      if (!Array.isArray(event.toolCalls)) throw new Error("Invalid Perch tool snapshot");
      snapshots = event.toolCalls;
    } else if (event.type === "stream_restart") {
      // Pi cannot retract already emitted deltas. Do not silently concatenate
      // abandoned output or let abandoned tool calls execute.
      if (answer || thinking) throw new Error("Perch restarted after emitting output; retry this turn");
      snapshots = [];
    } else if (event.type === "error" || (event.type === "done" && (event.ok === false || event.error))) {
      throw failure(event, undefined, secrets);
    } else if (event.type === "done") {
      if (typeof event.text === "string" && event.text !== answer && event.text.trim() !== answer.trim()) {
        if (!event.text.startsWith(answer)) throw new Error("Perch final answer differs from streamed output");
        yield chunk({ content: event.text.slice(answer.length) }); answer = event.text;
      }
      const calls = toolCalls(event.toolCalls ?? snapshots.filter(call => call.sealed !== false));
      if (!answer && !calls.length) throw new Error("Perch returned an empty response");
      const reason = event.finishReason ?? event.stop_reason ?? "stop";
      const length = ["length", "max_tokens", "max_output_tokens", "incomplete"].includes(reason);
      // Do not execute a tool truncated by the output limit.
      if (calls.length && length) throw new Error("Perch output limit interrupted a tool call");
      if (calls.length) yield chunk({ tool_calls: calls });
      yield chunk({}, calls.length ? "tool_calls" : length ? "length" : "stop", {
        model: event.model ?? model.id, usage: usage(event.usage),
      });
      terminal = true;
      break;
    }
    // retrying/model_call_failed/diagnostic events are nonterminal; Perch may
    // recover internally. They still reach the user's raw-stream observer.
  }
  signal?.throwIfAborted();
  if (!terminal) throw new Error("Perch stream ended without a completion event");
}

export function bridgeResponse(response, model, options, signal, secrets) {
  const iterator = chunks(response, model, options, signal, secrets);
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode("data: " + JSON.stringify(value) + "\n\n"));
      } catch (error) { controller.error(new Error(redact(error.message, secrets))); }
    },
    async cancel() { await iterator.return(); },
  }, { highWaterMark: 0 });
  // onResponse sees the original response, not this local protocol translation.
  return new Response(body, { status: response.status, headers: { "Content-Type": "text/event-stream" } });
}
