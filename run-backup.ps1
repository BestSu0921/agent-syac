$preview = @($args | Where-Object { $_ -eq '--dry-run' })
$syncExit = 0
foreach ($step in @('rules', 'memory', 'check')) {
  & 'C:\Program Files\nodejs\node.exe' "$PSScriptRoot\sync.mjs" $step @preview
  if ($LASTEXITCODE -ne 0 -and $syncExit -eq 0) { $syncExit = $LASTEXITCODE }
}
& 'C:\Program Files\nodejs\node.exe' "$PSScriptRoot\backup-agents.mjs" @preview
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit $syncExit
