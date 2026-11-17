# 优化补丁复核：`client.opt.js` vs `lib/client.js`（git ece67d4）

> 复核对象：`C:\Users\Zephyr\AppData\Local\Temp\client.opt.js`（884 行，未提交，未改动）
> 基线：`F:\Record\AIdatabase\09-杂项\DSH环境\dsh-toolbox\lib\client.js`（707 行，git `ece67d4`）
> 差异：`git diff --no-index -U3` 共 **408 行 diff**（+ 新增/改写约 120 行）
> 对照宿主：DSH Desktop **0.2.2-rc.1** 的 app.asar（路径/行号见各条；壳 bundle 为单行压缩，用"偏移"定位）
> 复核人：srcsleuth（只读复核，未改补丁、未改 lib/）

---

## 0. 结论摘要

| # | 变更 | 结论 | 依据 | 风险 |
| --- | --- | --- | --- | --- |
| ① | `nudge` 改 `_core.markDirty`（能力检测 + 回退） | ✅ **通过** | SlotCore `markDirty`（壳 偏移 497,821）语义与假条目的对外可见面等价 | 私有字段改名 → 已有回退，安全 |
| ② | `readSections` 三层缓存（账本引用 / 版本 / locale） | ✅ **账本维度无漏洞**；⚠️ locale 轴是**死轴** | SlotCore 每次 register/dispose 都换数组 + 版本 +1（§2.2 矩阵） | 见 §3（`ctx.locale` 不可用） |
| ③ | `SectionHost` memo + `renderHosted` ref 稳定 | ✅ **通过** | comparator 字段齐备、`renderSlot` 绑定按 entry 缓存（renderer:341-360） | 无（注意 `section.entry` 稳定性已成立） |
| ④ | 去掉 `savePrefs` 的 `bump()`，靠外壳 rows 重算级联 | ✅ **成立**（逐行核对链路见 §2.4） | settings-general:362 / :486-492 / :341 三处均为普通组件、无 memo | ⚠️ 依赖宿主实现细节，建议加零成本护栏（§2.4 末） |
| ⑤ | `setMode/setFolded/foldAll/unfoldAll` no-op 提前返回 | ✅ **行为等价** | 逐个函数比对（§2.5） | 无 |
| ⑥ | 剩余性能点 | 见 §2.6 | — | — |

**必修 1 项**：补丁第 878 行仍是 `const inject = ["slots"];`，但补丁在多处读 `ctx.locale`（:176/:622）。cordis 只把 **inject 里声明的服务**装进 fiber，未 inject 的 `ctx.locale` 会抛 `cannot get property "locale" without inject`，被 try/catch 吞掉 → **locale 轴永远是 0、语言切换不刷新**。修法：`const inject = ["slots", "locale"];`（或删掉 locale 轴）。详见 §3。

---

## 1. 复核方法

1. `git -C <repo> diff --no-index -U3 -- lib/client.js C:\...\client.opt.js` 得到完整差异（408 行），逐 hunk 核对；`node --check client.opt.js` **语法通过**。
2. 每条断言都用宿主源码验证，而不是只看补丁注释：槽位核心在
   `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js`（970,770 B / 198 行，第 123 行是 SlotCore 所在巨型行，按字节偏移引用）；
   设置外壳 `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`（1622 行）；
   渲染器 `dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js`（1884 行）；
   cordis `dsh/node_modules/@deepseek-ai/cordis/lib/index.js`（服务注入语义）；
   locale `dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js`。

---

## 2. 逐项复核

### 2.1 ① `_core.markDirty` 用法与回退（patch:153-165, 338-360）

**用法正确。** SlotCore.markDirty（壳 偏移 **497,821**）：

```js
markDirty(e,t){ t.version+=1;
  for(const r of[...this.mutateListeners]) r(e);                    // 同步：slots/changed
  this.dirty.add(t);
  this.flushScheduled||(this.flushScheduled=!0,queueMicrotask(()=>{this.flush()})) }   // 微任务：订阅者
```

