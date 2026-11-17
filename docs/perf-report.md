# dsh-toolbox 性能优化报告

日期：2026-11-17。基线：git ece67d4（0.1.0 交接态）。优化后版本：0.2.0。

## 1. 一句话结论

把设置侧栏过滤与工具箱渲染的热路径从"每次调用都全量扫描 + 解析全部 label + 排序"改为
"按账本引用 / 偏好版本 / locale 版本缓存"；把推版本号的假条目注册改成 Host 内部 markDirty；
再消掉一次切换里的重复渲染与残留展开态。基准里 entries('settings.section') 单次约 1.5 µs → 0.07–0.12 µs，
每次调用的 label thunk 13 → 0，一次切换的账本写操作 1 注册 + 1 注销 → 0。

## 2. 为什么改这些

DSH 0.2.2-rc.1 的实现事实（详见 docs/dsh-internals.md）：

1. SlotCore.entries(key) 返回账本数组本体，两次 mutation 之间是**同一个引用**；register/dispose 才换新数组并 version+1。
2. 外壳设置导航的 rows 用 getVersion('settings.section') + locale revision 做缓存；命中时根本不调 entries()。
3. resolveSlotLabel 没有缓存，rows 重算时对每个条目直接调 label thunk。
4. 订阅者通知是**微任务合批**的；同一次切换里的 register+dispose 只 flush 一次，但 version 会 +2。
5. SlotRegistry 实例持有 _core（SlotCore），_core.markDirty(key, record) 可只推版本、不动账本。
6. renderSlot 每次渲染都新建 props，但展开页在父重渲染时会级联重渲染；SectionHost 的 section 包装对象原来每帧新建，memo 无效。

## 3. 改动清单（lib/client.js）

| 位置 | 改动 | 收益 |
| --- | --- | --- |
| :153 canMarkDirty / :338 nudgeLedger | 优先 ctx.slots._core.markDirty('settings.section', core.records.get(...))，能力检测失败回退注册假条目；返回布尔值 | 一次切换 version +2 → +1；省 1 次数组复制+排序、1 次 slots/changed、1 次注册/注销 |
| :205 readSections(ctx, listHint) | 三层缓存键：账本数组引用 / getVersion 版本号 / locale revision；过滤器把已读到的 list 直接传进来；label 只在缓存未命中时解析 | 每次过滤的原 entries 调用 2 → 1、label 13 → 0；渲染期 raw entries 1 → 0 |
| :252 foldedSet | 用 (sections 数组引用, prefsEpoch) 缓存 Set，过滤器与渲染共用 | 每次调用不再重建 Set / 不再跑 isFolded 全表 |
| :267 installNavFilter | 去掉 signature 字符串拼接，改用 hidden Set 引用做缓存键；异常时直接返回原账本 | 折叠集大时去掉 O(n) 字符串分配 |
| :109 savePrefs / :492-:530 动作函数 | 偏好变更不再同步 bump()，依赖 nudge 推版本触发的外壳 rows 重算级联渲染，并加宏任务自愈检查（本页未重渲染就补 bump）；setMode/setFolded/foldAll/unfoldAll 加 no-op 提前返回；setMode 清展开态；setFolded 两个方向都清展开态 | 一次切换的工具箱全量渲染 2 轮 → 1 轮；无变化操作不再写 localStorage / 推版本；级联若被宿主 memo 化破坏会自动补渲染；修掉"放回侧栏后再次收纳自动展开"的残留状态 |
| :551 SectionHost memo / :593 renderHosted | SectionHost 用 memo + 比较 section.id/entry、ctx、renderHosted、localeRev；renderSlot 经 ref 固定；section 包装对象由 readSections 缓存 | 切换别的行/展开别的页时，不重建已展开的宿主页 |
| :705 诊断 | 增加"版本推送"一行，显示 markDirty 还是占位条目回退 | 真机可一眼确认优化路径生效 |
| 文件尾 inject | inject 增加 locale：块件只会把 inject 声明的服务装进 fiber，未声明时读 ctx.locale 会抛错被 try/catch 吞掉，locale 轴变成死轴 | 语言切换后设置页列表 label 能正确刷新（docs/perf-review.md 复核发现的必修项） |

