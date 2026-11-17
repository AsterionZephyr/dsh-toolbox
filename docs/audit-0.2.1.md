# 发布前审计：dsh-toolbox 0.2.1

> **审计快照**：工作树 2026-11-17 **21:01**（HEAD `17d310d` + Lead 未提交的发布准备改动）。
> `lib/client.js` = 43,286 B / 1089 行，**sha256 `B464CDFC985CADCC6C8E07FA60ABA4EB85B143228EEB2B82620118C135D28144`**。
> 未提交改动：`lib/client.js`(+77/−24)、`package.json`(+repository/homepage/bugs)、`README.md`(+repo 链接)、新增 `LICENSE`、`.github/workflows/tests.yml`。
> 审计方式：只读（未改任何文件）。宿主对照 = DSH Desktop 0.2.2-rc.1 的 app.asar。

## 结论：**需修复后发布（仅 1 条 P1，改 1 行；插件本体无 P0/P1）**

- **P0：未发现**。无崩溃/数据损坏/安全/隐私阻断项。
- **P1：1 条** —— `install.cmd` 走 PowerShell 5.1，而 `install.ps1` 用了 PS7 专有参数 `-Encoding utf8NoBOM` 且文件无 BOM（本机约定：被 5.1 调用的 .ps1 必须带 BOM）。README 把「双击 install.cmd」写成等价安装方式 → 首次安装在 5.1 上会直接报参数错误、中文输出乱码。
- 修法（任选其一，1 行）：`install.cmd` 改用 `pwsh`（`pwsh -NoProfile -ExecutionPolicy Bypass -File ...`，并在缺失时回退提示）；或 install.ps1 全量改为 5.1 兼容（存 UTF-8 **带 BOM**、`-Encoding utf8`），并放弃 `utf8NoBOM`。
- **插件运行时代码（`lib/client.js`）判定：可发布。**

---

## P1

### P1-1 `install.cmd` → PowerShell 5.1 与 install.ps1 不兼容（发布阻断：安装路径）

- 位置：`install.cmd:3`（`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"`）；`install.ps1:59/69/122/134`（`Set-Content ... -Encoding utf8NoBOM`）。
- 触发条件：双击 `install.cmd`（或任何 `powershell.exe` 5.1 环境）且 `profile/package.json` 需要写入（首次安装、或安装状态有变化）。
- 后果：`Set-Content : Cannot bind parameter 'Encoding'`（`$ErrorActionPreference='Stop'` → 终止）；已安装状态下若无需写入则不触发。另外 `install.ps1` 首字节为 `3C 23 0A`（`<#\n`，**无 BOM**），5.1 按 ANSI 解析 → 中文注释/输出乱码（工作区约定明确要求 5.1 调用的脚本带 BOM）。
- 建议：二选一（见结论）。并在 README「安装」节写明「需要 PowerShell 7（pwsh）」。

### P1-2（文档/流程，非代码）0.2.1 的真机 UI 证据缺口

- `docs/verify/report.md` 的证据采集时间是 **16:27–17:33**，而 0.2.1 是 **19:39（本地）** 才通过 HMR 应用的（`dsh-toolbox.lastApply.v1 = 2026-11-17T11:39:08.381Z`）→ **现有截图/报告不覆盖 0.2.1**。
- 当前 0.2.1 的真机结论仅来自用户口述：「原 account 设置入口恢复、诊断无异常」。
- 建议：发布说明如实写「0.2.1 已由用户确认设置入口恢复；展开/切换/刷新保持等 5 项未在 0.2.1 上留证据」，或补一次 5 分钟 UI 验收（打开设置 → 工具箱 → 切一行 → 刷新）。

---

## P2（不阻断发布，建议本次或下个小版本修）

