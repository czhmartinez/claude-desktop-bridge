$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repositoryRoot

function Wait-HttpEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "Timed out waiting for $Url"
}

function Invoke-NpmScript {
  param([Parameter(Mandatory = $true)][string]$Name)
  & npm.cmd run $Name
  if ($LASTEXITCODE -ne 0) { throw "npm run $Name failed with exit code $LASTEXITCODE" }
}

$desktopExecutable = Get-ChildItem -Path "apps/desktop/out" -Recurse -Filter "bridge.exe" |
  Where-Object { $_.FullName -match "Bridge-win32-x64" } |
  Select-Object -First 1
if ($null -eq $desktopExecutable) {
  throw "Packaged Windows executable was not found. Run npm run make:windows first."
}

$qaRoot = Join-Path $env:TEMP ("bridge-packaged-qa-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $qaRoot | Out-Null

$environmentKeys = @(
  "BRIDGE_RELAY_HOST",
  "BRIDGE_RELAY_URL",
  "BRIDGE_PUBLIC_RELAY_URL",
  "BRIDGE_PAIRING_BASE_URL",
  "BRIDGE_SERVICE_ORIGIN",
  "BRIDGE_RELAY_DATA",
  "BRIDGE_DESKTOP_CDP",
  "BRIDGE_E2E_FORCE_RELAY"
)
$originalEnvironment = @{}
foreach ($key in $environmentKeys) {
  $originalEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

$relayProcess = $null
$desktopProcess = $null
try {
  $relayUrl = "ws://127.0.0.1:8788/ws"
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_HOST", "0.0.0.0", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_URL", $relayUrl, "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_PUBLIC_RELAY_URL", "", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_PAIRING_BASE_URL", "http://127.0.0.1:8788", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_SERVICE_ORIGIN", "http://127.0.0.1:8788", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_RELAY_DATA", (Join-Path $qaRoot "relay.sqlite"), "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_DESKTOP_CDP", "http://127.0.0.1:9223", "Process")
  [Environment]::SetEnvironmentVariable("BRIDGE_E2E_FORCE_RELAY", "1", "Process")

  $nodeExecutable = (Get-Command node.exe).Source
  $relayStart = @{
    FilePath = $nodeExecutable
    ArgumentList = (Join-Path $repositoryRoot "apps/relay/dist/index.js")
    WorkingDirectory = $repositoryRoot
    WindowStyle = "Hidden"
    PassThru = $true
  }
  $relayProcess = Start-Process @relayStart
  Wait-HttpEndpoint -Url "http://127.0.0.1:8788/health"

  $desktopStart = @{
    FilePath = $desktopExecutable.FullName
    ArgumentList = @(
      "--bridge-packaged-qa",
      "--user-data-dir=`"$qaRoot`"",
      "--remote-debugging-port=9223"
    )
    WorkingDirectory = $desktopExecutable.DirectoryName
    PassThru = $true
  }
  $desktopProcess = Start-Process @desktopStart
  Wait-HttpEndpoint -Url "http://127.0.0.1:9223/json/version" -TimeoutSeconds 45

  Invoke-NpmScript -Name "test:desktop:packaged"
  Invoke-NpmScript -Name "test:desktop:pairing"
} finally {
  if ($null -ne $desktopProcess -and -not $desktopProcess.HasExited) {
    & taskkill.exe /PID $desktopProcess.Id /T /F 2>$null | Out-Null
  }
  if ($null -ne $relayProcess -and -not $relayProcess.HasExited) {
    Stop-Process -Id $relayProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Path $qaRoot -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($key in $environmentKeys) {
    [Environment]::SetEnvironmentVariable($key, $originalEnvironment[$key], "Process")
  }
}