- `core.records.get("settings.section")` 返回的是**活的 record 对象**（`records` 是 `Map`，壳 偏移 489,082 `records=new Map`），正是 `markDirty` 期望的第二个参数（它直接 `t.version+=1`）→ ✅。
- 对外可见面与"注册+立刻释放假条目"**完全等价**：`getVersion` +1（`getVersion(e){return this.records.get(e)?.version??0}`，偏移 496,327）、`slots/changed` 同步 emit 1 次、`subscribe` 回调在微任务里 1 次（`flush()` 偏移 498,060 每 tick 合并）。
- 少掉的开销：1 次 `register` 的全部校验、`[...entries, entry]` 复制 + 排序、1 次 `filter` 复制、1 次 `slots/changed`、以及"账本数组换新"导致的所有下游缓存失效。**这是本次最有价值的一条。**
- 回退：`if (!nudgeLedger(ctx)) bump();`（patch:495/501/513/529）—— 回退路径仍会生成 `__toolbox_nudge_*` 条目，过滤器里的剔除逻辑（patch:307-315）保留 ✅。
- 一致性：`canMarkDirty`（patch:153-165）与 `nudgeLedger`（patch:340-355）的判据一致（都要求 `_core` + `markDirty` + `records.get` 拿得到 record）✅。
- 小 nit（可选）：`canMarkDirty` 在诊断行里每轮渲染都读一次 `ctx.slots._core`；可缓存，但成本可忽略。

### 2.2 ② 三层缓存键是否覆盖全部账本变更（patch:205-250, 252-262, 294-320）

`readSections(ctx, listHint)` 的有效缓存键 = **账本数组引用**（`sectionsLedger`）+ **版本**（`sectionsVersion`）+ **locale revision**（`sectionsLocale`）；`filteredEntries` 的缓存键 = **账本数组引用** + **折叠集 Set 引用**（`foldedSet` 按 `sections` 引用 + `prefsEpoch` 缓存）。

覆盖矩阵（变更源 → 各轴是否变化）：

| 变更源 | 账本数组 | version | locale rev | prefsEpoch | 缓存是否正确失效 |
| --- | --- | --- | --- | --- | --- |
| `register` 新设置页 | **换新** | +1 | — | — | ✅ 重算 sections + 折叠集 + 过滤结果 |
| `dispose` 设置页 | **换新** | +1 | — | — | ✅ 同上 |
| 崩溃 abdicate（`reportEntryError`） | 不变 | +1 | — | — | ✅ 版本失效 → 走 branch#2 命中缓存（内容不变，正确） |
| `markDirty` 版本推送（本补丁） | **不变** | +1 | — | — | ✅ 同上；⚠️ 见下"必要细节" |
| 语言切换 | 不变 | 不变 | **+1** | — | ⚠️ **只有 `ctx.locale` 可用时才成立**（§3） |
| 偏好切换（收纳/放回） | 不变 | 不变 | — | **+1** | ✅ `foldedSet` 换新 Set → 过滤器重算；sections 内容与偏好无关，无需失效 |
| 插件热重载（entry 重启） | 换新 | +1 | — | — | ✅ |

**必要细节（补丁做对了）**：`readSections` 的第二命中分支会把 `sectionsVersion` 更新为当前版本（patch:219 `sectionsVersion = version;`）——没有这句，每次 markDirty 都会因版本不一致而重算全部 label。

**其他核对**：
- 账本"内容变化但版本不变"不可能：SlotCore 每次 register/dispose 都 `markDirty`（偏移 494,019 的 dispose 分支 / 492,9xx 的 register 分支）。
- 过滤器把 `list` 当 `listHint` 传入（patch:299）→ **不再在过滤路径里二次调用 entries()**（原来 `readSections(ctx)` 会走 `readRaw`），既省一次 map get，也避免重入 ✅。
- `hidden.size === 0` 时直接返回 `list` 且不更新 `cacheSrc/cacheHidden`（patch:303）——无害：非空恢复时 Set 是**新对象**，`cacheHidden === hidden` 必然不成立 → 会重算 ✅。
- 过滤器 teardown 清空 5 个缓存变量（patch:322-330）✅；`sectionsLocale` 未重置无害（branch#1 要求 `sectionsValue` 非空）。
- 缓存是**模块级**：插件 HMR 重载会得到新模块实例；`apply` 有 `applied` 守卫 ✅。

**结论**：账本/版本/偏好三个维度无漏洞；**唯一死轴是 locale**（§3）。

### 2.3 ③ `SectionHost` memo 与 `renderHosted`（patch:549-580, 589-596, 686-696）

