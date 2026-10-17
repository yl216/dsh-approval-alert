# 卸载 dsh-approval-alert:移除 profile 里的 bundles 条目、dependencies 条目与 node_modules 联接。
# 用法:powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-Profile web]
[CmdletBinding()]
param(
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$install = Join-Path $PSScriptRoot 'install.ps1'

Write-Host '== 卸载 dsh-approval-alert' -ForegroundColor Cyan
& $install -Profile $Profile -Uninstall
exit $LASTEXITCODE
