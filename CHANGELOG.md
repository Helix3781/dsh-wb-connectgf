# Changelog

版本号即 git tag，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.13.21] — 2026-10-23

**修 CN 端点 400 / 11128（渠道校验），并把包改名为 `dsh-wb-connectgf`。**

### 400 / 11128 的真正触发点（实测二分得出）

上游对「不像官方客户端发出的请求」返回 `{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`（提示「请求被拦截，请重新发送」）。在真实网关上做受控矩阵后确认，**触发因素是 system 提示词的内容，不是长度也不是工具**：

| 变量 | 结果 |
|---|---|
| system 提示词长度 | 无关（40 KB 无害填充照样 200） |
| 工具数量 / 体积 | 无关（116 个真实工具、125 KB 请求体照样 200） |
| DSH system 提示词前 42 段 | 200 |
| 第 43 段（客户端界面声明段） | **400** |

该段单独测 400，但它的 8 句**单独测全部 200**；留一法显示**去掉第 1 句或第 2 句即 200** → 触发条件是**两句同时出现**：

1. `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.`
2. `When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.`

即「声明自己在某个客户端界面上」+「消歧 this page/this GUI/this app」。官方客户端从不声明自己的界面。

### 改动

`prepareChatBody()` 里的 `normalizeHarnessOpener()` 换成 `normalizeSystemMessages()`，四条规则全部实测得出：

- harness 身份句 `You are an AI agent powered by DeepSeek Harness.` **不再发出**（删除而非替换，且删掉所有出现，不只是开头的）；
- 首条 system 消息以**官方客户端自己的开场白**开头 —— `cli/product.json` 的 `prompts["cli-agent-prompt"]` 用客户端同款 nunjucks 渲染出的逐字节真值（`You are CodeBuddy Code.` 后**没有空行**，`{%-`/`-%}` 吃掉了模板换行）。原先那句 `This conversation is powered by WorkBuddy` 不是官方客户端的句子，已删除；
- 删掉第三方「客户端界面声明」句（`removeClientSurfaceClaims()`）；
- system 内容一律拍平成单个字符串（官方客户端就发字符串；数组形态是它不会发的形状，CN 网关也拒）。

顺带修掉移植时暴露的两个真实缺陷：首段不含身份句时**整段被丢弃**（现在保留）；`prepareChatBody()` 跑两次会把官方开头**重复一遍**（现在幂等，国际路径的第二次调用不再重复）。

**代价**：模型不再知道「this page」指本界面（那段界面说明被整句删掉）。这是取舍，不是零成本修复。

### 改名

包从 `dsh-workbuddy-connect-functy` 改名为 **`dsh-wb-connectgf`**，分发源归本仓库（`Helix3781/dsh-wb-connectgf`）。按「改名三连带」同步了客户端 bundle 注册 id、`cordis.patch.yml` 的 `name:`、状态路由前缀 `/plugins/dsh-wb-connectgf/*`。**装到已有 profile 时要同步改 `cordis.patch.yml` 里手写的 `name:`，否则会撞重复注册。** 状态文件（`.workbuddy-accounts.json` 等）不含包名，改名不丢已登录账号。

## [0.13.20] — 2026-10-21

**修 issue #4：CN 端点拒绝 `reasoning_effort: "off"`（400 / 11133）。**

`dropUnsupportedEffort()` 原来只被 `prepareInternationalChatBody()` 调用，CN 分支把 body 原样透传 —— 注释里写着「CN 端点至今接受这个拼写」。issue #4 在 `deepseek-v4.1-flash` 上测出了反面：该行声明 `canDisableThinking: true`，适配器因此把 `thinkingLevelMap.off` 钉成 `"off"`，pi-ai 在任何未指定推理强度的请求上都会发它，CN 端点回 400 / 11133「模型无法处理此请求，请重试」。

最直接的受害者是 `@deepseek-ai/dsh-experimental-auto-review`：审查请求只带 `temperature` 和 provider/model，不带 effort，于是**每个工具调用都被拦在 body 执行之前**。同一会话换到 `glm-5.3-flash`（不钉 `off`）立刻恢复，把问题锁定在「effort 字面量 × 模型 × 区域」的组合上。

### 改动

新增 `prepareCnChatBody()`：共享的 `prepareChatBody()`（含 0.13.19 的 harness 开场句替换）之后再走 `dropUnsupportedEffort()`。`chatStream()` 的 CN 分支改用它。

两个区域现在共享同一条规则。没有采用 issue 建议的「只对拒收的行删字段」：一份 `off` 容忍名单会在新模型上线时过期，而它的失效方式是**某个模型悄悄坏掉**，不是统一省略一个可选字段。

CN 仍然不补 system 首条消息 —— 那是国际端点的要求，CN 接受以 user 消息开头的 body，补上去只会平白改变模型看到的内容。

### 关于 issue 里的另一个建议

issue 提到「CN 上 `reasoning_effort: "none"` 是可接受的，可以映射成 none」。没有采纳：国际侧 `gpt-6-astra` 拒绝 `none`，跨区域统一成「省略」更稳，且省略是唯一在每个模型上都测通的形态。

### 验证

`typecheck` / `test`（66 文件 / 896 用例）/ `build` / `test:engine` 全绿。

新增 5 例 `prepareCnChatBody` 单测（`off` 被删、声明值与非 off 的 `none` 保留、early-return 路径也删、不补 system、仍做开场句替换），2 例出网断言（CN 分支真的不带 `reasoning_effort: off`；显式 `high` 保留且不插 system）。同时把一条旧断言反转：原测试写死「CN 保留 `off`」，那正是本次要修的行为。
## [0.13.19] — 2026-10-21

**`0.13.19-alpha.0` + `0.13.19-alpha.1` 合并为正式版，并把风险写进 README。** 两个 alpha 的内容不重复，见下方两条历史条目；本条目只记正式化时新增的部分。

### README 新增风险提示（中英同步）

