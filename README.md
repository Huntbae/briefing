# 모닝 레이더 (brief.huntbae.com)

평일 아침 발행하는 경제·테크·모빌리티·정부공고 브리핑의 웹 아카이브입니다. 웹이 원본이고, 메일은 같은 원고의 요약판입니다.

## 구조

| 경로 | 내용 |
| --- | --- |
| `data/issues/YYYY-MM-DD.json` | 회차 원고(유일한 원본) |
| `build.py` | 원고 JSON → 웹 페이지·RSS·메일 HTML 생성(표준 라이브러리만 사용) |
| `YYYY/MM/DD/index.html` | 회차 전문(빌드 산출물) |
| `mail/YYYY-MM-DD.html` | 메일 요약판. `{{UNSUBSCRIBE_URL}}`은 발송 스크립트가 구독자별로 치환 |
| `feed.xml` | RSS 2.0 |
| `assets/style.css` | 웹 스타일 |
| `CNAME` | `brief.huntbae.com` |

## 발행 방법

1. `data/issues/`에 새 회차 JSON을 추가합니다(아래 스키마).
2. `python3 -I build.py`를 실행합니다.
3. 원고와 빌드 산출물을 함께 커밋하고 `main`에 푸시하면 GitHub Pages가 배포합니다.

`"draft": true`인 회차는 빌드에서 제외됩니다.

## 회차 JSON 스키마

```json
{
  "date": "YYYY-MM-DD",        // 발행일(메일이 나가는 날)
  "issue_no": 1,
  "sample": false,             // 견본이면 true
  "cutoff": "YYYY-MM-DD 24:00 KST",
  "headline": "한 줄 제목",
  "lead": "2~3문장 리드",
  "breaking": null,            // 05시 기준 속보가 있으면 한 줄 문자열
  "numbers": [{"value": "", "label": "", "note": ""}],      // 정확히 3개
  "market": [{"name": "", "value": "", "change": "", "dir": "up|down"}],
  "market_note": "시세 출처",
  "sections": [{"id": "economy|tech|mobility", "title": "", "items": [
    {"title": "", "body": ["문단"], "so_what": "우리 회사는 한 줄",
     "sources": [{"name": "", "url": "", "date": "YYYY-MM-DD"}]}]}],
  "radar": [{"title": "", "org": "", "deadline": "YYYY-MM-DD|null", "kind": "", "url": "", "note": ""}],
  "calendar": [{"date": "YYYY-MM-DD", "event": ""}],
  "checklist": ["5~7줄"]
}
```

## 편집 원칙

- 전날 24:00 마감. 당일 새벽 속보는 `breaking` 한 줄로만 넣습니다.
- 기사 문장은 옮기지 않고 새로 씁니다. 모든 항목에 출처·날짜·원문 링크를 답니다.
- 언론사 사진·방송 화면은 쓰지 않습니다.
- 수치는 원문 2곳과 대조하고, 1곳뿐이면 출처를 명시합니다.
- 정책은 사실과 경영 영향만 쓰고 정치적 평가는 하지 않습니다.
- 오류는 이 저장소의 원고를 고쳐 정정합니다.
