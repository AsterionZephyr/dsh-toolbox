# dsh-toolbox 交接文档

> 写于 2026-11-17 13:0x（会话 `session-1a299c2b`）；插件版本 0.1.0。
> 读者：接手本插件的下一个 DSH 会话 / 人。读完这一篇就够了，不用重跑调研。

## 0a. 接手更新（2026-11-17 18:xx，0.2.0 性能优化）

> 本节是接手后的**当前事实**；与下文冲突时以本节为准。

- 版本 0.2.0，代码已进 git（基线提交 ece67d4，性能优化提交紧随其后）。
- **首次加载不需要重启 DSH**：0.2.2-rc.1 的 bundle 通道在运行中会重新组合。已实测 `/plugins/events`
  的客户端图包含 `{"id":"dsh-toolbox","immediately":true}`，`/plugins/??dsh-toolbox/client.js` 返回 200。
  下文“只差重启 DSH”的说法作废。
- 性能优化（lib/client.js，详见 docs/perf-report.md）：
  - 设置页列表按“账本数组引用 + getVersion + locale revision”缓存；过滤器复用已读账本，label 只在缓存失效时解析；
  - 折叠集合按“页面列表 + 偏好版本”缓存，过滤器与渲染共用；
  - 推版本号优先用 `ctx.slots._core.markDirty`（不注册假条目），私有字段缺失时自动回退旧路径；
  - 偏好变更不再同步 `bump()`，依赖外壳 rows 重算级联渲染，一次切换少一轮全量渲染；带宏任务自愈检查；
  - 展开页 `memo` 隔离；顺手清掉“放回侧栏后再次收纳自动展开”的残留状态；
  - 诊断块新增“版本推送：markDirty / 占位条目回退”一行。
- 行为回归：`node bench/behavior-test.cjs lib/client.js` 9/9 通过（基线在“再次收纳不自动展开”一条失败）。
- 新增文件：`bench/`（桩件基准台 + 行为回归）、`docs/dsh-internals.md`（宿主源码调研）、
  `docs/perf-review.md`（补丁复核）、`docs/perf-report.md`（性能报告）、`docs/verify/`（真机证据链）。
- 真机 UI 验收仍欠：Web GUI 需要进程级 token（未落盘，拿不到）；桌面壳当前 `/plugins/events` SSE 报
  ERR_FAILED，已打开页面可能没收到插件更新。**刷新一次 DSH 窗口**后按第 6 节逐条验收即可。
- 宿主依赖新增：`_core` / `markDirty` 是私有实现（能力检测 + 回退）；`inject` 已加 `locale` 以订阅语言切换。
- **0.2.1 稳定性修复**（2026-11-17 19:xx）：account 的 `settings.launcher` 条目崩溃会让左下角设置入口变成
  single 槽位死格；工具箱里任一被收纳页崩溃会让 `settings.section` 的 list 槽位 abdicate 整个工具箱 → 空白页。
  已加：priority 1 的兜底齿轮（account 正常时让位）、工具箱/展开页两层 Error Boundary、
  `onEntryError` 自动重注册（限 3 次/分钟）、缺失 props 守卫、localStorage 诊断日志
  （`dsh-toolbox.diag.v1` / `dsh-toolbox.lastApply.v1`）。回归 12/12；
  详见 docs/bugfix-0.2.1.md。真机 UI 仍建议刷新一次后复核。

## 0. 一句话现状

