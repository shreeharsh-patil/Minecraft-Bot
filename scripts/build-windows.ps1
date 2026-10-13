param([switch]$Release, [string]$GccBin='C:\msys64\ucrt64\bin', [string]$TargetDirectory='D:\minecraft-rust-build')
$ErrorActionPreference='Stop'
if (-not (Test-Path -LiteralPath (Join-Path $GccBin 'gcc.exe'))) {throw 'Install a 64-bit MinGW GCC toolchain or build with MSVC Build Tools instead.'}
$env:PATH=$GccBin + ';' + $env:PATH
# GNU binutils response files mishandle apostrophes in this workspace path.
# Keep build output in a path without whitespace or apostrophes.
$env:CARGO_TARGET_DIR=[IO.Path]::GetFullPath($TargetDirectory)
rustup toolchain install nightly-2025-03-01-x86_64-pc-windows-gnu --profile minimal --component rustfmt,clippy
if ($LASTEXITCODE -ne 0) {throw 'Rust toolchain installation failed'}
if ($Release) {cargo +nightly-2025-03-01-x86_64-pc-windows-gnu build --release --locked}
else {cargo +nightly-2025-03-01-x86_64-pc-windows-gnu build --locked}
if ($LASTEXITCODE -ne 0) {throw 'Rust build failed'}
