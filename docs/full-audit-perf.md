# 全量审计 C：性能 / 泄漏 / 压力测试

审计快照：HEAD 1897761 加 Lead 修复（0.2.2）；Node v24.19.0 --expose-gc；
数据由 benchsmith 的 deps-aware 桩（临时目录）与 Lead 的 bench/ 交叉得到。
绝对时间受机器负载影响 ±20–50%；调用次数/version/timer 是确定值。

## 结论

无 P0/P1/P2 级性能或泄漏问题；只有 3 个 P3 热点（现实 13 页无感），无平方项。

## 规模（10/50/200/1000 页）

| 页数 | entries 稳态 | raw entries/次 | label/次 | 渲染一次（元素构建） | 元素数 | GC 后 heap |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 39 ns | 1 | 0 | 11.2 µs | 82 | 5.04 MB |
| 50 | 35 ns | 1 | 0 | 34.2 µs | 362 | 5.16 MB |
| 200 | 86 ns | 1 | 0 | 131.4 µs | 1412 | 5.54 MB |
| 1000 | 122 ns | 1 | 0 | 606.1 µs | 7012 | 6.94 MB |

- locale 变化会全量重建 sections：3.4/4.9/23.6/116.5 µs，label N 次；O(n log n)，无平方项。
- 1000 页 toggle handler 9.1 µs + rerender 561 µs；foldAll/unfoldAll 一对 1.06 ms（极端规模）。

## 缓存命中（100 页）

| 场景 | raw entries | label | 输出数组 |
| --- | --- | --- | --- |
| 账本不变 | 1 | 0 | 同一数组 |
| 仅 _core.markDirty 推版本 | 1 | 0 | 同一数组 |
| locale 变化 | 1 | 49 | 100 个不同数组 |
| prefs 变化（toggle 后） | 1 | 0 | 100 个不同数组 |

渲染路径：无变化 raw 0 / label 0；仅版本变化 raw 1 / label 0；locale 变 raw 1 / label N。

## 压力（13 页）

- 1000 次同步 toggle：version +1000（每次 +1），register/dispose 0/0，localStorage 写 1000，
  setTimeout 调度 1000 但 cascadeTimer 合并 → pending 峰值 1；GC 后 heap +0.08 MB。
- 500 次 expand/collapse：hosted 注册/释放 500/500，version +1000，renderSlot 500，hosted 归 0；
  监听器稳定。耗时 19.5 ms。
- foldAll/unfoldAll 500 对：0 注册/0 注销，version +1000，raw entries 1000，label 12，localStorage 写 1000，
  timer 合并，耗时 15.4 ms。
- 卸载后：settings.section/locale 监听器 0、pending timer 0、toolbox/icon/launcher/hosted 0、style 0。

## HMR

200 轮全新 eval + apply + mount/toggle/diag + unmount/teardown：0 失败；
prototype.entries 恢复、监听器/style/timer/hosted 归零、records 4、storage 3 键；
heap 5.53→5.86 MB（+1.6 KB/轮，不随轮次加速）。diag 上限 12 条 / 3985 B。

## 与 0.1.0 基线对比

| 指标 | 0.1.0 | 当前 |
| --- | --- | --- |
| entries 单次 | 1534–1655 ns | 40–180 ns（bench 口径 96–128 ns） |
| 原 entries 调用/次 | 2 | 1 |
| label thunk/次 | 13 | 0 |
| 一次 toggle version | 2 | 1（_core）/2（回退） |
| 一次 toggle register/dispose | 1/1 | 0/0（_core）/1/1（回退） |

## P3 热点（可不改）

1. 每次 revision 重建全部卡片元素；13 页约 10 µs，1000 页约 606 µs。未来插件上百可做行级 memo/虚拟化。
2. locale 变化全量重建 sections + label；locale 少变，可接受。
3. foldAll/setFolded 的 overrides 拷贝 + JSON stringify 随 N 线性；1000 页仍 <1 ms。

## 局限

- 桩件测逻辑成本，不含真实 React reconciliation/DOM/布局；render 数字是元素构建。
- 同实例 apply/teardown 循环的早期用例有假阳性（未正确 unmount）；HMR 全新实例 200 轮才是可靠生命周期结论。
- 未做真实 React Profiler 的提交次数测量；建议后续补验（预期 SettingsRoot 1 / SlotOutlet 1 / ToolboxSection 1 / SectionHost 0）。
