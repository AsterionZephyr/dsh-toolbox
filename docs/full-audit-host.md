# 全量审计 A：宿主契约 / React 生命周期 / HMR 与并发正确性

> **审计快照**：HEAD `1897761`（`v0.2.1-2`，工作树干净）。
> `lib/client.js` = 1,190 行（按 read 工具行号；磁盘 44,012 B），sha256 `89F3C1E835C33761912E7728ACF9BE7F6A37933410618A3D8027B86629DB35A0`。
> 对照宿主：DSH Desktop **0.2.2-rc.1** 的 app.asar（槽位核心在 `dsh-web-frontend/dist/assets/index-BgUyXZcc.js` 第 123 行，按字节偏移引用）。
> 审计方式：**只读**（未改任何文件），未做任何桌面操作。

## 后续修复说明（2026-11-18 05:xx）

本快照之后 Lead 已按本报告修复：P2-1 inject disposer、P2-2 disposed 直通、P2-3 slot key 改名
dsh-toolbox.page、P2-4 cascade timer 合并、P2-5 改用 prefsEpoch 判据、P2-8 diag storage 失效；
P2-6/P2-7 保留为文档说明/罕见边界。当前代码行号与本快照有差异，以 docs/full-audit-2026-11-18.md 为准。

## 结论

**可发布。未发现 P0 / P1。**

- P0（崩溃 / 数据损坏 / 权限越界 / 安全）：**0**
- P1（发布阻断或核心功能可被外部条件打断）：**0**
- P2（健壮性/契约洁癖，建议下个小版本修）：**8 条**，均不影响正常路径
- P3（nits / 文档漂移）：**6 条**

前一轮 2 条 P1 已消解：`install.cmd` 现在硬性要求 `pwsh`（缺失即退出并提示），不再有 5.1 参数不兼容；0.2.1 的真机证据边界已写入审计文档，发布说明按 P3-1 口径写即可。

---

## 已修复项回归确认（对上一轮 P2 的复核）

| 上轮问题 | 现状 | 位置 |
| --- | --- | --- |
| boundary 的 React key 用对象（被串成 `[object Object]`） | ✅ 已修：WeakMap→数字 key | `client.js:459-467`、`:759` |
| `renderCount += 1` 写在渲染期 | ✅ 已修：移入 `useLayoutEffect`（提交阶段） | `:778-780` |
| 渲染期写 `renderSlotRef.current` | ✅ 已修：`useLayoutEffect` + `[props.renderSlot]` | `:787-792` |
| `SectionHost` 边界没包住 `renderHosted()` 调用本身 | ✅ 已修：新增 `HostedPage` 组件，把调用点放进边界内 | `:727-729`、`:760` |
| 自愈定时器没有 `applied` 守卫 | ✅ 已修：回调首行 `if (!applied) return` | `:445-448` |
| icon 注册无 try/catch | ✅ 已修 | `:1146-1162` |
| launcher 固定 priority 1 可能与别的兜底撞车 | ✅ 已改为 1→2→3 重试 | `:1165-1181` |
| 版本号硬编码在 lastApply 里 | ✅ 已收敛为 `PLUGIN_VERSION` 常量（仍与 package.json 双源，见 P3-2） | `:56`、`:1001` |
| 诊断每帧读 localStorage | ✅ 已加 `diagCache`（跨标签页不失效，见 P2-8） | `:95`、`:125-135` |

---

## P2（8 条）

### P2-1 `slots.inject` 回调没有返回 disposer（契约偏离，当前良性）

