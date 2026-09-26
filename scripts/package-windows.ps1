$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") }
    finally { $sha.Dispose() }
  }
  finally { $stream.Dispose() }
}

function Invoke-PackageSmoke([string]$Executable, [string]$DataDirectory, [string]$FailureMessage) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Executable
  $info.Arguments = '--smoke-test --data-dir "' + $DataDirectory.Replace('"', '\"') + '"'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($info)
  if ($null -eq $process) { throw $FailureMessage }
  try {
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw $FailureMessage }
  }
  finally { $process.Dispose() }
}

$repo = Split-Path -Parent $PSScriptRoot
$stageRoot = Join-Path $repo ".packaging"
$deploy = Join-Path $stageRoot "deploy"
$package = Join-Path $stageRoot "package"
$downloads = Join-Path $stageRoot "downloads"
$artifacts = Join-Path $repo "artifacts"
$zipVerificationName = "Herald ZIP Verification H" + [char]0x00E9 + "rald " + [guid]::NewGuid().ToString("N")
$zipVerification = Join-Path ([IO.Path]::GetTempPath()) $zipVerificationName
$zipSmokeData = "$zipVerification-data"

foreach ($clean in @($deploy, $package, (Join-Path $stageRoot "node"), (Join-Path $stageRoot "launcher"))) {
  if (Test-Path -LiteralPath $clean) { Remove-Item -LiteralPath $clean -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $deploy,$package,$downloads,$artifacts | Out-Null

Push-Location $repo
try {
  corepack.cmd pnpm test
  if ($LASTEXITCODE -ne 0) { throw "Node tests failed" }
  corepack.cmd pnpm typecheck
  if ($LASTEXITCODE -ne 0) { throw "Node typecheck failed" }
  corepack.cmd pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Node build failed" }
  dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release
  if ($LASTEXITCODE -ne 0) { throw "Launcher tests failed" }
  corepack.cmd pnpm --config.node-linker=hoisted --filter herald-of-jams --prod deploy $deploy
  if ($LASTEXITCODE -ne 0) { throw "Production deploy failed" }

  $app = Join-Path $package "app"
  Move-Item -LiteralPath $deploy -Destination $app
  Copy-Item -Path (Join-Path $app "build/app/*") -Destination $app -Recurse
  Remove-Item -LiteralPath (Join-Path $app "build") -Recurse -Force

  $nodeVersion = (Get-Content -LiteralPath ".node-version" -Raw).Trim()
  $nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
  $releaseUrl = "https://nodejs.org/dist/v$nodeVersion"
  $nodeArchive = Join-Path $downloads $nodeArchiveName
  $sums = Join-Path $downloads "SHASUMS256.txt"
  if (-not (Test-Path -LiteralPath $nodeArchive)) { Invoke-WebRequest -Uri "$releaseUrl/$nodeArchiveName" -OutFile $nodeArchive }
  if (-not (Test-Path -LiteralPath $sums)) { Invoke-WebRequest -Uri "$releaseUrl/SHASUMS256.txt" -OutFile $sums }
  $expectedLine = Get-Content -LiteralPath $sums | Where-Object { $_ -match "\s$([regex]::Escape($nodeArchiveName))$" } | Select-Object -First 1
  if ($null -eq $expectedLine) { throw "Node checksum entry is missing" }
  $expected = ($expectedLine -split "\s+")[0].ToUpperInvariant()
  $actual = Get-Sha256 $nodeArchive
  if ($actual -ne $expected) { throw "Node checksum mismatch" }
  $nodeExtract = Join-Path $stageRoot "node"
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
  $nodeSource = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
  Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $package "runtime") -Recurse

  dotnet publish launcher/src/HeraldOfJams.Launcher/HeraldOfJams.Launcher.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o (Join-Path $stageRoot "launcher")
  if ($LASTEXITCODE -ne 0) { throw "Launcher publish failed" }
  Copy-Item -LiteralPath (Join-Path $stageRoot "launcher/Herald of Jams.exe") -Destination $package
  Copy-Item -LiteralPath "LICENSE" -Destination $package
  $version = (Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json).version
  $commit = (git rev-parse HEAD).Trim()
  $versionText = "app=$version`nnode=$nodeVersion`ndotnet=net10.0-windows`ncommit=$commit`n"
  [System.IO.File]::WriteAllText((Join-Path $package "VERSION"), $versionText, (New-Object System.Text.UTF8Encoding($false)))

  Get-ChildItem -LiteralPath $package -Recurse -File -Filter "*.map" | Remove-Item -Force
  Get-ChildItem -LiteralPath $package -Recurse -Directory | Where-Object { $_.Name -in @('test','tests') } | Sort-Object { $_.FullName.Length } -Descending | Remove-Item -Recurse -Force

  $forbidden = Get-ChildItem -LiteralPath $package -Recurse -File | Where-Object { $_.Name -in @('.env','config.env') -or $_.Name -match '\.(sqlite|db)(-wal|-shm)?$|\.map$' -or $_.FullName -match '[\\/](test|tests|logs)[\\/]' }
  if ($forbidden) { throw "Package contains forbidden mutable or development files" }

  $smokeData = Join-Path $stageRoot (".smoke-data-" + [guid]::NewGuid().ToString("N"))
  Invoke-PackageSmoke (Join-Path $package "Herald of Jams.exe") $smokeData "Packaged smoke test failed"
  $zip = Join-Path $artifacts "herald-of-jams-$version-win-x64.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $package "*") -DestinationPath $zip -CompressionLevel Optimal
  Expand-Archive -LiteralPath $zip -DestinationPath $zipVerification
  Invoke-PackageSmoke (Join-Path $zipVerification "Herald of Jams.exe") $zipSmokeData "Extracted package smoke test failed"
  $hash = Get-Sha256 $zip
  $size = (Get-Item -LiteralPath $zip).Length
  Write-Output "$zip ($size bytes, SHA256 $hash)"
}
finally {
  if (Test-Path -LiteralPath $zipVerification) { Remove-Item -LiteralPath $zipVerification -Recurse -Force }
  if (Test-Path -LiteralPath $zipSmokeData) { Remove-Item -LiteralPath $zipSmokeData -Recurse -Force }
  Pop-Location
}
