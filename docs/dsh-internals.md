# DSH 槽位 / 设置外壳内核调研（app.asar 源码级）

> 调研对象：本机 DSH Desktop **0.2.2-rc.1**（`dsh/package.json:4` `"version": "0.2.2-rc.1"`，包名 `@deepseek-ai/dsh-desktop-runtime`）。
> 关联包版本同为 `0.2.2-rc.1`：`dsh-client-modules`、`dsh-client-ui-renderer`、`dsh-client-ui-settings-general`、`dsh-web-frontend`、`dsh-client-hmr`。
> 写于 2026-11-17，针对 `dsh-toolbox` 0.1.0 的性能优化。**只读调研**，未改任何宿主/插件文件。
> 所有路径都是 **app.asar 内相对路径**（`D:\Program\DSH\DSH Official\resources\app.asar`），前缀 `dsh/` = asar 顶层目录。

---

## 0. 先纠正三处交接文档里的错误（会直接影响优化方向）

| # | HANDOVER.md 的说法 | 实际（0.2.2-rc.1） |
| --- | --- | --- |
| 1 | 槽位实现在 `node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js` | **asar 里没有这个包**（`@deepseek-ai` 下 300+ 包里搜不到 `*slot*` 路径）。SlotCore 实际被编进**前端壳 bundle**，作为 *static seed module* 存在（见 §1.1）。 |
| 2 | 假条目推版本是唯一办法 | 不注册条目也能推版本：`ctx.slots._core.markDirty(key, record)` 可直接调用（见 §3）。 |
| 3 | "bundle 组合只在启动时发生" | 组合（compose）是**增量重算**的：启动一次、每次 graph 变化一次、每次 client bundle 重建一次（`dsh-client-modules/lib/index.js:970-1004`、`:687-705`）。index.html 也是**每请求重渲染**（`dsh-host-frontend-static/lib/index.js:77`）。 |

**版本事实**：客户端热更新不需要重启宿主，连浏览器刷新都不需要（`dsh-client-hmr` 500ms 轮询 + SSE 热重启单条目，见 §5.3）。

---

## 1. Q1 槽位核心：entries / entriesOfSlot / register / dispose / 通知时机

### 1.1 SlotCore 在哪、怎么被加载

- **文件**：`dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BgUyXZcc.js`（970,770 字节，**198 行**，第 123 行是压缩后的巨型行）。
- SlotCore 类定义偏移 **489,082**（`var OI=class{ records=new Map; factories=new Map; mutateListeners=new Set; ... }`）；导出在偏移 498,249：
  ```js
  const MI=Object.freeze(Object.defineProperty({__proto__:null,SlotCore:OI,SlotOwnershipError:jI,StaleAuthorizationError:zI,resolveSlotLabel:EI,standardHookPropName:II},Symbol.toStringTag,{value:"Module"}))
  ```
- 为什么 asar 里找不到 slot 包：壳 bundle 把 11 个包做成 *seed module*（第 196 行，偏移 946,917）：
  ```js
  function YZ(){return{react:fk,"react/jsx-runtime":gk,"react-dom":xk,"react-dom/client":Ck,
    "@deepseek-ai/cordis":Rb,zod:JS,"@tanstack/react-virtual":rI,
    "@deepseek-ai/dsh-client-store":SI,"@deepseek-ai/dsh-client-ui-slots":MI,
    "@deepseek-ai/dsh-client-ui-primitives":FU,"@deepseek-ai/dsh-client-ui-dockkit":WZ}}
  ```
  浏览器侧模块解析第一优先级就是 seed（`dsh-client-modules/lib/client.js:881-890`：`if (this.seed.has(specifier)) return this.seed.get(specifier);`）。
  **结论**：`require("@deepseek-ai/dsh-client-ui-slots")` 拿到的是壳里的**单例**；所有客户端 bundle 共用同一个 SlotCore 类。
- Registry（`ctx.slots`）在另一个文件：
  `dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1305-1306`
  ```js
  var SlotRegistry = class extends _deepseek_ai_cordis.Service {
    _core = new _deepseek_ai_dsh_client_ui_slots.SlotCore();
  ```
  服务注册：`super(ctx, "slots")`（`:1348`），启动挂载：`new SlotRegistry(ctx).install(createSlotRenderer())`（`:1868`）。

### 1.2 `entries(key)`：**不新建数组**，mutation 之间引用稳定

偏移 494,194：
```js
entries(e){return this.records.get(e)?.entries??b1}
```
- `b1 = Object.freeze([])`（偏移 **489,042**，`const b1=Object.freeze([])`）：**空账本返回同一个冻结数组**。
- 非空时返回 `record.entries` 本体，即**同一个数组引用**，直到下一次 register/dispose 换新数组。
- Registry 侧的文档也明说（`dsh-client-ui-renderer/lib/client.js:1538`）：
  ```js
  /** Snapshot entries for a key (render-erased view; stable reference between mutations). */
  entries(key) { return this._core.entries(key); }   // :1542-1544
  ```