- **位置**：`client.js:1138-1144`（section）、`:1146-1162`（icon）、`:1165-1181`（launcher）——三个 `ctx.slots.inject(key, cb)` 的 `cb` 都返回 `undefined`。
- **宿主契约**：SlotRegistry.inject 把回调放进 `ctx.effect(callback, ...)`，并把 effect 的 disposer 存为 `active`；槽位声明消失或 **declarationEpoch 变化**时先调 `active()` 再重跑回调（`dsh-client-ui-renderer/lib/client.js:1384-1399`）。
- **触发条件**：槽位「重新声明」但旧条目没被清掉。当前 0.2.2-rc.1 不会发生——声明方（`sidebar.settings`）一旦 dispose，SlotCore 的 `releaseChildren` 会 `r.entries = b1` 并逐条 release（壳 bundle 偏移 **496,898**），所以回调重跑时不会撞 id 重复。
- **证据/影响**：无现网故障；属于「依赖宿主清账本」的隐式契约。若未来宿主改成「保留条目、只重置 spec」，我们的回调重跑会因 id 重复而抛错（被 `:1141` 的 try/catch 吞掉）→ 工具箱消失且只有诊断行可见。
- **修法**：三个回调都 `return` 一个幂等 disposer，例如
  ```js
  ctx.slots.inject("settings.section", function () {
    try { registerSection(); } catch (error) { reportDiag("section-register", error); }
    return function () {
      if (typeof disposeSection === "function") { try { disposeSection(); } catch (_) {} disposeSection = null; }
    };
  });
  ```
  （launcher/icon 同理；返回的 disposer 与 teardown 幂等共存，register 的 disposer 本身幂等——`renderer/lib/client.js:1813-1815` + `_register` `:1616-1622`。）

### P2-2 过滤器卸载后可能被别人的 wrapper 继续调用（卸载不彻底）

- **位置**：`client.js:347-364`（`filteredEntries`）、`:367-384`（teardown）。
- **触发条件**：另一个插件在我们的过滤器**之后**也包了 `SlotRegistry.prototype.entries`。我们 teardown 时 `proto.entries !== filteredEntries`（`:368` 的条件不成立）→ 不还原；对方的 wrapper 仍持有并通过闭包调用我们的 `filteredEntries` → 卸载后侧栏**仍按旧偏好折叠**，且我们的闭包（含 `ctx`）被永久持有。
- **宿主证据**：`entries` 是原型方法，任何插件都可包（宿主自己也只读它，`settings-general:1434`）。
- **修法**：加 `let disposed = false;`，在 `filteredEntries` 首行 `if (disposed) return original.call(this, key);`，teardown 里置 `disposed = true`（成本 0，彻底消除残留）。

### P2-3 子槽位 key `toolbox.page` 是全局命名空间，撞名会让整个插件消失

- **位置**：`client.js:57`（`PAGE_SLOT = "toolbox.page"`）、`:1041-1058`（`sectionOptions().children`）。
- **触发条件**：任何别的插件也声明 `toolbox.page`（SlotCore 的 records 是**单张全局表**，槽位名不分包）。此时我们的 `registerSection()` 抛 `slot "toolbox.page" is already declared`（壳 bundle 偏移 **491,276** 的 register 分支），被 `:1141` 捕获 → **工具箱 section 根本注册不上**（不是折叠失效，是整个插件不可见），只有 localStorage 诊断留痕。
- **概率**：低（名字够特定），**影响**：高（静默消失）。
- **修法**：改成带包名前缀的 key（建议 `dsh-toolbox.page`），并在 `docs/dsh-internals.md` 的槽位清单里同步；改 key 不涉及持久化数据，零迁移成本。另可在 `registerSection` 失败时把「展开」降级为禁用，而不是整页不出现。

### P2-4 `pushLedgerChange` 的定时器没有被 teardown 清理

- **位置**：`client.js:445-448`（每次折叠提交都 `setTimeout(..., 0)`，只存局部变量）。
- **触发条件**：HMR 重载 / 插件停用发生在定时器触发前 → 回调仍执行一次（现在有 `if (!applied) return` 兜底，不会误 bump）。
- **影响**：一次多余的 timer + 闭包（≤1 tick），无功能影响；快速连点 N 次会积 N 个 timer。
- **修法**：模块级 `let pendingHealTimer = null`，push 时若已有则复用；teardown 里 `clearTimeout`。（与 `healTimer` 同款处理，`:1094-1097` 已有范例。）

### P2-5 自愈判定用提交计数，属启发式（不会冻 UI，但会偶发多渲染一次）