## 4. 基准数据

工具：bench/（Node 桩件加载真实 client.js；13 个设置页，label 全 thunk；5 轮中位数）。
决定性计数不随机器负载变化；时间为单机采样，仅作量级参考。

| 指标 | 基线 | 优化后 |
| --- | --- | --- |
| entries('settings.section') 单次 | 1534–1655 ns | 43–87 ns |
| 其中原 entries 调用 | 2 次 | 1 次 |
| 其中 label thunk 调用 | 13 次 | 0 次 |
| 渲染一次工具箱的 label thunk | 13 次 | 0 次 |
| 渲染一次工具箱的 raw entries | 1 次 | 0 次 |
| 一次切换的 version 增量 | 2 | 1（_core 可用）/ 2（回退） |
| 一次切换的 register/dispose | 1/1 | 0/0（_core 可用）/ 1/1（回退） |
| 一次切换的 toolbox 全量渲染 | 2 轮（savePrefs bump + 账本 flush） | 1 轮（仅账本 flush 引起的 shell 级联） |

render 微基准（stub 里构建元素树，不代表真实 React 提交）：约 10.5 µs → 7–9 µs，趋势一致但绝对值不可外推。
真实收益主要来自：过滤/标签/版本写操作减少 + 一次切换少一轮全量渲染 + 展开页不再被无关重渲染。

## 5. 行为回归

bench/behavior-test.cjs 共 9 条，覆盖：默认自动折叠、单页切换与持久化、展开/卸载、放回侧栏清展开态、
全部收纳/全部放回、跨实例偏好、_core 缺失回退、插件卸载还原过滤器。
当前 lib/client.js 9/9 通过；基线在"放回侧栏后再次收纳不自动展开"一条失败（0.2.0 顺手修掉）。

## 6. 真机状态（2026-11-17）

- 插件已在运行中的 DSH 里被图包含：/plugins/events 的客户端图有 dsh-toolbox（rev 921a4663b66c）；
  /plugins/??dsh-toolbox/client.js 返回 200。说明 bundle 通道不需要"重启 DSH 才生效"。
- 设置面板 UI 的 6 条交互验收**尚未完成**：Web GUI 需要进程级 token（未落盘，拿不到），
  桌面壳页面的 /plugins/events SSE 当前报 ERR_FAILED（图事件流断），当前已打开页面可能没收到插件更新。
- 下一步（需要用户或正常环境）：刷新一次 DSH 窗口，打开 设置 → 工具箱，确认诊断块显示
  "侧栏过滤器：已安装"、"版本推送：markDirty（不写账本）"，再按 HANDOVER 第 6 节逐条验收。

## 7. 风险与回退

- _core / markDirty 是宿主私有实现：三个成员任一改名，能力检测失败会自动回退旧的假条目路径；
  此时功能不变，只是回到 version+2 / 1 注册+1 注销的成本。
- 去掉 savePrefs 的同步 bump 依赖"外壳 rows 重算会重渲染当前 active section"（settings-general SettingsRoot:352/362、
  SettingsPanel:261/341）。补丁带宏任务自愈：推完版本后若本页在下一轮宏任务前没有重渲染，就补一次 bump()。
  这条自愈只保证功能不静默失效，不保证一定只有 1 轮渲染。
- locale 轴：inject 已加 locale。若宿主移除 client-locale 服务，插件会因 inject 不满足而不激活；
  当前 web 组合必然带 locale，可接受。
- 复核记录见 docs/perf-review.md（srcsleuth，2026-11-17）；其中"必修 1 项 ctx.locale"已按建议修复，
  另按复核建议给 savePrefs 的级联渲染加了自愈。

- 回退：git revert 本次提交，或在 profile node_modules 上回退到上一版目录；插件自带 install.ps1 -Uninstall。