插件写完了，**已按 bundle 通道装进 desktop profile**，只差 **重启 DSH** 来完成首次加载；
重启后的验收清单在[第 6 节](#6-重启后的验收清单逐条勾)。宿主机理与边界在[第 4 节](#4-机制为什么必须这么写)，
回滚在[第 7 节](#7-回滚)。

## 1. 目标与约束

**用户诉求**（原始提醒）：插件装多了，设置面板左侧导航非常拥挤；想做一个「工具箱」插件，
把插件里没啥用、不常变动的设置页统统收纳进去。

**硬约束（读源码确认，别再浪费时间找官方通道）**：

- 设置侧栏 = `settings.section` 槽位账本的投影（`@deepseek-ai/dsh-client-ui-settings-general`）。
- 槽位系统：**声明即渲染授权**，一个槽位只有一个声明者；`renderSlot` 只对「本条目声明过的子槽位」放行，
  否则抛 `SlotOwnershipError`（`dsh-client-ui-renderer/lib/client.js:346-349`）。
- `settings.section` 由外壳（`sidebar.settings` 条目）声明，**第三方插件既不能代渲染别人写在 `settings.section` 里的页，
  也没有 hidden / group / parent 之类的选项**；`SlotMap` 里没有任何隐藏位。

结论：要「收进工具箱且能用原页面」，只能两条受控的非常规手段（见第 4 节）。

## 2. 交付物与当前状态

| 项 | 值 |
| --- | --- |
| 插件目录 | `F:\Record\AIdatabase\09-杂项\DSH环境\dsh-toolbox` |
| 安装方式 | bundle 通道（依赖行 + `dsh.profile.bundles` + node_modules junction） |
| junction | `C:\Users\Zephyr\.dsh\profiles\desktop\node_modules\dsh-toolbox` → 插件目录 |
| profile 备份 | `C:\Users\Zephyr\.dsh\profiles\desktop\package.json.bak-toolbox-20261117-125428` |
| 写进 profile 的东西 | `dependencies` 一行 `"dsh-toolbox": "link:F:/Record/AIdatabase/09-杂项/DSH环境/dsh-toolbox"`；`dsh.profile.bundles` 末尾一行 `"dsh-toolbox"` |
| **没写**的东西 | profile 的 `cordis.patch.yml`（手工通道，写了就双重挂载） |
| 首次加载 | 2026-11-17 已确认**运行中生效**（客户端图含 dsh-toolbox，无需重启；见 0a） |
| 运行验证 | 宿主加载已确认；设置面板 6 条交互验收未完成（token / SSE 限制，见 0a、第 5 节） |

插件文件：

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | 宿主半边，空壳：`export const name='toolbox'`、`inject=[]`、空 `apply()`。只为让 Loader 有个真实条目，`dsh-client-modules` 靠它发现 `dsh.client` |
| `lib/client.js` | 全部行为（约 700 行，手写预构建 bundle，无构建步骤；格式是 `window.__ModuleLoader__.load({id, factory})`，与本机 `dsh-ustc-usage/lib/client.js` 同构） |
| `cordis.patch.yml` | `- insert: [{id: toolbox, name: dsh-toolbox, config: {}}]` |
| `package.json` | `dsh.bundle.patch` + `dsh.client{platform:'web', immediately:true}` + `exports['./client']` |
| `install.ps1` / `install.cmd` | 幂等安装/卸载（复制、junction、package.json 两行、自检） |
| `README.md` | 面向用户：它是什么、怎么用、边界 |

## 3. 设计（用户可见行为）

- 设置侧栏多出一个「工具箱」，order 16（在「插件」之后、「通知」之前）。
- 默认**自动收纳**：`account / general / models / plugins` 四个核心页留在侧栏，其余插件页（宠物、微信、通知、
  主题配色、bili、workspace-mover、better-sidebar、dshmarket、技能管理……）全部从侧栏消失，收进工具箱。
- 工具箱页里每一行一个设置页：`已收纳` ↔ `在侧栏` 胶囊按钮随时切换；已收纳的行点标题**原地展开**，
  直接渲染那一页原本的组件（不是复制一份表单，是同一份组件 + 同一套 `locale/inject/store` 席位）。
- `全部收纳` / `全部放回` / `自动收纳第三方插件页` 开关；`诊断` 折叠块显示过滤器状态与页数统计。
- 偏好存浏览器 `localStorage`（键 `dsh-toolbox.prefs.v1`）：`{mode:'auto'|'manual', overrides:{id:boolean}}`，
  不动宿主配置文档、不动任何插件的配置。

## 4. 机制（为什么必须这么写）

### 4.1 侧栏折叠：包一层 `entries()`

- 代码：`lib/client.js:188` `installNavFilter()`。
- 做法：沿 `ctx.slots` 的原型链找到真正持有 `entries` 的那一层（`SlotRegistry.prototype`），
  用闭包替换：仅当 `key === 'settings.section'` 时过滤掉「折叠集合」里的 id（以及内部用的 `__toolbox_nudge_*` 占位条目）。
- 为什么可行：外壳导航 `ctx.slots.entries('settings.section')`（`settings-general/lib/client.js:1434`）；
  内容渲染走 `entriesOfSlot()`（`renderer/lib/client.js:1174`），是另一条路，**不受过滤器影响**。
- 稳定引用：过滤器带 `(账本数组, 折叠集合)` 的缓存，同一状态返回同一数组，不破坏 uSES 的 `getSnapshot` 契约。
- 原样读取：`readRaw` 保留原实现，工具箱自己列「所有页」时用它，不会被自己的过滤器绕进去。

### 4.2 折叠后让导航重算：`nudgeLedger()`

- 代码：`lib/client.js:255`。
- 外壳把导航行按 `getVersion('settings.section')` 缓存（`settings-general:1429-1440`）。折叠集变化时注册再立刻释放一个
  临时条目（id 前缀 `__toolbox_nudge_`，注册与释放在同一 tick），版本号 +2 → 微任务里通知 → 外壳重算行。
- 临时条目在过滤器里被无条件剔除，不会闪出一个空名行。

### 4.3 原位展开：把自己的子槽位当成「插槽」

- 代码：`hostSection()` `lib/client.js:282`、`unhostSection()` `:306`、`SectionHost` `:418`。
- 工具箱条目注册时声明子槽位：`children: { 'toolbox.page': { kind:'list', scope:'root' } }`（`apply()` `:601`）。
- 展开时，把目标页 `StoredEntry` 的**组件与席位原样搬过去**：
  `register({name:'toolbox.page', id, order, locale?, inject?, store?}, entry.component)`，
  然后 `props.renderSlot('toolbox.page', {close}, {only:id})`。
- 为什么合法：`toolbox.page` 的声明者就是工具箱自己，渲染授权成立；props 由槽位框架按注册声明组装，
  不是手工伪造（`inject` 会被框架以原样参数调用、`store` 由注册表按引用挂载）。
- 拒绝内嵌的唯一情形：目标条目自己声明了 `children`（一个槽位只能有一个声明者）→ 卡片显示「这个页暂不能内嵌」，不崩。

### 4.4 卸载

- 代码：`apply()` 里的 `ctx.effect` teardown（`:601` 起）。
- 依次：释放全部 `toolbox.page` 注册 → 释放工具箱 section/icon 注册 → 还原 `entries` 原型 → 移除注入的 `<style>`。

## 5. 已验证 / 未验证

**已验证（本机、离线）**

- `node --check lib/client.js` / `lib/index.js` 通过；`install.ps1` 语法解析通过。
- 桩件（stub）端到端：假 `SlotRegistry`（entries 在 prototype 上、register 会声明 children）+ 假 React + 假 DOM，跑通：
  1) 自动模式下核心页保留、`theme-palette/notifications/wechat` 从导航消失；
  2) 卡片列表数量正确（3 已收纳 / 4 在侧栏）；
  3) 展开 → `toolbox.page` 出现该 id 的注册 → `renderSlot('toolbox.page', …, {only:'theme-palette'})` 被调用；
  4) 卸载/折叠 → 子槽位注册被释放、`toolbox.page` 声明随之消失；
  5) `全部收纳` 后导航只剩 toolbox；`全部放回` 恢复全部并写回 `prefs`。