- **位置**：`client.js:444-447`（`expected = renderCount + 1`；`setTimeout` 里 `renderCount < expected` 才 `bump()`）、`:778-780`（计数点在 layout effect）。
- **触发条件**：外壳级联的 React 提交晚于我们的 0ms 宏任务（并发调度下可能）→ 判定「没渲染」→ 补一次 `bump()`。反之，若期间有任何别的工具箱提交（例如另一次 bump），计数已增加 → 判定「渲染过了」，但此时 UI 其实已经读到新 prefs（`foldedSet` 按 `prefsEpoch` 失效）→ 不会留下错误画面。
- **影响**：最多多一轮全量渲染；**不存在「点了没反应」的路径**。
- **修法**（可选）：把判据从「提交次数」换成「提交时的 prefsEpoch 快照」：layout effect 里记 `lastCommittedEpoch = prefsEpoch`，定时器里比 `lastCommittedEpoch < epochAtPush` 才 bump。语义更准，代码量相同。

### P2-6 展开页的 `store` 若是「独占 factory」，会新建实例（状态不共享）

- **位置**：`client.js:471-493`（`hostSection` 原样复制 `entry.store`，含函数形式）。
- **宿主证据**：`_register` 对 `typeof store === "function"` 会**立即调用**取 handle（`renderer:1604`）；独占 store 按 occurrence 新建实例（`resolveFactoryStore` `:1730-1753`）。共享 handle 则是引用计数复用（`_acquire/_release` `:1780-1802`）。
- **影响**：共享 handle 的页（notifications 等）状态与侧栏页一致 ✅；独占 factory 的页展开后是**新实例**（表单会重置）。这是方案本身的边界，不是 bug，但 README/HANDOVER 应写明一句，避免用户以为“数据丢了”。
- **修法**：文档补一句；若要更稳，可在 `hostSection` 里对函数形式 `store` 记一条诊断（说明会新建实例）。

### P2-7 影子条目（同 id 多 priority）会导致卡片重复，多数场景与宿主一致但展开项固定

- **位置**：`client.js:258-289`（`readSections` 按原始账本逐条建卡，不按 cell 去重）。
- **宿主证据**：外壳导航同样不去重（`settings-general:1434` 直接 map 全量 entries）→ **导航与卡片一致**；但 `entriesOfSlot` 按 cell 只取赢家（壳 bundle 偏移 **494,245**），而 `hostSection` 用 id 注册，展开的是该 id 的胜者 → 「点第 2 张卡、展开第 1 个」的错位。
- **触发条件**：两个插件/同一插件的两个注册使用同一 `id` 但不同 priority（本机实测无此情况）。
- **修法**：`readSections` 里按 `id` 去重保留首条（或直接用 `entriesOfSlot` 的语义），与展开行为对齐；代价是导航可能比宿主少一行（可接受，且更正确）。

### P2-8 `diagCache` 跨标签页/跨实例不失效

- **位置**：`client.js:95`（`diagCache`）、`:125-135`（`readDiag` 命中即返回）。
- **触发条件**：同一浏览器域打开两个 DSH 页面/窗口，A 写入新诊断，B 已缓存过旧值 → B 的诊断块不更新，直到 B 自己出错或刷新。
- **影响**：只影响诊断可读性。
- **修法**：监听 `window.addEventListener("storage", ...)` 置 `diagCache = null`；或把「最近异常」改为点击诊断时强制重读（一次读取代价可忽略）。

---

## P3（nits / 文档）

1. **发布说明口径**：`docs/verify/*` 的证据采集于 16:27–17:33，而 0.2.1 是 19:39 才热更的（`lastApply` 时间戳）→ 现有截图不覆盖 0.2.1；0.2.1 的真机结论来自用户口述（入口恢复、诊断无异常）。建议发布说明如实标注，避免「有截图=已验证」的误解。
2. **版本号双源**：`package.json:3` 与 `client.js:56` 的 `PLUGIN_VERSION` 都是 0.2.1，发版脚本需同步（漏改只会让诊断里的版本是旧的）。建议在 `install.ps1`/CI 里加一条一致性自检（读两个值比对）。
3. **`bench/README.md:12` 仍写「9 条」**，实际 `bench/behavior-test.cjs` 已是 **13 条**（README.md:125 的 13 是对的）。
4. **`apply()` 先写 `lastApply` 再检查 `ctx.slots`**（`:1001` 早于 `:1009` 的守卫）：ctx 不可用时也会留下「已应用」记录，误导排查。建议移到守卫之后。
5. **`filteredEntries` 的 `hidden.size === 0` 快路径不刷新 `cacheSrc/cacheHidden`**（`:349-352`）：正确但下次非空会多算一次。
6. **`readSections` 第二命中分支不更新 `sectionsLocale`**（`:273-276`）：分支条件已含 locale 相等，无影响；若未来允许 locale 为 `-1` 的「未知」态需复查。

