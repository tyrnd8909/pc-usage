# Lists this PC's finished Claude Code sessions with metadata only, from the session transcripts
# (~/.claude/projects/<project>/<session id>.jsonl). Prints one JSON line: ok, pc, ip, sessions.
# Never prints what was said: no prompt, no answer, no summary. The one free text is the session title,
# taken from the title records (custom-title, else ai-title), and dropped when it is the text of a prompt.
# Tokens are counted as in measure.ps1: assistant lines with usage, once per message id.
#   -Since        days back, by file modification time        -IdleMinutes  a session counts once its last line is this old
#   -MarksDir     the mod's marks folder: a session with an s_<id> mark newer than its files is skipped as unchanged
param(
  [int]$Since = 7,
  [int]$IdleMinutes = 30,
  [string]$MarksDir,
  [string]$ProjectsDir = (Join-Path $env:USERPROFILE '.claude\projects'),
  # For tests only: the PC name to report instead of this PC's
  [string]$PcName = $env:COMPUTERNAME
)
$ErrorActionPreference = 'Stop'
# PS 5.1: in some setups arrays serialize as {"value":[..],"Count":n}
Remove-TypeData System.Array -ErrorAction SilentlyContinue
# Non-ASCII goes out as \uXXXX: the console code page would garble Korean titles and paths on the way to the mod.
function Out($o) {
  $json = $o | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.Write([regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
}
try {
  Add-Type -AssemblyName System.Web.Extensions
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $js.MaxJsonLength = [int]::MaxValue
  $now = [DateTimeOffset]::Now
  $idleCut = $now.AddMinutes(-$IdleMinutes)

  $reId = [regex]'"message":\{[^{}]*?"id":"(msg_[^"]+)"'
  $reModel = [regex]'"model":"([^"]+)"'
  $reUsage = [regex]'"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+),"output_tokens":(\d+)'
  # The record's own uuid and timestamp sit side by side; nested content does not carry that pair.
  $reTs = [regex]'"uuid":"[0-9a-f-]{36}","timestamp":"([^"]+)"'
  # The tail of a user or assistant record: "userType":..,"entrypoint":..,"cwd":..,"sessionId":..,"version":..,"gitBranch":..
  $reTail = @{
    entrypoint = [regex]'"entrypoint":"((?:[^"\\]|\\.)*)"'
    cwd = [regex]'"cwd":"((?:[^"\\]|\\.)*)"'
    version = [regex]'"version":"((?:[^"\\]|\\.)*)"'
    gitBranch = [regex]'"gitBranch":"((?:[^"\\]|\\.)*)"'
  }
  function Str($raw) { $js.DeserializeObject('{"v":"' + $raw + '"}')['v'] }
  function Ms($ts) { [DateTimeOffset]::Parse($ts, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeMilliseconds() }
  function NewTotal { [ordered]@{ input = [int64]0; output = [int64]0; cacheRead = [int64]0; cacheWrite = [int64]0; messages = 0 } }

  # One assistant line's usage into $seen (once per message id); false if the line has none.
  function AddUsage($seen, $line, $p) {
    if ($line.IndexOf('"type":"assistant"') -lt 0 -or $line.IndexOf('"usage":{') -lt 0) { return $false }
    $u = $reUsage.Match($line); if (-not $u.Success) { return $false }
    $idm = $reId.Match($line)
    $id = if ($idm.Success) { $idm.Groups[1].Value } else { "$p`:$($seen.Count)" }
    $mm = $reModel.Match($line)
    $seen[$id] = @{ model = $(if ($mm.Success) { $mm.Groups[1].Value } else { 'unknown' })
      in = [int64]$u.Groups[1].Value; cw = [int64]$u.Groups[2].Value; cr = [int64]$u.Groups[3].Value; out = [int64]$u.Groups[4].Value }
    $true
  }
  # @{ total; byModel } of the usages in $seen
  function Sum($seen) {
    $tot = NewTotal; $by = [ordered]@{}
    foreach ($r in $seen.Values) {
      if (-not $by.Contains($r.model)) { $by[$r.model] = NewTotal }
      foreach ($x in @($by[$r.model], $tot)) { $x.input += $r.in; $x.output += $r.out; $x.cacheRead += $r.cr; $x.cacheWrite += $r.cw; $x.messages += 1 }
    }
    @{ total = $tot; byModel = $by }
  }

  $sinceCut = (Get-Date).AddDays(-$Since)
  # Top-level session files only; a session's subagents sit in <session id>\subagents\.
  # A session moved to another folder has a file in each: they are one session.
  $groups = @(Get-ChildItem $ProjectsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ChildItem $_.FullName -Filter *.jsonl -File -ErrorAction SilentlyContinue
  } | Where-Object { $_.LastWriteTime -ge $sinceCut } | Group-Object BaseName)

  $out = @(); $unchanged = 0; $active = 0
  foreach ($g in $groups) {
    $id = $g.Name
    $files = @($g.Group | Sort-Object LastWriteTime)
    $written = $files[-1].LastWriteTime
    if ($written -gt $idleCut.LocalDateTime) { $active++; continue }
    # Recorded already, and no file changed since the mark was written: nothing new to read.
    if ($MarksDir) {
      $mk = Join-Path $MarksDir "s_$id"
      if ((Test-Path $mk) -and $written -le (Get-Item $mk).LastWriteTime) { $unchanged++; continue }
    }
    $seen = @{}; $first = $null; $last = $null; $turns = 0; $cwd = @{}; $tailVal = @{}; $custom = $null; $ai = $null
    $prompts = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($fp in ($files | ForEach-Object FullName)) {
    foreach ($line in [IO.File]::ReadLines($fp)) {
      if ($line.StartsWith('{"type":"custom-title"')) { $v = $js.DeserializeObject($line)['customTitle']; if ($v) { $custom = [string]$v }; continue }
      if ($line.StartsWith('{"type":"ai-title"')) { $v = $js.DeserializeObject($line)['aiTitle']; if ($v) { $ai = [string]$v }; continue }
      # Timestamps are UTC in one ISO form, so text order is time order.
      $t = $reTs.Match($line)
      if ($t.Success) {
        $v = $t.Groups[1].Value
        if ($null -eq $first -or [string]::CompareOrdinal($v, $first) -lt 0) { $first = $v }
        if ($null -eq $last -or [string]::CompareOrdinal($v, $last) -gt 0) { $last = $v }
      }
      $isUser = $line.IndexOf('"type":"user"') -ge 0
      if (-not $isUser) {
        if ($line.IndexOf('"usage":{') -ge 0) { [void](AddUsage $seen $line $fp) }
        if ($line.IndexOf('"type":"assistant","uuid":"') -lt 0) { continue }
      }
      # The record's own fields close the line, after any nested content.
      $k = $line.LastIndexOf('"userType":"'); if ($k -lt 0) { continue }
      $tail = $line.Substring($k)
      $c = $reTail.cwd.Match($tail); if ($c.Success) { $cwd[$c.Groups[1].Value] = 1 + [int]$cwd[$c.Groups[1].Value] }
      foreach ($n in 'entrypoint', 'version', 'gitBranch') { $m = $reTail[$n].Match($tail); if ($m.Success -and $m.Groups[1].Value) { $tailVal[$n] = $m.Groups[1].Value } }
      # A person's prompt: a user line that is no tool result, no meta line, no sidechain, and not from a task or peer.
      if (-not $isUser -or $line.IndexOf('"toolUseResult":') -ge 0) { continue }
      $o = $js.DeserializeObject($line)
      if ($o['type'] -ne 'user' -or $o['isMeta'] -or $o['isSidechain']) { continue }
      if ($o.ContainsKey('origin') -and $o['origin'] -and $o['origin']['kind'] -and $o['origin']['kind'] -ne 'human') { continue }
      $content = $o['message']['content']
      $text = $content
      if ($content -isnot [string]) {
        if (@($content | Where-Object { $_['type'] -eq 'tool_result' }).Count) { continue }
        $text = @($content | Where-Object { $_['type'] -eq 'text' } | ForEach-Object { $_['text'] }) -join "`n"
      }
      # Command output and the interrupt marker are written as user lines, but nobody typed them.
      if ("$text" -match '^\s*(<local-command-|\[Request interrupted by user)') { continue }
      $turns++
      # Kept only to tell a title that is a prompt's own text; never printed.
      $trim = "$text".Trim()
      if ($trim) { [void]$prompts.Add($trim); [void]$prompts.Add(($trim -split "`n")[0].Trim()) }
    }
    }
    $tok = Sum $seen
    if ($null -eq $first -or ($turns -eq 0 -and $tok.total.messages -eq 0)) { continue }
    $start = Ms $first; $end = Ms $last
    # The session is still going if its last line is newer than the idle cut.
    if ($end -gt $idleCut.ToUnixTimeMilliseconds()) { continue }

    $title = if ($custom) { $custom } elseif ($ai) { $ai } else { $null }
    if ($title) { $title = $title.Trim(); if (-not $title -or $prompts.Contains($title)) { $title = $null } }
    if ($title -and $title.Length -gt 200) { $title = $title.Substring(0, 200) }
    $project = $null
    if ($cwd.Count) { $project = Str ($cwd.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key }
    $meta = @{}; foreach ($n in $tailVal.Keys) { $meta[$n] = Str $tailVal[$n] }

    $subFiles = @(foreach ($f in $files) {
      $subDir = Join-Path (Join-Path $f.DirectoryName $id) 'subagents'
      if (Test-Path $subDir) { Get-ChildItem $subDir -Filter *.jsonl -File | ForEach-Object FullName }
    })
    $subSeen = @{}
    foreach ($p in $subFiles) {
      foreach ($line in [IO.File]::ReadLines($p)) { if ($line.IndexOf('"usage":{') -ge 0) { [void](AddUsage $subSeen $line $p) } }
    }

    $out += [ordered]@{
      sessionId = $id
      date = [DateTimeOffset]::FromUnixTimeMilliseconds($start).LocalDateTime.ToString('yyyy-MM-dd')
      start = $start; end = $end
      project = $project; gitBranch = $meta['gitBranch']; title = $title
      turns = $turns; messages = $tok.total.messages
      total = $tok.total; byModel = $tok.byModel
      subagents = [ordered]@{ count = $subFiles.Count; total = (Sum $subSeen).total }
      version = $meta['version']; entrypoint = $meta['entrypoint']
    }
  }

  $ip = $null
  try {
    $ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
      Select-Object -First 1).IPv4Address.IPAddress
  } catch {}
  Out ([ordered]@{ ok = $true; pc = $PcName; ip = $ip; active = $active; unchanged = $unchanged; sessions = @($out) })
} catch {
  $msg = "$($_.Exception.Message)"
  Out @{ ok = $false; reason = $msg.Substring(0, [Math]::Min(200, $msg.Length)) }
}
