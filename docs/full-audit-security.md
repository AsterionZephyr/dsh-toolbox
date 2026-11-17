# 全量审计 B：安全 / 健壮性 / 兼容性 / 安装脚本

审计快照：HEAD 1897761 加本轮 Lead 修复；插件 0.2.2；宿主 DSH 0.2.2-rc.1。
独立审计（sentinel）与 Lead 动态测试合并；本文件只记录安全/健壮性，性能见 full-audit-perf.md。

## 结论

插件运行时代码：无 P0、无 P1。安装脚本发现并修复 1 条 P0（空容器尾逗号导致非法 JSON）；
另有 2 条 P1 已修/降级。当前可发布。

## 发现与处理

### P0（已修）

P0-1 install.ps1 对空 dependencies/bundles 写入尾逗号：
- 旧插入逻辑在空对象/空数组时生成带尾逗号的 JSON；PowerShell ConvertFrom-Json 宽松通过，
  但 Node JSON.parse 报错，DSH 启动读配置会失败。
- 已修：空容器分支不写尾逗号；写入前用 Test-Json 严格校验；最终文件再校验一次。
- 已验证 4 种布局：紧凑/多行 × 空/非空；Node JSON.parse 均通过；重复安装幂等；卸载后 JSON 合法。

### P1（已修/降级）

P1-1 注册失败无 fail-safe：
- 之前先装 entries 过滤器再注册 settings.section；若 id 冲突或子槽位 dsh-toolbox.page 已被占用，
  注册失败但过滤器已生效 → 所有非核心页被折叠且没有工具箱入口。
- 已修：先注册 section，成功后才装过滤器；注册失败会撤销过滤器；heal 失败也撤过滤器；
  新增回归测试（fail-section 桩）验证第三方页仍可见。
- 残余：若注册持续失败，不会自动重试（只记录诊断）；但不会破坏侧栏。

P1-2 卸载残留/非事务：
- 卸载正则只匹配带尾逗号的最后一项；若 dsh-toolbox 是最后一项（无逗号）会残留。
  已修为可选逗号并严格校验 JSON。
- 安装/卸载仍不是全事务：失败可能留下 junction/半复制；但 package.json 在写入前已严格校验，
  不会写坏配置；重跑脚本可恢复。列为 P2。

### P2（已修/记录）

- 悬空 junction（Target 目录被删）：Test-Path=false → New-Item 失败；已加检测和清理重建。
- Target 路径含 $1/$&：替换串会被 .NET 展开；已对 linkSpec 做 $→$$ 转义。
- install.cmd 丢参数/恒 exit 0：已透传 %* 并返回 pwsh 退出码。
- 硬编码本机路径：Target 默认改为 PSScriptRoot；公开仓库不再默认指向 F:/Record/...。
- 全局隐藏 __toolbox_nudge_ 前缀：已改成 __dsh_toolbox_nudge_，降低第三方 id 碰撞。
- overrides 的 __proto__ 赋值无效：已把 overrides 改为 null 原型对象，任意 id 都能正常存取，且无原型污染。
- 诊断信息：message 600 + stack 1200 写 localStorage（同源插件可读）；属本地调试信息，未含 token；
  若担心第三方数据，可缩短/加密。未改。
- entries 原型补丁是进程全局：别的插件若再包一层，teardown 后我们已 disposed 直通，但会永久多一层 wrapper；
  这是宿主没有 official API 的固有限制，已记录。
- overrides 不清理旧插件 id；只会缓慢增长，不影响正确性。
- 私有 _core 回退路径会短暂注册占位条目；仅旧宿主/降级时出现，已被过滤器剔除。
- 版本号双源：已加 package.json 与 PLUGIN_VERSION 一致性回归测试。

## 动态证据

- localStorage fuzz：overrides 含 __proto__/constructor/toString、畸形 JSON、非布尔值；
  Object.prototype 未被污染，插件默认/手动模式正常。
- 凭据扫描：git grep + PNG ASCII 扫描无 token/私钥/密码。
- XSS：CSS 固定，第三方 id/label 只走 React 文本，不拼 innerHTML。
- 兼容性：React 18.3.1，Electron 44.7（Chromium 远高于 111），color-mix/WeakMap/Set/queueMicrotask 可用；
  _core/markDirty 失效时回退；locale 缺失时与设置外壳一致不激活。
- 安装隔离测试：临时 profile（紧凑/多行）安装、重复安装、卸载；Node 严格 JSON 校验均通过。

## 残余风险（不阻断发布）

1. 安装/卸载非全事务，失败可能留半安装态；重跑可恢复。
2. 公开仓库的 docs/verify 截图含本机工作区/会话信息；需要时可改 private 或清理历史。
3. docs/verify 证据早于 0.2.1，0.2.1 真机结论来自用户确认（见 docs/bugfix-0.2.1.md）。
4. 第三方插件若使用同一 settings.section id/子槽位名，会与我们冲突；fail-safe 已保证不折叠页面。
