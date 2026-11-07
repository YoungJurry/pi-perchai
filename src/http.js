import { ORIGIN, USER_AGENT } from "./models.js";

export function headers(token, extra) {
  const result = new Headers({ "Content-Type": "application/json", "User-Agent": USER_AGENT });
  if (token) result.set("Authorization", "Bearer " + token);
  // Pi passes null to suppress a header. Its per-request overrides stay scoped here.
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === null) result.delete(key); else result.set(key, value);
  }
  return result;
}
export function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function deadline(signal, milliseconds = 15000) {
  const timed = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timed]) : timed;
}
export function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("[redacted]");
  return result.replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [redacted]")
    .replace(/((?:access_token|refresh_token|ticket|code_verifier)\s*["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[redacted]");
}
export function failure(body, status, secrets = []) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const error = new Error("Perch" + (status ? " HTTP " + status : "") + ": " + redact(text, secrets));
  if (status) error.status = status;
  if (body && typeof body === "object") {
    error.code = body.errorCode ?? body.code;
    if (Object.hasOwn(body, "enforced")) error.enforced = body.enforced;
  }
  return error;
}
export async function bodyText(response, limit = 1024 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Perch response exceeds the size limit");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function createClient({ origin = ORIGIN, fetch: fetchImpl, now = Date.now } = {}) {
  async function request(path, { token, signal, headers: extra, body, ...options } = {}) {
    const url = new URL(path, origin);
    if (url.origin !== new URL(origin).origin) throw new Error("Cross-origin Perch request refused");
    signal?.throwIfAborted();
    return (fetchImpl ?? globalThis.fetch)(url, { ...options, method: body === undefined ? "GET" : "POST",
      headers: headers(token, extra), signal, redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function json(path, options = {}) {
    const timeout = options.timeoutMs ?? 30000;
    const signal = deadline(options.signal, timeout);
    try {
      const response = await request(path, { ...options, signal });
      const text = await bodyText(response);
      const secrets = [options.token, options.body?.auth_code, options.body?.code_verifier, options.body?.refresh_token];
      let data; try { data = JSON.parse(text); } catch { throw failure(text, response.status, secrets); }
      if (!response.ok || data?.ok === false) throw failure(data, response.status, secrets);
      return data;
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      if (signal.aborted && signal.reason?.name === "TimeoutError") {
        const error = new Error(`Perch ${path}: request timed out after ${timeout}ms`, { cause });
        error.name = "TimeoutError";
        error.code = "perch_request_timeout";
        throw error;
      }
      throw cause;
    }
  }
  return { origin, request, json, now, fetch: fetchImpl };
}
