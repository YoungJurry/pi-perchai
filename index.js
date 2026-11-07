import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { createPerchProvider } from "./src/provider.js";

// No hooks, commands, tools, network requests, or credential reads at load time.
export default function perch(pi) {
  pi.registerProvider(createPerchProvider({ api: openAICompletionsApi() }));
}
