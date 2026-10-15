# pc-usage

Claude Code 모드(플러그인)입니다. 이 PC의 Claude Code 토큰 사용량을 매시 정각 기준으로 재서, 설정된 claude.ai 대시보드 아티팩트에 기록합니다. 끝난 세션의 메타데이터(시각, 토큰, 모델, 작업 폴더, 세션 제목)도 기록합니다. 대화 내용은 기록하지 않습니다.

설치(Claude Code 2.1.275 이상, 수동): `/plugin install pc-usage --marketplace tyrnd8909/pc-usage`. 보통은 아래 패키지로 설치합니다.

이 저장소는 배포용입니다. 설치는 관리 설치 패키지나 개인 설치 패키지로 합니다. 패키지는 이 저장소의 `release` 브랜치를 마켓플레이스로 등록하고 자동 업데이트를 켭니다.

- 마켓플레이스: `pc-usage-mkt` (`.claude-plugin/marketplace.json`)
- 플러그인: `pc-usage@pc-usage-mkt` (`plugins/pc-usage`)
- 대시보드 주소와 위치는 PC의 `config.json`에 있고, 이 저장소에는 없습니다.

현재 버전: 0.9.0