---

## 覆盖声明（本轮逐项核对，供发布说明引用）

### A. 错误边界
- `ToolboxBoundary`（`:578-615`）：class + `getDerivedStateFromError` + `componentDidCatch`，**两件套齐全**（React 要求至少其一；只写 `componentDidCatch` 也能捕获，但派生 state 更稳）。`retry()` 幂等、可重复失败。✅
- 布局：`ToolboxShell`（`:647-664`）包 `ToolboxSection`；每张展开卡片再包一层（`:754-762`）；`HostedPage` 让 `renderSlot` 抛错也落在边界内（`:727-729`）。✅
- `settings.launcher` 兜底**没有**边界——但它崩了会被宿主的 SlotErrorBoundary 捕获并 abdicate，此时槽位为空、宿主自带 fallback 接管（`settings-general:439-451` 传入 fallback）→ 设置入口仍可达。**可接受**。
- 边界捕获后只影响局部（工具栏/卡片），不会让条目被 abdicate（宿主只在错误**冒泡**时 abdicate，壳 bundle 偏移 496,464）。✅

### B. 槽位契约
- `settings.section` 声明方是 `sidebar.settings`（`settings-general:1522-1530`），我们用 `slots.inject` 等待声明后再注册 ✅（回调注册发生在父条目 register 的 `notifyDeclaration` 阶段，此时 spec 已提交）。
- `renderSlot('toolbox.page', ...)` 只对**自己声明过**的 children 调用 ✅（宿主在 `renderer:346-349` 校验——本插件的 `toolbox.page` 由自己声明，授权成立）。
- 展开时复制 `locale/inject/store`（`:471-493`），props 由槽位框架按注册声明组装，未伪造 ✅。
- `onEntryError` 是公开 API（`renderer:1574-1576`），回调签名 `(key, entry, error, info)` 与我们的使用一致（`:1128-1132`）✅。
- `settings.launcher`：single 槽位（`settings-general:1527-1530`），account 以 **默认 priority 0** 注册（`dsh-client-ui-settings-account/lib/client.js:5415-5419`，无 priority 字段），我们 1/2/3 → 健康时让位、abdicate/缺席时接管 ✅。渲染 props 为 `{wide, settingsOpen, openSettings, settingsShortcut, openOnboarding}`（`settings-general:439-451`），我们只用到 `wide`/`openSettings` ✅。

### C. 生命周期与泄漏
- 定时器：`healTimer` 在 teardown 清理（`:1094-1097`）✅；`pushLedgerChange` 的 timer 未清理（P2-4）。
- 订阅：`ctx.slots.subscribe`/`ctx.locale.subscribe` 在 effect cleanup 里退订（`:836-839`）✅；`onEntryError` 的 disposer 存于 `disposeErrorWatch` 并在 teardown 调用（`:1098-1101`）✅。
- DOM：`<style>` 在 teardown 移除（`:1119`）✅；无其它全局监听 ✅。
- 槽位注册：section/icon/launcher/hosted 全部在 teardown 释放（`:1102-1118`）✅；`hosted` Map 逐项释放并 delete（`:495-503`）✅。
- 原型补丁：teardown 条件还原 + 清缓存（`:367-384`）✅（被后装 wrapper 时的残留见 P2-2）。
- WeakMap `boundaryKeys` 不持有条目 → 无泄漏 ✅。