- 安装自检：依赖行、bundles 行、junction、patch 段清空、宿主/客户端入口文件都在。

**未验证（截至 2026-11-17 18:00；刷新页面后按第 6 节验收）**

- 真实 DSH 里 bundle 能否激活、`dsh.client` 能否被发现并下发（`/plugins/dsh-toolbox/client.js`）。
- 真实 `ctx.slots` 上过滤器能否装上（原型链 / Cordis 服务代理的行为）。诊断块里会直接写「已安装 / 未安装」。
- 各插件页被重挂进 `toolbox.page` 后的真实渲染（尤其是带 `store` 的 `notifications`、带 `inject` 的 `workspace-mover-rescue`、
  纯静态的 `wechat` / `better-sidebar` / `market` / `bili`）。
- 视觉/交互（面板内边距、深色主题下的对比度、移动端条带）。

**2026-11-17 18:00 更新**

- 已确认：宿主客户端图里有 dsh-toolbox，bundle 可取回 200；**不需要重启**。
- 仍未确认：设置面板的 6 条交互（见 docs/verify/report.md 的逐条表）。原因：
  1) Web GUI 的 token 是进程级一次性密钥，未落盘；pilot 只能停在 401 鉴权页。
  2) 桌面壳页面当前 `/plugins/events` 连接失败（DevTools Console 成排 ERR_FAILED），
     已打开的页面可能还没收到插件图更新。
