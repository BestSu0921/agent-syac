# 软件清单扫描（被 software-list.mjs 调用）
# 输出 UTF-8 JSON 到 $env:TEMP\sw-list.json
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$items = Get-ItemProperty $paths |
  Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 -and $_.DisplayName -notmatch '^(KB\d{6,}|DesktopShortcut|Security Update|Update for )' } |
  Select-Object DisplayName, DisplayVersion, Publisher, InstallDate,
    @{ n = 'Scope'; e = { if ($_.PSPath -like 'HKCU:*') { 'user' } else { 'machine' } } }
ConvertTo-Json @($items) -Compress | Out-File -FilePath "$env:TEMP\sw-list.json" -Encoding utf8
