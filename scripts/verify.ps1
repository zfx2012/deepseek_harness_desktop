#requires -Version 5.1
<#
.SYNOPSIS
  Unified verification pipeline for DeepSeek Harness Desktop (local + CI).

.DESCRIPTION
  Runs, in order:
    1. unit tests           (node --test)
    2. bundle validation    (prepare-dist.mjs hard checks)
    3. package              (electron-builder --win dir, no installers)
    4. bundled smoke        (packaged exe --smoke-bundled: MUST use resources/harness)
    5. error-path smoke     (packaged exe --smoke-error: invalid harness path -> error card)
    6. no-node smoke        (packaged exe with stripped PATH: ELECTRON_RUN_AS_NODE fallback)

  Any failure aborts with a non-zero exit code. Use from the repo root:
    pwsh scripts/verify.ps1
.EXAMPLE
  pwsh scripts/verify.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Respect externally provided mirrors/caches (CI shares one cache across steps).
if (-not $env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE = Join-Path $root '.cache\electron-builder' }
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) { $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/' }
if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }

function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  Write-Host "=== $Name ===" -ForegroundColor Cyan
  & $Body
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

function Run-Smoke {
  param([string]$Label, [string[]]$SmokeArgs, [string]$ConfigJson, [string]$UserData, [string[]]$ExtraEnv = @())
  $out = Join-Path $root ".verify-$Label-out.txt"
  $err = Join-Path $root ".verify-$Label-err.txt"
  Remove-Item -Force $out, $err -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $UserData -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $UserData | Out-Null
  if ($ConfigJson) {
    # Write without BOM so the config actually loads.
    [System.IO.File]::WriteAllText((Join-Path $UserData 'config.json'), $ConfigJson, [System.Text.UTF8Encoding]::new($false))
  }
  $env:DSH_DESKTOP_USERDATA = $UserData
  foreach ($kv in $ExtraEnv) {
    $k, $v = $kv -split '=', 2
    Set-Item -Path "Env:$k" -Value $v
  }
  try {
    $p = Start-Process -FilePath (Join-Path $root "release\win-unpacked\DeepSeek Harness Desktop.exe") `
      -ArgumentList $SmokeArgs -WorkingDirectory $root -Wait -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError $err
    if ($p.ExitCode -ne 0) {
      Write-Host "FAILED ($Label, exit $($p.ExitCode))" -ForegroundColor Red
      Get-Content $out -ErrorAction SilentlyContinue | Select-Object -Last 10
      Get-Content $err -ErrorAction SilentlyContinue | Select-Object -Last 10
      throw "smoke [$Label] failed"
    }
    Get-Content $out -Tail 3
  } finally {
    Remove-Item Env:DSH_DESKTOP_USERDATA -ErrorAction SilentlyContinue
    foreach ($kv in $ExtraEnv) { Remove-Item "Env:$($kv.Split('=')[0])" -ErrorAction SilentlyContinue }
  }
}

# 1. unit tests
Invoke-Step 'unit tests' { npm test }

# 2. bundle validation (must exist and pass hard checks)
Invoke-Step 'bundle validation' { node scripts/prepare-dist.mjs }

# 3. package (win-unpacked only; installers are built separately)
Invoke-Step 'package (dir)' { npx electron-builder --win dir }

# 4. bundled smoke — MUST come from resources/harness
$smokeHome = Join-Path $root '.verify-smoke-home'
$dshHome = ($smokeHome -replace '\\', '\\')
$config = '{"harnessPath":"","dshHome":"' + $dshHome + '\dsh-home","port":0,"workspace":"","autoRestart":true}'
Invoke-Step 'bundled smoke' {
  Run-Smoke -Label 'bundled' -SmokeArgs @('--smoke-bundled', '--disable-gpu') -ConfigJson $config -UserData $smokeHome
}

# 5. error-path smoke — invalid explicit harness path must render the error card
$errHome = Join-Path $root '.verify-err-home'
Invoke-Step 'error-path smoke' {
  Run-Smoke -Label 'error' -SmokeArgs @('--smoke-error', '--disable-gpu') `
    -ConfigJson '{"harnessPath":"C:\\nonexistent\\harness","dshHome":"","port":0,"workspace":"","autoRestart":true}' `
    -UserData $errHome
}

# 6. no-node smoke — stripped PATH forces the ELECTRON_RUN_AS_NODE fallback
$noNodeHome = Join-Path $root '.verify-nonode-home'
Invoke-Step 'no-node smoke (ELECTRON_RUN_AS_NODE)' {
  Run-Smoke -Label 'nonode' -SmokeArgs @('--smoke-bundled', '--disable-gpu') `
    -ConfigJson $config -UserData $noNodeHome -ExtraEnv @('Path=C:\Windows\System32;C:\Windows')
}

# cleanup
Remove-Item -Recurse -Force $smokeHome, $errHome, $noNodeHome -ErrorAction SilentlyContinue
Get-ChildItem $root -Filter '.verify-*-out.txt' -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem $root -Filter '.verify-*-err.txt' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host 'ALL VERIFICATION STEPS PASSED' -ForegroundColor Green