- 刷新一次 DSH 窗口即可重试；工具箱诊断块应显示“侧栏过滤器：已安装”“版本推送：markDirty（不写账本）”。

## 6. 重启后的验收清单（逐条勾）

1. **刷新 DSH 页面**（先 Ctrl+R；bundle 层运行中会重新组合，通常不必重启）。
2. 打开任意会话 → 设置（`Mod+,`）。左侧导航应只剩：账户 / 通用 / 模型 / 插件 / **工具箱**。
3. 点「工具箱」：应看到一行行插件页（宠物、微信、通知、主题配色、bili、workspace-mover、better-sidebar、dshmarket…），
   右侧按钮显示 `已收纳`；底部「诊断」里**侧栏过滤器 = 已安装**、模式 = 自动。
4. 任点一行的标题展开 → 该页原组件应在卡片内渲染出来（例如「主题配色」能换色并立即生效）。
5. 把某行切到 `在侧栏` → 侧栏应立即多出该页；再切回 `已收纳` → 侧栏消失。
6. 点「全部放回」→ 侧栏恢复全部页；点「全部收纳」→ 只剩工具箱。刷新页面后状态应保留（localStorage）。
7. 若某页展开后空白/报错：把该行切回 `在侧栏` 记录 id，按第 8 节排查。

**排错入口**

- 设置 → 插件 → 插件列表：能看到 `dsh-toolbox` 及其加载错误（client bundle 传输/执行失败会在这里显示）。
- 浏览器 DevTools console：`[dsh-toolbox] …` 开头的 console.warn 是插件自己降级时的提示。
- 宿主启动日志里 `warning: N entry did not activate` 说明宿主半边没上来（多半是 package.json/junction 问题）。
- 文件级自检（不依赖 UI）：

```powershell
$p = 'C:\Users\Zephyr\.dsh\profiles\desktop'
(Get-Item "$p\node_modules\dsh-toolbox" -Force).LinkType            # 期望 Junction
(Get-Content "$p\package.json" -Raw | ConvertFrom-Json).dependencies.'dsh-toolbox'
(Get-Content "$p\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles -contains 'dsh-toolbox'
Test-Path 'F:\Record\AIdatabase\09-杂项\DSH环境\dsh-toolbox\lib\client.js'
```

## 7. 回滚

```powershell
pwsh -File 'F:\Record\AIdatabase\09-杂项\DSH环境\dsh-toolbox\install.ps1' -Uninstall
# 然后刷新页面（必要时重启 DSH）
```

卸载会：删 junction、删 `dependencies` 与 `bundles` 两行、（若历史上有）清掉 profile patch 里的工具箱段；
插件目录与浏览器 `localStorage` 保留（要删自己删）。手工回滚等价于：删 junction + 删那两行 + 重启。

## 8. 已知坑与边界

1. **别写 profile 的 `cordis.patch.yml`**：bundle 通道与手工通道互斥，同时写会双重挂载
   （见 `DSH环境/DSH插件开发参考.md` F、G 节）。install.ps1 会在安装时清掉历史遗留的手工段。
2. **折叠 ≠ 注销**：页面条目仍在账本里；插件热重载/卸载后工具箱列表跟着账本重算（订阅 `settings.section`）。
3. **正在看的页被收起**：面板内容仍留在原处，但侧栏没有高亮项；点别的导航即可。属可接受缺陷，未做处理。
4. **依赖私有实现**：`SlotRegistry.prototype.entries`。DSH 升级后若改名/改签名，过滤器装不上 → 诊断显示「未安装」，
   折叠失效但不崩；此时优先看新版是否有官方分组 API，有就迁移。
5. **子槽位冲突**：目标页若声明了 children，不能内嵌（显示提示）。本机 12 个插件实测都没有这种情况，但升级后可能出现。
6. **store 席位**：共享 handle 按引用挂载（引用计数），独占 factory 会新起一个实例；两种都由槽位框架处理，
   但行为差异要留意（`notifications` 用的是 `store` 占位）。
