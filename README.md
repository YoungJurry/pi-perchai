# pi-perchai

Perch AI 的实验性 Pi 原生 Provider。**不启动 Perch CLI、不跑本地代理**；只调用账号自身的 Perch 托管推理网关。

> Perch CLI **不是开源软件**。本扩展是独立的互操作实现，不捆绑官方 CLI。
> 官方将这些接口定义为内部端点，第三方直接调用可能被限制或导致账号停用。正确的 User-Agent/请求字段不等于获得了公开 API 权限，更不能证明绕过成功。
> 当前验证：Pi 1.5.0 的离线模拟与真实宿主加载器测试，以及匿名 OAuth 授权入口返回 302。**尚未用真实 Starter 账号完成登录／推理验证**，不要把离线通过当作服务端放行。

## 使用

安装需要 Node ≥22.19 与支持原生 Provider 的 Pi（已测试 Pi 1.5.0）：

```sh
pi install git:github.com/YoungJurry/pi-perchai
```

升级：

```sh
pi update git:github.com/YoungJurry/pi-perchai
```

安装／升级后重启 Pi 或执行 `/reload`。也可以在不安装的情况下试运行本地项目：

```sh
pi -e /tmp/pi-perchai
```

项目本身不会替你写入 `~/.pi/agent/extensions/` 或修改全局设置；安装交给 Pi 包管理器。
不要同时启用其他注册同名 `perch` Provider 的旧草稿。

1. `/login` → **Perch AI** → 选择 Google 或 GitHub。
2. 按 Pi 的提示在浏览器登录。
3. 登录结束后会跳到 `http://127.0.0.1:51121/callback?code=...`；**页面无法连接是正常的**，本扩展不监听本地端口。复制地址栏中的**完整 URL**，粘贴回 Pi 的登录提示。
4. `/model` 搜索 **DeepSeek V4.1 Flash (Starter)**。其他模型按显示名称上的 Starter/Pro 标签选择。
5. `/thinking` 选择支持的思考级别，发一条短消息验证。

凭据只由 Pi 写入其 `auth.json`。不读取／导入／覆盖 Perch CLI 凭据，不共享其轮换 refresh token。退出用 `/logout` → Perch AI。

未登录时 `pi --list-models` 的“可用模型”列表可能不显示 Perch，这是正常的。目录是静态快照，不代表你的账号获准使用其中所有模型；服务端仍决定套餐权限与额度。

## 轻量化边界

- 扩展入口只有一次 `pi.registerProvider(provider)`。
- **零 `pi.on()`，零工具，零额外命令**；不添加提示词、工具声明、UI 组件或每轮事件回调。
- 初始化、查模型及认证状态均不联网；没有模型刷新钩子、自动轮询、文件监听、后台任务或缓存保温。
- 没有子进程、本地监听端口、代理、额外 runtime npm 依赖或全局 fetch/API 覆写。
- 只有选中 Perch 发请求时才创建请求专用 fetch 转换器。消息／工具历史转换、Pi 事件、取消和费用计算复用 Pi 自带 OpenAI adapter，不复制 SDK。
- Perch 的 ticket 缓存只在内存中，最多 16 项，按 token 指纹、Pi session、当前用户回合与 transport 隔离；按需续签，不跨用户消息合并回合。同一标准回合最多 40 次模型调用，超出时提示发送新消息，不用换票重置预算。并发排队使用各自取消信号。
- SDK 层不重复推理重试；Perch 自己的恢复事件继续观察，最终失败交给 Pi。403、429、client_update_required 等报告，不自动换账号、升档或接受收费溢出。

“不使用时无额外回调／后台任务”不代表零内存或绝对零加载成本。

## 目前支持与限制

- 文本、思考流、工具声明／调用／结果、多轮 Pi 工具历史、usage/cache 记账、取消。
- `onPayload`／响应头／原始 Perch 流事件遵循 Pi 的正常请求观测接口，不注册全局钩子。
- **暂不支持图片**。含图片的当前或历史消息明确报错，不偷偷丢图或伪称支持视觉。
- 缺失完成帧、损坏 JSON、未完成工具参数、重启后已输出内容等明确失败，不把半截结果当成功或执行废弃工具调用。
- 不额外调用 Perch 的 Flock、记忆、搜索、文件上传或云代理服务；这些不是接入模型的必要组件。
- 模型名字、option ID、限时活动和价格会变化。官网当前将 Qwen 的 Starter 活动标至 2026-11-20；Crouton 是不保证持续的 preview。没有把 Pro 的 DeepSeek Promo 假装成 Starter 额度。
- Pi 底栏是目录费率估算，不是可提现余额，也不是精确 PT 账单；账号 Usage 页面才是额度真值。部分后端价格与官网公开费率有差别。
- 输出上限采用保守预算，未声称复刻全部官方模型最大输出配置。
- 固定 Perch origin 与已确认的 Supabase 项目，拒绝把账号凭据发到任意 `baseUrl` 覆写地址。测试可通过工厂显式注入 origin/fetch，但正常入口没有这个远端重定向开关。

## 开发测试

需要已安装 Pi 1.5.0 和 Node ≥22.19。测试使用宿主 SDK，不安装另一份依赖。若 Pi 不在标准目录，可设置 `PI_TEST_AI_DIR` 指向该版本的 `@earendil-works/pi-ai` 包。

```sh
npm test
npm run check
```

测试进程禁止真实 fetch 和 socket 连接，不读取账号凭据、不消耗额度。含 native OAuth、ticket 并发／续期／隔离、SSE Unicode/CRLF、多轮工具、错误、取消、Pi 模型集合和真实扩展 loader 测试。

协议证据与未验证项见 [docs/protocol.md](docs/protocol.md)。