- ⚠️ 对过滤器的意义：`dsh-toolbox` 的 `filteredEntries` 用 `cacheSrc === list` 做缓存键是**成立的**（账本引用稳定），但它自己每次折叠集变化都会换 `cacheSig`，所以缓存只在"账本没动 + 折叠集没动"时命中。

### 1.3 `entriesOfSlot(key)`：**每次新建数组**，按 cell 取赢家

偏移 494,245：
```js
entriesOfSlot(e){const t=this.records.get(e);if(!t?.spec)return b1;const r=t.spec.kind;
  if(r==="chain")return t.entries;const i=[],n=new Set;
  for(const s of t.entries){if(this.abdicated.has(s))continue;
    const l=r==="keyed"?s.options.key:r==="list"?s.options.id:void 0;
    n.has(l)||(n.add(l),i.push(s))}return i}
```
- `list`/`keyed`：按 `priority → order` 排序后**第一个未被 abdicate 的**入 cell（低 priority 优先，同 priority 低 order 优先）；**每次调用都 new 一个数组**。
- `chain`：直接返回 `record.entries`（引用稳定）。
- Registry 注释对得上（`:1545-1556`）：`Fresh array per call, not a uSES getSnapshot source.`
- **关系总结**：`entries()` = 全量账本（含被 shadow 的、含 abdicated 的）；`entriesOfSlot()` = 每个 cell 的胜者（渲染用）。两者**不是同一份数据，也不是同一份缓存**。侧栏导航读 `entries()`，`renderSlot` 读 `entriesOfSlot()` —— 这正是工具箱"折叠但不注销"的立足点。

### 1.4 `register()`：换新数组 + 排序 + 版本 +1

偏移 491,276 起（`register(e,t){`），关键几句：
```js
const u=[...r.entries,l];
if(u.sort(i.kind==="list"
   ?(f,h)=>(f.options.priority??0)-(h.options.priority??0)||(f.options.order??0)-(h.options.order??0)
   :(f,h)=>(f.options.priority??0)-(h.options.priority??0)), r.entries=u,
   this.markDirty(e.name,r), e.children){ /* 每个子槽位：record+spec+markDirty+notifyDeclaration */ }
return()=>{ r.entries.includes(l)&&(r.entries=r.entries.filter(f=>f!==l),this.markDirty(e.name,r),this.releaseEntry(l)) }
```
（数组替换 + 排序在偏移 ~492,9xx；dispose 分支在偏移 494,019。）

- 排序维度：`list` = priority 升序 → order 升序；其余 = 只按 priority。
- 每次 register / dispose 都**新建数组**（旧引用作废，uSES 快照失效）。
- register 还做：单/键/列表重复检查（同 priority 同 id 抛错）、`children` 重声明检查、store handle 的 scope 冲突检查（一次性校验，见 §4）。

### 1.5 `markDirty` / `flush`：**版本同步 +1，订阅者微任务批量通知**

偏移 497,821（`markDirty`）、498,060（`flush`）：
```js
markDirty(e,t){ t.version+=1;
  for(const r of[...this.mutateListeners]) r(e);          // ① 同步：mutateListeners
  this.dirty.add(t);
  this.flushScheduled||(this.flushScheduled=!0, queueMicrotask(()=>{ this.flush() })) }  // ② 微任务
notifyDeclaration(e){ for(const t of[...e.declarationListeners]) t() }                   // ③ 同步：inject 回调
flush(){ this.flushScheduled=!1; const e=[...this.dirty]; this.dirty.clear();
  for(const t of e) for(const r of[...t.listeners]) r() }                                // ④ 每个 dirty record 的 listeners 各一次
```
- **`getVersion(key)` 是同步可读的**：偏移 496,327 `getVersion(e){return this.records.get(e)?.version??0}`。
- **`subscribe(key, fn)` 的 fn 在微任务里触发**，同一 tick 内多次 mutation **只 flush 一次**（`flushScheduled` 合并）。
- `register` + 立刻 `dispose`（同一 tick）= **版本 +2，通知只 1 次**。当前 `nudgeLedger` 就是这个效果。
- `mutateListeners`（`onMutate`，偏移 496,380）是**同步**的，Registry 用它桥接成 cordis 事件（`dsh-client-ui-renderer/lib/client.js:1349-1351`）：
  ```js
  this._core.onMutate((key) => { ctx.emit("slots/changed", key); });
  ```
- `declarationListeners`（`inject` 的等待者）在 **register 内部同步**回调（`notifyDeclaration`），不排队。

---

## 2. Q2 设置外壳热路径（`dsh-client-ui-settings-general`）