顶部风险框 + 「已知限制」补两条 + 「免责声明」补四条，说的是同一件事，但面向不同读者的阅读位置：

- 2026-10-20 起网关启用第三方客户端渠道校验，典型报错 `400 / 11128`；
- 校验维度在增加：系统提示词开头固定句、`X-Conversation-*` 三件套、`acp-connection-id`、`X-No-*` 的用法 —— 历史上已因后两者各被拦过一次；
- **账号风险有实例**：本轮排查中一个 CN 账号 refresh token 被吊销（`invalid_grant: User disabled`），另一个被判「账号存在异常行为，已被限制使用」（`403 / 11140`）；
- 上游 2026-10-20 停止维护、明确不再适配此类校验，仓库计划 10-22 下线；本仓库是独立分支仍在维护，但不承诺可用性期限；
- 明确声明**不做风控规避**（不改 IP、不伪造设备指纹、不做批量注册），因此上游若加新维度（设备、频率、签名），本插件不会尝试绕过。

### 关于 PR #6

`Helix3781/dsh-wb-connectgf#6`（外部提交）主张「改请求头修复 11128」。已在 PR 下给出对照数据说明归因不成立：同一套请求头、只换 body 开场句即可从 400 变 200，唯一变量是 body。该 PR 目前 `mergeable: false (dirty)`，未合并。
## [0.13.19-alpha.1] — 2026-10-21

**修 11128 的真正成因：system prompt 开头那句 DSH 身份句。** 上一版（`0.13.19-alpha.0`）把同一条报错当成身份头问题去修，方向错了 —— 上游 PR #202 / #204 与实测都指向请求体内容。

### 实测（2026-10-21，CN 网关 `copilot.tencent.com`）

| system 首条消息 | 结果 |
|---|---|
| 以 `You are an AI agent powered by DeepSeek Harness.` 开头（字符串） | **400 / 11128** |
| 同上，但为数组形态 `content` 的 `text` 部件 | **400 / 11128** |
| 换成 `This conversation is powered by WorkBuddy.` | 200 |
| 普通 system（`You are a helpful assistant.`） | 200（该账号随后被风控，见下） |

对照组证明：**拦截只认 body 内容，与请求头无关** —— 带全套官方头、只把开场句换掉的请求就能通过。上一版补的 `acp-connection-id` 等头对这条判定不起作用。

### 改动

`prepareChatBody()` 增加 `normalizeHarnessOpener()`：

- 把 `system` / `developer` 消息**开头**的 DSH 身份句换成官方开场句；
- 官方开场句不是编的：`resources/plugins/workbuddy-builtin/welcomemode/{code,work,design}/prompt.tpl` 首行都是 `This conversation is powered by {{ productName }}`，`productName` 在 `cli/product.json` 里是 `WorkBuddy`。所以替换后发出去的是**官方客户端真的会发的那句话**，不是中性替身；
- 锚定在消息开头（容忍前导空白与 BOM）：实测同一句出现在句中/后面时网关接受，所以不越界改写用户自己的提示词；
- 同时覆盖字符串 content 与数组形态的 `text` 部件 —— 只改字符串会漏掉一半请求（上游 PR #204 相对 #202 的关键差异）；
- 长会话里每条 system 消息都改（只改第一条实测仍 400）；
- 幂等：替换后的句子不含原句，国际版路径二次调用不会叠加。

### 与上一版的关系

`alpha.0` 的头对齐（`acp-connection-id`、去掉 `X-No-*`、id 拼写、`channel_check` 分类与重发）**保留** —— 那些是「更像官方客户端」的正确方向，只是**不是这条报错的原因**。上一版的 CHANGELOG 把因果说错了，这里更正。

### 验证

`typecheck` / `test`（66 文件 / 889 用例）/ `build` / `test:engine` 全绿。新增 `tests/prepare.spec.ts` 的 7 例：句首替换、数组 content、多条 system、user 消息不受影响、句中不越界、幂等、前导空白。

真实上游：改写后发出的开场句为 `This conversation is powered by WorkBuddy.`，国际网关 200 正常流式。CN 侧因两个账号本轮均已失效（一个 token 被吊销、一个被判定异常行为限制），未能完成对照。
## [0.13.19-alpha.0] — 2026-10-21

> **预发布，非正式版。** 发在 npm 的 `alpha` dist-tag 上（`--tag alpha`），`latest` 仍是 0.13.18。安装需显式写版本或 tag：`dsh-wb-connectgf@alpha`。
>
> 这批改动动的是**请求身份本身**（新头、换 id 拼写），失败模式是「上游换个方式拒绝」，因此先走预发布观察一轮再考虑并入正式线。分支：`alpha`。
>
> **注意：本版没有修掉 11128。** 当时把成因判断成请求头，方向错了；真正的成因见 `0.13.19-alpha.1`。

**修「渠道校验」被拒（`400 / 11128 / Illegal API invocation from an unapproved channel`）。** 起因是一轮真实失败：上游回 `displayTips`「This call failed channel verification, possibly because it was not sent from an official client」，界面显示的却是被截断的裸 JSON。解包 `WorkBuddy.app` 逐头比对后，问题分四层，四个都修了。

### 1. 缺 `acp-connection-id`（最像硬伤的一项）

官方网关代理 `main/server.js` 的 `applyGatewayHeaders` 对**每一次** chat 请求都设 `acp-connection-id`，值来自会话账本（`VlmSessionLedger` 的 per-session metadata）。插件从来没发过这个头 —— 是唯一一个「官方必发、插件完全缺席」的头，而失败的判定词恰好是 channel verification。

现在按会话生成并稳定：`ChatChannel.acpConnectionId`，一次会话不换，被拒后换新的。**诚实记一句**：官方那个值是 `/connect` 握手换来的服务端签发值，这里是本地生成的声明值 —— 比缺席强，但要做到字面一致得先做 ACP 握手，那是传输层改动，不在本版。

