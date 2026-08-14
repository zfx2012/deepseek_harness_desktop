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
    7. update-feed smoke    (packaged exe --smoke-update: discovers v0.2.0 from a local feed)

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
  $savedEnv = @{}
  foreach ($kv in $ExtraEnv) {
    $k, $v = $kv -split '=', 2
    $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
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
    foreach ($k in $savedEnv.Keys) {
      if ($null -eq $savedEnv[$k]) {
        Remove-Item "Env:$k" -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path "Env:$k" -Value $savedEnv[$k]
      }
    }
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
# JSON-escape the whole path: the '\\dsh-home' suffix must be doubled too,
# otherwise '\d' is an invalid JSON escape and SettingsStore silently falls
# back to defaults (the smoke would then touch the real ~/.dsh).
$dshHome = (($smokeHome + '\dsh-home') -replace '\\', '\\')
$config = '{"harnessPath":"","dshHome":"' + $dshHome + '","port":0,"autoRestart":true}'
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

# 7. update-feed smoke — the packaged app must discover version 0.2.0 from a
# local generic feed (electron-updater end-to-end discovery)
$updateHome = Join-Path $root '.verify-update-home'
$feedPort = 18765
Invoke-Step 'update-feed smoke' {
  $nodeExe = (Get-Command node -ErrorAction Stop).Source
  $feed = Start-Process -FilePath $nodeExe -ArgumentList 'scripts/update-feed.mjs', '--port', $feedPort `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden
  try {
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
      try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$feedPort/latest.yml" -UseBasicParsing -TimeoutSec 2
        $ready = $true
        break
      } catch {
        Start-Sleep -Milliseconds 300
      }
    }
    if (-not $ready) { throw "update-feed did not come up on port $feedPort" }
    Run-Smoke -Label 'update' -SmokeArgs @('--smoke-update') `
      -ConfigJson $null -UserData $updateHome `
      -ExtraEnv @("DSH_DESKTOP_UPDATE_URL=http://127.0.0.1:$feedPort/", 'DSH_DESKTOP_EXPECT_VERSION=0.2.0')
  } finally {
    Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue
  }
}

# cleanup
Remove-Item -Recurse -Force $smokeHome, $errHome, $noNodeHome, $updateHome -ErrorAction SilentlyContinue
Get-ChildItem $root -Filter '.verify-*-out.txt' -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem $root -Filter '.verify-*-err.txt' -ErrorAction SilentlyContinue | Remove-Item -Force

Write-Host 'ALL VERIFICATION STEPS PASSED' -ForegroundColor Green
