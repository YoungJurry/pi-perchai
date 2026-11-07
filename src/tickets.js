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
      slot = { tail: Promise.resolve(), current: undefined, transport };
      if (entries.size >= 16) entries.delete(entries.keys().next().value);
      entries.set(key, slot);
    }
    const operation = slot.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      let current = slot.current;
      if (current?.calls >= 40) throw new Error("Perch standard turn ticket call budget exhausted (40); send a new user message");
      if (!current || current.expires - client.now() <= 30000) {
        const body = current ? { renew: true, ticketId: current.ticketId } : { surface: "cli", profile: "standard" };
        const data = await transport.json("/api/perch-terminal/turn-ticket", { token, signal, body });
        const expires = Date.parse(data.expiresAt);
        if (!data.ticket || !data.ticketId || !data.runId || !Number.isFinite(expires) || expires <= client.now()) {
          throw new Error("Incomplete or expired Perch turn ticket");
        }
        signal?.throwIfAborted();
        current = { token: data.ticket, ticketId: data.ticketId, runId: data.runId,
          expires, calls: current?.calls ?? 0 };
        slot.current = current;
      }
      signal?.throwIfAborted();
      current.calls += 1;
      return current;
    });
    slot.tail = operation.then(() => {}, () => {});
    return abortable(operation, signal);
  };
}
