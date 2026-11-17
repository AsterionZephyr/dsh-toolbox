<#
  dsh-toolbox 安装/卸载脚本（幂等）。

  通道：**bundle 通道**（与本机 dsh-ustc-usage / dsh-desktop-hand / dsh-ustc-image 一致）
    - 插件包内 cordis.patch.yml 声明挂载行（dsh.bundle.patch）
    - profile package.json 的 dsh.profile.bundles 追加 "dsh-toolbox"
    - profile package.json 的 dependencies 记一行 link:<插件目录>
    - profile node_modules 建 junction，供 Node 按包名解析
  不写 profile 的 cordis.patch.yml：那是"手工通道"，与 bundle 通道同时用会双重挂载
  （见 DSH环境/DSH插件开发参考.md 第 F、G 节）。

  用法：
    pwsh -File install.ps1                 # 安装（默认从本目录复制到 DSH环境\dsh-toolbox）
    pwsh -File install.ps1 -Uninstall      # 卸载（删 junction 与两行；插件目录保留）
    双击 install.cmd 等价于安装。

  所有改动前都会备份（*.bak-toolbox-<时间戳>）。
#>
[CmdletBinding()]
param(
  [string]$Source = $PSScriptRoot,
  [string]$Target = 'F:\Record\AIdatabase\09-杂项\DSH环境\dsh-toolbox',
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$NL = [Environment]::NewLine

function Assert-Path($path, $what) {
  if (-not (Test-Path -LiteralPath $path)) { throw "$what 不存在：$path" }
}
function Backup($path) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $to = $path + '.bak-toolbox-' + $stamp
  Copy-Item -LiteralPath $path -Destination $to -Force
  return $to
}

$packageJson = Join-Path $Profile 'package.json'
$patchFile = Join-Path $Profile 'cordis.patch.yml'
$nodeModules = Join-Path $Profile 'node_modules'
$link = Join-Path $nodeModules 'dsh-toolbox'
Assert-Path $packageJson 'profile/package.json'
Assert-Path $nodeModules 'profile/node_modules'

if ($Uninstall) {
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    if ($item.LinkType -eq 'Junction') { [System.IO.Directory]::Delete($link); Write-Host "已删除 junction：$link" }
    else { throw "$link 不是 junction，为安全起见不自动删除" }
  }
  $text = Get-Content -LiteralPath $packageJson -Raw -Encoding utf8
  $before = $text
  $text = [regex]::Replace($text, '(?m)^[ \t]*"dsh-toolbox"\s*:\s*"[^"]*",\r?\n', '')
  $text = [regex]::Replace($text, '(?m)^[ \t]*"dsh-toolbox",\r?\n', '')
  if ($text -ne $before) {
    $bak = Backup $packageJson
    Set-Content -LiteralPath $packageJson -Value $text -Encoding utf8NoBOM -NoNewline
    Write-Host "已从 package.json 移除 dsh-toolbox 的依赖行与 bundles 行（备份：$bak）"
  } else {
    Write-Host 'package.json 里没有 dsh-toolbox，无需改动。'
  }
  if (Test-Path -LiteralPath $patchFile) {
    $patch = Get-Content -LiteralPath $patchFile -Raw -Encoding utf8
    if ($patch -match 'dsh-toolbox') {
      $bak2 = Backup $patchFile
      $next = [regex]::Replace($patch, '(?s)\r?\n?# >>> dsh-toolbox >>>.*?# <<< dsh-toolbox <<<\r?\n?', $NL)
      Set-Content -LiteralPath $patchFile -Value $next -Encoding utf8NoBOM -NoNewline
      Write-Host "已清理 profile cordis.patch.yml 里的旧工具箱段（备份：$bak2）"
    }
  }
  Write-Host '卸载完成，重启 DSH 生效。'
  return
}

