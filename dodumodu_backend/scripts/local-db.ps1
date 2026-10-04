<#
Local database control for development. The repository root .env points
DATABASE_URL at this server, so `npm run dev` needs it running; nothing in the
application code starts or stops a database.

  .\scripts\local-db.ps1 status     is it up, and can we reach it
  .\scripts\local-db.ps1 start      start it (safe to run twice)
  .\scripts\local-db.ps1 stop       graceful shutdown
  .\scripts\local-db.ps1 restart
  .\scripts\local-db.ps1 init       create the cluster + database (new machine only)

It uses the PostgreSQL server already installed on this machine rather than a
downloaded copy: the cluster is a normal data directory, owned by whichever
pg_ctl starts it, so there is nothing portable to keep in step. A cluster created
this way is not a Windows service and does not survive a reboot - run `start`
again, which is the point: the data is yours and the process is disposable.

Keep this file ASCII. Windows PowerShell 5.1 reads a .ps1 file as ANSI unless it
has a UTF-8 BOM, and a UTF-8 em dash then decodes to a curly quote - which it
treats as a string terminator, so one dash inside a message breaks the parse
with a baffling "missing }" error. Every other file in this repository is UTF-8
and may use whatever characters it likes; this one may not.

Overridable: LOCAL_PG_BIN, LOCAL_PG_DATA, LOCAL_PG_PORT, LOCAL_PG_DB.
#>
[CmdletBinding()]
param([ValidateSet("start", "stop", "restart", "status", "init")][string]$Action = "status")

$ErrorActionPreference = "Stop"

$dataDir = if ($env:LOCAL_PG_DATA) { $env:LOCAL_PG_DATA } else { Join-Path $env:LOCALAPPDATA "dodumodu-pg\data" }
$port = if ($env:LOCAL_PG_PORT) { $env:LOCAL_PG_PORT } else { "55432" }
$dbName = if ($env:LOCAL_PG_DB) { $env:LOCAL_PG_DB } else { "dodumodu" }
$logFile = Join-Path (Split-Path $dataDir -Parent) "server.log"

function Find-PgBin {
  # An explicit override always wins, and skips the version matching below.
  if ($env:LOCAL_PG_BIN -and (Test-Path (Join-Path $env:LOCAL_PG_BIN "pg_ctl.exe"))) { return $env:LOCAL_PG_BIN }
  $roots = @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL")
  $candidates = @(
    foreach ($root in $roots) {
      if (Test-Path $root) {
        Get-ChildItem $root -Directory | ForEach-Object {
          $bin = Join-Path $_.FullName "bin"
          if (Test-Path (Join-Path $bin "pg_ctl.exe")) { $bin }
        }
      }
    }
  )
  if ($candidates.Count -eq 0) {
    throw "No PostgreSQL installation found. Install PostgreSQL 15 or newer (https://www.postgresql.org/download/windows/) or set LOCAL_PG_BIN to a bin directory containing pg_ctl.exe."
  }
  # A data directory records the major version that created it, and no other
  # major version will open it - so the server binaries are not a free choice.
  # This machine has more than one installed (15 and 18); using 18's pg_ctl to
  # start a 15 cluster fails at the first read of the data files, long after
  # the command looked like it worked.
  $versionFile = Join-Path $dataDir "PG_VERSION"
  if (Test-Path $versionFile) {
    $major = (Get-Content $versionFile -First 1).Trim()
    # The install directory is named for the version: ...\PostgreSQL\15\bin.
    $match = $candidates | Where-Object { (Split-Path (Split-Path $_ -Parent) -Leaf) -eq $major } | Select-Object -First 1
    if (-not $match) {
      $have = ($candidates | ForEach-Object { Split-Path (Split-Path $_ -Parent) -Leaf }) -join ", "
      throw "The cluster at $dataDir is PostgreSQL $major, and no PostgreSQL $major installation was found (installed: $have). Install PostgreSQL $major, or point LOCAL_PG_BIN at it."
    }
    return $match
  }
  # No cluster yet (init): the newest installed version.
  return ($candidates | Sort-Object { [int](Split-Path (Split-Path $_ -Parent) -Leaf) } -Descending | Select-Object -First 1)
}

$bin = Find-PgBin
$pgCtl = Join-Path $bin "pg_ctl.exe"
$psql = Join-Path $bin "psql.exe"
$createdb = Join-Path $bin "createdb.exe"
$initdb = Join-Path $bin "initdb.exe"
$version = (& $pgCtl --version) -replace ".*\(PostgreSQL\)\s*([\d.]+).*", '$1'
Write-Host "PostgreSQL $version  bin: $bin"

function Get-ServerState {
  $status = & $pgCtl -D $dataDir status 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { return $true }
  return $false
}

