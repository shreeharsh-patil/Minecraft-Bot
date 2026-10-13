param([Parameter(Mandatory)][int]$ProcessId,[int]$Seconds=30,[string]$Output='benchmark-results/process.json')
$ErrorActionPreference='Stop'
$taskProcess=Get-Process -Id $ProcessId
$taskCpuBefore=$taskProcess.TotalProcessorTime.TotalSeconds
$taskStart=[Diagnostics.Stopwatch]::StartNew()
$taskSamples=@()
for ($taskSampleIndex=0; $taskSampleIndex -lt $Seconds; $taskSampleIndex++) {
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) {break}
    $taskSamples+=@{rss_bytes=$taskProcess.WorkingSet64;private_bytes=$taskProcess.PrivateMemorySize64;elapsed_seconds=$taskStart.Elapsed.TotalSeconds}
    Start-Sleep -Seconds 1
}
$taskProcess.Refresh()
$taskResult=@{process_id=$ProcessId;duration_seconds=$taskStart.Elapsed.TotalSeconds;cpu_seconds=$taskProcess.TotalProcessorTime.TotalSeconds-$taskCpuBefore;cpu_percent_one_core=100*($taskProcess.TotalProcessorTime.TotalSeconds-$taskCpuBefore)/$taskStart.Elapsed.TotalSeconds;samples=$taskSamples}
$taskOutputPath=[IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskOutputPath) | Out-Null
$taskResult | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskOutputPath
Write-Host "Saved process observations to $taskOutputPath"
