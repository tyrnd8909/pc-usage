# Sums this PC's Claude Code token usage for one local date, cumulative up to each requested hour,
# from the session transcripts (~/.claude/projects/**/*.jsonl). Prints one JSON line.
# Each assistant message is counted once (by message id); timestamps are UTC and compared in local time.
#   -Date  yyyy-MM-dd (local)       -Hours  comma list of hours 1..24, e.g. "8,9,10"; 24 = the whole day
param(
  [Parameter(Mandatory)][string]$Date,
  [Parameter(Mandatory)][string]$Hours,
  [string]$ProjectsDir = (Join-Path $env:USERPROFILE '.claude\projects'),
  # For tests only: the PC name to report instead of this PC's
  [string]$PcName = $env:COMPUTERNAME
)
$ErrorActionPreference = 'Stop'
# Non-ASCII goes out as \uXXXX: the console code page (CP949) would garble a Korean PC name on the way to the mod.
function Out($o) {
  $json = $o | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.Write([regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
}
try {
  $day = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)
  $hourList = @($Hours.Split(',') | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ } | Sort-Object)
  $cutoffs = @{}; foreach ($h in $hourList) { $cutoffs[$h] = $day.AddHours([double]$h) }
  $last = $cutoffs[$hourList[-1]]

  $reId = [regex]'"message":\{[^{}]*?"id":"(msg_[^"]+)"'
  $reModel = [regex]'"model":"([^"]+)"'
  $reTs = [regex]'"timestamp":"([^"]+)"'
  $reUsage = [regex]'"usage":\{"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+),"output_tokens":(\d+)'

  # One record per message id: local time, model, four counts.
  $seen = @{}
  $files = Get-ChildItem $ProjectsDir -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $day }
  foreach ($f in $files) {
    $sr = New-Object IO.StreamReader($f.FullName, [Text.Encoding]::UTF8)
    try {
      while ($null -ne ($line = $sr.ReadLine())) {
        if ($line.IndexOf('"type":"assistant"') -lt 0 -or $line.IndexOf('"usage":{') -lt 0) { continue }
        $u = $reUsage.Match($line); if (-not $u.Success) { continue }
        $ts = $reTs.Match($line); if (-not $ts.Success) { continue }
        $t = [datetime]::Parse($ts.Groups[1].Value, $null, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
        # [00:00, cutoff): the cutoff instant belongs to the next slot, so hour 24 (next day 00:00) never overlaps the next day
        if ($t -lt $day -or $t -ge $last) { continue }
        $idm = $reId.Match($line)
        $id = if ($idm.Success) { $idm.Groups[1].Value } else { "$($f.Name):$($ts.Groups[1].Value)" }
        $mm = $reModel.Match($line)
        $seen[$id] = @{ t = $t; model = $(if ($mm.Success) { $mm.Groups[1].Value } else { 'unknown' })
          in = [int64]$u.Groups[1].Value; cw = [int64]$u.Groups[2].Value; cr = [int64]$u.Groups[3].Value; out = [int64]$u.Groups[4].Value }
      }
    } finally { $sr.Dispose() }
  }

  $slots = [ordered]@{}
  foreach ($h in $hourList) {
    $cut = $cutoffs[$h]
    $by = @{}; $tot = [ordered]@{ input = [int64]0; output = [int64]0; cacheRead = [int64]0; cacheWrite = [int64]0; messages = 0 }
    foreach ($r in $seen.Values) {
      if ($r.t -ge $cut) { continue }
      if (-not $by.ContainsKey($r.model)) { $by[$r.model] = [ordered]@{ input = [int64]0; output = [int64]0; cacheRead = [int64]0; cacheWrite = [int64]0; messages = 0 } }
      foreach ($x in @($by[$r.model], $tot)) {
        $x.input += $r.in; $x.output += $r.out; $x.cacheRead += $r.cr; $x.cacheWrite += $r.cw; $x.messages += 1
      }
    }
    $slots[('{0:D2}' -f $h)] = [ordered]@{ total = $tot; byModel = $by }
  }

  $ip = $null
  try {
    $ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
      Select-Object -First 1).IPv4Address.IPAddress
  } catch {}
  Out ([ordered]@{ ok = $true; pc = $PcName; ip = $ip; date = $Date; files = @($files).Count; slots = $slots })
} catch {
  $msg = "$($_.Exception.Message)"
  Out @{ ok = $false; reason = $msg.Substring(0, [Math]::Min(200, $msg.Length)) }
}
