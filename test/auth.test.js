import test from "node:test";
import assert from "node:assert/strict";
import { createAuth } from "../src/auth.js";
import { createClient } from "../src/http.js";
import { createTickets } from "../src/tickets.js";
import { json } from "./helpers.js";
import { createHash } from "node:crypto";

const supabase = "https://zlfuvsfjtgsdtqcaykia.supabase.co";
function authBackend({ expiresAt, error, cfg = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), body: init.body ? JSON.parse(init.body) : undefined, init }; calls.push(call);
    if (call.url.endsWith("/cli-auth/config")) return json({ ok: true, supabaseUrl: supabase, supabaseAnonKey: "public-key", providers: ["google", "github"], ...cfg });
    if (error) return json(error, 400);
    return json({ access_token: "ACCESS", refresh_token: "REFRESH_NEXT", expires_at: expiresAt ?? Math.floor(Date.now() / 1000) + 3600 });
  };
  const client = createClient({ fetch });
  return { calls, client, auth: createAuth(client) };
}
function interaction(choice = "github", pasted = "http://127.0.0.1:51121/callback?code=CODE", signal) {
  const notices = [], prompts = [];
  return { notices, prompts, signal,
    notify(event) { notices.push(event); },
    async prompt(value) { prompts.push(value); return value.type === "select" ? choice : pasted; },
  };
}

test("native OAuth PKCE/manual callback login; no server or external CLI", async () => {
  const { auth, calls } = authBackend(), ui = interaction();
  const credential = await auth.login(ui);
  assert.equal(credential.type, "oauth"); assert.equal(credential.access, "ACCESS"); assert.equal(credential.refresh, "REFRESH_NEXT");
  assert.equal(credential.origin, "https://app.perchai.app");
  assert.equal(calls.length, 2); assert(calls[1].url.startsWith(supabase + "/auth/v1/token?grant_type=pkce"));
  assert.equal(calls[1].body.auth_code, "CODE");
  const url = new URL(ui.notices[0].url), verifier = calls[1].body.code_verifier;
  assert.equal(url.searchParams.get("provider"), "github"); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(calls[1].init.headers.get("apikey"), "public-key");
  assert.equal(ui.prompts.at(-1).type, "manual_code");
  const requestAuth = await auth.toAuth(credential);
  assert.equal(requestAuth.apiKey, "ACCESS"); assert.equal(calls.length, 2, "toAuth never networks");
});

test("refresh honors rotation and native cancellation", async () => {
  const { auth, calls } = authBackend();
  const credential = { type: "oauth", origin: "https://app.perchai.app", access: "OLD", refresh: "REFRESH_OLD", expires: 1 };
  const result = await auth.refresh(credential, AbortSignal.timeout(1000));
  assert.equal(result.refresh, "REFRESH_NEXT"); assert.equal(credential.refresh, "REFRESH_OLD");
  assert.equal(calls[1].body.refresh_token, "REFRESH_OLD"); assert(calls[1].url.endsWith("grant_type=refresh_token"));
  const signal = AbortSignal.abort();
  await assert.rejects(auth.refresh(credential, signal), { name: "AbortError" });
  assert.equal(calls.length, 2);
});

for (const [label, paste] of [
  ["another host", "https://elsewhere.invalid/callback?code=CODE"],
  ["wrong port", "http://127.0.0.1:2222/callback?code=CODE"],
  ["wrong path", "http://127.0.0.1:51121/x?code=CODE"],
  ["denied", "http://127.0.0.1:51121/callback?error=denied"],
  ["missing code", "http://127.0.0.1:51121/callback"],
  ["bare code", "CODE"],
]) test("reject callback: " + label, async () => {
  const { auth, calls } = authBackend();
  await assert.rejects(auth.login(interaction("google", paste)));
  assert.equal(calls.length, 1, "never exchange an invalid callback");
});

test("untrusted auth configuration never receives a credential", async () => {
  const { auth, calls } = authBackend({ cfg: { supabaseUrl: "https://evil.invalid" } });
  await assert.rejects(auth.login(interaction()), /Unexpected/);
  assert.equal(calls.length, 1);
});

