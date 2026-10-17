# 兼容 Windows PowerShell 5.1 与 PowerShell 7+。
<#
.SYNOPSIS
  把 dsh-approval-alert 安装进 DSH 的 profile。

.DESCRIPTION
  默认走“手工接线”(最安全,不需要 pnpm,也不动已有的依赖树):
    1. profile/package.json 的 dependencies 里加一条 link: 指向本目录;
    2. profile/package.json 的 dsh.profile.bundles 里追加 "dsh-approval-alert";
    3. 在 profile/node_modules 下建一个指向本目录的目录联接(junction)。

  这三步都是幂等的,重复运行不会产生重复项。安装完成后 **需要重启 DeepSeek
  Harness**(Web 界面刷新不够:插件 bundle 在启动时进入加载图)。

.PARAMETER Profile
  profile 名,默认 desktop(桌面版)。想装进 web profile 就传 -Profile web。

.PARAMETER UsePnpm
  改用官方方式 `dsh plugin --profile <name> add link:<dir>`(会同时维护
  pnpm-lock.yaml)。要求:DeeP Seek Harness 已完全退出,且 pnpm 在 PATH 上。
  先手工接线、之后再补 lockfile 时也可以单独用这个开关重跑一次。

.PARAMETER Uninstall
  反向操作:移除 bundles 条目、dependencies 条目与 node_modules 联接。

.EXAMPLE
  pwsh -File scripts/install.ps1
  pwsh -File scripts/install.ps1 -Profile web
  pwsh -File scripts/install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$UsePnpm,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PackageName = 'dsh-approval-alert'
$pluginDir = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $Profile)
$manifestPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path $profileDir (Join-Path 'node_modules' $PackageName)

function Write-Section([string]$text) {
  Write-Host ''
  Write-Host "== $text" -ForegroundColor Cyan
}

function Write-Step([string]$text) {
  Write-Host "   · $text"
}

function Write-Done([string]$text) {
  Write-Host "   ✓ $text" -ForegroundColor Green
}

function Write-Warn2([string]$text) {
  Write-Host "   ! $text" -ForegroundColor Yellow
}

# --- 前置检查 ---------------------------------------------------------------

Write-Section "检查环境"
Write-Step "插件目录:$pluginDir"
Write-Step "DSH 家目录:$dshHome"
Write-Step "目标 profile:$profileDir"

foreach ($required in @('package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js')) {
  $target = Join-Path $pluginDir $required
  if (-not (Test-Path -LiteralPath $target)) {
    throw "插件目录不完整,缺少 $required(当前目录:$pluginDir)"
  }
}
Write-Done '插件目录结构完整(package.json / cordis.patch.yml / lib/index.js / lib/client.js)'

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "找不到 profile 清单:$manifestPath`n请先启动一次 DeepSeek Harness 让它初始化 profile,然后再运行本脚本。"
}
Write-Done '找到 profile 清单'

# --- 可选:官方 pnpm 路径 ---------------------------------------------------

if ($UsePnpm -and -not $Uninstall) {
  Write-Section '尝试官方安装方式(dsh plugin ... add link:...)'
  $appExe = 'D:\Software\dsh\DeepSeek Harness.exe'
  $cliBin = 'D:\Software\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($running) {
    Write-Warn2 'DeepSeek Harness 正在运行;官方方式要求完全退出,改装为手工接线。'
  }
  elseif (-not (Test-Path -LiteralPath $appExe) -or -not (Test-Path -LiteralPath $cliBin)) {
    Write-Warn2 "找不到 DSH 应用或 CLI($appExe),改装为手工接线。"
  }
  elseif (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Warn2 'PATH 上没有 pnpm,改装为手工接线。'
  }
  else {
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
      & $appExe $cliBin plugin --profile $Profile add "link:$pluginDir"
      if ($LASTEXITCODE -ne 0) { Write-Warn2 "pnpm 返回 $LASTEXITCODE,继续手工接线把状态补齐。" }
      else { Write-Done '官方安装方式完成' }
    }
    finally {
      Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
  }
}

# --- 编辑 profile/package.json ---------------------------------------------

Write-Section '更新 profile 清单'
Copy-Item -LiteralPath $manifestPath -Destination "$manifestPath.bak" -Force
Write-Step "已备份:$manifestPath.bak"

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

if (-not $manifest.PSObject.Properties['dependencies']) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.PSObject.Properties['dsh']) {
  $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dsh.PSObject.Properties['profile']) {
  $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dsh.profile.PSObject.Properties['bundles']) {
  $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}

$bundles = @($manifest.dsh.profile.bundles)
$dependencies = $manifest.dependencies
$depProps = $dependencies.PSObject.Properties.Name

