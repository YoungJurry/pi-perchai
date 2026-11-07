# Perch 协议核对（2026-11-07）

## 证据和来源

- 官方 npm 包 `perchai-cli@2.4.125` 的元数据和 LICENSE 表明它是 **Proprietary**，不是公开源码仓库。本项目不捆绑、不导入、不运行官方 CLI。
- 静态核对文件 `dist/perch.mjs` 的 SHA-256：`cb25c55f0ef9563883828966287f3ed07d60c50f6a5ce3a8723047816039e824`。此文件只用作本地协议核对材料，不在仓库中。
- 公开 MIT 第三方参考 `iuaiti/dsh-provider-perchai`，commit `187fdbc1ed0ca997a31978b67555c9c9404e4c9d`。其 README 同样警告 hosted gateway 的 surface 限制；不能据此断言第三方请求已成功。
- 官方模型／价格文档：https://www.perchai.app/docs/concepts/models
- 官方 API 权限说明：https://www.perchai.app/pricing

本实现按协议独立编写，复用 Pi 自带公开 API；不复制 WorkBuddy 的登录、gzip、账号头或桌面身份字段。测试 mock 只验证本地契约，不代表真实服务放行。

## 最小通路

1. GET `/api/perch-terminal/cli-auth/config`：公开 Supabase 项目配置及提供的登录方式。
2. Supabase PKCE 浏览器 OAuth → callback code → `/auth/v1/token?grant_type=pkce`，JSON 为 `auth_code` 和 `code_verifier`。
3. refresh grant 由 Pi 原生凭据锁管理，不另设刷新定时器或登录态文件。
4. POST `/api/perch-terminal/turn-ticket`，body `{surface:"cli",profile:"standard"}`。本扩展要求响应 `ticket`、`ticketId`、`runId`、`expiresAt` 完整，按需使用 `{renew:true,ticketId}`；续期保留当前回合调用计数，达到标准 profile 的 40 次预算后报错，不另铸 ticket 重置预算。用户回合从当前 transcript 的最近 user 消息／数量指纹推导，工具迭代复用 ticket，新 user 消息必须另开回合，无全局事件钩子。无 sessionId 的独立 SDK 请求各算一个回合。
5. POST `/api/perch-terminal/model-call`：Bearer、`x-perch-turn-ticket`、JSON、SSE Accept；UA 独立固定到所核对的官方 CLI 2.4.125。此 UA 是否必要或被校验仍未验证。

### Envelope 字段追踪

托管 proxy 路径是 `rro` 的 early return → `kYe(t,n,r)` → `aen` → `sen`；`sen` 去掉 `onChunk/onReasoningChunk/onStreamEvent/signal` 后，将剩余对象交给 `KZt.body` 包为 `{request:e}`。

因此 `request` 中保留调用方的 `maxTokens`、`toolChoice`、`messages`、`tools`、`temperature` 原名。**不能将 `rro` 中 early return 后的直连 provider 分支误认为 proxy 路径**：那里才将 `t.maxTokens` 改名为内部 `maxOutputTokens`，随后调用 H6/sYe，未发送到此托管网关。第一次子 agent 审计混淆了两个分支，二次追踪已纠正；本项目保留 `request.maxTokens`。

Envelope 顶层包括 `clientSurface:"cli"`、`manualModelOptionId`、`lane:"chat"`、`strictManual:false`、`roostReasoning` 与 `effort:{level,orchestration:false}`。`Yno` 展示顶层 effort；本扩展将 ticket 返回的 `runId` 用于 model-call，不建立官方 CLI 的 client runId 映射。后者的远端等价性待真实测试。

### 浏览器登录

本扩展直接打开 GoTrue authorize URL，不加 SDK 内部用于取 JSON 后自行跳转的 `skip_http_redirect=true`。使用标准 PKCE `S256`。匿名实测该 URL返回 302 到 GitHub，未完成账号登录或 token exchange。

固定 callback 为 `http://127.0.0.1:51121/callback`，由用户复制地址栏 URL；不创建回调服务器。这与官方随机端口监听器的 UX 不同。最终 OAuth 回调是否被服务端允许仍需用户真实登录测试。

## 省略的组件

`x-perch-call-delta` 与 held-digest/length 是全量消息的增量传输优化。扩展始终发送当前完整 transcript；不实现 digest/chunk-store、relay、记忆、云 agent、Flock、桌面浏览器或 telemetry。

不发送 `promoOverflowAccepted`；不捏造套餐、账号权限、runClass、请求签名或廉价模型的替代身份。

Perch 原始 `answer_delta`／`reasoning_delta` 转为 OpenAI 流，Pi API 接着转换为自己的消息事件。工具快照等待成功 `done` 后才输出，不执行失败／废弃流的工具。`model_call_failed` 可是内部恢复通知，不当成立即最终失败。必须有完成帧，不能只凭 HTTP 200 或流关闭判定成功。

Perch `inputTokens` 是缓存之外的输入；OpenAI `prompt_tokens` 是包含缓存的输入总量。因此归一时适当加上缓存，再由 Pi adapter 扣除，避免缓存重复记账。reasoning 是 output 子集，不重复加算。

## 模型目录与价格

Starter DeepSeek、GLM Flash 和 Crouton 的 option ID 在客户端别名表中已确认。Qwen 的 option ID 已确认，但 Starter 可用性依据官网 2026-11-07 的限时活动说明，而不是宣称本扩展已查到用户账户权限。服务端可能仍拒绝。

上限采用保守预算；未将未声明最大输出的 Starter 卡猜成官方保证的上限。费率主要用官网公开目录；Starter DeepSeek 的 cache rate 使用该 Starter 卡明确标出的 `$0.03/M`。例如 GLM 5.3 的客户端后端报价与官网有差别，底栏估算不应代替账户 PT 账单。

## 验证层级

- 固定 UA、surface 字段是客户端协议兼容信息，**不是已验证的鉴权绕过**。
- 无有效 token 时不同 UA 都是 401，不能推导登录后是否校验版本、surface 或 entitlement。
- 匿名 body wrapper 能走到 401，而无 wrapper 得 400，不说明模型字段已被服务端验证。
- 匿名 OAuth 入口 302、离线 mock 和真实 Pi loader 测试只证明所述层级的行为；**不证明额度、工具和推理的远端可用性**。
- 首次短文本、一次工具调用以及长期 token 刷新仍待真实 Starter 账号验证。若网关返回 surface/client/version/plan 限制，本实现报告失败，不另试规避手段。
