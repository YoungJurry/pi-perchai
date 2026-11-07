// Test-process-only firewall, never imported by the extension.
import { Socket } from "node:net";
globalThis.fetch = async () => { throw new Error("Offline test attempted global network access"); };
Socket.prototype.connect = function () { throw new Error("Offline test attempted a socket connection"); };