if ($Uninstall) {
  $bundles = @($bundles | Where-Object { $_ -ne $PackageName })
  if ($depProps -contains $PackageName) { $dependencies.PSObject.Properties.Remove($PackageName) }
  $manifest.dsh.profile.bundles = @($bundles)
}
else {
  if ($depProps -notcontains $PackageName) {
    $dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue "link:$pluginDir"
    Write-Done "dependencies += $PackageName (link:$pluginDir)"
  }
  else {
    $existing = $dependencies.$PackageName
    if ($existing -ne "link:$pluginDir") {
      $dependencies.$PackageName = "link:$pluginDir"
      Write-Done "dependencies.$PackageName 已更新为 link:$pluginDir(原:$existing)"
    }
    else { Write-Step "dependencies 已包含 $PackageName" }
  }

  if ($bundles -notcontains $PackageName) {
    $bundles = @($bundles) + $PackageName
    $manifest.dsh.profile.bundles = @($bundles)
    Write-Done "dsh.profile.bundles += $PackageName(当前顺序:$($bundles -join ' → '))"
  }
  else { Write-Step "dsh.profile.bundles 已包含 $PackageName" }
}

$json = $manifest | ConvertTo-Json -Depth 24
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# ConvertTo-Json 在 5.1 上会输出 4 空格 + "key":  "value" 的怪格式;有 node 就用它
# 重新序列化成 DSH 自己的 2 空格风格(没有 node 时退回 PowerShell 的输出,JSON 仍合法)。
$nodeExe = $null
$nodeCandidates = @(
  (Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
  'node'
)
foreach ($candidate in $nodeCandidates) {
  if (Test-Path -LiteralPath $candidate) { $nodeExe = $candidate; break }
  if ($candidate -eq 'node' -and (Get-Command node -ErrorAction SilentlyContinue)) { $nodeExe = $candidate; break }
}

if ($nodeExe) {
  $tmpManifest = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-profile-' + [guid]::NewGuid().ToString('N') + '.json')
  [System.IO.File]::WriteAllText($tmpManifest, $json, $utf8NoBom)
  & $nodeExe (Join-Path $PSScriptRoot 'normalize-manifest.mjs') $tmpManifest $manifestPath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $manifestPath)) {
    [System.IO.File]::WriteAllText($manifestPath, ($json + "`n"), $utf8NoBom)
  }
  Remove-Item -LiteralPath $tmpManifest -Force -ErrorAction SilentlyContinue
}
else {
  [System.IO.File]::WriteAllText($manifestPath, ($json + "`n"), $utf8NoBom)
}
Write-Done "写入 $manifestPath"

# --- node_modules 联接 ------------------------------------------------------

Write-Section '维护 node_modules 联接'
$nodeModules = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }

$existingLink = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
if ($Uninstall) {
  if ($existingLink) {
    if ($existingLink.LinkType) { [System.IO.Directory]::Delete($linkPath, $false) }
    else { Remove-Item -LiteralPath $linkPath -Recurse -Force }
    Write-Done "已移除联接 $linkPath"
  }
  else { Write-Step '联接本来就不存在' }
}
else {
  $linkMissingOrWrong = $true
  if ($existingLink) {
    $target = $null
    if ($existingLink.LinkType) { $target = @($existingLink.Target)[0] }
    if ($target) {
      $resolved = [System.IO.Path]::GetFullPath($target)
      if ($resolved -eq [System.IO.Path]::GetFullPath($pluginDir)) { $linkMissingOrWrong = $false }
      else {
        Remove-Item -LiteralPath $linkPath -Recurse -Force
        Write-Step "旧联接指向 $resolved,已移除"
      }
    }
    else {
      # 已是一个真实目录(可能被 pnpm 复制安装过):保留并提示
      if (Test-Path -LiteralPath (Join-Path $linkPath 'package.json')) {
        $linkMissingOrWrong = $false
        Write-Step '已存在实体安装目录,保留(不覆盖)'
      }
      else { Remove-Item -LiteralPath $linkPath -Recurse -Force }
    }
  }
  if ($linkMissingOrWrong) {
    New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
    Write-Done "已建立联接:$linkPath → $pluginDir"
  }
  else { Write-Step '联接已就绪' }
}

# --- 结果校验 ---------------------------------------------------------------

Write-Section '校验'
$finalManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$finalBundles = @($finalManifest.dsh.profile.bundles)
$installed = Test-Path -LiteralPath (Join-Path $linkPath 'package.json')

if ($Uninstall) {
  if ($finalBundles -notcontains $PackageName -and -not $installed) {
    Write-Done '卸载完成'
    Write-Host '   · 重启 DeepSeek Harness 后,提醒功能与左下角小铃铛会消失。'
  }
  else {
    Write-Warn2 '看起来还有残留,请检查 profile 清单与 node_modules 联接。'
    exit 1
  }
  exit 0
}

if ($finalBundles -notcontains $PackageName) { Write-Warn2 'bundles 里没有本插件,安装未生效'; exit 1 }
if (-not $installed) { Write-Warn2 'node_modules 联接不可用,安装未生效'; exit 1 }

Write-Done 'profile 清单与联接都正确'
Write-Host ''
Write-Host '下一步:' -ForegroundColor Cyan
Write-Host '   1) 完全退出并重新启动 DeepSeek Harness(仅刷新页面不够);'
Write-Host '   2) 启动后左下角会出现一个小铃铛,点它就能配置提示音与通知;'
Write-Host '   3) 也可以在「设置 → 插件」里找到本插件那一页。'
Write-Host ''
Write-Host '验证小技巧:在开发者工具控制台执行 __dshApprovalAlert.testAlert() 可立即试听。'