文件：`dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`（1622 行）。

### 2.1 rows 缓存键 = `getVersion('settings.section')` + `locale.getSnapshot().revision`

`:1411-1441`：
```js
let rowsVersion = -1; let rowsRevision = -1; let rows = [];
const shellInjected = () => ({
  openDesktopUpdate: () => { ... },
  hooks: {
    sections: {
      getSnapshot: () => {
        const version = ctx.slots.getVersion("settings.section");        // :1429
        const revision = ctx.locale.getSnapshot().revision;              // :1430
        if (version !== rowsVersion || revision !== rowsRevision) {
          rowsVersion = version; rowsRevision = revision;
          rows = ctx.slots.entries("settings.section").map((e) => ({    // :1434  ★ 唯一的 entries() 调用
            id: e.options.id ?? "",
            order: e.options.order ?? 0,
            label: resolveSlotLabel(e.options.label) ?? ""               // :1438  ★ label thunk 在此调用
          })).sort((a, b) => a.order - b.order);
        }
        return rows;                                                     // :1441  命中缓存就返回同一数组
      },
      subscribe: (listener) => {
        const offLedger = ctx.slots.subscribe("settings.section", listener);  // :1444
        const offLocale = ctx.locale.subscribe(listener);                     // :1445
        return () => { offLedger(); offLocale(); };
      }
    },
    ...
```
- **调用次数**：`SettingsRoot` 里 `const rows = useSections((s) => s)`（`:362`）→ uSES-with-selector 的 `getSnapshot` **每次渲染调用 1 次**，但只有 version/locale 变化时才真正走 `entries()`。所以：
  - 无版本变化的重渲染：**0 次** `entries()`；
  - 版本变化后的那一次渲染：**1 次** `entries()` + N 次 `resolveSlotLabel`。
- `label` 是 **行构建时调用**（在 getSnapshot 里），不是渲染时；`resolveSlotLabel` **无缓存**，就是直接调 thunk：
  壳 bundle 偏移 488,993：`function EI(e){return typeof e=="function"?e():e}`（= 导入名 `resolveSlotLabel`）。
- 所以外壳每次重算 = **1×entries + N×(label thunk) + 1×sort**。N = 当前账本条数（本机 13~14）。

### 2.2 一次折叠集变化 → 几轮渲染（源码推断）

以工具箱点一次"已收纳 ↔ 在侧栏"（`setFolded` → `savePrefs` → `nudgeLedger`）为例：

| 步骤 | 触发 | 效果 |
| --- | --- | --- |
| 1 | `savePrefs()` → `bump()`（`lib/client.js:112`） | 工具箱自己的 `useSyncExternalStore` 重渲染（**第 1 轮**，此时侧栏 rows 还是旧缓存） |
| 2 | `nudgeLedger()`：register（version+1）→ dispose（version+1） | `markDirty` 同步 emit `slots/changed` ×2；微任务只排 1 次 flush |
| 3 | 微任务 flush | ① 外壳 `subscribe` → uSES 重渲染 → getSnapshot 发现 version 变了 → `entries()`（走工具箱过滤器）→ rows 重算；② 工具箱 `ctx.slots.subscribe("settings.section")`（`lib/client.js:457`）→ `bump()` → **第 2 轮** |
| 4 | 若展开/收起导致 `SectionHost` mount/unmount | 再加 1 次 register/dispose（`toolbox.page`）+ 微任务 flush + 页面组件挂载 |

**结论**：一次折叠切换 = **工具箱至少 2 轮渲染 + 外壳 1 轮 rows 重算**，且每轮工具箱渲染都会 `readSections()`（排序 + 全部 label thunk，`lib/client.js:451`）。这是当前最明显的浪费点（见 §7）。

---

## 3. Q3 不注册假条目，能不能推版本 / 通知订阅者？

### 3.1 `ctx.slots._core` **可以直接拿到**（本版本成立）

- 字段来源：`dsh-client-ui-renderer/lib/client.js:1306` `_core = new SlotCore()`，是 **公开的类字段**（不是 `#private`）。
- 能否穿过 cordis 访问：`ctx.slots` 拿到的是 cordis 给 Service 包的一层 **traceable Proxy**（`dsh/node_modules/@deepseek-ai/cordis/lib/index.js:125-163` `createTraceable`）：
  ```js
  const desc = getPropertyDescriptor(target, prop);
  if (desc && "value" in desc) innerValue = desc.value; ...
  const innerTracker = innerValue?.[symbols.tracker];
  if (innerTracker) return createTraceable(...); 
  else if (!tracker.noShadow && typeof innerValue === "function") { ... return createShadowMethod(...) }
  else return innerValue;
  ```
  `_core` 是实例自有的**值属性**，值是普通 SlotCore 实例（没有 `symbols.tracker`）→ **原样返回**。所以 `ctx.slots._core` 就是那个 SlotCore 单例。
