param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Args,
    [bool]$NewWindow = $true,
    [bool]$OpenBrowser = $true,
    [string]$Url,
    [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'

# Optional per-project config
$configPath = Join-Path $PSScriptRoot 'run.config.json'
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($null -ne $cfg.OpenBrowser) { $OpenBrowser = [bool]$cfg.OpenBrowser }
        if ($null -ne $cfg.NewWindow) { $NewWindow = [bool]$cfg.NewWindow }
        if ($cfg.Url) { $Url = [string]$cfg.Url }
        if ($cfg.WaitSeconds) { $WaitSeconds = [int]$cfg.WaitSeconds }
    } catch {
        Write-Warning "Could not parse run.config.json: $_"
    }
}

# Ensure venv is present and deps installed
& "$PSScriptRoot\setup_venv.ps1"

# Compute interpreter path (matches setup_venv)
$projectBase = Split-Path -Leaf (Resolve-Path .)
$venvHome = if ($env:VENV_HOME) { $env:VENV_HOME } else { Join-Path $env:LOCALAPPDATA 'venvs' }
$venvPath = Join-Path $venvHome ($projectBase -replace '[^\w\.-]', '-')
$py = Join-Path $venvPath 'Scripts\python.exe'

# Default args: app.py if present
if (-not $Args -or $Args.Count -eq 0) {
    if (Test-Path 'app.py') {
        $Args = @('app.py')
    } else {
        Write-Host "Usage: ./run.ps1 <script.py | -m module> [args]"
        Write-Host "Examples: ./run.ps1 app.py | ./run.ps1 -m flask run"
        exit 1
    }
}

# Start the server
if ($NewWindow) {
    Start-Process -FilePath $py -ArgumentList $Args -WorkingDirectory (Get-Location)
} else {
    # run inline so we see errors
    & $py @Args
    exit $LASTEXITCODE
}

# Build URL if requested
if ($OpenBrowser) {
    if (-not $Url -or $Url.Trim() -eq '') {
        if ($env:APP_URL) {
            $Url = $env:APP_URL
        } else {
            $hostName = if ($env:FLASK_RUN_HOST) { $env:FLASK_RUN_HOST } else { '127.0.0.1' }
            if ($hostName -eq '0.0.0.0') { $hostName = '127.0.0.1' }
            $port = if ($env:FLASK_RUN_PORT) { $env:FLASK_RUN_PORT } else { '5000' }
            $Url = "http://$($hostName):$($port)/"
        }
    }

    # Try to wait until server responds, then open browser
    $ok = $false
    for ($i = 0; $i -lt $WaitSeconds; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Url -Method Head -TimeoutSec 2 | Out-Null
            $ok = $true
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $ok) {
        # Fallback to a short delay if probe didn't succeed
        Start-Sleep -Seconds 3
    }
    Start-Process $Url
}
