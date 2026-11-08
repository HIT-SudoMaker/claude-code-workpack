@echo off
setlocal
title Claude/Codex Cleaner
where pwsh >nul 2>&1 || (echo [!] PowerShell 7 not found - https://aka.ms/install-powershell & pause & exit /b 1)
set "CCC_SELF=%~f0"
pwsh -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:CCC_SELF;$m='#'+'__CCC_PS__';$s=[IO.File]::ReadAllText($p,[Text.UTF8Encoding]::new($false,$true));$i=$s.LastIndexOf($m);if($i-lt 0){throw 'PowerShell marker missing'};&([scriptblock]::Create($s.Substring($i+$m.Length)))"
set "CCC_RC=%ERRORLEVEL%"
pause
exit /b %CCC_RC%
#__CCC_PS__
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$started = Get-Date
$script:Log = $null

function L($Level, $Message) {
    $line = '[{0:HH:mm:ss}] [{1}] {2}' -f (Get-Date), $Level, $Message
    Write-Host $line
    if ($script:Log) { try { Add-Content -LiteralPath $script:Log -Value $line -Encoding utf8 } catch { } }
}
function Fmt([long]$Bytes) {
    if ($Bytes -ge 1GB) { '{0:N2} GiB' -f ($Bytes / 1GB) }
    elseif ($Bytes -ge 1MB) { '{0:N1} MiB' -f ($Bytes / 1MB) }
    elseif ($Bytes -ge 1KB) { '{0:N1} KiB' -f ($Bytes / 1KB) }
    else { "$Bytes B" }
}
function CleanRoot($Path, $Name) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Name data root must be an absolute path."
    }
    if ($Path.StartsWith('\\')) { throw "$Name data root cannot be a UNC path." }
    $full = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Path))
    $drive = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetPathRoot($full))
    if ($full.Equals($drive, [StringComparison]::OrdinalIgnoreCase)) { throw "$Name data root cannot be a drive root." }
    if (Test-Path -LiteralPath $full) {
        $item = Get-Item -LiteralPath $full -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "$Name data root is not a regular directory: $full"
        }
    }
    $full
}
function Under($Path, $Root) {
    try {
        $p = [IO.Path]::GetFullPath($Path)
        $r = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Root))
        $p.StartsWith($r + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    } catch { $false }
}
function Safe($Root, $Path) {
    $r = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Root))
    $p = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Path))
    if ($p.Equals($r, [StringComparison]::OrdinalIgnoreCase) -or -not (Under $p $r)) {
        throw "Unsafe cleanup path: $p"
    }
    $cursor = $r
    foreach ($part in ([IO.Path]::GetRelativePath($r, $p) -split '[\\/]')) {
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point blocked: $cursor" }
        }
    }
    $p
}
function Bytes($Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0L }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { return [long]$item.Length }
    [long](($item | Get-ChildItem -Recurse -Force -File | Measure-Object Length -Sum).Sum ?? 0)
}

$claudeRoot = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$codexRoot  = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$Tools = [ordered]@{
    claude = @{
        Root = CleanRoot $claudeRoot 'Claude'
        Dirs = @('backup','backups','cache','daemon\dispatch','daemon\pty-pids','debug','file-history',
                 'image-cache','jobs','logs','paste-cache','projects','session-env','sessions',
                 'shell-snapshots','statsig','tasks','usage-data')
        Files = @('daemon.lock','daemon.log','daemon.status.json','history.jsonl','stats-cache.json')
        Pats = @()
    }
    codex = @{
        Root = CleanRoot $codexRoot 'Codex'
        Dirs = @('.tmp','ambient-suggestions','browser','cache','computer-use-turn-ended',
                 'computer-use\cache','computer-use\history','computer-use\sessions','computer-use\tmp',
                 'dictation-history','generated_images','log','memories','node_repl','sessions',
                 'thread-writer-locks','tmp','vendor_imports')
        Files = @('history.jsonl','models_cache.json','session_index.jsonl','transcription-history.jsonl')
        Pats = @(@{f='*.sqlite*'},@{f='.codex-global-state.json.tmp-*'},@{f='sandbox*.log'},
                 @{d='.sandbox';f='sandbox*.log'})
    }
}