### 2. 多发了官方从不发的 `X-No-*` 族

`X-No-User-Id` / `X-No-Enterprise-Id` / `X-No-Department-Info` 在官方包里**只出现在 `/v2/auth/state`**，且值是字符串 `"true"`。插件原来在 chat 上用 `"1"`，而本机两个 CN 账号都没有 `enterpriseId`，于是**每次 chat 都带 `X-No-Enterprise-Id: 1`**。缺一个头是信息不全，多一个官方不会发的头是主动说假话。现在没有值就不发。

### 3. 三个 id 的拼写与官方不一致

官方不是一套 UUID 用到底（`cli/dist/codebuddy-lite-wb.mjs`）：

| id | 官方 | 插件（旧） | 插件（现在） |
|---|---|---|---|
| `X-Conversation-ID` | `crypto.randomUUID()`，带横线 | 带横线 ✅ | 带横线 |
| `X-Conversation-Request-ID` | `.replace(/-/g,'')`，32 位 hex | 带横线 ❌ | 32 位 hex |
| `X-Conversation-Message-ID` | **UUIDv7** `.replace(/-/g,'')` | 随机 UUID 带横线 ❌ | UUIDv7 32 位 hex |
| `X-Root-Request-ID` | **仅在** fork/subagent 时发 | 每轮无条件发 ❌ | 不发 |

`uuidv7Hex()` 是新的：前 48 位是毫秒时间戳，所以 id 按到达时间可排序 —— 这正是随机 UUID 模仿不了、而按会话分桶的网关看得见的东西。

### 4. 被拒一次就打死整轮（行为侧）

`11128` 落进 `classifyUpstreamError` 的兜底 `client` 类，而 `client` 不在 `isAccountScoped` 里，于是 `rotation.ts` 直接返回、一次都不重试 —— 可上游自己的 `displayMsg` 写的正是「请重新发送」。

新增失败类 `channel_check`：只认渠道校验的措辞（`unapproved channel` / `channel verification` / `not sent from an official client` / `没通过渠道校验`），**不认单独的 11128**（同码在 CN 是 developer role、国际是缺 system，那两个本仓库在 body 层已修）。该类：

- 换一个全新会话（`WorkBuddyChatChannels.reset`）后**在原账号上重发一次**；第二次仍被拒即终局，不消耗其他账号（换号必然同样被拒）；
- 不给账号上 bench、不标 session_dead —— 账号和凭证都是好的，把它踢出轮换是错的。

### 5. 截断的 body 让用户看不到真正的原因

`ERROR_BODY_LIMIT` 原为 4096，而这类答复带三语 `displayMsg` + `displayTips` + `requestId`，超长后被截成半截 JSON → `extractDisplayErrorMessage` 解析失败 → 退化成 400 字符裸片段，恰好把「请重新发送」那句切掉了。

- 上限提到 64 KiB；
- 解析失败时新增窄兜底 `readJsonStringField`：按字段名取**完整闭合**的 JSON 字符串字面量，值被切断就返回 undefined 而不是半句话。

### 验证

`typecheck` / `test`（66 文件 / 881 用例）/ `build` / `test:engine` 全绿。新增回归：渠道类识别（含「11128 本身不算」的反向断言）、截断 body 的取词与「不返回半个值」、id 拼写与 UUIDv7 可排序性、`X-No-*` 缺席、`acp-connection-id` 跨轮稳定、被拒后重发一次且不 bench 不换号。
## [0.13.18] — 2026-10-20

### 请求身份按官方桌面端逐项补齐（只为少被限流，不改行为）

起因是一条排查：插件侧频繁 `429 soft_rate`，同一时刻官方客户端却能正常发言。查下来真正的报错是本地合成的（池子被 bench 时 `noAccountResult` 直接回 429，一次上游请求都没发），但也确实存在「插件的请求在网关眼里不像官方客户端」这一层。本版修的就是这一层。

对齐依据不是猜测，是从装着的 `WorkBuddy.app` 包里读出来的：CLI 的 `buildConversationHeaders` / 请求头组装，以及桌面端网关代理 `applyGatewayHeaders`（文件 `main/daemon-bootstrap.js`）。

- **会话头改成三层生命周期**（新增 `src/chat-channel.ts`）。官方注释写得很直白：「一次会话内必须稳定，现生成会把同一次桌面操作的几十次调用在网关侧拆成几十个会话」。原来三个 UUID 每请求全新，一轮 DSH 对话（agent 循环 + 工具调用 + 标题生成）在网关侧就是十几次「新会话」。现在：`X-Conversation-ID` 一次会话稳定（空闲 30 分钟换）、`X-Conversation-Request-ID` 一轮稳定（10 分钟换）、`X-Conversation-Message-ID` 每请求新；并按账号隔离，两个账号不共用会话。同时补上官方也发的 `X-Request-ID`（= message id）与 `X-Root-Request-ID`。
- **补上归属族**：`X-Agent-Intent: craft`、`X-Agent-Purpose: conversation`、`X-Agent-Type: main`、`x-codebuddy-request: 1`、`X-Private-Data: true`。官方每次 chat 都带，缺一项就不再像那个客户端。
- **补上 trace 三件套**：`traceparent`（W3C）、`b3` + `X-B3-*`（B3）、`X-Trace-ID` 共享同一个 traceId —— 官方代理的注释说明三套各生成一个等于没有 trace。
- **chat 不再带 `Origin`/`Referer`**：原来是 `Origin: https://www.codebuddy.cn` 去打 `copilot.tencent.com`，跨源浏览器语义，原生客户端不发。refresh / catalog / billing 保留这两个头，因为它们确实是控制台的请求。chat 的 `X-Tenant-Id` 在有企业身份时一并补上（与 `billingHeaders` 同一拼写）。
- **fallback 版本号跟着真实安装走**：CN 5.5.6 → 5.6.2，国际 5.5.2 → 5.7.6（读的是本机装的两个 App）。只在 bundle 读不到时才用，但那时报一个早已停发的版本号是唯一会错在 wire 上的东西。
- **国际服 chat UA 的产品 token 改回 `WorkBuddy`**。原来写的是 `WorkBuddy/<v> WorkBuddy AI/<v> CLI/<v>`，理由是「token 指该区域的应用」。从包里读出来不是这样：`WorkBuddy.app` 与 `WorkBuddy AI.app` 的网关代理**都**硬编码 `[`WorkBuddy/${v}`, `WorkBuddy/${v}`, CLI/…]`；`WorkBuddy AI` 只出现在 `product.json`、窗口标题和**目录**请求的 `WorkBuddyAI/<v>` 里，不在 chat 上。2026-10-20 实测（`deepseek-v4.1-flash`，两写法各 10 次交替）：6/10 vs 7/10 接受率，拒绝全是 `429/14003「模型繁忙」`——**没有任何可测差异**。所以空格写法既没换来配额，又声明了一个官方不发的形状，改回原样。区域现在只决定版本号、`X-Domain` 和 URL，不再决定产品 token。
  - 注意 `chatUserAgent` 的签名因此去掉 `region` 参数：留着一个不再影响结果的参数，下一个改它的人会以为它有用。
  - 顺手记下：`14003` 是官方错误码表里的 `RateLimitError`（容量），不是 `14001 UsageLimitExceeded`（额度）。所以国际服那些 429 是**服务端满负荷**，改请求头改不掉。