- 顺带两条本版本事实（对 `installNavFilter` 有利）：
  - `ctx.slots` 每次读取都会 **new 一个 Proxy**（没有缓存）→ `ctx.slots !== ctx.slots`，但 `Object.getPrototypeOf(ctx.slots)` = `SlotRegistry.prototype`（Proxy 未定义 getPrototypeOf 陷阱，落到 target）。
  - 方法属性会被包一层 `createShadowMethod`（每次访问新建 Proxy），`this` 被换成 "shadow ctx"；但该 shadow 的属性查找仍落到 Registry 实例上，所以 `this._core` / 原型上的 `entries` 都能正常读到 —— 现有 `original.call(this, key)` 写法成立。

### 3.2 最小可用路径：`markDirty`（不注册任何条目）

```js
const core = ctx.slots._core;                    // SlotCore 单例
const rec  = core.record("settings.section");    // 取（或创建）record，见偏移 495,9xx record(e)
core.markDirty("settings.section", rec);         // version+1 → mutateListeners 同步 → 微任务 flush
```
- `record(key)` 偏移 **497,382**：`record(e){let t=this.records.get(e); return t||(t={spec:void 0,...,version:0,listeners:new Set,declarationListeners:new Set}, this.records.set(e,t), t)}`（不存在就建，副作用极小）。
- 效果与 `nudgeLedger` **等价（对外可见面完全相同）**：`getVersion` +1、`slots/changed` 同步 emit 1 次、`subscribe` 回调微任务 1 次；**但账本数组不变**（`entry.entries` 不动），不触发排序、不触发 `children` 校验、不产生任何临时 id。
- 对比现状（`lib/client.js:255-275`）：register+dispose = 2 次 markDirty、1 次 `[...entries, entry]`+sort、1 次 filter、2 次 `slots/changed` emit，且依赖过滤器把 `__toolbox_nudge_*` 剔掉才不闪空行。

### 3.3 其他路径与风险评估

| 路径 | 可行 | 说明 / 风险 |
| --- | --- | --- |
| **A. `ctx.slots._core.markDirty(key, _core.record(key))`** | ✅ 推荐 | 最小、无账本副作用。风险：三个私有成员（`_core` / `record` / `markDirty`）任一改名即失效 → **必须做能力检测 + 回退到假条目**：`typeof core?.markDirty === "function" && typeof core?.record === "function"`。 |
| B. patch `SlotRegistry.prototype.getVersion` + `subscribe`，用私有 revision 叠加 `settings.section` | ✅ 可行（更"公开"） | 只用公开方法，但要把原 subscribe 的 disposer 串起来、只对目标 key 生效；每次读 `getVersion` 都多一层调用。比 A 多写 ~30 行，收益相同。 |
| C. `ctx.slots._core.reportEntryError(key, dummyEntry, err, {abdicate:true})`（偏移 496,464） | ⚠️ 不推荐 | 也会 markDirty，但会把 `dummyEntry` 加进 `abdicated` WeakSet 并**广播 entryErrorListeners**（外壳有错误 UI / 插件列表会记录失败）。 |
| D. `ctx.emit("slots/changed", "settings.section")` | ❌ 不够 | 只是事件，**不改 version**，外壳的 rows 缓存对照版本号 → 不会重算（除非有人监听该事件并自己 setState）。 |
| E. dispose + 重新 register 工具箱自己的 section | ❌ | 版本 +2 但会把工具箱页整页卸载重挂（组件状态、展开集、DOM 全丢）。 |
| F. 直接改 `record.version++`（不调 markDirty） | ❌ | 版本变了但**不排 flush**，订阅者永远不通知 → 外壳 rows 不刷新（下次 flush 才顺带刷）。 |

**结论**：可以完全不注册假条目。推荐 A + 能力检测回退；若追求"只用公开 API"，选 B。

---

## 4. Q4 renderSlot / 子槽位注册 / SectionHost 的成本点

### 4.1 `renderSlot` 本身：绑定缓存，但出口组件每帧重算

- 绑定按 entry 缓存（`dsh-client-ui-renderer/lib/client.js:341-360` `renderSlotCache`）：`renderSlot(key, owner, opts)` 每个 entry 只创建一次闭包，检查 `isLive(entry)` + `entry.children?.[key]` 后返回 `<SlotOutlet slotKey ownerProps opts/>`。
- `SlotOutlet`（`:1117-1128`）每次渲染：
  ```js
  useSyncExternalStore((fn)=>host.subscribe(slotKey,fn), ()=>host.getVersion(slotKey));   // :1119
  const spec = host.specOf(slotKey);                                                      // :1122
  ```
