import { createHash, randomUUID } from "node:crypto";
import { createAuth } from "./auth.js";
import { createClient, deadline, bodyText, failure, redact } from "./http.js";
import { ID, ORIGIN, models, effort } from "./models.js";
import { createTickets } from "./tickets.js";
import { bridgeResponse } from "./stream.js";

// The SDK/API is supplied by Pi; only Perch's wire protocol lives here.
export function createPerchProvider({ api, origin = ORIGIN, fetch: fetchImpl, now } = {}) {
  if (!api?.stream || !api?.streamSimple) throw new Error("Pi OpenAI API is required");
  const client = createClient({ origin, fetch: fetchImpl, now });
  const catalog = models(origin), tickets = createTickets(client), transports = new WeakMap();
  function transport(customFetch) {
    if (!customFetch) return client;
    if (!transports.has(customFetch)) transports.set(customFetch, createClient({ origin, fetch: customFetch, now }));
    return transports.get(customFetch);
  }
  function prepare(model, context, options = {}) {
    if (context.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "image"))) {
      throw new Error("Perch image input is not verified by this extension; use a vision provider");
    }
    if (model.baseUrl !== origin) throw new Error("Refusing to send Perch credentials to an overridden endpoint");
    const token = options.apiKey;
    if (!token) throw new Error("Sign in to Perch AI with /login first");
    if (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0 ||
      (options.maxTokens !== undefined && (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0))) {
      throw new Error("Perch output budget must be positive and finite");
    }
    const level = effort(model, options.reasoning ?? options.reasoningEffort ?? "off");
    const wire = transport(options.fetch), timeout = options.timeoutMs ?? 300000;
    const { onPayload, onResponse, onProviderStreamEvent } = options;
    // Created only for a selected Perch call. Never wrap fetch globally.
    async function scopedFetch(url, init) {
      const parent = init.signal && options.signal ? AbortSignal.any([init.signal, options.signal]) : init.signal ?? options.signal;
      const signal = deadline(parent, timeout), secrets = [token];
      try {
        const target = new URL(url);
        if (target.origin !== new URL(origin).origin || !target.pathname.endsWith("/chat/completions")) {
          throw new Error("Unexpected Perch adapter endpoint");
        }
        signal.throwIfAborted();
        const params = JSON.parse(init.body);
        const request = { messages: params.messages, maxTokens: Math.min(model.maxTokens, params.max_tokens ?? model.maxTokens) };
        if (params.tools) request.tools = params.tools;
        if (params.temperature !== undefined) request.temperature = params.temperature;
        if (params.tool_choice) request.toolChoice = params.tool_choice;
        // Perch tickets are per logical user turn, not per five-minute session.
        // Derive the boundary here rather than adding a global turn_start hook.
        const users = params.messages.filter(message => message.role === "user");
        const scope = options.sessionId
          ? options.sessionId + ":" + createHash("sha256").update(JSON.stringify([users.length, users.at(-1)?.content])).digest("hex")
          : randomUUID(); // Stateless SDK calls are separate turns.
        const turn = await tickets(token, scope, signal, wire);
        if (turn) secrets.push(turn.token);
        const payload = { request, runId: turn?.runId ?? randomUUID(), lane: "chat", strictManual: false,
          clientSurface: "cli", manualModelOptionId: model.id,
          roostReasoning: level !== "off", effort: { level, orchestration: false } };
        const replacement = await onPayload?.(payload, model);
        let outgoing = replacement === undefined ? payload : replacement;
        if (outgoing?.request) {
          const limit = outgoing.request.maxTokens;
          if (!Number.isFinite(limit) || limit <= 0) throw new Error("Invalid Perch payload output budget");
          outgoing = { ...outgoing, request: { ...outgoing.request, maxTokens: Math.min(limit, request.maxTokens) } };
        }
        signal.throwIfAborted();
        const response = await wire.request("/api/perch-terminal/model-call", {
          token, signal, body: outgoing,
          headers: { Accept: "text/event-stream", ...options.headers, ...(turn ? { "x-perch-turn-ticket": turn.token } : {}) },
        });
        try {
          await onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
          if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
            const text = await bodyText(response);
            let data; try { data = JSON.parse(text); } catch { data = text; }
            const error = failure(data, response.status, secrets);
            error.headers = Object.fromEntries(response.headers);
            throw error;
          }
          return bridgeResponse(response, model, { onProviderStreamEvent }, signal, secrets);
        } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      } catch (error) {
        if (signal.aborted) throw error;
        // SDKs wrap custom-fetch exceptions as generic "Connection error".
        // An error response preserves Perch status/code/body without global hooks.
        return new Response(JSON.stringify({ error: { message: redact(error.message, secrets), code: error.code } }), {
          status: error.status >= 400 && error.status <= 599 ? error.status : 502,
          headers: { ...error.headers, "Content-Type": "application/json" },
        });
      }
    }
    return { model, context, options: { ...options, maxRetries: 0, fetch: scopedFetch,
      onPayload: undefined, onResponse: undefined, onProviderStreamEvent: undefined } };
  }
  function dispatch(kind, model, context, options) {
    const request = prepare(model, context, options);
    return api[kind](request.model, request.context, request.options);
  }
  return {
    id: ID, name: "Perch AI", baseUrl: origin,
    auth: { oauth: createAuth(client) },
    getModels: () => catalog,
    stream: (model, context, options) => dispatch("stream", model, context, options),
    streamSimple: (model, context, options) => dispatch("streamSimple", model, context, options),
  };
}