7. **localStorage 是浏览器域的**：换端口 / 清缓存会丢偏好，回到默认「自动收纳」。

## 9. 后续可做（按价值排序）

1. **重启后按第 6 节验收**，把通过/失败的插件 id 记到本文档末尾（维护一段「实测表」）。
2. 若某个页展开异常：先看它的注册选项（`locale/inject/store/children`），大概率是 `children` 或依赖 shell owner props。
3. 若 DSH 新版提供官方分组/隐藏 API，把 4.1 的补丁换成官方通道（这是最该做的一次技术债偿还）。
4. 可选：把「已收纳」的判定从 `localStorage` 迁到宿主 settings 文档（`ctx.configForms`），实现跨浏览器/双机同步；
   目前单机够用，没做。
5. 可选：工具箱内支持搜索/按来源分组（当前按 `order` 平铺）。
6. 把本次安装补记进 `DSH环境/插件安装记录.md`（本次只写了本目录 README/HANDOVER，没动那份大文档）。

## 10. 关键事实速查（省得再翻源码）

**槽位 API（`ctx.slots`，`dsh-client-ui-renderer` 的 SlotRegistry）**

```js
ctx.slots.inject(key, cb)          // 等槽位声明；cb 返回 disposer；绑调用方 fiber
ctx.slots.register(options, Comp)  // options: name, children?, store?, locale?, inject?, id/order/label(list), priority
ctx.slots.entries(key)             // 原始账本（含被 shadow 的）—— 外壳导航读它
ctx.slots.entriesOfSlot(key)       // 每个 cell 的胜者 —— 渲染读它
ctx.slots.subscribe / getVersion   // 变更通知 / 版本号（uSES 配对）
props.renderSlot(key, owner, opts) // 仅限本条目 children 声明过的 key；opts: only / fallback / entryKey
```

**外壳渲染模型（`dsh-client-ui-settings-general`）**

- 导航行：`ctx.slots.entries('settings.section')` → `{id, order, label}`，按 `order` 升序；图标走 `settings.section.icon`（按 id 匹配）。
- 内容：只挂当前 `activeId` 一个：`renderSlot('settings.section', {close}, {only: activeId})`。
- 版本缓存：`getVersion('settings.section')` + locale revision；任一变化才重算行。

**本机设置页 id 一览（2026-11-17 扫描）**

| id | order | 来源 |
| --- | --- | --- |
| account | -10 | 核心 |
| general | 0 | 核心（外壳） |
| theme-palette | 5 | dsh-theme-palette |
| models | 10 | 核心 |
| plugins | 15 | 核心 |
| toolbox | 16 | 本插件 |
| skills-manager | 25 | @michengai/dsh-skills-manager |
| notifications | 40 | @dingyi222666/dsh-session-notification |
| wechat | 40 | dsh-wechat |
| market | 40 | dshmarket |
| workspace-mover-rescue | 60 | dsh-workspace-mover |
| better-sidebar | 100 | dsh-better-sidebar |
| bili | 100 | billion-context |
| pet | （动态） | @linxin666/dsh-pet，经 `webUiExtensions.registerPage` 注册 |

**版本事实**：DSH Desktop 0.2.2-rc.1（`app.asar` 内 `dsh/package.json`）；客户端槽位包 0.2.2-rc.1；
设置外壳空载 800×800 面板，窄屏 <768px 导航变横向条带。

## 11. 参考资料

- `DSH环境/DSH插件开发参考.md`：本地插件安装（F 节）、profile patch 通道取舍（G 节）——**本次安装方式依据它**。
- `DSH环境/插件安装记录.md`：历史插件安装/回滚/配置键（第四、十部分与本机 pwsh 固定相关）。
- 源码位置（app.asar 内，需解包阅读）：
  - `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`（外壳导航/内容投影）
  - `dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js`（renderSlot 授权、props 组装）
  - `dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js`（SlotCore：entries/entriesOfSlot/register）
- 同构样例：`C:\Users\Zephyr\.dsh\profiles\desktop\node_modules\dsh-ustc-usage\lib\client.js`（手写预构建客户端 bundle）。
