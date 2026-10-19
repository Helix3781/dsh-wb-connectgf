# Changelog

版本号即 git tag，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
- **设置页首屏不再空等**：状态文档按产品缓存进 `localStorage`（键 `dsh-workbuddy-connect-functy/status/<variant>`，用法与 `@mars-sea/dsh-commandcode-provider` 的缓存同构，读写都容忍 storage 缺失或抛错），进入页面先渲染上次的账号与余额，同时并行拉取实时数据并在到达后替换；某一路读取失败时保留屏幕上已有文档而不是清空。
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
- 客户端插件名同步为 `dsh-workbuddy-connect-functy-client`。

## [0.13.6] — 2026-10-01

- **对外改名**：仓库与 npm 包改为 `dsh-workbuddy-connect-functy`，以区别上游 `corrinehu/dsh-workbuddy-connect`（npm 上的同名包仍归上游，当前 `0.7.1`）。provider id（`workbuddy` / `workbuddy-ai`）和 CLI 二进制名 `dsh-workbuddy-connect` 保持不变，已装用户的会话和脚本不用改。
- 状态 / 探测 / 账号路由改为 `/plugins/dsh-workbuddy-connect-functy/...`，与新包名一致。
- README 中英重写：标明 fork、对照上游 0.7.1 的差异、界面安装与命令行安装分开写。
- 截图换成 2026-10-01 实拍（对话、模型选择器、设置账号、设置模型），并在仓库根声明 `screenshots.json`。
- 并入上游：Windows 在 Electron 宿主内发现桌面 App（#66），以及国际端点的 effort 拒绝码按区域识别（#75）。

[0.13.12]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.12
[0.13.11]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.11
[0.13.10]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.10
[0.13.9]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.9
[0.13.8]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.8
[0.13.7]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.7
[0.13.6]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.6