- `renderOutletContent`（`:1130-1222`）对 list 槽位：
  ```js
  const entries = host.entriesOf(slotKey);          // = _core.entries（全量，含 shadow）
  const rows = host.entriesOfSlot(slotKey).map(...) // 新数组
  ... rowIds 去重 ... let list=[...rows].sort((a,b)=>a.order-b.order)   // :1218 复制+排序
  if (opts?.only !== void 0) list = list.filter(...)                     // :1219
  ```
  → **每次出口渲染都有 1 次 new 数组 + 1 次 sort + 1 次 filter**，与 entry 数量线性相关。这是"每次父组件重渲染都付一次"的成本。
- props 组装（`standardKit` `:736-767` + `RootEntry` `:882-888`）：
  - `kit` 对象**每次渲染都新建**（`{...standard, renderFactorySlot}`），但里面每个函数/源都是缓存引用：`renderFactorySlot` 按 entry 缓存、`renderSlot` 按 entry 缓存、`observableHook` 按 source 缓存（`:219-227`）、`localeSeat` 按 (face, ns, revision) 缓存（`:541-558`）。
  - `inject` 结果按 entry 缓存（`rootInjectCache`，`:431-434/499-506`）→ **`inject()` 每个 entry 只跑一次**，不是每帧。
  - 最终 `<Comp {...kit} {...injected} {...slotInjected.props} {...ownerProps} />`（`:792-798`）→ **props 身份每帧都变**，`React.memo` 对宿主页面组件无意义（除非只传稳定引用）。
- `store` 席位（`:1603-1615` `_register` + `:1713-1729` `resolveStore`）：
  - `store` 是**共享 handle** 时：`_acquire` 引用计数 +1，`resolveStore` 按 scope key 取**已有实例** → **重新注册同一页不会新起实例**，行为等价、成本可忽略。
  - `store` 是**独占 factory**（`() => handle`）时：按 occurrence 新起实例（`:1730-1753`）→ 每次重挂都是新 store。
- `locale`：注册时只存 namespace 字符串；渲染时 `localeSeat` 命中缓存（同 revision 返回同一个 `t`），首帧才 `face.bind(ns)`。

### 4.2 子槽位 register 的成本（`toolbox.page` 这种"展开才注册"）

单次 `ctx.slots.register(options, Comp)` 的真实开销（`dsh-client-ui-renderer/lib/client.js:1813-1815` → `:1602-1623` → SlotCore.register）：

1. `this.ctx.effect(() => this._register(...), "slots.register()")` —— **挂一个 cordis effect**（fiber 卸载时自动回收）；
2. `_register`：`options.store` 若是函数则**立即调用**取 handle；拼 `erased` 对象；`_core.register` 做 §1.4 的全部校验（重复 cell、store scope 冲突、children 重声明）+ 数组复制排序 + markDirty；
3. `_acquire(store, scope)` 引用计数；
4. 返回幂等 disposer（首次 dispose 时 `_core` filter + markDirty + `releaseEntry` + `_release`）。

**"展开才注册"的模式没有隐藏额外开销**：一次展开 = 1 register + 1 dispose + 1 次微任务 flush + 被挂页面的首次挂载。相对"一直注册着"只多了这两次 O(n) 数组操作（n = 子槽位条目数，通常 1）。真正的成本在**被展开页自身**（表单/列表首帧）和 §4.3 的重渲染传导。

### 4.3 展开的页在父组件重渲染时会不会被重建？——不会 remount，但会**级联重渲染**

链条：
`ToolboxSection`（每次 `bump()` 重渲染）→ `sections.map` 里 `h(SectionHost, {section, ctx, renderSlot})`（`lib/client.js:519`）→ `SectionHost` 渲染 `props.renderSlot(PAGE_SLOT, {close: function(){}}, {only})`（`:442`）→ `SlotOutlet` 重渲染 → `RootEntry` → `<Comp {...新kit} {...新ownerProps}>`。

- **不会重建**：`SectionHost` 的 `useEffect` 依赖是 `[section.id, section.entry]`（`:433`），`section.entry` 是账本里的稳定 entry 对象 → 父组件重渲染**不会**重复 register/unregister。
- **会重渲染**：React 按 key 复用（`SlotOutlet` 位置固定、`RootEntry` key = `e{entryKey}`），但每次父渲染都会给它**新的 props 身份**（`kit` 新对象、`ownerProps` 新对象 `{close}`、`section` 新对象）→ 被展开页（及其子树）**每次都重渲染**。
- ⚠️ 现状还有一个放大器：`readSections()`（`lib/client.js:151-175`）**每次调用都新建 section 包装对象**（`{id, order, label, source, entry}`），所以 `SectionHost` 的 `section` prop 每帧都是新引用 → `React.memo(SectionHost)` **现在完全无效**，必须改成传原始字段（id/order/label/entry）或把 memo 的比较函数写成按 `id + entry` 比较。
- 结论：**有 memo 机会**，但前提是先消除"每帧新对象"（`ownerProps` 提到模块常量、`readSections` 结果按 (账本引用, prefs revision) 缓存、`SectionHost` 用 `memo(..., (a,b)=>a.section.id===b.section.id && a.section.entry===b.section.entry && a.open===b.open)`）。