测试侧：新增 `tests/chat-channel.spec.ts`（7 例，覆盖会话/轮/请求三层生命周期、账号隔离、边界时刻、clear、表容量上限）；`tests/chat-identity-wire.spec.ts` 新增归属族与通道断言、refresh 反向断言（归属族是 chat-only），并把版本断言改成对着常量断言而不是字面量。

## [0.13.17] — 2026-10-20
### 支持的 DSH 版本：**只有 `0.2.1-rc.x`**

本版 `peerDependencies` 收窄为 `^0.2.1-rc.1` + `@earendil-works/pi-ai ^1.1.0`。**安装在 `0.1.7-alpha.x` 或 `0.2.0-rc.x` 上会被包管理器拒绝**，这是有意的：

| DSH 线 | 其 `dsh-llm-pi-ai` 依赖的 pi-ai |
|---|---|
| `0.1.7-alpha` | `^0.85.1` |
| `0.2.0-rc` | `^0.87.1` |
| `0.2.1-rc` | `^1.1.0` ← 本版锁定这一代 |

本插件把 pi-ai 作为真实依赖锁在 `1.1.0`，并把模型对象交给宿主的 `PiAiAdapter`。在 0.85/0.87 的宿主上，同一进程会存在两代 pi-ai，**第一个请求在发出 HTTP 之前就以 `PI_AI_ERROR` 失败**（0.13.12 修的就是这个）。所以旧线不是「未测试」，而是**装上也发不出消息**，peer range 如实说这件事。

（`src/supported-hosts.ts` 里 `UNSUPPORTED_HOSTS` 以数据形式记录了这两条线及原因，`tests/supported-hosts.spec.ts` 钉住它。）


> **此次更新跨度较大，并未经过充分测试，更新后可能出现显示问题以及其他更严重的问题。**
>
> 建议升级前备份 `~/.dsh`（尤其是 `.workbuddy-*.json` 状态文件与 `profiles/<profile>/cordis.patch.yml`），出问题时便于回退。


### 1. 限流状态直接显示剩余时间

账号行的状态 chip 原来写「限流中」，现在写「4 小时」（数字与单位间有空格）。原因（额度耗尽）保留并与时间并列：「额度耗尽 · 2 小时」——那一个词决定用户是等待还是换号，只给时间就丢了这层信息。

同时删掉灰字里重复的倒计时：之前同一个行里既写「限流中 · 7 分钟后重试」，灰字又写「7 分钟后恢复」。现在等待时间只在 chip 里出现一次；灰字只保留**额度周期重置**（`creditsResetAtMs`），那是另一件事——bench 解除后它仍在。

### 2. 改设置为什么慢（写入其实一直失败）

实测出来两件事，其中一件是真 bug：

- **写入返回 `state: failed`**：`Configuration for "llm-workbuddy" is overridden by a home patch or command-line overlay`。宿主 `config-editor` 在写入前会把结果与 profile 的 patch 层比对，而本机 `cordis.patch.yml` 给 `llm-workbuddy` 写了 `config:`（`probeControlVisible` / `sidebarCreditVisible`），于是每次 `forms.update` 都被拒。这是 profile 配置问题，不是代码问题 —— 要改的是把这两个字段从 patch 里删掉，或接受 patch 覆盖即写不进。
- **界面仍要等**：旧实现在写之后 `await readAll()`，即两版状态路由各读一遍；实测 CN 0.35s、国际版 **1.3s**，且每个账号可能触发一次 billing。

改动：
- 写入改为**先画后确认**：点击瞬间把该开关的值放到本地（`writtenPreferences`），失败则回滚并显示原值；成功则保留，等页面自己的分钟轮询校正。
- 写入成功后**不再 `readAll()`**：这次写只改了一个布尔/枚举，其余事实没有变化；侧栏仍收到 `refreshPanel()`（那是用户正看着的地方）。
- 不再置 `busy`：开关不会因为一次重读而自我禁用，重复点击幂等。

### 3. 侧栏卡片关闭状态下仍闪现一下

根因：首帧快照为空，所有偏好回落到默认值，而 `sidebarCreditVisible` 的默认是 `true`，于是**关掉的卡片先被画出来**，等真实文档到达再消失。

修法：视图新增 `preferencesSettled`（= `fetchedAt > 0`，即至少完成过一次轮询）。侧栏卡片与输入框徽标都先看这个标志——「还没问过」不画，而不是先猜一个默认值再当众纠正。轮询本身照常启动（gate 只影响画什么），一轮失败也仍算 settled，所以宿主挂掉时卡片还在、仪表盘仍可达。