### D. `savePrefs` 不 bump 的级联假设
- 链路：`savePrefs`（只 +prefsEpoch）→ `pushLedgerChange` → `nudgeLedger`（`_core.markDirty`，版本 +1 + 微任务 flush）→ 外壳 `ctx.slots.subscribe`（`settings-general:1443-1449`）→ `SettingsRoot` 的 uSES（`:362`，相等性 Object.is，`renderer:155-160`）→ rows 重建（`:1429-1441`，version 变 → 新数组）→ `SettingsPanel`（**普通函数组件、无 memo**，`:486-492`）→ `:341` 的 `renderSlot('settings.section', {only: active})` → `SlotOutlet`（`renderer:1117-1128`）→ `RootEntry`（`:882-888`）→ `ToolboxSection` 重新渲染。
- 兜底：`pushLedgerChange` 的宏任务自愈（`:439-449`，判据见 P2-5）→ 宿主一旦 memo 化内容区，最坏多一次自渲染，不会静默失效 ✅。
- 反向确认：工具箱**不会**因 `markDirty`（账本数组不变）而自渲染（`:815-825` 用账本引用过滤）→ 一次切换确实只有一轮渲染（正常路径）✅。

### E. React 规则
- Hooks 顺序：`ToolboxSection`（uSES → layoutEffect → useRef → layoutEffect → useCallback → useEffect）无分支、无提前 return ✅；`SectionHost`（useState → useEffect）✅；`HostedPage`/launcher/icon/shell 无 hooks ✅。
- 渲染期副作用：已全部移出（`renderCount`→layoutEffect，`renderSlotRef`→layoutEffect）✅；渲染期只剩纯读（`readSections`/`foldedSet`/缓存写入，均为模块缓存、无 React 状态写入）✅。
- key：卡片 `key: section.id`（`:816-818`）✅；边界 key 为数字（`:759`）✅。
- `memo` 比较器只看 `ctx/renderHosted/localeRev/section.id/section.entry`（`:763-772`），宿主页 props 身份每帧变化的问题被正确绕开 ✅。
- `useLayoutEffect` 有 `React.useLayoutEffect || React.useEffect` 回退（`:47`），SSR/旧 React 不会崩 ✅。

### F. 多实例 / HMR / 并发
- `apply` 有 `applied` 守卫（`:997-999`），同一模块实例不会被应用两次 ✅；HMR 重载得到新模块实例 + 旧 fiber teardown（原型还原、样式移除、订阅释放）✅。
- HMR 机制（宿主）：`client-hmr` 每 500 ms stat 轮询（`dsh-client-hmr/lib/index.js:22`、`:79-92`）→ `clientModules.rebuilt`（`dsh-client-modules/lib/index.js:687-705`）→ SSE `rebuilt` → `entries.reload`（`dsh-client-modules/lib/client.js:431-461`）→ `replace`（`:492-505`，**先 await 拆 fiber 再 import**）→ 新 apply 不会与旧 teardown 并发 ✅。
- 并发渲染：过滤器对同一 (账本引用, 隐藏集) 返回同一数组 → uSES 快照稳定（`renderer:1119` 的 getVersion 也只在版本变化时变）✅；两个并发渲染各自读缓存，无写竞争（单线程 + 同步缓存写）✅。
- 多窗口/多标签：各自独立 JS realm + 各自补丁；`localStorage` 共享偏好（预期行为），诊断缓存不互通（P2-8）。
- 双通道安装：`install.ps1` 会清 profile `cordis.patch.yml` 里的旧手工段（`:129-137`），避免同页两份 apply；若用户手工再挂一次，`apply` 的模块级守卫在**同一 realm** 内仍然生效（不同 realm 才会双份，属极端情况）。

---

## 仍建议真机补验（不影响本次发布判断）

1. 一次折叠切换的提交次数（React Profiler）：预期 `SettingsRoot` 1、`SlotOutlet(settings.section)` 1、`ToolboxSection` 1、`SectionHost` 0。
2. 展开一个**独占 store** 的页（如带 `store: () => handle` 的插件），确认状态重置是否符合预期（P2-6）。
3. 两个窗口同时打开设置，确认偏好互相同步、诊断不串（P2-8）。
