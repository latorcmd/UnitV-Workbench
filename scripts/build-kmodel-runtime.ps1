$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native/kmodel-runtime/kmodel_runtime.c'
$outputDirectory = Join-Path $root 'public/kpu'
$output = Join-Path $outputDirectory 'kmodel-runtime.wasm'
$buildTemp = Join-Path $root '.build-tmp/kmodel-runtime'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $buildTemp | Out-Null
$env:TEMP = $buildTemp
$env:TMP = $buildTemp
& clang --target=wasm32 -O3 -msimd128 -fno-builtin -nostdlib `
  '-Wl,--no-entry' '-Wl,--export-memory' '-Wl,--initial-memory=67108864' `
  '-Wl,--max-memory=536870912' '-Wl,--allow-undefined' `
  -o $output $source
if ($LASTEXITCODE -ne 0) { throw "kmodel runtime build failed: $LASTEXITCODE" }
Write-Host "Built $output"
