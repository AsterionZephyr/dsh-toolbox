# dsh-toolbox 全量审计报告（2026-11-18）

## 0. 结论

**可发布：发现并修复 1 条 P0（安装脚本空容器尾逗号）与 3 条 P1；当前无未修复 P0/P1。**
插件本体（lib/client.js）无 P0/P1；性能无平方级热点，常规 13 个设置页场景稳定。

## 1. 快照与方法

- 基线：HEAD 1897761（v0.2.1）加本轮审计期间 Lead 的修复，lib/client.js 1240 行，
  sha256 FD55DC0C8D65079D74D283590D7EEBE7F9D27F6A1D20FD06E5E1FE7BCD7B0E8D。
- 宿主：DSH Desktop 0.2.2-rc.1，源码事实见 docs/dsh-internals.md。
- 方法：
  1) 独立审计 A（srcsleuth）：宿主契约 / React 生命周期 / HMR / 并发，见 docs/full-audit-host.md；
  2) Lead 逐行审计 lib/client.js、bench、install、package、CI；
  3) Lead 动态测试：16 条行为回归、1000 页规模、1000 次切换、200 次展开/收起、
     安装脚本隔离测试（紧凑/多行 package.json、空/非空容器、重复安装、卸载）、
     原型污染/畸形输入/凭据扫描；
  4) 安全/性能审计 B/C 的结论已并入 docs/full-audit-security.md 与 docs/full-audit-perf.md。

## 2. 问题清单

### P0（已修）

| 编号 | 问题 | 触发 | 处理 |
| --- | --- | --- | --- |
| P0-1 | install.ps1 对空的 dependencies/bundles 写入尾逗号，生成非法 JSON；ConvertFrom-Json 宽松通过但 Node JSON.parse/DSH 启动会失败 | 全新/精简 profile 首次安装 | 空容器分支不写尾逗号；写入前 Test-Json 严格校验；4 种布局 + Node 严格解析验证通过 |


### P1（发布阻断，已修）

| 编号 | 问题 | 触发 | 处理 |
| --- | --- | --- | --- |
| P1-1 | install.ps1 只认多行 package.json；紧凑单行 JSON 下依赖行/bundles 行插入失败 | 新用户/精简 profile 首次安装 | 已改为同时兼容紧凑与多行；隔离测试通过（重复安装不再改写、卸载能清两行） |
| P1-2 | 先装 entries 过滤器再注册 settings.section；id/子槽位冲突时注册失败但过滤器已生效，所有非核心页被折叠且无工具箱入口 | 槽位撞名/注册异常 | 已改为先注册 section，成功后装过滤器；失败撤过滤器；新增 fail-section 回归 |
| P1-3 | 卸载正则要求尾逗号；dsh-toolbox 是最后一项时依赖行残留 | 卸载 | 已改为可选逗号；卸载后严格校验 JSON |

### P2（已修或已记录）

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| P2-1 | 三个 ctx.slots.inject 回调不返回 disposer，依赖宿主 releaseChildren 清账本 | 已修：返回幂等 disposer |
| P2-2 | 别的插件后装 entries wrapper 时，teardown 条件还原失效，旧过滤器残留 | 已修：disposed 旗标，卸载后直接放行；新增回归 |
| P2-3 | 子槽位 key "toolbox.page" 是全局命名空间，撞名会让整个插件静默注册失败 | 已修：改名 "dsh-toolbox.page" |
| P2-4 | pushLedgerChange 的 setTimeout 无清理、快速连点会积累 | 已修：单 timer 合并 + teardown 清理 |
| P2-5 | 自愈判据用提交计数，并发下可能多渲染一轮 | 已改：用 prefsEpoch 提交快照判断 |
| P2-6 | 独占 store factory 的展开页会新建实例（状态不共享） | 框架语义，README/HANDOVER 已写明 |
| P2-7 | 同 id 不同 priority 的影子条目会让卡片重复、展开固定取胜者 | 罕见；宿主导航同样不去重，暂记录不改 |
| P2-8 | diagCache 跨标签页不失效 | 已修：监听 storage 事件失效缓存 |
| P2-9 | 安装脚本路径含 $ 时，替换字符串可能被 .NET 当成替换模式 | 已修：linkSpec 做 $→$$ 转义 |
| P2-10 | 悬空 junction（目标目录已删）时 New-Item 失败 | 已修：检测并清理重建 |
| P2-11 | install.cmd 丢参数/恒 exit 0 | 已修：透传 %* 与退出码 |
| P2-12 | install.ps1 默认 Target 硬编码本机路径 | 已修：默认 PSScriptRoot |
| P2-13 | 全局隐藏 __toolbox_nudge_ 前缀可能误伤第三方 id | 已改为 __dsh_toolbox_nudge_ |
| P2-14 | overrides 的 __proto__ 赋值无效 | 已改为 null 原型 overrides |
| P2-15 | 安装/卸载仍非全事务，失败可能留半安装态 | 已记录：package.json 写入前严格校验，不写坏配置；重跑可恢复 |
| P2-16 | 诊断 message/stack 写 localStorage（同源可读） | 已记录：本地调试信息，无 token；可后续缩短 |
| P2-17 | overrides 不清理旧插件 id | 已记录：缓慢增长，不影响正确性 |

### P3（nits / 已记录）

- docs/verify 证据采集于 0.2.1 热更前；0.2.1 真机结论来自用户确认（原 account 入口恢复、诊断无异常），
  docs/bugfix-0.2.1.md 已写明。
