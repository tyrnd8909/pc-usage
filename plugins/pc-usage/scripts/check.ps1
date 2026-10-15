# pc-usage 자가 진단 (Windows PowerShell 5.1 이상). 설치 스크립트가 끝에 실행하고, 상태확인.cmd 로 언제든 다시 실행할 수 있습니다.
# 하는 일: 설정(기록할 곳·위치)을 보여 주고, 오늘 사용량을 실제로 측정해 보고, 모드가 마지막으로 남긴 결과(last.json)를 보여 줍니다.
# 기록을 보내는 일은 Claude Code 세션 안의 모드만 하고, 여기서는 보내지 않습니다.
# 0.9.2: 위치가 회사이고 hubUrl 이 있으면 사내 허브로 기록하는 PC다(대시보드 주소가 없어도 정상). last.json 의 허브 상태도 보여 준다.
#   -DataRoot  config.json 이 있는 폴더 (기본: %ProgramData%\pc-usage\config.json 이 있으면 그곳, 없으면 %USERPROFILE%\.claude\pc-usage)
# 측정 스크립트는 이 파일과 같은 폴더의 measure.ps1 을 씁니다.
param(
  [string]$DataRoot
)
$ErrorActionPreference = 'Continue'
$userDir = Join-Path $env:USERPROFILE '.claude\pc-usage'
if (-not $DataRoot) {
  $shared = Join-Path $env:ProgramData 'pc-usage'
  $DataRoot = if (Test-Path (Join-Path $shared 'config.json')) { $shared } else { $userDir }
}
$ok = $true
function Line($state, $msg) { Write-Host ("  [{0}] {1}" -f $state, $msg) }

Write-Host ""
Write-Host "pc-usage 자가 진단 ($env:COMPUTERNAME)"
Write-Host "  데이터 폴더: $DataRoot"

# 1) 설정
$cfg = $null
try { $cfg = [IO.File]::ReadAllText((Join-Path $DataRoot 'config.json')).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { }
$hubMode = $cfg -and $cfg.site -eq '회사' -and $cfg.hubUrl
if ($hubMode) { Line '정상' "기록할 곳: 사내 허브 $($cfg.hubUrl)" }
elseif ($cfg -and $cfg.artifactUrl) { Line '정상' "기록할 곳: 대시보드 $($cfg.artifactUrl)" }
else { Line '오류' 'config.json 이 없거나 기록할 곳(허브 주소)이 없습니다. 설치를 다시 하세요.'; $ok = $false }
if ($cfg -and $cfg.site) { Line '정상' "위치: $($cfg.site)" } else { Line '참고' '위치가 없습니다.' }

# 2) 측정: 오늘 0시부터 지금 정각까지(0시대이면 1시까지)
$measure = Join-Path $PSScriptRoot 'measure.ps1'
if (-not (Test-Path $measure)) { Line '오류' "측정 스크립트가 없습니다: $measure"; $ok = $false }
else {
  $now = Get-Date
  $hour = [Math]::Max(1, $now.Hour)
  $raw = & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $measure -Date $now.ToString('yyyy-MM-dd') -Hours "$hour" 2>&1 | Out-String
  try {
    $m = $raw.Trim() | ConvertFrom-Json
    if ($m.ok) {
      $t = $m.slots.("{0:D2}" -f $hour).total
      Line '정상' ("측정: 오늘 {0:D2}시까지 응답 {1}건, 출력 토큰 {2:N0} (대화 기록 파일 {3}개, IP {4})" -f $hour, [int]$t.messages, [long]$t.output, $m.files, $m.ip)
    } else { Line '오류' "측정 실패: $($m.error)"; $ok = $false }
  } catch { Line '오류' ("측정 결과를 읽지 못했습니다: " + $raw.Trim().Substring(0, [Math]::Min(200, $raw.Trim().Length))); $ok = $false }
}

# 3) Claude Code 명령과 플러그인 등록(있을 때만 확인)
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
  $list = (& $claude.Source plugin list 2>&1 | Out-String)
  if ($list -match 'pc-usage@') { Line '정상' 'Claude Code 에 pc-usage 플러그인이 등록되어 있습니다.' }
  else { Line '참고' 'claude plugin list 에 pc-usage 가 없습니다. 관리 설치라면 다음 세션을 열 때 자동 설치됩니다.' }
} else { Line '참고' 'claude 명령이 PATH 에 없어 플러그인 등록은 확인하지 않았습니다.' }

# 4) 모드가 마지막으로 남긴 결과
$last = Join-Path $userDir 'last.json'
if (Test-Path $last) {
  try {
    $l = [IO.File]::ReadAllText($last) | ConvertFrom-Json
    $when = ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$l.at)).LocalDateTime
    Line '정상' ("모드 마지막 실행: {0:MM-dd HH:mm} (v{1}) {2}" -f $when, $l.ver, $l.text)
    if ($hubMode -and $l.hub) {
      switch ($l.hub.kind) {
        'ok'      { Line '정상' '허브 기록: 정상' }
        'pending' { Line '참고' '허브 승인 대기: 관리자가 허브의 [PC 등록하기] 또는 PC 상태 화면에서 승인하면 기록이 시작됩니다.' }
        'denied'  { Line '오류' ("허브가 거절함(HTTP {0}): {1}" -f $l.hub.status, $l.hub.reason); $ok = $false }
        'fail'    { Line '참고' ("허브 연결 실패: {0}. 다음 확인 때 다시 보냅니다." -f $l.hub.reason) }
      }
    } elseif (-not $hubMode -and $cfg -and $l.artifactUrl -and $l.artifactUrl -ne $cfg.artifactUrl) { Line '참고' '마지막 실행은 다른 대시보드 주소였습니다. 새 세션을 열면 새 주소로 기록합니다.' }
  } catch { Line '참고' 'last.json 을 읽지 못했습니다.' }
} else { Line '참고' '모드가 아직 실행된 적이 없습니다(0.7.0 이후 기록). Claude Code 세션을 열고 /pc-usage 를 입력하세요.' }

Write-Host ""
if ($ok) { Write-Host "진단 결과: 측정은 정상입니다. Claude Code 세션을 열면 매시 정각 자동으로 기록합니다. 바로 확인하려면 /pc-usage 를 입력하세요." }
else { Write-Host "진단 결과: 위 [오류] 항목을 확인하세요." }
if (-not $ok) { exit 1 }