$ProcessRoots = @{
    claude = @((Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code'),
               (Join-Path $env:USERPROFILE '.local\share\claude'))
    codex  = @((Join-Path $env:APPDATA 'npm\node_modules\@openai\codex'),
               (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex'))
}
foreach ($key in @('claude','codex')) {
    $name = if ($key -eq 'claude') { 'claude' } else { 'codex' }
    foreach ($command in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
        if ($command.Path -and $command.Path.EndsWith('.exe',[StringComparison]::OrdinalIgnoreCase)) {
            $ProcessRoots[$key] += Split-Path -Parent $command.Path
        }
    }
}

function Agents($Keys) {
    $all = @(Get-CimInstance Win32_Process)
    @($all.Where{
        $process = $_
        foreach ($key in $Keys) {
            $names = if ($key -eq 'claude') { @('claude.exe') } else { @('codex.exe','chatgpt.exe','node_repl.exe') }
            if ($names -notcontains $process.Name.ToLowerInvariant() -or -not $process.ExecutablePath) { continue }
            if (@($ProcessRoots[$key].Where{ Under $process.ExecutablePath $_ }).Count) { return $true }
        }
        $false
    })
}
function StopAgents($Keys) {
    $agents = @(Agents $Keys)
    if (-not $agents.Count) { L OK 'No selected product process is running.'; return }
    $ids = @($agents.ProcessId)
    foreach ($process in @($agents | Where-Object { $ids -notcontains $_.ParentProcessId })) {
        taskkill /F /T /PID $process.ProcessId *> $null
        if ($LASTEXITCODE -eq 0) { L INFO "Stopped owned $($process.Name) tree (PID $($process.ProcessId))." }
    }
    $limit = (Get-Date).AddSeconds(10)
    do { Start-Sleep -Milliseconds 400; $left = @(Agents $Keys) } while ($left.Count -and (Get-Date) -lt $limit)
    if ($left.Count) { throw "Selected product is still running. Close it and retry." }
}

function Candidates($Keys) {
    $list = @()
    foreach ($key in $Keys) {
        $tool = $Tools[$key]
        foreach ($relative in $tool.Dirs) {
            $path = Safe $tool.Root (Join-Path $tool.Root $relative)
            if (-not (Test-Path -LiteralPath $path)) { continue }
            $item = Get-Item -LiteralPath $path -Force
            if (-not $item.PSIsContainer) { throw "Expected directory: $path" }
            if (@(Get-ChildItem -LiteralPath $path -Force).Count) {
                $list += [pscustomobject]@{Tool=$key;Kind='Dir';Path=$path;Bytes=Bytes $path}
            }
        }
        foreach ($relative in $tool.Files) {
            $path = Safe $tool.Root (Join-Path $tool.Root $relative)
            if (Test-Path -LiteralPath $path) { $list += [pscustomobject]@{Tool=$key;Kind='File';Path=$path;Bytes=Bytes $path} }
        }
        foreach ($pattern in $tool.Pats) {
            $base = if ($pattern.d) { Safe $tool.Root (Join-Path $tool.Root $pattern.d) } else { $tool.Root }
            if (-not (Test-Path -LiteralPath $base)) { continue }
            foreach ($file in @(Get-ChildItem -LiteralPath $base -Filter $pattern.f -File -Force)) {
                $path = Safe $tool.Root $file.FullName
                $list += [pscustomobject]@{Tool=$key;Kind='File';Path=$path;Bytes=[long]$file.Length}
            }
        }
    }
    @($list | Sort-Object Path -Unique)
}
function ClearDir($Root, $Path) {
    [void](Safe $Root $Path)
    $link = Get-ChildItem -LiteralPath $Path -Recurse -Force |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
    if ($link) { throw "Reparse point blocked: $($link.FullName)" }
    foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) {
        Remove-Item -LiteralPath $child.FullName -Recurse -Force
    }
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count) { throw "Directory not empty: $Path" }
}
function DelFile($Root, $Path) {
    [void](Safe $Root $Path)
    Remove-Item -LiteralPath $Path -Force
    if (Test-Path -LiteralPath $Path) { throw "File still exists: $Path" }
}

try {
    Write-Host "`n  Claude/Codex Cleaner - complete local data cleanup"
    Write-Host "  Claude : $(Fmt (Bytes $Tools.claude.Root))"
    Write-Host "  Codex  : $(Fmt (Bytes $Tools.codex.Root))"
    $answer = Read-Host "`nTarget? [1] Claude   [2] Codex   [3] All"
    $scope = switch ($answer.Trim()) { '1'{'claude'} '2'{'codex'} '3'{'all'} default{Write-Host '[INFO] Cancelled.';exit 0} }
    $keys = if ($scope -eq 'all') { @('claude','codex') } else { @($scope) }
    $before = @{}; foreach ($key in $keys) { $before[$key] = Bytes $Tools[$key].Root }

    $preview = @(Candidates $keys)
    Write-Host "`nThe following history, sessions, memories, caches and logs will be permanently cleared:"
    foreach ($item in $preview) { Write-Host ('  [{0,-6}] {1,10}  {2}' -f $item.Tool,(Fmt $item.Bytes),$item.Path) }
    $total = [long](($preview | Measure-Object Bytes -Sum).Sum ?? 0)
    Write-Host "`n  Planned: $($preview.Count) target(s), $(Fmt $total)"
    $confirm = Read-Host "`nContinue? Type Y to clean the selected data"
    if ($confirm.Trim() -notmatch '^(?i:y|yes)$') { Write-Host '[INFO] Cancelled. No data was changed.'; exit 0 }

    try {
        $logDir = Join-Path $env:LOCALAPPDATA 'ClaudeCodexCleaner\Logs'
        [void](New-Item -ItemType Directory -Path $logDir -Force)
        $script:Log = Join-Path $logDir "Cleaner-$($started.ToString('yyyyMMdd-HHmmss')).log"
    } catch { Write-Host "[WARN] Logging unavailable: $($_.Exception.Message)" }

    L INFO "Selected scope: $scope"
    StopAgents $keys
    $plan = @(Candidates $keys)
    if (@(Agents $keys).Count) { throw 'A selected product restarted before cleanup.' }

    $failed = [Collections.Generic.List[string]]::new()
    foreach ($item in $plan) {
        try {
            if ($item.Kind -eq 'Dir') { ClearDir $Tools[$item.Tool].Root $item.Path }
            else { DelFile $Tools[$item.Tool].Root $item.Path }
            L OK "Cleared $($item.Path)"
        } catch { $failed.Add($item.Path); L BLOCKED "$($item.Path): $($_.Exception.Message)" }
    }

    $residue = @()
    try { $residue = @(Candidates $keys) }
    catch { $failed.Add('verification'); L BLOCKED "Verification failed: $($_.Exception.Message)" }
    foreach ($item in $residue) { L BLOCKED "Residue or regrowth: $($item.Path)" }
    $running = @(Agents $keys)
    if ($running.Count) { $failed.Add('process restarted'); L WARN 'A selected product restarted during cleanup.' }

    $after = @{}; [long]$freedTotal = 0
    foreach ($key in $keys) { $after[$key] = Bytes $Tools[$key].Root; $freedTotal += $before[$key] - $after[$key] }
    $status = if (-not $failed.Count -and -not $residue.Count -and -not $running.Count) { 'SUCCESS' } else { 'PARTIAL' }
    Write-Host "`n==================== SUMMARY ===================="
    foreach ($key in $keys) { Write-Host ('  {0,-7}: freed {1}' -f $key,(Fmt ([Math]::Max($before[$key]-$after[$key],0)))) }
    Write-Host "  Total      : $(Fmt ([Math]::Max($freedTotal,0)))"
    Write-Host "  Residue    : $($residue.Count)"
    Write-Host "  Failures   : $($failed.Count)"
    Write-Host "  Status     : $status"
    Write-Host "  Log        : $(if($script:Log){$script:Log}else{'unavailable'})"
    Write-Host '================================================='
    L INFO "Cleanup status: $status"
    exit $(if ($status -eq 'SUCCESS') { 0 } else { 1 })
} catch {
    Write-Host "`n[FATAL] $($_.Exception.Message)" -ForegroundColor Red
    if ($script:Log) { L FATAL $_.Exception.Message }
    exit 1
}