---

## 5. Q5 客户端 bundle 如何加载 / `immediately` 的真实含义 / 改了要不要重启

### 5.1 加载模型：bundle 只"注册工厂"，apply 在条目激活时跑

`dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js`
- bundle 顶层只有 `window.__ModuleLoader__.load({id, factory})` → 只是把 factory 塞进表（`:704-716` `register(registration)`），**模块体副作用（含 CSS 注入）在 factory 执行时才发生**。
- 脚本加载 = 同源经典 script 注入（`:581-594` `defaultLoadBundle`）：
  ```js
  const el = document.createElement("script"); el.async = true; el.src = url;
  el.addEventListener("load", () => { el.remove(); resolve(); }, {once:true});
  document.head.append(el);
  ```
- 条目编排（`:383-399` `start`）：boot 时对 `manifest.plugins` **每一个** row 都 `loader.create({name:id})` → cordis 条目激活 → `import(id)`（`:881-895`）→ `arriveGraphRow` → 注册工厂 → `materialize` → 调用 bundle 的 `apply(ctx, config)`。
- **注意**：`manifest.plugins` = graph 里的**每一行**（`parseBootManifest` `:137-141` 无条件 push），不是只有 `immediately` 的。

### 5.2 `immediately: true` 的真实含义 = **预热**，不是"立即激活"

- 声明侧：`package.json` 的 `dsh.client.immediately`（host 读取：`dsh-client-modules/lib/index.js:800` `immediately: decl.immediately === true`；写进 graph row：`:466` `...fields.immediately ? { immediately: true } : {}`）。
- 消费侧：壳 bundle（`index-BgUyXZcc.js` 第 196 行，偏移 949,793）：
  ```js
  async prefetchImmediateTier(){ await Promise.all(
    this.manifest.plugins.filter(e=>e.immediately).map(e=>this.modules.prefetch(e.id).catch(t=>{}))) }
  ```
  调用点在 `run()` 里：`const n=this.prefetchImmediateTier(), s=new ut; this.ctx=s, this.page.setTotal(...), await n, await KZ({ctx:s, modules:this.modules, manifest:this.manifest, ...})`
  → **在条目挂载（KZ）之前**把所有 `immediately` 行的 bundle 拉下来并注册工厂。
- `prefetch` 语义（`client.js:896-902`）：`arriveGraphRow` → 只注册工厂，**不 materialize、不 apply**。
- **对工具箱**：`package.json` 里 `immediately: true` 只让 `/plugins/.../client.js` 在首屏前多一次预热请求，**不影响 apply 时机**（apply 由 cordis 条目激活驱动，宿主半边 `lib/index.js` 存在即激活）。

### 5.3 改 `lib/client.js` 后：**不用重启宿主，通常也不用刷新浏览器**

`dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js`
- 默认每 **500ms** stat 轮询每个 graph 行的 bundle 文件（`:22` `pollIntervalMs: ... .default(500)`；`:79-92` `pollWatches`）：
  ```js
  const bundleStat = (path) => { const b = statSync(path);
    return { mtimeMs: b.mtimeMs, ctimeMs: b.ctimeMs, size: b.size }; };   // :28-35
  ```
- 变了就 `ctx.clientModules.rebuilt(id)`（`:48-62`）→ host 侧重算 rev 并重新读字节（`dsh-client-modules/lib/index.js:687-705`）：
  ```js
  rebuilt(id){ const baseline=this.captureArtifactBaseline(record.meta.clientPath);
    const rev=artifactRevision(baseline); if (rev===record.entry.rev) return rev;
    const bundle=readFileSync(record.meta.clientPath); record.baseline=baseline;
    record.entry=graphRow(id,rev,record.meta); record.bundle=bundle;
    this.composed=this.compose(); for (const notify of this.rebuildListeners) notify(id,rev); this.notifyGraphChanged(); return rev }
  ```
- 同时通过 SSE `/plugins/events` 推 `{type:"rebuilt", id, rev}`（`:140-169`）→ 浏览器半 `dsh-client-hmr/lib/client.js:269-296`：
  ```js
  const handle = (frame) => { (frame.type === "graph" ? ... entries.sync(frame.graph) : entries.reload(frame.id, frame.rev)).catch(...) }
  ```
- `entries.reload(id, rev)`（`dsh-client-modules/lib/client.js:431-461`）→ `replace()`（`:492-505`）：
  `index.invalidateForReplacement(id, rev)` → `prefetch(id)`（新 rev URL）→ `tearDownEntryFiber(entry)` → `removeOwnedStyles(id)` → `modules.import(id)` → `entry.refresh()`
  → **插件条目热重启（apply 重跑、旧 DOM/CSS 清掉），页面不刷新**。