comparator（patch:573-579）：
```js
prev.ctx === next.ctx &&
prev.renderHosted === next.renderHosted &&
prev.localeRev === next.localeRev &&
prev.section.id === next.section.id &&
prev.section.entry === next.section.entry
```
- `ctx`：`api.ctx()` 返回 apply 时捕获的同一个对象 → 恒等 ✅。
- `renderHosted`：`useCallback(..., [])`（patch:591-593）→ 恒等 ✅；它通过 `renderSlotRef.current` 读**最新**的 renderSlot，既稳定又不陈旧 ✅。
- `section.entry`：SlotCore 的 entry 对象自 register 起不变（dispose 只是从数组里 filter 掉）→ 恒等 ✅。这正是旧代码 "memo 无效" 的根因（旧 `readSections` 每次新建 section 包装对象），补丁用 `id + entry` 绕开了包装对象身份 ✅。
- `localeRev`：语言切换时强制宿主页重渲染（让 label 文案刷新）；§3 修好后有效。
- 展开/收起不受 memo 影响：父层是 `isOpen ? h(SectionHost, …) : null`（patch:686-696），状态翻转直接 mount/unmount ✅。
- 补充：memo **不会**冻结宿主页自身的更新——宿主页的 re-render 由 `toolbox.page` 的 SlotOutlet 订阅（renderer:1119）驱动，与 SectionHost 的 memo 无关 ✅。

### 2.4 ④ 去掉 `savePrefs` 的 `bump()`：级联是否成立（patch:111-122, 492-535）

**结论：成立。** 逐行链路（点一次"已收纳 ↔ 在侧栏"）：

1. `setFolded` → `savePrefs`（只写 prefs + `prefsEpoch+1`，**不再 bump**）→ `nudgeLedger` → `markDirty('settings.section')` → **version+1**，并排一个微任务 flush（patch:111-122, 338-360, 498-506）。
2. 微任务 flush → `record.listeners` 逐个回调（SlotCore `flush()` 偏移 498,060）→ 外壳的监听器
   `ctx.slots.subscribe("settings.section", listener)`（settings-general:1443-1449）。
3. 该 listener 是 `hooks.sections` 的订阅者，最终由 `bindSnapshotSelector` 绑到 uSES（renderer:155-160，**相等性默认 Object.is**）；SettingsRoot 用 `const rows = useSections((s) => s)`（settings-general:362）。
4. uSES 回读 `getSnapshot()`：version 变了 → rows **重建为新数组**（settings-general:1429-1441）→ selector 返回新引用 → **SettingsRoot 重渲染**。
5. SettingsRoot 渲染体：`open && (0, react_jsx_runtime.jsx)(SettingsPanel, { rows, renderSlot, activeId, onSelect, onClose })`（settings-general:486-492）。`SettingsPanel` 是**普通函数组件**（:261），**没有 memo**，也没有 `useMemo` 包住面板体 → **必然重渲染**。
6. SettingsPanel 渲染体：`children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })`（settings-general:341）→ 每次渲染都新建 `<SlotOutlet>` 元素 → SlotOutlet 重渲染（renderer:1117-1128）→ `renderOutletContent`（:1130-1222）→ `RootEntry`（key `e{entryKey}`）→ `<Comp {...新kit} {...新ownerProps}>` → **ToolboxSection 重渲染**。
7. 于是卡片、胶囊按钮、诊断行都拿到新 prefs；同时工具箱自己的账本订阅（patch:602-640）**刻意忽略**"账本数组未变"的推送，不再额外 bump —— 全程 **1 轮**工具箱渲染。

**成立的前提（必须写进代码注释，否则未来会静默坏掉）**：
- **P1** SettingsPanel 不被 memo 化、面板体不被 `useMemo` 缓存（当前成立，纯函数组件；这是宿主实现细节，不是契约）。
- **P2** 工具箱页只通过 settings 面板的 `renderSlot('settings.section', {only: active})` 渲染（当前唯一路径；若将来别处也渲染，那条路径不会级联）。
- **P3** 状态更新是**异步**的（微任务 → React 提交）；点完立刻读 DOM 的测试会看到旧值。正常交互不可感知。

**护栏选项（二选一）**：

