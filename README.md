# dsh-toolbox —— 设置侧栏「工具箱」

把**不常改动的插件设置页**从设置面板左侧导航收进一个「工具箱」页，需要时在工具箱里原位展开。
侧栏只留核心页（通用 / 模型 / 插件 / 账户），插件页默认全部收纳。

当前状态与后续动作见同目录 [`HANDOVER.md`](HANDOVER.md)。

## 为什么需要它

设置面板导航是 `settings.section` 槽位账本的投影：**每个插件注册一个一级页**。
本机装了 12+ 个带设置页的插件，导航就被十几个「一年点两次」的页面挤满。

DSH 没有公开的「分组 / 收纳」扩展点：槽位**声明即渲染授权**（一个槽位只有一个声明者），
所以第三方页既不能由别人代为渲染，也没有 hidden / group 选项。本插件用两条受控机制解决：

1. **侧栏折叠**：给 `SlotRegistry.prototype.entries` 包一层过滤器，只对
   `key === 'settings.section'` 剔除「已收纳」的 id。导航读 `entries()`，于是这些页
   从侧栏消失；内容渲染读 `entriesOfSlot()`，不受影响。
2. **原位展开**：工具箱自己的条目声明子槽位 `toolbox.page`；展开某页时，把那一页
   **原本的组件连同它的 `locale` / `inject` / `store` 席位**重新注册进子槽位，
   再 `renderSlot` 出来。props 由槽位框架按原样组装，不伪造、不越权
   （`toolbox.page` 的声明者就是工具箱自己）。

两条机制都可逆：插件卸载时还原原型、释放全部子槽位注册。

## 性能（0.2.0）

设置侧栏过滤与工具箱渲染原来的热路径是"每次调用都全量扫描账本 + 解析全部 label + 排序"，
一次切换还会注册/释放一个假条目并把账本版本推 2 格。0.2.0 做了这些改动：

- 设置页列表按 `(账本数组引用, getVersion, locale revision)` 缓存；过滤器复用已读到的账本，
  label thunk 只在账本/locale 变化时解析一次。
- 折叠集合按 `(页面列表, 偏好版本)` 缓存，过滤器和渲染共用。
- 优先用宿主内部的 `ctx.slots._core.markDirty` 推版本号：不动账本、不注册假条目；
  宿主升级导致私有字段缺失时自动回退到旧路径（功能不变，只是回到旧成本）。
- 偏好变更不再同步 `bump()`，依赖外壳 rows 重算级联渲染工具箱页，一次切换少一轮全量渲染；
  另加一个宏任务自愈检查，宿主以后若把内容区 memo 化，会自动补一次渲染。
- 展开的宿主页用 `memo` 隔离：切换别的行、展开别的页时不再连带重建它。
- 顺手修掉"放回侧栏后再次收纳会自动展开"的残留展开态。

基准（`bench/`，Node 桩件加载真实 client.js；13 个设置页、label 全 thunk；5 轮中位数）：

| 指标 | 基线 0.1.0 | 0.2.0 |
| --- | --- | --- |
| `entries('settings.section')` 单次 | 1534–1655 ns | 43–87 ns |
| 每次原 `entries()` 调用 | 2 | 1 |
| 每次 label thunk 调用 | 13 | 0 |
| 一次切换的 version 增量 | 2 | 1（有 `_core`）/ 2（回退） |
| 一次切换的 register/dispose | 1/1 | 0/0（有 `_core`）/ 1/1（回退） |

详细方法、局限与真机状态见 [docs/perf-report.md](docs/perf-report.md)；
复跑方式见 [bench/README.md](bench/README.md)。

## 用法

设置 → 工具箱：

- **自动收纳第三方插件页**（默认开）：核心页留在侧栏，其余插件页全部收起。
- 每行右侧胶囊按钮：`已收纳` / `在侧栏`，点一下切换。
- 已收纳的行点标题可**原地展开**，直接改那一页的设置。
- `全部收纳` / `全部放回`：一键切换（「全部放回」会同时关掉自动模式）。
- `诊断`：过滤器是否装上、当前模式、页数统计。

偏好存浏览器 `localStorage`（键 `dsh-toolbox.prefs.v1`），不写宿主配置文档。

## 安装 / 卸载

走 **bundle 通道**（与本机 `dsh-ustc-usage` / `dsh-desktop-hand` / `dsh-ustc-image` 一致）：
插件包内 `cordis.patch.yml` 声明挂载行 → profile `package.json` 的 `dsh.profile.bundles` 收录 →
profile `node_modules` 的 junction 提供包名解析。**不写 profile 的 `cordis.patch.yml`**
（那是「手工通道」，与 bundle 通道同时用会双重挂载）。

```powershell
# 双击 install.cmd，或：
pwsh -File install.ps1

# 卸载（删 junction 与 package.json 两行；插件目录保留）
pwsh -File install.ps1 -Uninstall
```

bundle 通道在运行中会被重新组合（0.2.2-rc.1 实测：宿主启动后安装/改动插件也能出现在
`/plugins/events` 的客户端图里），不一定要重启 DSH。改 `lib/client.js` 后由 dsh-client-hmr
轮询发现并热重启插件；若页面的 `/plugins/events` 事件流断开（DevTools 里成排 ERR_FAILED），
刷新一次页面即可拿到新图。设置里出现「工具箱」即成功。

## 已知边界

- **折叠只影响导航**：页面的注册本身不动；插件热重载/卸载后列表跟着重算。
- **正在看的那一页被收起**时，内容仍留在面板里，但侧栏不再有高亮项；点别的导航即可。
- 若某个页自己声明了子槽位（子槽位只能有一个声明者），无法重复声明，展开时显示
  「这个页暂不能内嵌」而不是崩掉。**目前第三方插件里没有这种页**。
- 依赖 `SlotRegistry.prototype.entries` 这一层实现细节；DSH 升级后若该方法改名或改签名，
  工具箱会自动降级：诊断里显示「过滤器未安装」，折叠失效但不会崩。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边（空壳）：只为占一个 Loader 条目，让 dsh-client-modules 发现 `dsh.client` |
| `lib/client.js` | 全部行为：侧栏过滤器、工具箱页、原位展开、图标、样式 |
| `cordis.patch.yml` | bundle patch：`insert` 一行 `id: toolbox / name: dsh-toolbox` |
| `install.ps1` / `install.cmd` | 安装/卸载（复制 + junction + package.json 两行，幂等） |
| `HANDOVER.md` | 交接文档：现状、机制、验证清单、回滚 |
| `bench/` | Node 桩件基准台 + 9 条行为回归（不依赖 DSH） |
| `docs/` | 宿主源码调研、性能优化报告、复核记录、真机验证证据 |

## 回滚

1. `pwsh -File install.ps1 -Uninstall`（或手工删 junction + package.json 两行）。
2. 重启 DSH。
3. 浏览器 `localStorage` 键 `dsh-toolbox.prefs.v1` 可留可删，不影响其他插件。

插件本体只读设置侧栏的槽位账本，不改任何插件的配置与数据。