- ⚠️ 两个前提/坑：
  1. rev 由 **mtimeMs + ctimeMs + size** 派生（`dsh-client-modules/lib/index.js:222-228` `artifactRevision`）——三者全不变就检测不到（正常保存必然会变 mtime，除非刻意回写）。
  2. 若 `dsh-client-hmr` 未挂载：**光刷新浏览器不一定生效** —— 同一 rev 的响应体是缓存的（`compose()` 里 `buildCombo([record])` 用的是扫描时快照的 `record.bundle` 字节，`index.js:751-760`），没有任何按请求读盘。此时只能靠条目重启（启停插件）或重启宿主。
- 实测口径：本会话运行时上下文已声明 *"The client-plugin HMR receiver is active"*；热重启的具体耗时建议真机用 `performance` 面板量。

---

## 6. Q6 `/plugins` 路由：URL 形态、rev 含义、组合时机

文件：`dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`

### 6.1 路由注册

`:620-630`：
```js
const registerWebCarrier = (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register({
    kind: "prefix", path: PLUGIN_ROUTE,                       // const PLUGIN_ROUTE = "/plugins"  (:230)
    resource: (request) => this.fetchBundle(request)
  }), "client-modules: bundle route");
};
ctx.inject(["webServer"], registerWebCarrier);
ctx.on("webserver/index-inject", (table) => { table.push(...bootInjections(this.composed)); });   // :628-630
```

### 6.2 URL 形态（本版本真实字符串）

- 单包/组合脚本（`comboSearch` `:262-268`）：
  ```js
  const comboSearch = (ids, rev, sourceMap=false) =>
    `??${ids.map(id=>`${id}/client.js${sourceMap?".map":""}`).join(",")}&rev=${rev}`;
  const comboUrl = (ids, rev, sourceMap=false) => `${PLUGIN_ROUTE}/${comboSearch(ids, rev, sourceMap)}`;
  ```
  → 单行示例：`/plugins/??dsh-toolbox/client.js&rev=0a1b2c3d4e5f`
  （**两个问号是字面量**：第一个开启 query，第二个是 key 的一部分；host 用 `pathname+search` 原样拼回字符串做 Map 查找，`:1103-1104`。所以不要"美化"成 `?id=...`。）
  → 多包组合：`/plugins/??a/client.js,b/client.js&rev=...`（3 KiB 上限自动分组，`:294-311`）
  → 浏览器侧用**文档相对形式**（去掉开头 `/`）：`plugins/??a/client.js&rev=...`（`:269-277` `comboReference`）。
- 包内分块（`chunkUrl` `:278-281`）：`/plugins/<id>/client.<name>.js?rev=<rev>`（按需、首次请求才读盘、之后缓存）。
- 包资源（`PACKAGE_ASSET_PATH` `:236`）：`/plugins/<pkg>/assets/<path>`（**每次请求都读盘**，`:1062-1088`）。
- `rev` = 12 位 sha1：行 rev 由 **bundle 文件 stat（mtime/ctime/size）** 派生（`:222-228`），组合 rev 由有序行 rev 派生（`compose()` `:766-771`，`shortHash(JSON.stringify({entries,batches}))`）。`rev` 只用于缓存键 + 一致性校验，**不是内容哈希**。
- 缓存头：所有 bundle/chunk 响应 `cache-control: public, max-age=31536000, immutable`（`:188` `IMMUTABLE_CACHE`，`:1105-1112`）。所以"同一 URL 的字节永不改"是硬契约 → 换内容必须换 rev。

### 6.3 "bundle 组合只在启动时发生"——不成立

- 组合（compose）在：① 服务构造（启动，`:616-619`）；② 每次 flush（plugin 启停/graph 变化，`:970-1004`）；③ 每次 `rebuilt()`（`:687-705`）。
- index.html 的注入行是**每次 index 请求重算**的：
  `dsh/node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js:68-106` `serveStatic`，`:77` `body = renderIndex(await readFile(distIndex, "utf8"))`；
  `:132` `registerFallback({ resource: (...) => serveStatic(..., (html) => ctx.webServer.renderIndex(html, ...)) })` → `renderIndex` 会跑 `webserver/index-inject` 的 tap（即 `bootInjections(this.composed)`）。index 响应**没有 cache 头**（`:78` 只设 content-type）。
