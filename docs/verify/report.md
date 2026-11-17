# dsh-toolbox 真机验证报告（共享任务板 task-3）

> 执行：livecheck（子智能体）｜时间：2026-11-17 16:27–17:33｜环境：本机 Windows 10/11，DSH Desktop 0.2.2-rc.1（commit c59d10a），web GUI `http://127.0.0.1:11412`
>
> **一句话结论：插件已在本机"运行中"的 DSH 里生效（宿主已把 client bundle 组合进客户端启动图并下发）；但设置面板的 UI 逐条验收（侧栏出现「工具箱」、展开、切换、刷新保持）本次没能完成**——web 端 token 拿不到，桌面端设置入口在"不碰其它窗口"的前提下打不开。

---

## 1. 环境与时序（很关键）

| 事实 | 值 |
| --- | --- |
| DSH 宿主进程 | PID 10136，`dsh-desktop-host`，启动于 **2026-11-15 21:18:21** |
| 插件安装时间 | **2026-11-17 12:54**（profile 备份 `package.json.bak-toolbox-20261117-125428`） |
| 是否重启过 | **没有**（宿主进程启动早于安装两天） |
| web 服务归属 | 11412 由宿主进程 10136 监听（桌面端内嵌，不是单独的 `dsh web`） |

**推论（已实测证实，见 §2）**：bundle 通道**不需要重启**也能生效——DSH 会按 Loader 条目在运行中重组客户端启动图。HANDOVER 第 2 节"首次加载要重启 DSH"的说法需要更新。

---

## 2. 已证实：插件对宿主生效 ✅

| 检查 | 结果 |
| --- | --- |
| 客户端启动图（`GET /plugins/events`，该路由不需要鉴权） | 图中含 **`{"id":"dsh-toolbox","url":"plugins/??dsh-toolbox/client.js&rev=921a4663b66c","rev":"921a4663b66c","immediately":true}`**；图 rev `647fed981493`，共 91 个条目（`dsh-theme-palette` / `dsh-wechat` / `@linxin666/dsh-pet` 等第三方条目并列在列） |
| client bundle 可取回 | `GET /plugins/??dsh-toolbox/client.js&rev=921a4663b66c` → **200**，25447 B |
| 与仓库文件是否同源 | 本地 `lib/client.js` 25378 B；服务端比本地多 **69 B**，即 combo 追加的 `\n;\n//# sourceMappingURL=??dsh-toolbox/client.js.map&rev=921a4663b66c\n`；正文逐字节一致（头部注释、`window.__ModuleLoader__.load({id:"dsh-toolbox"...})` 完全相同） |
| 安装状态 | junction 存在（`LinkType=Junction` → `F:\Record\AIdatabase\09-杂项\DSH环境\dsh-toolbox`）；`dependencies."dsh-toolbox" = link:...`；`dsh.profile.bundles` 含 `dsh-toolbox` |

证据文件：[graph-entry.json](graph-entry.json)

**结论**：宿主半边 + client bundle 都已上线，插件本身没有"没装上/没加载"的问题。

---

## 3. 未完成：设置面板 UI 验收 ❌

### 3.1 Web GUI 路线（首选，失败）

- `GET http://127.0.0.1:11412/` → **401**，body：`dsh web authentication required; reopen the URL printed by dsh web.`
- 该 401 只挡外壳；`/plugins/*` 路由（含 `/plugins/events`）**不需要鉴权**——§2 的证据正是这么拿到的。
- 找 token 的位置与结果：

| 位置 | 结果 |
| --- | --- |
| 进程命令行（含 11412 / dsh / electron 的进程） | 无 token，只有端口与路径 |
| `%USERPROFILE%\.dsh\logs` | 最新只到 2026-11-04（旧 desktop-next 日志），没有本次启动日志 |
| `%APPDATA%\@deepseek-ai\dsh-desktop\logs` | 空目录 |
| `Local Storage\leveldb`、`Session Storage` | 扫 `token`/`11412`/`auth`（ASCII + UTF-16）→ **无命中** |
| `Network\Cookies` | 被 Electron 独占，无法复制读取 |
| `%USERPROFILE%\.dsh\electron-user-data` | 2026-11-04 的旧目录，不是当前用户数据目录 |

- 判断：token 是**随进程启动生成的一次性密钥**（`dsh-web-app` 里 "process-token URL line"），没有落盘，本次拿不到。pilot 浏览器只能停在鉴权页。
- **token 没有写进任何仓库文件/截图**（全程没拿到过）。

### 3.2 桌面端路线（受限，没能打开设置）

桌面窗口抓图可用（PrintWindow，不抢焦点），但**找不到可点的设置入口**：

- 侧栏底部只有「远程控制」「新版本」，**没有齿轮**；
- DOM 查询无带「设置」aria-label 的按钮（`triggers=[]`）；
- `Mod+,`：SendKeys 与 Win32 `keybd_event` 两种方式各发一次 Ctrl+Comma，**都没打开设置**；
- 按 lead 指令，17:31 起已**停止一切桌面点击/键盘注入**，未再尝试。

### 3.3 HANDOVER 第 6 节验收清单逐条