# ---- 1) 复制插件目录 ----
$resolvedTarget = $null
try { $resolvedTarget = (Resolve-Path -LiteralPath $Target).Path } catch { $resolvedTarget = $null }
$needCopy = -not ($resolvedTarget -and ((Resolve-Path -LiteralPath $Source).Path -eq $resolvedTarget))
if ($needCopy) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  foreach ($name in @('lib', 'cordis.patch.yml', 'package.json', 'README.md', 'HANDOVER.md', 'install.ps1', 'install.cmd')) {
    $from = Join-Path $Source $name
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $Target -Recurse -Force }
  }
  Write-Host "已复制插件到：$Target"
} else {
  Write-Host "插件已在目标位置：$Target"
}

# ---- 2) junction ----
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  $targets = @($item.Target)
  if ($item.LinkType -eq 'Junction' -and ($targets -contains $Target)) {
    Write-Host "junction 已存在：$link"
  } else {
    throw "$link 已存在但不是指向 $Target 的 junction，请先手工处理"
  }
} else {
  New-Item -ItemType Junction -Path $link -Target $Target | Out-Null
  Write-Host "已建立 junction：$link -> $Target"
}

# ---- 3) package.json：依赖行 + bundles 行 ----
$text = Get-Content -LiteralPath $packageJson -Raw -Encoding utf8
$before = $text
$linkSpec = 'link:' + ($Target -replace '\\', '/')

if ($text -notmatch '"dsh-toolbox"\s*:') {
  $replacement = '$1    "dsh-toolbox": "' + $linkSpec + '",' + $NL
  $text = [regex]::Replace($text, '("dependencies"\s*:\s*\{\r?\n)', $replacement, 1)
}
if ($text -notmatch '(?m)^[ \t]*"dsh-toolbox",\s*$') {
  $replacement2 = '$1        "dsh-toolbox",' + $NL
  $text = [regex]::Replace($text, '("bundles"\s*:\s*\[\r?\n)', $replacement2, 1)
}

if ($text -ne $before) {
  $bak = Backup $packageJson
  Set-Content -LiteralPath $packageJson -Value $text -Encoding utf8NoBOM -NoNewline
  Write-Host "已写入 package.json（备份：$bak）"
} else {
  Write-Host 'package.json 已是目标状态，未改动。'
}

# ---- 4) 清掉旧的手工通道段（若存在） ----
if (Test-Path -LiteralPath $patchFile) {
  $patch = Get-Content -LiteralPath $patchFile -Raw -Encoding utf8
  if ($patch -match 'dsh-toolbox') {
    $bak2 = Backup $patchFile
    $next = [regex]::Replace($patch, '(?s)\r?\n?# >>> dsh-toolbox >>>.*?# <<< dsh-toolbox <<<\r?\n?', $NL)
    Set-Content -LiteralPath $patchFile -Value $next -Encoding utf8NoBOM -NoNewline
    Write-Host "已清理 profile cordis.patch.yml 里的旧工具箱段（备份：$bak2）"
  }
}

# ---- 5) 自检 ----
$json = Get-Content -LiteralPath $packageJson -Raw -Encoding utf8 | ConvertFrom-Json
$checks = [ordered]@{
  Dependency  = [bool]$json.dependencies.'dsh-toolbox'
  Bundles     = (@($json.dsh.profile.bundles) -contains 'dsh-toolbox')
  Junction    = (Test-Path -LiteralPath $link)
  PatchClean  = -not ((Test-Path -LiteralPath $patchFile) -and ((Get-Content -LiteralPath $patchFile -Raw -Encoding utf8) -match 'dsh-toolbox'))
  HostEntry   = (Test-Path -LiteralPath (Join-Path $Target 'lib\index.js'))
  ClientEntry = (Test-Path -LiteralPath (Join-Path $Target 'lib\client.js'))
  BundlePatch = (Test-Path -LiteralPath (Join-Path $Target 'cordis.patch.yml'))
}
$checks.GetEnumerator() | ForEach-Object { Write-Host ("自检 " + $_.Key.PadRight(12) + " = " + $_.Value) }
if ($checks.Values -contains $false) { throw '安装自检失败' }

Write-Host ''
Write-Host '安装完成。bundle 通道在启动时组合，**重启 DSH** 后生效；'
Write-Host '重启后打开 设置 → 工具箱（侧栏应只剩 通用/模型/插件/账户 + 工具箱）。'
