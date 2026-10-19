 = 'C:\\Users\\Chinedu\\Documents\\web_work\\dodumodu\\dodumodu_site'
Write-Output ('ROOT declared: ' + )
# compute two levels up from test/ and one level up
 = Join-Path (Split-Path (Split-Path  -Leaf) -Parent) (Split-Path  -Leaf)
 = Split-Path (Split-Path  -Parent) -Parent
Write-Output ('ONE_UP: ' + )
Write-Output ('TWO_UP: ' + )
Write-Output ('exists dist at TWO_UP: ' + (Test-Path (Join-Path  'dist')))
Write-Output ('exists admin dir at TWO_UP: ' + (Test-Path (Join-Path  'dodumodu_site' 'dist')))