1. **`pushLedgerChange` 的自愈定时器不受 teardown 管理**（`lib/client.js:443-445`）：`setTimeout(...)` 既没有 `applied` 守卫，也没有在卸载时 `clearTimeout`。HMR 卸载后最多再触发一次 `bump()`（对已卸载树无害，但属于泄漏式副作用）。建议：保存 timer id，teardown 里清掉；回调首行 `if (!applied) return`。
2. **`renderCount += 1` 写在渲染期**（`:767`，`ToolboxSection` 函数体第一行）：渲染副作用，违反 React 规则；StrictMode 双渲染/被丢弃的并发渲染都会记账，使 `pushLedgerChange` 的「是否已级联渲染」判断出现偶发误判（只会多渲染一次或漏补一次，不影响功能）。建议移到 `useEffect` 或用 `useLayoutEffect` 计数。
3. **每次渲染 `renderSlotRef.current = props.renderSlot`**（`:754`）：渲染期写 ref，React 官方不推荐（并发下可能写进被丢弃的渲染）。风险极低（值同源），可改为 `useEffect` 同步或在 `useMemo` 里派生。
4. **`SectionHost` 的局部边界没有覆盖 `renderSlot` 调用本身**（`:748-755`）：`props.renderHosted(section.id)` 在创建 `ToolboxBoundary` 元素**之前**求值；若 `renderSlot` 抛错（仅当工具箱条目已被 dispose 的竞态），错误会冒泡到 `ToolboxShell` 的整页边界，显示「工具箱 渲染失败」而不是单卡警告。建议把 `renderHosted` 放进边界内的子组件里调用。
5. **桩件的 `entriesOfSlot` 不建模 priority/abdicate**（`bench/stub.cjs:102` 直接返回原始账本）：所以 `behavior-test` 里「launcher priority 1」与「abdicate 后自愈」两条测试**无法验证真实语义**（真实语义已由宿主源码核实：single 槽位按 priority 升序取第一个未 abdicate 的条目——`index-BgUyXZcc.js:123` 偏移 494,245）。建议给桩件补：按 priority 排序、按 cell 去重、abdicated 集合。
6. **文档口径漂移**：README「bench/… 9 条行为回归」实际 **12 条**（`bench/behavior-test.cjs` 12 个 `test()`，`docs/bugfix-0.2.1.md:51` 也写 12/12）；README 性能表「43–87 ns」与 `bench/results-optimized.json` 的 64.66/85.24 ns、`bench/README.md` 的「66–120 ns」三处不一致。建议统一引用 `results-*.json`。
7. **版本号两处硬编码**：`package.json:3` = 0.2.1，`lib/client.js:984` 的 `lastApply` 也写死 `"0.2.1"`。下次 bump 容易漏改（漏改的后果：诊断里显示的版本是旧的，误导 HMR 排查）。建议客户端从 `require("../package.json").version` 不可行（浏览器 bundle 无该能力），改为在构建/发版脚本里同步，或干脆只写 git rev。
8. **`diagCache` 跨标签页不失效**（`:123-133`）：一旦读过就常驻，其它标签页/其它实例写入的新诊断在本页看不到（直到本页自己 reportDiag 或刷新）。功能影响小；若想让诊断跨页实时，订阅 `storage` 事件或在诊断展开时强制重读。

---

## P3（nits，可不改）

- `filteredEntries` 在 `hidden.size === 0` 时提前返回、不更新 `cacheSrc/cacheHidden`（`:349`）—— 正确，只是下次非空会多算一次。
- `readSections` 的 branch#2 命中后不更新 `sectionsLocale`（`:265-268`）—— 因为分支条件已含 locale 相等，无影响。
- `reportDiag` 在 `localStorage.setItem` 抛错（配额）时不更新 `diagCache`（`:110-114`）—— 极端场景，可忽略。
- `docs/verify/*.png` 三张共约 1.1 MB 已入库（证据文件）；如介意仓库体积可转 Git LFS，或发布后移出。**不属于「临时文件误提交」**。

---

## Lead 本轮自查修复的复核（重点）

| 修复 | 结论 | 备注 |
| --- | --- | --- |
| **boundary React key 对象问题** → `boundaryKeyOf`（WeakMap → 数字，`:453-467`、`:751`） | ✅ **正确**，修复了我原审计里「`key={section.entry}` 会被字符串化成 `[object Object]`、条目换了错误状态仍粘着」的问题 | 数字 key 单调递增、WeakMap 不持引用 → 无泄漏；新条目 → 新 key → 边界重挂 ✅ |
| **diagnostics localStorage 每帧读取** → `diagCache`（`:93`、`:110-133`） | ✅ 正确（渲染期不再 `JSON.parse`） | 新增跨标签页不失效问题 → 见 P2-8 |
| **launcher priority 1/2/3 重试**（`:1137-1160`） | ✅ 逻辑正确：account 默认 priority 0（`dsh-client-ui-settings-account/lib/client.js:5415-5419`，**未写 priority**），我们 1/2/3 依次让位；`return` 成功后不再尝试；仅第 3 次失败才记诊断 | 无新竞态（register 抛错时不会留下条目）；唯一副作用：若别的插件本就占用了 priority 2/3 作为兜底，会被我们抢占——本机无这种插件，记为可接受 |
| **icon 注册 try/catch**（`:1129-1147`） | ✅ 正确 | 失败不再影响后续 launcher 注册 |
| **LICENSE / package repo 元数据 / CI** | ✅ 合理 | `files: ["lib","cordis.patch.yml"]` 仍正确（npm 自动带上 README/LICENSE）；`.github/` 不会进包；CI 在 ubuntu 跑 `node bench/behavior-test.cjs lib/client.js` + `bench.cjs`，两个脚本是纯 Node/无 DSH 依赖、路径用 `path.resolve` → 可跑通；行为测试本身会加载 client.js，语法错误会被 CI 捕获 |

---

## 发布清单核对（Lead 指定三项）