- `bootInjections`（`dsh-client-modules/lib/index.js:518-563`）按顺序产出：① 内联 `__ModuleLoader__` 队列脚本；② `application` 批次 `<link rel=modulepreload>`；③ `bootstrap` 批次 `<script src>`（阻塞）；④ `global __DSH_BOOT__ = graph`。
- **对 client 文件热更新的影响**：页面刷新能拿到**最新 graph/rev**（因为每请求重渲染），但能否拿到**最新字节**取决于 rev 是否已更新；rev 更新只由 `rebuilt()`（HMR 轮询）或条目重启触发。→ 结论：**刷新 ≠ 拿到新字节**，见 §5.3。

---

## 7. 对 dsh-toolbox 的直接优化映射（按收益排序）

| # | 现状（`lib/client.js`） | 成本 | 建议 |
| --- | --- | --- | --- |
| 1 | `filteredEntries` 每次都 `foldedSet(readSections(ctx))`（`:221`） | 每次 `entries('settings.section')` = `readSections` 全量：遍历 + **每个 label thunk 调用** + 排序（`:151-175`）；外壳重算 1 次/版本变化，工具箱自己渲染还要再来 1 次 | 过滤只需要 **id 集合**：直接 `original.call(this,key)` 取账本、对 `entry.options.id` 跑 `isFolded()`，**不排序、不调 label、不建 section 对象**。折叠集用 `(账本数组引用, prefs revision)` 缓存。 |
| 2 | `nudgeLedger` 注册/释放假条目（`:255-275`） | 2 次 markDirty + 数组复制排序 + 2 次 `slots/changed`，并把 `__toolbox_nudge_*` 塞进账本（过滤器必须兜底剔除） | 改 `ctx.slots._core.markDirty("settings.section", core.record("settings.section"))`，能力检测失败再回退假条目（§3.2）。 |
| 3 | `savePrefs` 的 `bump()` + 账本 flush 的 `bump()` 各触发一次全量渲染（`:112`、`:456-463`） | 每次切换 = 工具箱 2 轮渲染（每轮全部卡片重建） | nudge 前设 `suppressLedgerBump = true`，flush 微任务里消费一次后复位；或把 ledger 订阅回调做 rAF/微任务去抖。 |
| 4 | `ToolboxSection` 渲染中直接 `readSections(ctx)`（`:451`） | 每次渲染 N 次 label thunk + sort + N 个新对象 | 按 `(账本数组, prefs revision)` 缓存结果；label 只在需要显示时调（或缓存字符串）。 |
| 5 | `SectionHost` 的 `section`/`ownerProps` 每帧新对象（`:442`、`:519`） | 展开页每次父渲染都重渲染（§4.3），memo 失效 | `ownerProps` 提到模块常量；`SectionHost` 改 `memo` 且只传 `{id, order, entry, open}` 原始值；卡片行同理。 |
| 6 | 过滤器的 `cacheSig` 拼接字符串（`:227-228`） | 折叠集大时每次 O(n) 字符串拼接 | 用 `prefs` 版本号或 `Set` 引用做签名。 |

> 说明：1→6 都是**纯客户端**改动，不碰宿主、不碰槽位契约；且 1/2/4 与"外壳重算次数"这条主线直接相关。

---

## 8. 附：读 app.asar 的正确姿势（本机实测，与常见教程不同）

- 文件：`D:\Program\DSH\DSH Official\resources\app.asar`，**213,202,918 字节**，22,102 个条目。
- 头部实测（**注意本包比教科书多一个 u32**）：
  ```
  u32@0  = 4            （header size 字段自身的 pickle 长度）
  u32@4  = 5748132      （headerSize）
  u32@8  = 5748128      （= headerSize - 4，多出来的一层）
  u32@12 = 5748124      （= jsonLen）
  u32@16 = '{' …        （JSON 起始）
  文件数据起点 = 8 + headerSize = 5,748,140 = 16 + jsonLen   ✅ 自洽
  ```
- 稳健读法（两种布局都吃）：`headerSize = u32@4`；`dataStart = 8 + headerSize`；从 offset 8 起向后扫第一个 `0x7B('{')` 得 JSON 起点；`jsonLen = dataStart - jsonStart`。**不要**假设 JSON 一定在 12。
- 单文件抽取：`fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset))`（offset 是字符串，注意 `Number()`）。
- 本调研解包到 `%TEMP%\dsh-asar-src`（**未进仓库**），只解了 15 个文件，没解全包。

---

## 9. 仍需真机确认的三件事（源码已给结论，但未在运行中的 DSH 上验证）

1. `ctx.slots._core.markDirty(...)` 在真实 cordis ctx 上可调用、且外壳 rows 确实重算（§3.2）——建议在工具箱"诊断"块里加一行 `typeof ctx.slots._core?.markDirty`。
2. 一次折叠切换的真实渲染轮数（§2.2 为源码推断）——用 React DevTools Profiler 量 `ToolboxSection` / `SettingsRoot` 的 commit 次数。
3. HMR 热重启 `dsh-toolbox` 的端到端时延（保存文件 → apply 重跑）——§5.3。