# Two Windows-specific traps live here, and both fail silently, which is why
# this goes through .NET directly rather than the Start-Process cmdlet:
#
# 1. `pg_ctl start` hands its console handles to the postmaster it launches, so
#    anything that waits on that pipe never returns - `pg_ctl ... | Out-Null`,
#    and Start-Process -Wait, which waits for descendants as well. The database
#    is up seconds before the command appears to hang. So only pg_ctl itself is
#    waited on, and only for a bounded time.
# 2. Argument quoting. An element containing spaces has to be quoted here or
#    pg_ctl reads `-p 55432 -h localhost` as `-p 55432` and complains about an
#    "unrecognized operation mode 55432". Start-Process joins its array with
#    spaces and drops the quoting, so the command line is built here.
function Quote-PgArg {
  param([string]$Arg)
  if ($Arg -match '[\s"]') { return '"' + ($Arg -replace '"', '\"') + '"' }
  return $Arg
}

function Invoke-PgCtl {
  param([string[]]$PgArgs, [int]$TimeoutMs = 60000)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $pgCtl
  $psi.Arguments = (($PgArgs | ForEach-Object { Quote-PgArg $_ }) -join " ")
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # Deliberately no output redirection. The postmaster inherits whatever handles
  # pg_ctl was given, so a pipe opened here is a pipe the database holds open for
  # as long as it runs - and reading it (even asynchronously) never finishes.
  # pg_ctl's own progress is worth seeing in the console anyway, and the server
  # log has the detail if something goes wrong.
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $null = $proc.Start()
  if (-not $proc.WaitForExit($TimeoutMs)) {
    try { $proc.Kill() } catch { }
    throw "pg_ctl $($PgArgs[-1]) did not exit within $TimeoutMs ms. Server log: $logFile"
  }
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw "pg_ctl $($PgArgs[-1]) failed (exit $($proc.ExitCode)). Server log: $logFile" }
}

function Show-Status {
  if (-not (Test-Path $dataDir)) { Write-Host "No cluster at $dataDir. Run: .\scripts\local-db.ps1 init" -ForegroundColor Yellow; return }
  if (Get-ServerState) {
    Write-Host "Server: running on port $port" -ForegroundColor Green
    if (Test-Path $psql) {
      $probe = & $psql -h 127.0.0.1 -p $port -U postgres -d $dbName -t -A -c "select 'database ' || current_database() || ' reachable'" 2>&1 | Out-String
      if ($LASTEXITCODE -eq 0) { Write-Host ("  " + $probe.Trim()) }
      else { Write-Host "  running, but database '$dbName' is missing - run: .\scripts\local-db.ps1 init" -ForegroundColor Yellow }
    }
  } else {
    Write-Host "Server: stopped (data kept at $dataDir)" -ForegroundColor Yellow
  }
}

switch ($Action) {
  "status" { Show-Status }

  "start" {
    if (-not (Test-Path $dataDir)) { throw "No cluster at $dataDir. Run: .\scripts\local-db.ps1 init" }
    if (Get-ServerState) { Write-Host "Already running on port $port."; break }
    # -h localhost keeps it off the network: this is a development database and
    # it trusts its local user, so it must not be reachable from the LAN.
    Invoke-PgCtl @("-D", $dataDir, "-l", $logFile, "-o", "-p $port -h localhost", "-w", "start")
    Write-Host "Started on port $port." -ForegroundColor Green
    Show-Status
  }

  "stop" {
    if (-not (Get-ServerState)) { Write-Host "Not running."; break }
    Invoke-PgCtl @("-D", $dataDir, "-m", "fast", "-w", "stop")
    Write-Host "Stopped. The database is intact at $dataDir" -ForegroundColor Green
  }

  "restart" { & "$PSScriptRoot\local-db.ps1" stop; & "$PSScriptRoot\local-db.ps1" start }

  "init" {
    if (Test-Path (Join-Path $dataDir "PG_VERSION")) { Write-Host "Cluster already exists at $dataDir"; Show-Status; break }
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    # trust: no password prompt, and safe precisely because it only listens on
    # localhost. Swap to scram-sha-256 if you ever expose this port.
    & $initdb -D $dataDir -U postgres -A trust -E UTF8 --no-locale | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed" }
    Invoke-PgCtl @("-D", $dataDir, "-l", $logFile, "-o", "-p $port -h localhost", "-w", "start")
    & $createdb -h 127.0.0.1 -p $port -U postgres $dbName
    if ($LASTEXITCODE -ne 0) { throw "could not create database $dbName" }
    Write-Host "Created cluster and database $dbName on port $port." -ForegroundColor Green
    Write-Host "Next: npm run db:migrate and npm run db:seed"
  }
}
