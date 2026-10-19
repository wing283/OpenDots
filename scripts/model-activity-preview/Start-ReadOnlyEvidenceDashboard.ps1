param(
  [Parameter(Mandatory)][string]$ExistingEvidenceRoot,
  [Parameter(Mandatory)][string]$SolEvidenceRoot,
  [int]$Port = 58370
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$evidenceRoot = (Resolve-Path -LiteralPath $ExistingEvidenceRoot).Path
$solEvidenceRoot = (Resolve-Path -LiteralPath $SolEvidenceRoot).Path
$node = (Get-Command node -ErrorAction Stop).Source
$port = $Port
if ($port -lt 1 -or $port -gt 65535) { throw 'Port must be between 1 and 65535.' }
if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Port $port is already listening; retry with -Port <free-port>." }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$stdout = Join-Path $env:TEMP "seraphim-readonly-dashboard-$stamp.stdout.log"
$stderr = Join-Path $env:TEMP "seraphim-readonly-dashboard-$stamp.stderr.log"
$process = Start-Process -FilePath $node -ArgumentList @('--import','tsx',(Join-Path $PSScriptRoot 'read-only-evidence-dashboard.ts'),$evidenceRoot,$solEvidenceRoot,[string]$port) -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Start-Sleep -Milliseconds 700
if ($process.HasExited) { throw "Dashboard exited during startup. See $stderr" }
try { $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 3 -UseBasicParsing } catch { throw "Dashboard health check failed: $($_.Exception.Message) See $stderr" }
if ([int]$response.StatusCode -ne 200) { throw "Unexpected Dashboard HTTP status $([int]$response.StatusCode). See $stderr" }
[pscustomobject]@{ PID=$process.Id; URL="http://127.0.0.1:$port/"; StartedAtUtc=$process.StartTime.ToUniversalTime().ToString('o'); EvidenceRoots=@($evidenceRoot,$solEvidenceRoot); StdoutLog=$stdout; StderrLog=$stderr; Host='127.0.0.1'; ReadOnly=$true } | ConvertTo-Json -Compress
