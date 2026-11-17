# dsh-toolbox 基准台与回归测试

用 Node 桩件加载**真实的** lib/client.js，量化客户端热路径；不依赖 DSH、不启动浏览器。
2026-11-17 建立（性能优化交接）。

## 文件

| 文件 | 作用 |
| --- | --- |
| stub.cjs | 桩件：window.__ModuleLoader__、localStorage、document、React hooks、按真实 SlotCore 语义实现的假 SlotRegistry（entries 稳定引用、register/dispose 版本+1、微任务合并通知、_core.markDirty） |
| bench.cjs | 指标基准：filter / render / toggle，5 轮取中位数 |
| behavior-test.cjs | 黑盒行为回归（9 条），node bench/behavior-test.cjs 退出码 0/1 |
| results-baseline.json | ece67d4 基线数字 |
| results-optimized.json | 优化后数字 |

## 跑

    # 行为回归（当前工作树）
    node bench/behavior-test.cjs lib/client.js

    # 基准（可一次传多个版本做 A/B）
    node bench/bench.cjs lib/client.js

    # 取交接基线做对照
    git show ece67d4:lib/client.js > %TEMP%\client.baseline.js
    node bench/bench.cjs %TEMP%\client.baseline.js lib/client.js

场景：13 个设置页（4 核心 + 8 第三方 + 工具箱自己），label 全用 thunk（统计调用次数）。
withCore=true/false 分别模拟真实宿主（ctx.slots._core 可用）与旧宿主/降级路径。

## 指标

- filter.nsPerCall：连续调用 entries('settings.section') 的单次耗时；同时统计原 entries 调用次数、label thunk 次数。
- render.usPerRender：直接调用 ToolboxSection 组件函数、构建整棵元素树的耗时（关闭 useEffect 重复执行）。
- toggle.*：点一次「已收纳↔在侧栏」引起的账本 version 增量、register/dispose 次数。

## 局限（重要）

1. 桩件只测**逻辑成本**，不测真实 React reconciliation/DOM；render 指标只能看相对趋势。
2. 真实外壳 rows 重算、uSES 通知、展开页级联渲染不在本基准内，由源码分析与真机验证覆盖。
3. 时间是单机采样，绝对值受其他进程影响；决定性指标是调用次数/版本增量这类不随负载变化的计数。

## 2026-11-17 结果摘要（Node v24.19.0 / Windows / 5 轮中位数）

| 指标 | 基线 | 优化后 |
| --- | --- | --- |
| entries 单次 | 1534–1655 ns | 65–130 ns |
| 每次 entries 的原 entries 调用 | 2 | 1 |
| 每次 entries 的 label thunk 调用 | 13 | 0 |
| 渲染中 label thunk 调用 | 13 / 次 | 0 |
| 一次切换的 version 增量 | 2 | 1（有 _core）/ 2（回退） |
| 一次切换的 register/dispose | 1 / 1 | 0 / 0（有 _core）/ 1 / 1（回退） |

原始数字见 results-baseline.json / results-optimized.json。