1. **`install.ps1` 复制清单**（`:83`）：`lib, cordis.patch.yml, package.json, README.md, HANDOVER.md, install.ps1, install.cmd` —— **有意不含 `docs/` 与 `bench/`**。对「bundle 通道运行插件」而言这是正确的：运行只需要 `package.json` + `lib/` + `cordis.patch.yml`；`README/HANDOVER` 是给人看的可选件。**结论：没有漏掉必需项**（前提是发布说明里区分「安装包」与「仓库」）。若希望安装目录也带诊断文档，可加 `docs/bugfix-0.2.1.md`（非必需）。
2. **`package.json` `files`**：`["lib","cordis.patch.yml"]` —— 合理。`exports["./client"]` 指向 `lib/client.js`（client-modules 硬性要求，app.asar `dsh-client-modules/lib/index.js:200-210,791-793`）；`peerDependencies` 全部 optional；`"type":"module"` 与 `lib/index.js` 的 ESM `export` 一致。
3. **仓库有无不该提交的临时文件**：`git ls-files` 24 个文件，**无** `.bak`/`node_modules`/`bench/out`/`*.log`/`client.opt.js` 等临时产物；`.gitignore` 已覆盖 `*.bak`、`node_modules/`、`bench/out/`、`*.log`。仅 `docs/verify/*.png`（证据）与新增 `LICENSE`/`.github/` 属正常入库。**结论：干净。**

---

## 我已检查过的项（供发布说明引用）

- 代码：`lib/client.js`（1089 行，逐段读完）、`lib/index.js`、`package.json`、`cordis.patch.yml`、`install.ps1`/`install.cmd`（含字节级 BOM 检查）、`README.md`、`HANDOVER.md`（对照）。
- 测试/基准：`bench/stub.cjs`（关键 API 逐条对照）、`bench/bench.cjs`、`bench/behavior-test.cjs`（12 条）、`bench/results-*.json`、`bench/README.md`。
- 文档：`docs/bugfix-0.2.1.md`、`docs/verify/report.md`、`docs/perf-review.md`（我上一轮）、`docs/dsh-internals.md`。
- 宿主语义对照（app.asar 0.2.2-rc.1）：`settings.launcher` 声明为 single（settings-general:1526-1530）、渲染 props `{wide, settingsOpen, openSettings, settingsShortcut, openOnboarding}`（:439-451）、account 注册无 priority（settings-account:5415-5419）、`entriesOfSlot` 按 priority 取未 abdicate 的赢家（壳 bundle 第 123 行 偏移 494,245）、`reportEntryError` 的 abdicate 语义（偏移 496,464）、`onEntryError`（renderer:1574-1576）、uSES 相等性 Object.is（renderer:155-160）。
- 运行时行为：错误边界覆盖（ToolboxShell / SectionHost / launcher 无边界但有 onClick try-catch）、自愈限流（3 次/分钟、80 ms、teardown 清 timer）、过滤器缓存失效矩阵（账本引用/版本/locale/prefsEpoch 四轴）、uSES 稳定快照（数字 revision + 缓存数组）、HMR/多实例（`applied` 守卫、teardown 还原原型与样式、lastApply 诊断）。

**一句话**：插件本体可以发；把 `install.cmd` 的 PS5.1 路径修掉（1 行）、发布说明写清 0.2.1 的真机证据边界，就能发。


---

## Lead 修复记录（2026-11-17 21:xx，晚于上面的快照）

- P1-1 已修：install.cmd 改为先检测并调用 pwsh（PowerShell 7），5.1 下给出明确错误而不是参数报错/乱码。
- P1-2 已记录：docs/bugfix-0.2.1.md 写明 docs/verify 证据不覆盖 0.2.1，并记录用户 20:39 的确认
  （原 account 入口恢复、「设置入口：宿主 account 入口」「最近异常：无」）。
- P2-1 已修：pushLedgerChange 的宏任务加 applied 守卫；teardown 后不再 bump。
- P2-2 已修：renderCount 改在 useLayoutEffect（提交阶段）递增，不在渲染期写模块变量。
- P2-3 已修：renderSlotRef 改在 useLayoutEffect 更新。
- P2-4 已修：新增 HostedPage，把 renderHosted() 调用放进错误边界内部，renderHosted 本身抛错也能被单卡片边界接住。
- P2-5 已修：stub 的 entriesOfSlot 现在按 priority/order 排序并跳过 abdicated；新增 launcher 优先级测试（13 条）。
- P2-6 已修：README/bench/perf-report 的 9→13、性能数字统一为 65–130 ns（单机波动），并去掉不一致的 7–9 µs 表述。
- P2-7 已修：client.js 增加 PLUGIN_VERSION 常量，lastApply 不再单独硬编码。
- P2-8 保留为已知限制：diagCache 不监听跨标签页 storage 事件；单窗口场景无影响。

复测：node --check 通过；bench/behavior-test.cjs 13/13 通过；bench 仍为 filter 2→1 次 entries / 13→0 label、toggle version 2→1、register 1/1→0/0。