### 4. 多版本支持（当前从 Desktop 的 0.2.1-rc.2 起）

新增两个模块，把「能不能装」和「能不能跑」分开：

- `src/supported-hosts.ts`：支持矩阵（0.2.1-rc / 0.2.0-rc / 0.1.7-alpha 三行，每行记录对应的 pi-ai 代次与验证程度），并**由矩阵派生** peer range。测试把行与 `package.json` 的 peerDependencies 按集合比对，防止出现「表里加了、manifest 不认」这类上游踩过的坑（peer 钉死单个 prerelease 导致下一个版本装不上）。
- `src/host-capabilities.ts`：运行期结构探测 —— 设置服务是 `configure`/`update` 还是旧的 `installSection`、`fs` 是否带 `processPathFromHostPath`。全部按宿主实际给的对象判断，不比对版本字符串；方法绑回原对象（0.2.x 实现依赖 `this`）。半残服务（只有 configure 没有 update）判为不可写，避免装出一个存不下的表单。
- `index.ts` 的设置注入与图片路径翻译改用这两个探测。

诚实说明：目前**只有 0.2.1-rc.2 一条线经过完整验证**（typecheck / 844+ 用例 / engine load / 两条状态路由 / 设置写入）。0.2.0-rc 与 0.1.7-alpha 是结构兼容（同代 API 形状），未另做构建验证——矩阵里逐行写明，不假装跑过。

### 5. 自动签到

按 `linguo2625469/workbuddy2api-panel` 验证过的线上行为实现（路径、请求头、拒绝标记都取自该实现）：

- `src/checkin.ts`：`POST {billingBase}/v2/billing/meter/daily-checkin`（国际版先试无 `/v2` 前缀，404 再换），空 body `{}`，带 `X-User-Id` / `X-Enterprise-Id` / `X-Tenant-Id` / `X-Domain`。三种结局分开：`checked-in` / `already` / `failed`。「已签到」是**成功**而不是错误——否则第一次之后每次都像失败。仅 5xx 与传输失败重试（2s、4s 两次），4xx 与业务拒绝不重试。
- `src/checkin-store.ts`：每变体一份记录（`.workbuddy-checkin.json` / `.workbuddy-ai-checkin.json`），按本地日 `YYYY-MM-DD` 判定「今天签过没有」。记录不做成布尔值：日期才是那个问题的答案，也扛得住改时区。
- `src/checkin-service.ts`：每 15 分钟唤醒一次，唤醒本身零成本，直到本地日翻页才真的发请求。跳过停用与登录失效的账号；失败只警告，**不 bench 账号、不动登录态**——签到是赠品，不是用户请求的请求。手动 `checkOne` 不受记录限制。
- 接线：`checkinAuto` 偏好（**默认关**，因为它会替用户花一次请求）、路由动作 `check-in` / `set-checkin-auto`、状态文档新增 `checkin` 段（每账号：记录日 + 上次结果）、设置页新增「每日签到」分组（一个开关 + 每账号一行 + 「立即签到」）。

### 验证

- `pnpm run typecheck` / `pnpm run test`（**63 文件 / 850 用例**）/ `pnpm run build` / `pnpm run test:engine` 全绿。
- 新增 6 个测试文件：`supported-hosts`、`host-capabilities`、`checkin`、`checkin-store`、`checkin-service`，以及 settings-page / probe-route 里的签到与乐观写回归。
- 顺带：`0.13.15` 的依赖代次跟随（`0.2.1-rc.2` + pi-ai `1.1.0`）在本版继续保持，peer 由矩阵派生为三线并集。
## [0.13.15] — 2026-10-19

**修 issue #3：暂时为空的账号池被报成 401 session_dead**，宿主据此判 AUTH 并显示「API 密钥无效 / 未登录」，而 token 完全有效、账号一分钟后自愈。

根因在 `src/rotation.ts` 的 `noAccountResult()`：它把「池子里现在没人可用」一律映射成 `kind: session_dead` + `status: 0`，而 `KIND_STATUS.session_dead = 401`，shim 于是回 401 `not_signed_in` —— 宿主的 `classifyPiAiError` 把它归为不可重试的 AUTH。

issue 里的建议改法是「一律 429 + Retry-After: 60」。那会把反向的误判带上：池子真的为空、或所有账号被用户停用/登录失效时，那是**登录问题**，应当请用户去登录，而不是让宿主无限重试。所以按「池子为什么空」分类：

- **有成员能自己回来**（被限流 bench，`cooldown.untilMs` 在未来）→ `soft_rate` / 429，`Retry-After` 取**最早**回来的那个账号的剩余秒数（不是写死 60），宿主于是启动自己的退避重试。
- **能自己回来的成员全是额度耗尽**（`cooldown.reason === 'credit'`）→ `hard_credit` / 402：同样自愈，但一秒后重试只会再吃一次拒绝，交还给让用户换账号/等额度。
- **没有成员能自己回来**（池为空 / 全被停用 / 全 session_dead）→ 仍是 `session_dead` / 401，并且文案分开：空池说「未登录，请登录一次或添加账号」，全被禁用说「N 个账号均已停用或登录失效，请重新启用或登录」。

同时修掉一处会误导排查的输出：`status: 0` 表示**根本没有发上游请求**，旧代码仍在错误文案里拼 `(http 0)`，读起来像一个真实但奇怪的上游状态。现在 0 不再带状态注记。

新增回归（共 7 例）：
- `tests/rotation.spec.ts`：限流池 → `soft_rate` 且 `Retry-After` 有界、额度池 → `hard_credit`、全停用 → `session_dead` 且无 `Retry-After`、空池 → 登录提示；并镜像宿主的 `\b(?:401|403)\b` 启发式，断言合成的错误文案不会踩中它。
- `tests/shim.spec.ts`：把三类合成失败真的走一遍 HTTP，断言状态码 429 / 402 / 401、`Retry-After` 头的存在与缺失、以及文案里不再出现 `http 0`。

