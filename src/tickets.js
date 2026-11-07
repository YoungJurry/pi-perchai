import { createHash } from "node:crypto";
import { abortable } from "./http.js";

// Provider-instance-local; bounded; no timers, persistence, or lifecycle hooks.
// A queued caller uses its own signal, so aborting one request cannot cancel another.
export function createTickets(client) {
  const entries = new Map();
  return async function ticket(token, sessionId, signal, transport) {
    signal?.throwIfAborted();
    const key = createHash("sha256").update(token).digest("hex") + ":" + (sessionId ?? "direct");
    let slot = entries.get(key);
    if (!slot || slot.transport !== transport) {
      slot = { tail: Promise.resolve(), current: undefined, transport, calls: 0 };
      if (entries.size >= 16) entries.delete(entries.keys().next().value);
      entries.set(key, slot);
    }
    const operation = slot.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      let current = slot.current;
      if (slot.calls >= 40) throw new Error("Perch standard turn ticket call budget exhausted (40); send a new user message");
      if (!current || current.expires - client.now() <= 30000) {
        const body = current ? { renew: true, ticketId: current.ticketId } : { surface: "cli", profile: "standard" };
        let data;
        try { data = await transport.json("/api/perch-terminal/turn-ticket", { token, signal, body }); }
        catch (error) {
          // The official CLI permits advisory ticket failures. Only follow an
          // explicit server enforced:false response, never infer it from timeout,
          // 401/403/429, missing fields, or an unknown network failure.
          if (error.status >= 500 && error.status <= 599 && error.enforced === false && !signal?.aborted) {
            slot.calls += 1;
            return undefined;
          }
          throw error;
        }
        const expires = Date.parse(data.expiresAt);
        if (!data.ticket || !data.ticketId || !data.runId || !Number.isFinite(expires) || expires <= client.now()) {
          throw new Error("Incomplete or expired Perch turn ticket");
        }
        signal?.throwIfAborted();
        current = { token: data.ticket, ticketId: data.ticketId, runId: data.runId, expires };
        slot.current = current;
      }
      signal?.throwIfAborted();
      slot.calls += 1;
      return current;
    });
    slot.tail = operation.then(() => {}, () => {});
    return abortable(operation, signal);
  };
}