- **B（稳妥，建议默认）**：恢复 `savePrefs` 的 `bump()`，接受"一次切换 2 轮渲染"。其余 5 项优化仍是净收益，且**不依赖任何宿主实现细节**。
- **A（保留 1 轮，接受耦合）**：维持现状，但必须做到：
  1. 在补丁里写明 P1/P2/P3 三条前提（尤其"SettingsPanel 及其面板体不得被 memo/useMemo 包住"）；
  2. 诊断块加一行说明，例如 `"导航级联：settings 面板 renderSlot（0.2.2-rc.1 已核对）"`；
  3. 可选自愈：`ToolboxSection` 渲染时把 `renderedEpoch = prefsEpoch` 记到模块级变量；`nudgeLedger` 成功后用**宏任务**检查，未渲染才补 `bump()`：
     ```js
     if (!nudgeLedger(ctx)) bump();
     else setTimeout(function () { if (renderedEpoch !== prefsEpoch) bump(); }, 0);
     ```
     - **必须用宏任务**：微任务早于 React 提交，会误判成"没渲染"，导致每次都多渲染一次。
     - **不要用 `getRevision()` 当判据**：外壳级联渲染不会改工具箱的 `revision`，用它必然误判。

> 取舍：A 省的是"每次切换少 1 次全量渲染"（N≈13 张卡片）；B 换来的是"UI 更新只依赖基线行为"。若本次优化要可量化收益，A 值得留，但前提必须写进代码。

### 2.5 ⑤ no-op 提前返回的等价性（patch:492-535）

| 函数 | 判据 | 等价性 |
| --- | --- | --- |
| `setMode`（:492） | `prefs.mode === mode` | ✅ checkbox 的 onChange 只在变化时触发；原来重复写同一值只是多一次 nudge |
| `setFolded`（:498） | `isFolded(id) === folded` | ✅ `isFolded` 已含 overrides / 核心页 / 模式三层判定；等价于"目标状态已达成就别写" |
| `foldAll`（:508） | `overrides[id] !== true` 有变化才写 | ✅ 注意 auto 模式下由 mode 隐式收纳的页**没有 override**，所以首次点击仍会写满 overrides（与基线一致） |
| `unfoldAll`（:522） | 拆成"偏好变化 / 展开态+宿主清理" | ✅ 只有偏好变化才 nudge；否则 `bump()`。修掉了原来"无变化也 nudge"的浪费；`unhostSection` 幂等，提前调用无害 |

一个可观察差异：`unfoldAll` 在"一切都没变"时直接 return（原来也会 nudge）——用户可见行为相同。

### 2.6 ⑥ 剩余性能点（按收益排序）

1. **卡片行每轮重建**（patch:660-730 区域）：N 个 `h("div", …)`/`h("button", …)` 每次工具箱渲染都重建。可把 Row 提成 `memo` 组件，props 只传 `{id, label, order, isFolded, isOpen, onToggle, onExpand}`（回调用 `useCallback` 或 ref 稳定）。
2. **`expanded` 清理循环**每轮 O(expanded × sections)：可并进 `readSections` 缓存里，或改成 `sectionsById` Map。
3. **`renderHosted` 内的 `{close: function(){}}`**（patch:592）每次调用新建：提到模块常量后，宿主页在 `SectionHost` 重渲染时能少一次 ownerProps 身份变化（收益小，因为 memo 已挡住大部分）。
4. **诊断行**每轮重算 `canMarkDirty` + 拼字符串：可忽略。
5. **宿主侧不可控**：外壳每次 rows 重建都会对 N 个 entry 调 `resolveSlotLabel`（settings-general:1434-1439，无缓存）。这是剩下最大的一块，但属于宿主代码。
6. **不可控**：任何插件 register/dispose、locale 变化都会让工具箱整页重渲染一次（因为它是当前 active section，面板必然重渲染）。要更快只能上虚拟列表。

---

## 3. 专项：插件 client ctx 上 `ctx.locale` 到底能不能用？

### 3.1 结论

**不能（未 inject 时）。** 补丁现在的 `localeRevision()` 永远返回 0，`ctx.locale.subscribe` 永远不会安装。

### 3.2 证据（cordis 服务注入语义）

1. fiber 只把 **inject 声明的服务**装进自己的 `_store`：
   `dsh/node_modules/@deepseek-ai/cordis/lib/index.js:393` `for (const name of Object.keys(this.inject)) this._checkImpl(name);`
2. `committed` 只是 `_store` 的浅拷贝：`:669` `this.committed = { ...this._store };`
3. 读服务时先查 `fiber.committed`，再沿父链向上：
   `:1267` `let impl = fiber.committed?.[prop];` … `:1270-1277` 逐层向上，最后
   `:1274` `if (!fiber.runtime) throw error;` —— **root fiber 的 `runtime` 为 null**（`:396-400`，root 的 `committed` 是空对象 `Object.create(null)`）→ 抛出 `:1257` 创建的 `cannot get property "locale" without inject`。
