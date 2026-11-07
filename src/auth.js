import { createHash, randomBytes } from "node:crypto";
import { createClient } from "./http.js";

const SUPABASE = "https://zlfuvsfjtgsdtqcaykia.supabase.co";
const CALLBACK = "http://127.0.0.1:51121/callback";
export function createAuth(client) {
  async function config(signal) {
    const data = await client.json("/api/perch-terminal/cli-auth/config", { signal });
    if (data.supabaseUrl?.replace(/\/$/, "") !== SUPABASE || !data.supabaseAnonKey ||
      !Array.isArray(data.providers) || !data.providers.length) throw new Error("Unexpected Perch auth configuration");
    return data;
  }
  async function exchange(cfg, grant, body, signal) {
    const authClient = createClient({ origin: SUPABASE, fetch: client.fetch, now: client.now });
    const data = await authClient.json("/auth/v1/token?grant_type=" + grant, {
      signal, headers: { apikey: cfg.supabaseAnonKey }, body,
    });
    const expires = data.expires_at ? data.expires_at * 1000 : client.now() + data.expires_in * 1000;
    if (typeof data.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token ||
      !Number.isFinite(expires) || expires <= client.now()) throw new Error("Incomplete Perch token response");
    return { type: "oauth", access: data.access_token, refresh: data.refresh_token,
      expires: expires - 60000, origin: client.origin };
  }
  function bound(credential) {
    if (credential.type !== "oauth" || credential.origin !== client.origin) {
      throw new Error("Perch credentials belong to another endpoint or an old draft. Run /login again.");
    }
  }
  return {
    name: "Perch AI", loginLabel: "Sign in to Perch AI (Google / GitHub)", isSubscription: true,
    async login(interaction) {
      const cfg = await config(interaction.signal);
      const provider = await interaction.prompt({ type: "select", message: "Perch sign-in provider",
        options: cfg.providers.map(id => ({ id, label: id === "github" ? "GitHub" : id === "google" ? "Google" : id })) });
      if (!cfg.providers.includes(provider)) throw new Error("Perch login cancelled");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const url = new URL(SUPABASE + "/auth/v1/authorize");
      url.search = new URLSearchParams({ provider, redirect_to: CALLBACK,
        code_challenge: challenge, code_challenge_method: "S256" }).toString();
      interaction.notify({ type: "auth_url", url: url.toString(),
        instructions: "Sign in, then copy the browser's final 127.0.0.1 callback URL. The callback page may not load; that is expected." });
      const pasted = await interaction.prompt({ type: "manual_code",
        message: "Paste the FULL http://127.0.0.1:51121/callback?code=... URL" });
      let callback; try { callback = new URL(pasted.trim()); } catch { throw new Error("Paste the full Perch callback URL"); }
      if (callback.origin !== new URL(CALLBACK).origin || callback.pathname !== "/callback" ||
        callback.username || callback.password) throw new Error("Unexpected Perch callback URL");
      if (callback.searchParams.has("error")) throw new Error("Perch browser sign-in was denied");
      const code = callback.searchParams.get("code");
      if (!code || code.length > 2048) throw new Error("Missing code in Perch callback URL");
      interaction.signal?.throwIfAborted();
      return exchange(cfg, "pkce", { auth_code: code, code_verifier: verifier }, interaction.signal);
    },
    async refresh(credential, signal) {
      bound(credential);
      if (!credential.refresh) throw new Error("Perch refresh token missing. Run /login again.");
      return exchange(await config(signal), "refresh_token", { refresh_token: credential.refresh }, signal);
    },
    async toAuth(credential) {
      bound(credential);
      return { apiKey: credential.access, baseUrl: client.origin };
    },
  };
}