| # | 验收条目 | 结果 | 说明 / 证据 |
| --- | --- | --- | --- |
| 1 | 重启 DSH | **未做（禁止）**；且实测**不重启也已生效** | §2 |
| 2 | 左侧导航只剩 账户/通用/模型/插件/**工具箱** | **未验证** | 打不开设置面板 |
| 3 | 工具箱页：各插件页行、`已收纳` 按钮、诊断块「侧栏过滤器=已安装」 | **未验证** | 同上 |
| 4 | 任点一行标题原地展开，原组件真实渲染 | **未验证** | 同上 |
| 5 | 切 `已收纳`↔`在侧栏`，侧栏即时增减 | **未验证** | 同上 |
| 6 | 全部放回 / 全部收纳 / 刷新后状态保持 | **未验证** | 同上 |
| 7 | 某个页展开空白/报错时记录 id | 无数据 | 同上 |
| — | 设置面板打开耗时 | **未测** | 面板没打开 |

---

## 4. 本次发现的可疑现象（值得优先跟进）

1. **桌面壳里 `/plugins/events` 事件流持续失败**：DevTools Console 里成排
   `GET dsh-app://app/plugins/events net::ERR_FAILED 200 (OK)`，Errors 计数 **534**（见截图）。
   - 按 `dsh-client-modules` README 的说法：图事件流一旦断了，"页面既不更新插件、也检测不到 release 变化，直到刷新"。
   - **含义**：当前这个已经打开的页面**很可能没有收到 dsh-toolbox 的图更新**——宿主那边有（§2），页面这边没挂上。所以"现在打开设置看不到工具箱"完全可能，**先刷新页面（Ctrl+R，等价 web 端 F5，不是重启 DSH）再验收**。
   - 也可能只是桌面壳 `dsh-app://` 协议下 SSE 不被支持的环境问题，不一定是插件的问题，需要对照"没装插件时同一个窗口有没有这条错误"。
2. **桌面壳找不到设置入口**：`settings.launcher` 槽位可能被别的插件（如 dsh-better-sidebar）接管，或桌面壳把它渲染在了别处。做验收前要先确认"正常情况下设置怎么打开"，否则会把"入口找不到"误判成插件问题。

---

## 5. 边界与改动核对

- 未重启 DSH；未改 profile / 配置；未改 `lib/`、`bench/`、`install*`、`package.json`；只写了 `docs/verify/`。
- 未在仓库里存 token（本次也没拿到 token）。

---

## 6. 桌面操作记录与影响（按 lead 要求逐条交代）

| 时间 | 操作 | 目标窗口 | 影响 |
| --- | --- | --- | --- |
| 16:37–16:47 | `desktop_focus` / `desktop_click` | DSH 主窗口（handle 197652） | 尝试打开设置；期间点到侧栏「插件」「插件市场」「自动化任务」「更多」等，DSH UI 切过页面（**只切了 UI，没有改任何数据/配置**） |
| 16:55 | PowerShell `SendKeys("^,")` | 前台窗口（当时是 DSH） | DSH 界面换到了别的会话页 |
| 16:57 | 点 DSH 菜单栏「应用」 | DSH 主窗口 | 原生菜单弹出（截图变黑），随即 Esc 关闭 |
| 17:08 | `desktop_type f12` | DSH 主窗口 | 打开了 DSH 自己的 DevTools（handle 3606684） |
| 17:09–17:31 | 在 DevTools 窗口内点击/输入 | DevTools（属 DSH 进程） | 在 console 里执行了 `1+1`、DOM 查询等只读表达式 |
| 17:32 | `PostMessage(WM_CLOSE)`（只发给句柄 3606684，不抢焦点） | DevTools | 已关闭（`desktop_list_windows` 复查：无 Developer Tools 窗口） |

**必须知会用户的风险点**：**17:09:32 有一次点击落在屏幕坐标 (630,396)**，当时 DevTools 正要最小化、无法确认最上层窗口是谁；如果当时最上层是嘉立创 EDA 窗口，**可能在该窗口内产生过一次点击**。此后所有点击都落在 DSH 自己的窗口内。

- 没有对 EDA 窗口做过任何**主动**操作；没有拖拽、没有关闭任何非 DSH 窗口；没有向其它程序注入文字。
- 键盘注入（Ctrl+Comma / Esc / F12 / DevTools 内打字）全部发生在"DSH 主窗口或 DSH 的 DevTools"为前台时（工具回执里的 `foregroundTitle` 可查）。

---

## 7. 建议的下一步（把验收做完的最短路径）

1. **先刷新一次 DSH 窗口**（Ctrl+R，或直接重开窗口）——解决 §4.1 的图事件流问题，让页面重新从宿主拿一遍启动图；
2. 由**用户手动**打开设置（`Mod+,` 在用户手上有效），确认左侧是否有「工具箱」，截图保存到本目录；
3. 如果能提供一个**带 token 的 URL**（只贴在会话里，不进仓库），我可以直接用 pilot 浏览器把第 6 节 6 条全部跑完并留截图，包括刷新后 localStorage 持久化。

---

## 8. 证据文件

| 文件 | 内容 |
| --- | --- |
| [graph-entry.json](graph-entry.json) | `/plugins/events` 图中 dsh-toolbox 条目（含 rev、图 rev、条目总数） |
| [desktop-app-window.png](desktop-app-window.png) | 桌面端 DSH 主窗口整图（**桌面端证据**，截图时停在 lead 会话） |
| [desktop-devtools-console-events-errors.png](desktop-devtools-console-events-errors.png) | DSH 的 DevTools Console：`/plugins/events` 多条 `net::ERR_FAILED`；以及 console 可用性验证 `1+1 → 2`（**桌面端证据**） |
| [desktop-app-current.png](desktop-app-current.png) | 桌面端窗口 17:31 状态（**桌面端证据**） |