- package.json 与 client.js 的 PLUGIN_VERSION 双源：已加回归测试（bench/behavior-test.cjs）。
- bench/README 的条数已同步（15 条）。
- apply() 的 lastApply 已移到 ctx.slots 守卫之后。
- 其他缓存快路径的写法正确，保持现状。

## 3. 安全审计

- **原型污染**：预置 overrides 含 __proto__/constructor/toString 的 localStorage 后加载插件，
  Object.prototype 未被污染，页面折叠行为正常；readPrefs 只接受 boolean。
- **XSS/CSS 注入**：插件 CSS 为固定常量；第三方 entry id/label 只作为 React 文本节点，
  不拼 innerHTML/样式；错误信息也用 React 文本渲染。
- **凭据/敏感信息**：git grep + PNG ASCII 扫描未发现 token/私钥/密码；运行期诊断只写本地 localStorage，
  不写仓库。注意：docs/verify 截图包含本地工作区/会话信息，仓库当前为 public，
  若需保密可改 private 或删除证据截图（需重写历史才能从旧 commit 移除）。
- **全局原型补丁**：entries 只过滤 settings.section，其他 key 原样返回；卸载/被后装 wrapper 时通过
  disposed 旗标放行；异常路径不吞掉宿主其它 key。
- **安装脚本**：junction 仅在 LinkType=Junction 时删除；目标路径、备份、正则均本地执行；
  已用隔离 profile 测试安装/重复安装/卸载。
- **供应链**：npm pack 仅含 LICENSE/README/cordis.patch.yml/lib/package.json；CI 无秘密、
  仅跑 Node 测试。

## 4. 性能审计

### 4.1 规模（当前 stub，过滤缓存生效）

| 设置页数 | entries 单次 | 每次原 entries 调用 | label 调用/次 | 渲染一次 |
| --- | --- | --- | --- | --- |
| 10 | 279 ns | 1 | 0 | 15.9 µs |
| 50 | 211 ns | 1 | 0 | 29.0 µs |
| 200 | 197 ns | 1 | 0 | 86.1 µs |
| 1000 | 287 ns | 1 | 0 | 441 µs |

结论：过滤路径基本平坦（缓存命中），渲染随卡片数线性增长；无 O(n²) 热点。
1000 页场景渲染约 0.44 ms，属于极端场景；常规 13 页约 9 µs（stub 元素树构建，不代表真实 React 提交）。

### 4.2 与 0.1.0 基线对比

| 指标 | 0.1.0 | 当前 |
| --- | --- | --- |
| entries('settings.section') 单次 | 1534–1655 ns | 96–108 ns |
| 每次原 entries 调用 | 2 | 1 |
| 每次 label thunk 调用 | 13 | 0 |
| 一次切换 version 增量 | 2 | 1（_core 可用）/2（回退） |
| 一次切换 register/dispose | 1/1 | 0/0（_core 可用）/1/1（回退） |

### 4.3 压力与泄漏

- 1000 次切换：version 正常递增，无崩溃；切换后展开项正常卸载，teardown 后工具箱 section/icon/launcher
  与 toolbox.page 注册均清空。
- 200 次展开/收起：hosted Map 无残留；展开页错误边界不泄漏。
- 监听器泄漏结论：stub 的 useEffect 没有 deps 记忆，不能直接用于判断真实 React 监听器泄漏；
  真实代码的 subscribe/onEntryError/locale 订阅均有 cleanup（审计 A 已逐行确认）。
- 已知热点（不阻断）：每次 revision 会重建全部卡片元素（13 页约 9 µs）；若未来插件页数上百，
  可考虑行级 memo 或虚拟列表；宿主页已有 memo，不再随无关切换重建。
- 独占 store factory 的页面展开是新实例，属于语义边界，已在文档说明。

## 5. 兼容性与发布检查

- React 18.3：useSyncExternalStore/useLayoutEffect/class boundary 均支持；useLayoutEffect 有回退。
- DSH 私有 _core/markDirty：能力检测 + 假条目回退；版本升级失效不会崩。
- locale：inject 增加 locale；缺失时插件不激活（与设置外壳一致）。
- 浏览器 API：color-mix 仅影响视觉；WeakMap/Set/queueMicrotask 均为现代基线。
- 子槽位改名不涉及持久化数据，升级零迁移。
- install.cmd 硬性要求 pwsh；install.ps1 兼容紧凑/多行 package.json，幂等，卸载可逆。
- npm pack 内容正确；GitHub Actions 两次运行 success（8f4f8fb、4feff8e）。

## 6. 已验证命令

    node --check lib/client.js
    node bench/behavior-test.cjs lib/client.js        # 15/15
    node bench/bench.cjs lib/client.js                # A/B 数字
    node bench/bench.cjs <baseline> lib/client.js     # 0.1.0 对比
    pwsh -File install.ps1 -Source ... -Target ... -Profile <temp>   # 隔离测试

真机 UI 的逐条验收仍未做（需要刷新 DSH 后人工点开设置）；用户已确认 0.2.1 原 account 入口恢复、
诊断无异常。建议后续用 React Profiler 复核一次切换的提交次数（预期 SettingsRoot 1 / SlotOutlet 1 /
ToolboxSection 1 / SectionHost 0）。

## 7. 后续建议（按价值）

1. P2-7 影子条目：readSections 按 id 去重，与 entriesOfSlot 的胜者对齐（低优先）。
2. 若插件页数上百，卡片列表做行级 memo/虚拟化。
3. 把 docs/verify 的证据更新到 0.2.1 后（或删掉旧截图），再考虑公开仓库的隐私边界。
4. 给 install.ps1 加路径含 $ 的转义（P2-9）。
