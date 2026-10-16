# Fix block B in orders.ts: replace requirePermissionOf(c, PERMISSIONS.ordersWrite)
# with requirePermission(c.get("principal"), PERMISSIONS.ordersWrite) for the
# v2 routes (block B). Run from the repo root with:
#   powershell.exe -File scripts/fix-orders-require.ps1
$path = "c:/Users/Chinedu/Documents/web_work/dodumodu/dodumodu_backend/src/routes/admin/orders.ts"

$lines = Get-Content $path
$out = @()
$inBlockB = $false
$blockBTotal = 0
for ($i = 0; $i -lt $lines.Count; $i++) {
  $line = $lines[$i]
  # Enter block B when we hit the bulk/action route post declaration
  if ($line -match '"bulk/action"') { $inBlockB = $true }
  if ($inBlockB -and $line -match '^  return route;$') { $inBlockB = $false }
  if ($inBlockB -and $line -match 'requirePermissionOf\(c, PERMISSIONS\.ordersWrite\)') {
    $line = '    requirePermission(c.get("principal"), PERMISSIONS.ordersWrite);'
    $blockBTotal++
  }
  $out += $line
}

Set-Content -Path $path -Value $out -Encoding UTF8
Write-Host "Block B requirePermissionOf -> requirePermission count=" $blockBTotal
Write-Host "Total lines now: " ($out.Count)



