Write-Host '== FLOW PROBE =='
$s=New-Object Microsoft.PowerShell.Commands.WebRequestSession
$h=@{'Content-Type'='application/json';'Origin'='http://127.0.0.1:8787';'X-Test-Ip'='10.94.94.94'}
Write-Host '--- request ---'
Invoke-RestMethod 'http://127.0.0.1:8787/auth/request' -Method POST -Headers $h -Body '{"email":"staff@example.com"}' -WebSession $s | ConvertTo-Json -Compress
Write-Host '--- mailbox ---'
Invoke-RestMethod 'http://127.0.0.1:8787/auth/test/mailbox/staff@example.com' -WebSession $s | ConvertTo-Json -Depth 5
