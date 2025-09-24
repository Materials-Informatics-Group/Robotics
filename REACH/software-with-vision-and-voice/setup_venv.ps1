param(
    # Optional: override the venv name (defaults to current folder name)
    [string]$Name,
    # Optional: override where venvs live (defaults to %LOCALAPPDATA%\venvs or $env:VENV_HOME)
    [string]$VenvRoot
)

$ErrorActionPreference = 'Stop'

# Resolve project name (used for the venv folder name)
$projectBase = Split-Path -Leaf (Resolve-Path .)
$projectName = if ($Name) { $Name } else { ($projectBase -replace '[^\w\.-]', '-') }

# Resolve venv root (allow env var override)
$venvHome = if ($PSBoundParameters.ContainsKey('VenvRoot') -and $VenvRoot) { $VenvRoot } elseif ($env:VENV_HOME) { $env:VENV_HOME } else { Join-Path $env:LOCALAPPDATA 'venvs' }
$venvPath = Join-Path $venvHome $projectName

# Ensure directory exists
New-Item -ItemType Directory -Force -Path $venvHome | Out-Null

function Get-PythonCmd {
    $candidates = @(
        @('py','-3.12'), @('py','-3.11'), @('py','-3.10'), @('py','-3.9'),
        @('py','-3'), @('python')
    )
    foreach ($cand in $candidates) {
        try {
            if ($cand.Count -gt 1) {
                & $cand[0] $cand[1] -c "print(1)" 2>$null | Out-Null
            } else {
                & $cand[0] -c "print(1)" 2>$null | Out-Null
            }
            return $cand
        } catch {}
    }
    throw "No Python 3 interpreter found. Install Python 3 first."
}

$cand = Get-PythonCmd

# Create venv if missing
if (-not (Test-Path $venvPath)) {
    Write-Host "[venv] Creating at $venvPath"
    if ($cand.Count -gt 1) {
        & $cand[0] $cand[1] -m venv "$venvPath"
    } else {
        & $cand[0] -m venv "$venvPath"
    }
}

$py  = Join-Path $venvPath 'Scripts\python.exe'
$pip = Join-Path $venvPath 'Scripts\pip.exe'

Write-Host "[venv] Using interpreter: $py"

# Upgrade base tooling
& $py -m pip install --upgrade pip setuptools wheel

# Install dependencies
if (Test-Path 'requirements.txt') {
    Write-Host "[venv] Installing from requirements.txt (upgrade)"

    # If moving to contrib, remove any conflicting OpenCV builds **only if installed**
    $req = Get-Content 'requirements.txt' -Raw
    if ($req -match 'opencv-contrib-python') {
        $pkgs = & $pip list --format=freeze 2>$null
        if ($pkgs -match '^opencv-python==') {
            & $pip uninstall -y opencv-python | Out-Null
        }
        if ($pkgs -match '^opencv-python-headless==') {
            & $pip uninstall -y opencv-python-headless | Out-Null
        }
    }

    # Upgrade in-place so new pins take effect
    & $pip install --upgrade --upgrade-strategy eager -r requirements.txt
}
elseif (Test-Path 'pyproject.toml') {
    Write-Host "[venv] No requirements.txt found; attempting editable install (pip install -e .)"
    try { & $pip install -e . } catch { Write-Warning "Editable install failed. Consider adding a requirements.txt." }
}
else {
    Write-Host "[venv] No requirements.txt or pyproject.toml found; created an empty venv."
}

Write-Host "[venv] Ready: $venvPath"
