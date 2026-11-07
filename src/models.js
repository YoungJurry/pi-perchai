export const ORIGIN = "https://app.perchai.app";
export const ID = "perch";
// Independently confirmed in perchai-cli 2.4.125; not inherited from WorkBuddy.
export const USER_AGENT = "perchai-cli/2.4.125";

// [option ID, label, context, output ceiling, input/output/cache USD per million,
//  Perch effort levels]. Text-only until the gateway image path is live-tested.
const rows = [
  ["openrouter-deepseek-deepseek-v4-1-flash-crusoe", "DeepSeek V4.1 Flash (Starter)", 1048576, 65536, .30, 1.20, .03, ["off", "low", "high", "max"]],
  ["openrouter-z-ai-glm-5-3-flash-crusoe", "GLM 5.3 Flash (Starter)", 1048576, 65536, .15, .50, .05, ["low", "high", "max"]],
  ["openrouter-qwen-qwen3-8-max-0902", "Qwen 3.8 Max (Starter promo / Pro)", 262144, 131072, 2, 6, .25, ["off", "low", "medium", "high"]],
  ["openrouter-stealth-crouton-alpha", "Crouton Alpha (preview; Starter)", 1048576, 131072, 0, 0, 0, ["low", "medium", "high", "xhigh", "max"]],
  ["openrouter-deepseek-deepseek-v4-1-flash-crusoe-pro", "DeepSeek V4.1 Flash 1017 (Pro)", 1048576, 131072, .30, 1.20, .006, ["off", "low", "high", "max"]],
  ["openrouter-deepseek-deepseek-v4-pro-crusoe", "DeepSeek V4 Pro 0813 (Pro)", 1048576, 65536, 1.74, 3.48, .14, ["off", "low", "high", "max"]],
  ["openrouter-z-ai-glm-5-3-crusoe", "GLM 5.3 (Pro)", 1048576, 65536, 1.75, 5.50, .325, ["low", "high", "max"]],
  ["wandb-minimax-m3", "MiniMax M3 (Pro)", 262000, 65536, .29, 1.20, .06, ["off", "high"]],
  ["anthropic-claude-opus-5-5", "Claude Opus 5.5 (Pro)", 1000000, 128000, 4, 20, .20, ["low", "medium", "high", "xhigh", "max"]],
  ["anthropic-claude-sonnet-5-5", "Claude Sonnet 5.5 (Pro)", 1000000, 128000, 2, 10, .20, ["off", "low", "medium", "high", "xhigh", "max"]],
  ["azure-foundry-gpt-6-1-sol", "GPT-6.1 Sol (Pro)", 1050000, 128000, 2, 10, .10, ["off", "low", "medium", "high", "xhigh", "max"]],
  ["azure-foundry-gpt-6-1-terra", "GPT-6.1 Terra (Pro)", 1050000, 128000, 1, 5, .05, ["off", "low", "medium", "high", "xhigh", "max"]],
  ["gemini-gemini-4-argon", "Gemini 4 Argon (Pro)", 1000000, 65536, 4, 20, .20, ["low", "medium", "high"]],
];
const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function effort(model, level = "off") {
  const levels = model.perchEfforts ?? ["off", "low", "medium", "high"];
  if (!order.includes(level)) throw new Error("Unsupported Perch thinking level: " + level);
  // Same upward-first clamping convention as Pi; never advertise an unknown level.
  return levels.find(value => order.indexOf(value) >= order.indexOf(level)) ?? levels.at(-1);
}
export function models(origin = ORIGIN) {
  return rows.map(([id, name, contextWindow, maxTokens, input, output, cacheRead, levels]) => ({
    id, name, contextWindow, maxTokens, provider: ID, api: "openai-completions", baseUrl: origin,
    reasoning: true, input: ["text"], cost: { input, output, cacheRead, cacheWrite: 0 },
    perchEfforts: levels,
    thinkingLevelMap: Object.fromEntries(order.map(level => [level, levels.includes(level) ? level : null])),
    compat: { supportsDeveloperRole: false, supportsStore: false, supportsStrictMode: false,
      supportsReasoningEffort: false, supportsFinishReason: true, maxTokensField: "max_tokens" },
  }));
}