顺带跟随宿主代次（上一版遗留）：`devDependencies` 的 `@deepseek-ai/dsh-*` 全部升到 `0.2.1-rc.2`、`@earendil-works/pi-ai` 升到 `1.1.0`（与 DSH `0.2.1-rc.2` 宿主同代）、`cordis ^4.0.5` / `cosmokit 1.8.6` / `schemastery ^3.18.5`；`pi-ai-guard` 的期望版本同步为 `1.1.0`。装到本机 Desktop profile 后实际加载为 `0.13.14` 时已验证路由可用，本版在此基础上继续。
## [0.13.14] — 2026-10-18

**同步上游 0.7.8 / 重写设置页账号区。** 上游差异是逐条对着上游 commit 在本地源码里核过的，只补本仓库真正缺的部分（其余早在此前的 cherry-pick 里就有）。

### 同步上游（本仓库此前缺的）

- **DSH 0.2.1-rc.2 支持**：peer range 从 `^0.1.7-alpha.1 || ^0.2.0-rc.1` 放宽成再并上 `^0.2.1-rc.1`。上游在 0.7.7/0.7.8 里把 peer 钉死成 `0.2.1-rc.2`（等于放弃旧线），本仓库保留并集 —— 与 0.13.1 的双线策略一致。
- **`@deepseek-ai/dsh-atomic-write` 改为打进产物**（`tsdown.config.ts` 的 `alwaysBundle`），并从 peer 列表移除。桌面运行时只在 `app.asar` 内部引用这个包、不保证把它暴露在插件的解析路径上：本机实测 `require.resolve` 从这里返回 `MODULE_NOT_FOUND`，装好的插件 `lib/account-cli-*.js` 一 import 就整块加载失败（上游 0.7.6 正是这么炸的）。打包后 `node --input-type=module -e "import('./lib/index.js')"` 通过。
- **`X-Conversation-*` 三件头**（上游 #139）：国际网关 2026-10-16 起对不带该族的 `/v2/chat/completions` 直接回 400 / 11128。每个请求现生成三个 UUID；CN 网关实测接受同样的头，所以两版都带，不分支。
- **CN 目录请求补企业身份头**（上游 #123）：`/v3/config` 按账号身份分发名册，企业账号缺 `X-User-Id` + `X-Enterprise-Id` 会被静默返回个人名册（少一个模型）。只有当凭证两半都在时才发，国际端点保持原样。
- **显示名去重**（上游 a7318d1）：CN 文档把 `hy3` 与 `hy3-x` 都叫 "Hy3"，两条价格不同的行在选择器里无法区分。解析后按 id 尾部补后缀（`hy3-x` → "Hy3-X"），id 不动。
- **`reg.exe` 诊断按字节判定**（上游 3f5fbd9）：中文 Windows 上 `reg query` 的 stderr 是 cp936，按 UTF-8 解码得到的乱码匹配不上任何诊断，导致每个不存在的根都报「发现不完整」。改为先 UTF-8 再 GBK 解码，并把 `execFile` 的 `encoding` 设为 `buffer`。
- **网关端口避开 fetch 黑名单**（上游 2bdeb0f）：`listen(0)` 可能拿到 fetch 标准禁止的端口，pi-ai 的每个请求都会以 `TypeError: fetch failed` 失败，而监听器看起来是好的。`src/loopback.ts` 新增 `FETCH_BLOCKED_PORTS` / `bindToUsablePort`，shim 改用它。

### 设置页账号区重写

- **同一产品的账号合并进一张卡片**（原来一个账号一张卡）：卡片头是产品名、`ready/total 可用` 和该池的合计额度；下面每账号一行。
- **删掉展开交互**：账号行的所有数字直接显示在名字下方的灰色小字里 —— 剩余 / 上限、已用、请求数、输入/输出 token、缓存命中率、恢复时间（或令牌过期时间）。以前这些都在折叠区里，等于把「打开这个页面的理由」藏起来。
- **决策类操作留在 ⋮ 菜单**（启用/停用、测试、重命名、删除），重命名与删除仍是行内表单/确认条，不用浏览器对话框。
- **数据侧补齐 `creditsResetAtMs`**：`CreditEntry` 以前根本没收上游的 `used`（`creditsUsed` 字段一直是死字段），也不读 `cycleResetTime`。现在两者都进快照，账号行才有「已用」「x 小时后恢复」可显示。
- **改用平台原子件**：状态点走 `StateDot`，标签走 `Tag`（本地那套四色胶囊删除），分段控件对齐平台度量（4px 内边距、`--dsw-radius-md/sm`）。
- **清理**：删掉 3 个只被自己引用的共用件（`Disclosure` / `QuotaBar` / `CheckRow`）、`UsageStat`、81 条死文案与 60 余条死样式规则。

### 验证

- `pnpm run typecheck` / `pnpm run test`（57 文件 / 774 用例）/ `pnpm run build` / `pnpm run test:engine` 全绿。
- 测试随新结构更新：账号行的断言从「展开后的统计格子」改成「灰字里的片段」；产品合计从独立卡片改成 card head 上的「剩余 / 上限」。
## [0.13.13] — 2026-10-17

