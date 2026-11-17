# 0.2.1 稳定性修复：设置入口消失 / 工具箱空白

日期：2026-11-17。用户报告两个症状：

1. 左下角设置入口经常被"吞掉"；
2. 工具箱页面偶尔变成空白。

## 1. 左下角设置入口消失

### 证据

- 桌面端截图（docs/verify/desktop-app-window.png 同款布局）里侧栏底部只剩「远程控制」和「新版本」；
  「新版本」是 settings-general 的 DesktopUpdateIndicator，说明 **SettingsRoot 本身还在渲染**。
- 设置入口由 sidebar.settings（single 槽位）→ renderSlot('settings.launcher')（single 槽位）组成。
  account 插件的 AccountMenu 注册在 settings.launcher；它一旦在渲染中抛错，renderer 的
  SlotErrorBoundary 会报告并 **abdicate 该条目**。single 槽位在「账本里还有条目、但都不可渲染」时
  渲染一个空死格（SettingsRoot 自带的 fallback 只在 entries 为空时才用），
  于是底部只剩更新指示器，齿轮消失。

### 修复

- SettingsLauncherFallback：以 **priority 1** 注册一个极简齿轮到 settings.launcher。
  account 的入口 priority 0，健康时它照常胜出；account 崩溃/缺席时 priority 1 的兜底成为赢家，
  齿轮不会消失。点击调用宿主传入的 openSettings()。
- 工具箱诊断块增加「设置入口」一行：显示当前是「宿主 account 入口」还是「兜底齿轮（account 入口不可用）」。
- 这不是修 account 插件本身，而是防止它的单点崩溃让设置完全不可达；account 恢复正常后兜底自动让位。

## 2. 工具箱空白

### 原因

settings.section 是 **list** 槽位。renderer 对 list 槽位的条目崩溃会 reportEntryError(..., {abdicate:true})：
条目被标记 abdicate，导航（读原始账本）里仍然有「工具箱」，内容（读 entriesOfSlot）却渲染空死格 → 空白页。
触发源通常是**被收纳页自己**在展开时抛错（某些插件页依赖宿主 owner props / 状态），
或者工具箱组件在某个瞬间拿到不完整 props，错误冒泡到 settings.section 的条目边界。

### 修复

- ToolboxShell：用 ToolboxBoundary（React class error boundary）包住整个 ToolboxSection；
  工具箱自身/其子树里的渲染错误只显示「渲染失败：… + 重试」，不再让条目被 abdicate。
- SectionHost：每个展开的宿主页再套一层 ToolboxBoundary（key=原条目），
  单个插件页崩了只影响那一张卡片，不会把整个工具箱打空。
- 守卫：props.api/ctx 缺失、renderSlot 不是函数时返回可见提示而不是抛错。
- 自愈：注册 ctx.slots.onEntryError，若工具箱条目仍被外壳 abdicate，80ms 后自动注销并重注册
  （最多 3 次/分钟，防确定性崩溃循环）。这条兜底针对「我们自己没拦住」的情况。
- 运行时诊断：错误写入 localStorage dsh-toolbox.diag.v1；诊断块显示最近一条；
  dsh-toolbox.lastApply.v1 记录版本与应用时间（用于确认 HMR 是否加载了新代码）。

## 3. 验证

- 行为回归：node bench/behavior-test.cjs lib/client.js，12/12 通过。新增 3 条：
  - 被收纳页渲染崩溃只显示局部警告，工具箱条目仍在；
  - settings.launcher 兜底已注册并可打开设置；
  - 工具箱条目被 abdicate 后会自动重注册。
- 真机：0.2.1 已通过 dsh-client-hmr 应用到运行中的 DSH（Electron localStorage
  dsh-toolbox.lastApply.v1 = {"version":"0.2.1","at":"2026-11-17T11:39:08.381Z"}）；
  /plugins/events 的 dsh-toolbox 条目 rev 已换新，bundle 含 ToolboxBoundary / SettingsLauncherFallback / scheduleSectionHeal。
- 截图复核未完成：检查时 DSH 窗口已被用户最小化，无法用 PrintWindow 取内容；
  按约定没有做任何桌面点击/恢复窗口操作。

## 4. 仍待确认

- 如果**刷新后**齿轮仍不出现，说明是 sidebar.settings 整个条目被 abdicate（不是 settings.launcher），
  需要看诊断块「设置入口」行和 DevTools Console 的 slot entry crashed in 'sidebar.settings'。
- 如果工具箱仍空白，诊断块「最近异常」会显示被拦截的错误；把那一行发给开发者即可定位具体插件页。
- 兜底齿轮的视觉比 account 头像菜单简朴（只有齿轮 + “设置”），这是刻意的最小实现。