test("auth exchange rejects expired/incomplete responses and masks refresh tokens", async () => {
  await assert.rejects(authBackend({ expiresAt: 1 }).auth.login(interaction()), /Incomplete/);
  const { auth } = authBackend({ error: { error: "REFRESH_OLD failed; refresh_token=REFRESH_OLD" } });
  try { await auth.refresh({ type: "oauth", origin: "https://app.perchai.app", refresh: "REFRESH_OLD" }, AbortSignal.timeout(1000)); assert.fail(); }
  catch (error) { assert(!error.message.includes("REFRESH_OLD")); assert.match(error.message, /redacted/); }
});

test("OAuth select cancellation and manual paste cancellation do not exchange", async () => {
  for (const ui of [{ ...interaction(), prompt: async () => "" }, { ...interaction(), prompt: async () => { throw new Error("cancel"); } }]) {
    const { auth, calls } = authBackend();
    await assert.rejects(auth.login(ui)); assert.equal(calls.length, 1);
  }
});

function ticketsBackend() {
  let now = Date.now(), sequence = 0;
  const calls = [], transport = { async json(path, opts) {
    opts.signal?.throwIfAborted(); calls.push({ path, ...opts });
    return { ok: true, ticket: "ticket-" + (++sequence), ticketId: "id-" + sequence,
      runId: "run-" + sequence, expiresAt: new Date(now + 300000).toISOString() };
  } };
  const get = createTickets({ now: () => now });
  return { get, calls, transport, advance: time => { now += time; } };
}

test("tickets reuse within a turn, preserve call ceiling, and renew before expiry", async () => {
  const { get, calls, transport, advance } = ticketsBackend();
  const first = await get("TOKEN", "s", undefined, transport);
  advance(275000);
  await get("TOKEN", "s", undefined, transport);
  assert.deepEqual(calls[1].body, { renew: true, ticketId: first.ticketId });
  for (let i = 2; i < 40; i++) await get("TOKEN", "s", undefined, transport);
  await assert.rejects(get("TOKEN", "s", undefined, transport), /budget exhausted/);
  assert.equal(calls.length, 2, "never mint a fresh ticket to reset an exhausted turn budget");
  await get("TOKEN", "new-user-turn", undefined, transport);
  assert.deepEqual(calls[2].body, { surface: "cli", profile: "standard" });
});

test("simultaneous calls share a ticket; other account/session/transport gets its own", async () => {
  const { get, calls, transport } = ticketsBackend();
  const result = await Promise.all(Array.from({ length: 5 }, () => get("TOKEN", "s", undefined, transport)));
  assert(result.every(r => r.token === result[0].token)); assert.equal(calls.length, 1);
  await get("OTHER_TOKEN", "s", undefined, transport);
  await get("TOKEN", "other-session", undefined, transport);
  await get("TOKEN", "s", undefined, { ...transport });
  assert.equal(calls.length, 4);
});

test("an expired ticket asks to renew the same turn rather than resetting its budget", async () => {
  const { get, calls, transport, advance } = ticketsBackend();
  const first = await get("TOKEN", "s", undefined, transport); advance(301000);
  await get("TOKEN", "s", undefined, transport);
  assert.deepEqual(calls[1].body, { renew: true, ticketId: first.ticketId });
});

test("ticket errors do not silently send an unticketed model call", async () => {
  const { get } = ticketsBackend();
  await assert.rejects(get("TOKEN", "s", undefined, { json: async () => ({ ticket: "t" }) }), /Incomplete/);
  await assert.rejects(get("TOKEN", "s", undefined, { json: async () => { throw new Error("403 perch_surface_required"); } }), /perch_surface_required/);
});

test("cancelled queued caller returns immediately without cancelling the first caller", async () => {
  const { get, transport } = ticketsBackend();
  let release, started;
  const begin = new Promise(resolve => { started = resolve; });
  const t = { json: async (...args) => { started(); await new Promise(resolve => { release = resolve; }); return transport.json(...args); } };
  const first = get("TOKEN", "s", undefined, t); await begin;
  const controller = new AbortController(), second = get("TOKEN", "s", controller.signal, t);
  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  release(); assert((await first).token);
});
