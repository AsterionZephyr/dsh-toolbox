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

bundle 在启动时组合，**改完要重启 DSH**；重启后刷新页面，设置里出现「工具箱」即成功。

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

## 回滚

1. `pwsh -File install.ps1 -Uninstall`（或手工删 junction + package.json 两行）。
2. 重启 DSH。
3. 浏览器 `localStorage` 键 `dsh-toolbox.prefs.v1` 可留可删，不影响其他插件。

插件本体只读设置侧栏的槽位账本，不改任何插件的配置与数据。
