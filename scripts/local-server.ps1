param([switch]$AcceptEula, [int]$Port=25575, [int]$RconPort=25576)
$ErrorActionPreference='Stop'
if (-not $AcceptEula) {throw 'Review https://www.minecraft.net/eula first. Re-run with -AcceptEula only if you agree. This creates a disposable local test server.'}
$taskRepositoryRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskServerDirectory=Join-Path $taskRepositoryRoot '.test-server'
New-Item -ItemType Directory -Force -Path $taskServerDirectory | Out-Null
$taskManifest=Invoke-RestMethod 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
$taskVersion=Invoke-RestMethod ($taskManifest.versions | Where-Object id -eq '1.21.4').url
$taskJarPath=Join-Path $taskServerDirectory 'server.jar'
if (-not (Test-Path -LiteralPath $taskJarPath)) {Invoke-WebRequest $taskVersion.downloads.server.url -OutFile $taskJarPath}
if ((Get-FileHash -LiteralPath $taskJarPath -Algorithm SHA1).Hash.ToLowerInvariant() -ne $taskVersion.downloads.server.sha1) {throw 'Minecraft server checksum mismatch'}
$taskRconPassword=[guid]::NewGuid().ToString('N')
Set-Content -LiteralPath (Join-Path $taskServerDirectory 'eula.txt') -Value 'eula=true'
$taskProperties=@"
server-ip=127.0.0.1
server-port=$Port
online-mode=false
enforce-secure-profile=false
enable-rcon=true
rcon.port=$RconPort
rcon.password=$taskRconPassword
view-distance=4
simulation-distance=4
spawn-protection=0
level-type=minecraft:flat
generate-structures=false
difficulty=normal
max-players=8
"@
Set-Content -LiteralPath (Join-Path $taskServerDirectory 'server.properties') -Value $taskProperties
# RCON controls only this disposable loopback server. It is never part of the bot.
$env:MC_TEST_DISPOSABLE='yes'
$env:MC_TEST_PORT="$Port"
$env:MC_TEST_RCON_PORT="$RconPort"
$env:MC_TEST_RCON_PASSWORD=$taskRconPassword
Write-Host 'Run cargo test --test java_integration -- --ignored --test-threads=1 in a second terminal with the four MC_TEST_* environment variables from this shell.'
Write-Host 'This shell has the generated RCON password in MC_TEST_RCON_PASSWORD. Do not commit or publish it.'
Push-Location -LiteralPath $taskServerDirectory
try {java -Xms512M -Xmx1G -jar server.jar nogui} finally {Pop-Location}