- **修复「探测思考强度」在 WorkBuddy AI 上恒定报 `sentinel status 400 (invalid_parameter_value)`**：探测的第二步（sentinel，一个不可能合法的 `reasoning_effort` 值）用来判断上游到底认不认这个参数，只有把它的 400 认成「effort 值非法」才会继续走第三步逐档扫描。Global 端点在 2026-10-01 的实测里回的是手写码 `model_param_invalid`，2026-10-17 起改成回上游 `InvalidParameter` 句子生成的 `invalid_parameter_value` —— 语义没变、码变了，于是 `INVALID_EFFORT_CODES.global` 不再命中，整次探测降级成 `unknown`，界面只显示「检测未完成」。
  - `src/probe.ts` 的 global 词表补上 `invalid_parameter_value`（保留旧的 `model_param_invalid`，两者都是句子级通用码，归属仍由 baseline 步骤担保）。`cn` 词表不动：该端点实测一直回字段级的 `invalid_reasoning_effort`。
  - `tests/probe.spec.ts` 新增一条用例：global 端点对 sentinel 回 `invalid_parameter_value` 时必须判为 `validating` 并扫完全部五档；原有「同信封兄弟码仍降级 unknown」的用例继续守住不扩面。

## [0.13.12] — 2026-10-16

- **修复「Cannot read properties of undefined (reading 'length')」** —— 这个报错在本插件里有两个互不相干的成因，本版一起处理。

  **一、pi-ai 版本漂移（致命：所有 WorkBuddy 请求全部失败）**。上游 issue #69 / #77 / #82 / #92 是同一件事：`dsh-llm-pi-ai@0.2.0-rc.2` 依赖 `^0.87.1`，而本插件此前**只声明 peer、自己没有依赖**，profile 又是 `autoInstallPeers: false`，于是插件实际解析到的 pi-ai 由 profile 根目录谁先装谁说了算。宿主 0.87 会把 system prompt 折成 `messages` 里一条 **content 为字符串**的消息；0.85/0.82 的 `estimateMessageTokens` 却把 `message.content` 当 block 数组遍历，走到 `block.name.length` → `undefined.length`。请求在构造 body 之前就炸，日志里只有一句不透明的 `PI_AI_ERROR`，且**全程没有发出任何上游请求**（`usage` 与耗时全 0）。
  - `package.json` 增加 `"dependencies": { "@earendil-works/pi-ai": "0.87.1" }`（与上游 0.7.6 的做法一致）：插件自己装一份，profile 根有旧副本也不会被抢占。
  - 移植上游的 `src/pi-ai-guard.ts`，在 `apply()` 启动时解析**本模块实际加载到的那一份** pi-ai，版本不符就打一行点名具体版本的警告（只警告不抛：宿主可能仍能服务其他 provider）。以后再发生同类漂移，看到的是「加载了 0.85.1，本插件需要 0.87.1」，而不是那句无从下手的话。

  **二、探测结果渲染未兜底 `efforts`（插槽崩溃）**。`isWorkBuddyWebStatus` 只校验判别字段，`probe.results[]` 的形状没有任何保障，下游四处直接读长度：
  - `client/WorkBuddyProbeControl.tsx` 的 tooltip 与结果气泡：改为 `(result.efforts?.length ?? 0) > 0`。
  - `client/WorkBuddySettingsPage.tsx` 的模型行徽标：该行原先在 `validation` 判断**之前**就 `result.efforts.join(...)`，只要 `result !== undefined` 就必然解引用，连非 `validating` 的缺字段记录都能崩；两处一并兜底。
  - 设置页的状态缓存新增 `hasRenderableProbeResults()`：`probe.results` 里任一条 `efforts` 不是数组就**整份**文档作废（不是丢单条）。缓存是共享的 `localStorage`，0.13.11 起首屏直接渲染它，因此旧版本或同源其他客户端写入的一份文档足以在首屏崩掉 `conversation.input.right` —— 这也解释了 issue #77 里「清空 `.workbuddy-probe.json` 仍然复现」（该文件是宿主侧记录，浏览器侧缓存是另一份）。
  - 未采用的更彻底做法（收紧 `isWorkBuddyWebStatus` 对 `probe.results` 逐条校验）：它会改动两半边共用的守卫，回归面更大，本次按最小面处理。

## [0.13.11] — 2026-10-06

- **输入框额度徽标移到最右侧，并且可以点开看分账号额度**：那枚「WorkBuddy: 5,266」从"和上下文占用挤在一起"改为排在 composer dock 行内最后 —— 位置由 flex `order` 决定（DSH 把上下文占用控件追加在插槽条目**之后**，且插槽出口是 `display:contents`，只靠 DOM 顺序会落在它左边），再用 `margin-left:auto` 顶到行右端。点击徽标展开的面板**照 DSH 自己的上下文占用弹框（`ContextMeter`）实现**，不是另发明一个：同一套定位与关闭原语（`useAnchoredPosition` 上方定位 + `useDismissOnOutsidePointer` + Esc）、同样 **portal 到 `document.body`**（否则会被 composer 的 overflow 裁掉）、同一套菜单材质（`--dsw-specific-menu` + backdrop-filter + `--dsw-elevation-prominent`）、同样 `min(264px, 100vw - 24px)` 宽度与 12px 内边距、同样的"标题行 + 4px 容量条 + `dl/dt/dd` 行"结构；触发按钮也照抄它的字号/内边距/圆角与 hover、展开态填充。面板内按 **WorkBuddy / WorkBuddy AI 分组，每组一行一个已添加账号**，显示各自余额（有上限则"剩余 / 上限"，没读过则「尚未读取」而不是 0）；没有账号的产品整组不出现。
- **新增两个开关**（均默认开、plugin-wide、设在设置页「侧边栏」分组内，与侧边栏卡片开关并列）：**「输入框额度徽标」** `composerCreditVisible`，与**「输入框检测按钮」** `probeControlVisible`（思考强度检测控件）。三个开关彼此独立 —— 关掉徽标不会连带关掉检测按钮，反之亦然。
  - 该分组的显示条件也一并修正：原先只在"侧栏那两项偏好有值"时才渲染，三个独立偏好下会把第三个开关一起藏起来；现在任一偏好有值即渲染。
  - 检测按钮的开关由控件自己读同一份状态文档决定是否渲染；字段缺失（旧宿主）一律按"显示"处理，与另两个开关同规矩。
