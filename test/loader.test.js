import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { aiDir } from "./helpers.js";

test("real Pi extension loader: exactly one native provider and zero hooks/tools/commands", async () => {
  const directory = resolve(aiDir, "../pi-coding-agent/dist/core");
  const { loadExtensions } = await import(pathToFileURL(directory + "/extensions/loader.js"));
  const { createEventBus } = await import(pathToFileURL(directory + "/event-bus.js"));
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  const loaded = await loadExtensions([entry], process.cwd(), createEventBus());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.handlers.size, 0); assert.equal(extension.tools.size, 0); assert.equal(extension.commands.size, 0);
  assert.equal(loaded.runtime.pendingProviderRegistrations.length, 0);
  const registrations = loaded.runtime.pendingNativeProviderRegistrations;
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].provider.id, "perch");
  assert.equal(registrations[0].provider.getModels().length, 13);
  // Calling catalog/auth availability does not start a refresh or background job.
  assert.equal(registrations[0].provider.refreshModels, undefined);
});