4. 所以补丁里两处 `ctx.locale` 读取（patch:178、patch:622）都会走进 try/catch 的降级分支。

### 3.3 影响

- 缓存 `locale` 轴退化为常量 0：语言切换后**不会**让 `readSections` 失效 → 工具箱列表里**别的插件注册的 section label**（`resolveLabel(options.label)` 调的是对方的 `t()` thunk）会停留在旧语言，直到下一次账本/偏好变化。
- `SectionHost` 的 `localeRev` 恒等 → 语言切换时宿主页不因它重渲染（宿主页若自己有 locale hook 则不受影响）。
- 功能不崩（全部被 try/catch 包住），属于"看起来有、其实是死的"代码。

### 3.4 修法

**推荐**：把补丁第 878 行改成
```js
const inject = ["slots", "locale"];
```
- 与设置外壳一致：`settings-general/lib/client.js:1339-1349` 的 inject 同时含 `"slots"` 和 `"locale"`。
- 代价：工具箱要等 locale 就绪才激活。web 组合里 locale 是核心服务（`dsh-client-locale` 提供），settings-general 本身就要求它，实际无风险；只有在"不含 locale 的极简组合"里才会永不激活。
- 收益：locale 轴真正生效，语言切换即时刷新；`localeRev` 的 memo 判据也有意义。

**备选**：不加 inject，则**删掉整条 locale 轴**（patch:176-185、:206-219 的 locale 参数、:598、:620-628、:576），把"死代码"清掉，并在注释里写明"label 不随语言切换刷新，直到下一次账本变化"。

### 3.5 顺带回答"是不是同一个根 ctx / 同一个服务实例"

- **ctx 不是同一个对象**：每个插件 fiber 都有自己的子 ctx —— `cordis/lib/index.js:346` `this.ctx = this.context = parent.extend({ fiber: this });`。
- **服务实例是同一个**：locale 由 `ctx.provide("locale", locale)` 注册一次（`dsh-client-locale/lib/client.js:1838`），cordis 的 `reflect.store` 按 isolate key 单例保存（`cordis/lib/index.js:1401` `this.store[key] = impl;`）。只要 inject 了，任何插件拿到的都是**同一个 LocaleFace**：
  - `getSnapshot()` 返回同一份 snapshot，含 `revision`（client-locale:1538-1540，注释明确 "stable reference between changes, uSES-safe"）；
  - `subscribe(fn)` 返回 unsubscribe（client-locale:1548-1553）。
- 所以补丁的用法（`getSnapshot().revision` + `subscribe`）在 API 层面是对的，**只差 inject 这一行**。

---

## 4. 处理清单

**必修**
- [ ] `const inject = ["slots", "locale"];`（补丁 :878），或删除 locale 轴（§3.4）。

**建议修（按价值）**
- [ ] ④ 的级联依赖：加注释说明 P1/P2/P3，并二选一——(B) 恢复 `savePrefs` 的 bump（最稳）；(A') 在 ToolboxSection 用 `useEffect([prefsEpoch])` 做"未渲染则补 bump"的自愈。
- [ ] 卡片行 memo 化（§2.6-1）。
- [ ] `expanded` 清理并进 sections 缓存 / 用 Map（§2.6-2）。

**可选 nit**
- [ ] `renderHosted` 的 `{close}` 提到模块常量（§2.6-3）。
- [ ] `canMarkDirty` 结果按 ctx 缓存一次（§2.1 末）。

**不需要改**
- ① `markDirty` 用法、② 账本维度缓存、③ memo comparator、⑤ no-op 判据 —— 均与宿主 0.2.2-rc.1 行为一致。

---

## 5. 未验证项（建议真机 / React Profiler）

1. 一次折叠切换的实际渲染轮数：预期 `SettingsRoot` 1 次、`SlotPanel/SlotOutlet(settings.section)` 1 次、`ToolboxSection` 1 次、`SectionHost` 0 次（未展开时）。
2. `ctx.slots._core` 在运行中可读（诊断行"版本推送：markDirty（不写账本）"即为证据）。
3. 修好 inject 后，切换语言是否即时刷新工具箱列表 label。
4. 补丁上线后 `localStorage` 里 `dsh-toolbox.prefs.v1` 的形态（no-op 守卫会少写冗余 override，属预期）。