- **删除设置页里「仪表盘」那一行入口**：仪表盘现在只从侧栏额度卡片进入；卡片关掉时设置页不再提供第二个入口。
- **设置页首屏不再空等**：状态文档按产品缓存进 `localStorage`（键 `dsh-wb-connectgf/status/<variant>`，用法与 `@mars-sea/dsh-commandcode-provider` 的缓存同构，读写都容忍 storage 缺失或抛错），进入页面先渲染上次的账号与余额，同时并行拉取实时数据并在到达后替换；某一路读取失败时保留屏幕上已有文档而不是清空。
- **账号区新增「刷新账号」按钮**：一次刷新两版所有已登录账号的余额与状态（每版走各自的 `refresh-credits`，清掉该池的额度缓存，下一次状态读取会为每个账号重新拉一次 billing）；只刷账号状态，模型目录仍走它自己那排「刷新列表」。

## [0.13.10] — 2026-10-06

- **刷新 npm 包的 git 出处**：仓库历史经过一次身份重写 —— 早先在本机全局 git 身份未配置时推入的提交被登记成了另一个名字，现已在全部提交与 tag 上统一为维护者账号 `functy23`。重写只改署名，**文件内容逐字节未变**（main 的 tree 哈希与 27 个 tag 指向的 tree 与重写前完全一致），提交数与代码均无改动；本版据此重新构建并发布，使 npm 包记录到的提交与实际仓库对齐。

## [0.13.9] — 2026-10-05

- **修复「检测未完成」只报 `TypeError: fetch failed`**：思考强度探测的每一步现在把网络层失败与上游应答分开对待 —— 传输失败（请求根本没到）按 400ms / 1200ms 退避重试两次，HTTP 应答（哪怕是 401/429）仍然只问一次，因为它已经是上游对这个请求的结论；探测自身的 30 秒超时也不重试，否则一次卡死会变成三倍停顿。这样本地代理/VPN 链路上瞬时丢包不会再被记成「模型探测不出来」。
- 失败原因不再被 `fetch` 的固定一句话吃掉：新增共用的 cause 链渲染（`src/fetch-failure.ts`），失败行从 `baseline status 0: transport error: TypeError: fetch failed` 变成 `baseline status 0 (3 attempts): transport error: TypeError: fetch failed; cause: Error: connect ECONNREFUSED 127.0.0.1:7891`，并带上 happy-eyeballs 的 `AggregateError` 逐地址原因、超时的 `TimeoutError`。聊天、探测、令牌刷新三处的传输失败共用同一条渲染。
- 并入上游 #54：chat 与 probe 请求补上 `X-IDE-Type` / `X-IDE-Name` / `X-IDE-Version` 三个 IDE 归属头，版本取与 User-Agent 同一个解析出来的桌面 App 版本；refresh、catalog、billing 三条路径保持不带该头族。

## [0.13.8] — 2026-10-02

- **插件管理页现在有本地化标题与描述**：DSH 读取的插件文案来自包内的 `locale/<语言>.json`（`meta.title` / `meta.description`），没有该文件时才回退到 `package.json` 的 `name` / `description`。补上 `locale/en.json`、`locale/zh.json`，并在 `exports` 里导出 `./locale/*.json`、在 `files` 里带上 `locale`，插件列表与详情页才会显示中文/英文的标题与一句话说明。

## [0.13.7] — 2026-10-01

- **修好浏览器半边整块不加载**：0.13.6 改名后，`tsdown.config.ts` 里客户端 bundle 的注册 id 仍写着旧名 `dsh-workbuddy-connect`。宿主以「解析出的 manifest 包名」作为浏览器模块身份，于是那一行永远等不到自己的 factory，加载器按协议重试同一份脚本，第二次执行就以 `duplicate factory registration` 抛错 —— 结果是 `1 entry did not activate`，侧栏卡片、仪表盘、设置页全部消失（宿主侧模型分组不受影响）。
- 注册 id 改为从 `package.json` 的 `name` 派生，与版本戳同一次读取，避免以后再改名时脱钩；`tests/version.spec.ts` 增加断言锁死「产物必须按包名注册」。
- 客户端插件名同步为 `dsh-wb-connectgf-client`。

## [0.13.6] — 2026-10-01

- **对外改名**：仓库与 npm 包改为 `dsh-wb-connectgf`，以区别上游 `corrinehu/dsh-workbuddy-connect`（npm 上的同名包仍归上游，当前 `0.7.1`）。provider id（`workbuddy` / `workbuddy-ai`）和 CLI 二进制名 `dsh-workbuddy-connect` 保持不变，已装用户的会话和脚本不用改。
- 状态 / 探测 / 账号路由改为 `/plugins/dsh-wb-connectgf/...`，与新包名一致。
- README 中英重写：标明 fork、对照上游 0.7.1 的差异、界面安装与命令行安装分开写。
- 截图换成 2026-10-01 实拍（对话、模型选择器、设置账号、设置模型），并在仓库根声明 `screenshots.json`。
- 并入上游：Windows 在 Electron 宿主内发现桌面 App（#66），以及国际端点的 effort 拒绝码按区域识别（#75）。

[0.13.12]: https://github.com/Helix3781/dsh-wb-connectgf/releases/tag/v0.13.12
[0.13.11]: https://github.com/Helix3781/dsh-wb-connectgf/releases/tag/v0.13.11
[0.13.10]: https://github.com/Helix3781/dsh-wb-connectgf/releases/tag/v0.13.10
[0.13.9]: https://github.com/Helix3781/dsh-wb-connectgf/releases/tag/v0.13.9
[0.13.8]: https://github.com/Helix3781/dsh-wb-connectgf/releases/tag/v0.13.8
[0.13.7]: https://github.com/Helix3781/dsh-wb-connectgf/releases/tag/v0.13.7
[0.13.6]: https://github.com/Helix3781/dsh-wb-connectgf/releases/tag/v0.13.6
