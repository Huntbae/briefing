#!/usr/bin/env python3
"""모닝 레이더 정적 사이트 빌더.

data/issues/YYYY-MM-DD.json 을 읽어 다음을 만든다.
  - /YYYY/MM/DD/index.html  회차 전문(웹 원본)
  - /index.html             최신호 + 아카이브 목록
  - /archive/index.html     전체 아카이브
  - /about/index.html       소개·구독·개인정보 안내
  - /feed.xml               RSS 2.0
  - /mail/YYYY-MM-DD.html   메일 요약판(Apps Script가 가져가 발송)

외부 패키지 없이 표준 라이브러리만 쓴다.
"""
from __future__ import annotations

import datetime as dt
import html
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data" / "issues"
SITE_URL = "https://brief.huntbae.com"
BRAND = "모닝 레이더"
TAGLINE = "어제의 변화, 오늘의 할 일 — 경제·테크·모빌리티·정부공고"
PUBLISHER = "Hunt Bae"
CONTACT = "huntbae@huntbae.com"
HOME = "https://www.huntbae.com"
WEEKDAYS = "월화수목금토일"


def load_config() -> dict:
    """site.json 의 운영 설정(구독 웹앱 주소 등)을 읽는다. 없으면 빈 값."""
    p = ROOT / "site.json"
    if p.exists():
        with p.open(encoding="utf-8") as f:
            return json.load(f)
    return {}


CONFIG = load_config()
SUBSCRIBE_APP = CONFIG.get("subscribe_url", "").strip()  # Apps Script 웹앱 /exec 주소
SUBSCRIBE_PATH = "/subscribe/"  # 사이트 안의 고정 주소(웹앱으로 넘겨 줌)

e = html.escape


def kdate(iso: str) -> str:
    d = dt.date.fromisoformat(iso)
    return f"{d.year}년 {d.month}월 {d.day}일({WEEKDAYS[d.weekday()]})"


def short(iso: str) -> str:
    d = dt.date.fromisoformat(iso)
    return f"{d.month}/{d.day}({WEEKDAYS[d.weekday()]})"


def dday(issue_date: str, target: str | None) -> str:
    if not target:
        return "상시"
    n = (dt.date.fromisoformat(target) - dt.date.fromisoformat(issue_date)).days
    if n == 0:
        return "D-DAY"
    return f"D-{n}" if n > 0 else f"D+{-n}"


def issue_path(iso: str) -> str:
    y, m, d = iso.split("-")
    return f"/{y}/{m}/{d}/"


def load_issues() -> list[dict]:
    issues = []
    for p in sorted(DATA.glob("*.json")):
        with p.open(encoding="utf-8") as f:
            issue = json.load(f)
        if issue.get("draft"):
            continue
        issues.append(issue)
    issues.sort(key=lambda i: i["date"], reverse=True)
    return issues


# ---------------------------------------------------------------- web pages
def page(title: str, body: str, description: str = TAGLINE, canonical: str = SITE_URL + "/") -> str:
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(description)}">
<link rel="canonical" href="{e(canonical)}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{e(canonical)}">
<meta property="og:type" content="article">
<link rel="alternate" type="application/rss+xml" title="{BRAND}" href="/feed.xml">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header class="site-head">
  <div class="wrap head-row">
    <a class="brand" href="/">{BRAND}</a>
    <nav><a href="/archive/">아카이브</a><a href="/about/">소개·구독</a><a href="/feed.xml">RSS</a></nav>
  </div>
</header>
<main class="wrap">
{body}
</main>
<footer class="site-foot">
  <div class="wrap">
    <p><strong>{BRAND}</strong> · 발행 {e(PUBLISHER)} · <a href="mailto:{CONTACT}">{CONTACT}</a> · <a href="{HOME}">huntbae.com</a></p>
    <p class="muted">기사 원문 저작권은 각 언론사·기관에 있습니다. 이 페이지의 요약은 발행인이 새로 쓴 글이며, 수치는 표기된 출처 기준입니다. 투자 권유가 아닙니다.</p>
  </div>
</footer>
</body>
</html>
"""


def render_sources(sources: list[dict]) -> str:
    links = " · ".join(
        f'<a href="{e(s["url"])}" rel="noopener" target="_blank">{e(s["name"])}</a> {e(s.get("date", ""))}'
        for s in sources
    )
    return f'<p class="src">출처: {links}</p>'


def render_issue_body(issue: dict) -> str:
    parts = []
    sample = '<span class="badge">견본</span>' if issue.get("sample") else ""
    parts.append(
        f"""<article class="issue">
<p class="meta">제{issue['issue_no']}호 · {kdate(issue['date'])} · 기준 {e(issue['cutoff'])} {sample}</p>
<h1>{e(issue['headline'])}</h1>
<p class="lead">{e(issue['lead'])}</p>"""
    )
    if issue.get("breaking"):
        parts.append(f'<div class="breaking"><strong>05시 기준 속보</strong> {e(issue["breaking"])}</div>')

    nums = "".join(
        f'<div class="num"><div class="v">{e(n["value"])}</div><div class="l">{e(n["label"])}</div><div class="n">{e(n["note"])}</div></div>'
        for n in issue["numbers"]
    )
    parts.append(f'<section><h2>오늘의 숫자</h2><div class="nums">{nums}</div></section>')

    rows = "".join(
        f'<tr><th>{e(m["name"])}</th><td>{e(m["value"])}</td><td class="{e(m.get("dir", ""))}">{e(m["change"])}</td></tr>'
        for m in issue["market"]
    )
    parts.append(
        f'<section><h2>시장 한눈에</h2><table class="mkt"><tbody>{rows}</tbody></table>'
        f'<p class="src">{e(issue.get("market_note", ""))}</p></section>'
    )

    for sec in issue["sections"]:
        items = []
        for it in sec["items"]:
            body = "".join(f"<p>{e(p)}</p>" for p in it["body"])
            items.append(
                f"""<div class="item">
<h3>{e(it['title'])}</h3>
{body}
<p class="sowhat"><strong>우리 회사는</strong> {e(it['so_what'])}</p>
{render_sources(it['sources'])}
</div>"""
            )
        parts.append(f'<section id="{e(sec["id"])}"><h2>{e(sec["title"])}</h2>{"".join(items)}</section>')

    radar_rows = "".join(
        f'<tr><td class="dday">{dday(issue["date"], r.get("deadline"))}</td>'
        f'<td><a href="{e(r["url"])}" rel="noopener" target="_blank">{e(r["title"])}</a><br><span class="muted">{e(r["org"])} · {e(r["note"])}</span></td>'
        f'<td>{short(r["deadline"]) if r.get("deadline") else "공고문 확인"}</td></tr>'
        for r in issue["radar"]
    )
    parts.append(
        f'<section id="radar"><h2>공고·마감 레이더</h2><table class="radar"><thead><tr><th>남은 날</th><th>공고</th><th>마감</th></tr></thead><tbody>{radar_rows}</tbody></table></section>'
    )

    cal = "".join(f"<li><strong>{short(c['date'])}</strong> {e(c['event'])}</li>" for c in issue["calendar"])
    parts.append(f'<section><h2>다가오는 일정</h2><ul class="cal">{cal}</ul></section>')

    chk = "".join(f"<li>{e(c)}</li>" for c in issue["checklist"])
    parts.append(f'<section class="check"><h2>경영자 체크리스트</h2><ul>{chk}</ul></section>')

    parts.append(
        (f'<section class="cta"><p>매일 아침 메일로 받아 보시려면 <a class="btn" href="{SUBSCRIBE_PATH}">무료 구독 신청</a></p></section></article>'
         if SUBSCRIBE_APP else
         '<section class="cta"><p>매일 아침 메일로 받아 보시려면 <a href="/about/">구독 안내</a>를 확인하십시오.</p></section></article>')
    )
    return "\n".join(parts)


def render_index(issues: list[dict]) -> str:
    latest = issues[0]
    rest = "".join(
        f'<li><a href="{issue_path(i["date"])}">{kdate(i["date"])} · {e(i["headline"])}</a></li>' for i in issues[1:20]
    )
    more = f'<section><h2>지난 호</h2><ul class="list">{rest}</ul><p><a href="/archive/">전체 아카이브 →</a></p></section>' if rest else ""
    intro = f'<p class="tagline">{TAGLINE}</p>'
    body = intro + render_issue_body(latest).replace("<h1>", f'<h1><a href="{issue_path(latest["date"])}">', 1).replace("</h1>", "</a></h1>", 1) + more
    return page(f"{BRAND} — {TAGLINE}", body)


def render_archive(issues: list[dict]) -> str:
    items = "".join(
        f'<li><span class="muted">제{i["issue_no"]}호 · {kdate(i["date"])}</span><br><a href="{issue_path(i["date"])}">{e(i["headline"])}</a></li>'
        for i in issues
    )
    return page(f"아카이브 — {BRAND}", f'<h1>아카이브</h1><ul class="list">{items}</ul>', canonical=SITE_URL + "/archive/")


def subscribe_block() -> str:
    privacy = ("수집 항목은 이메일(필수)과 이름·소속(선택)이며, 메일 발송 목적에만 쓰고 구독 해지 시 발송을 멈춥니다. "
               "신청하시면 확인 메일이 가며, 메일 안의 버튼을 눌러야 구독이 시작됩니다. 메일 하단 링크로 언제든 해지할 수 있습니다.")
    if SUBSCRIBE_APP:
        return f'<p><a class="btn" href="{SUBSCRIBE_PATH}">무료 구독 신청</a></p><p class="muted">{privacy}</p>'
    return (f'<p>구독 신청 양식은 준비 중입니다. 먼저 받아 보고 싶으시면 <a href="mailto:{CONTACT}?subject=모닝 레이더 구독 신청">{CONTACT}</a>로 '
            f'이름과 이메일을 보내 주십시오.</p><p class="muted">{privacy}</p>')


def render_subscribe() -> str:
    """/subscribe/ — 구독 웹앱으로 넘겨 주는 고정 주소. 웹앱 주소가 바뀌어도 사이트 링크는 그대로 둔다."""
    if not SUBSCRIBE_APP:
        return page(f"구독 — {BRAND}", '<h1>구독 신청</h1><p>구독 양식을 준비 중입니다. <a href="/about/">소개·구독</a>을 확인하십시오.</p>',
                    canonical=SITE_URL + SUBSCRIBE_PATH)
    url = e(SUBSCRIBE_APP)
    return f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>구독 신청 — {BRAND}</title>
<meta http-equiv="refresh" content="0; url={url}">
<link rel="canonical" href="{SITE_URL}{SUBSCRIBE_PATH}">
<link rel="stylesheet" href="/assets/style.css">
</head><body><main class="wrap"><p>구독 신청 양식으로 이동합니다. 이동하지 않으면 <a href="{url}">여기</a>를 누르십시오.</p></main></body></html>
"""


def render_about() -> str:
    body = f"""<article class="issue">
<h1>{BRAND} 소개</h1>
<p class="lead">{BRAND}는 평일 아침, 전날까지 나온 경제·테크·모빌리티 뉴스와 정부 공고를 골라 경영자가 할 일과 함께 정리하는 브리핑입니다.</p>
<section><h2>무엇을 담나요</h2><ul>
<li>오늘의 숫자 3개와 시장 지표</li>
<li>경제·시장, 테크·AI, 모빌리티·스마트시티 주요 소식과 “우리 회사는” 한 줄</li>
<li>지원사업·입찰·의견수렴 공고의 마감 D-day</li>
<li>이번 주 경영자 체크리스트</li></ul></section>
<section><h2>편집 원칙</h2><ul>
<li>전날 24시까지의 정보를 기준으로 하며, 새벽 속보는 따로 표시합니다.</li>
<li>모든 항목에 출처와 원문 링크를 답니다. 기사 문장은 옮기지 않고 새로 씁니다.</li>
<li>정책은 사실과 경영 영향만 쓰고, 정치적 평가는 하지 않습니다.</li>
<li>오류는 이 웹 페이지에서 고치고 정정 사실을 표시합니다.</li></ul></section>
<section><h2>메일로 받기</h2>
{subscribe_block()}</section>
<section><h2>발행인</h2><p>{e(PUBLISHER)} · <a href="{HOME}">huntbae.com</a> · <a href="mailto:{CONTACT}">{CONTACT}</a></p></section>
</article>"""
    return page(f"소개·구독 — {BRAND}", body, canonical=SITE_URL + "/about/")


# --------------------------------------------------------------------- RSS
def render_feed(issues: list[dict]) -> str:
    def rfc822(iso: str) -> str:
        d = dt.datetime.fromisoformat(iso + "T06:00:00+09:00")
        return d.strftime("%a, %d %b %Y %H:%M:%S +0900")

    items = "".join(
        f"""<item><title>{e(i['headline'])}</title><link>{SITE_URL}{issue_path(i['date'])}</link>
<guid isPermaLink="true">{SITE_URL}{issue_path(i['date'])}</guid><pubDate>{rfc822(i['date'])}</pubDate>
<description>{e(i['lead'])}</description></item>"""
        for i in issues[:30]
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>{BRAND}</title><link>{SITE_URL}/</link><description>{e(TAGLINE)}</description><language>ko</language>
{items}
</channel></rss>
"""


# -------------------------------------------------------------- mail digest
def render_mail(issue: dict) -> str:
    """메일 클라이언트용 요약판. 표 레이아웃 + 인라인 스타일만 쓴다.

    {{UNSUBSCRIBE_URL}} 은 Apps Script가 구독자별 해지 링크로 바꾼다.
    """
    url = SITE_URL + issue_path(issue["date"])
    font = "font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;"
    nums = "".join(
        f'<td width="33%" valign="top" style="padding:10px;border:1px solid #e3e6ec;{font}">'
        f'<div style="font-size:22px;font-weight:700;color:#1f3864">{e(n["value"])}</div>'
        f'<div style="font-size:13px;color:#333;margin-top:2px">{e(n["label"])}</div></td>'
        for n in issue["numbers"]
    )
    mkt = "".join(
        f'<tr><td style="padding:4px 0;{font}font-size:14px;color:#333">{e(m["name"])}</td>'
        f'<td align="right" style="padding:4px 0;{font}font-size:14px;color:#111">{e(m["value"])}</td>'
        f'<td align="right" style="padding:4px 0 4px 10px;{font}font-size:13px;color:{"#c00000" if m.get("dir") == "up" else "#2f5597"}">{e(m["change"])}</td></tr>'
        for m in issue["market"]
    )
    secs = []
    for sec in issue["sections"]:
        rows = []
        for it in sec["items"]:
            rows.append(
                f'<p style="margin:14px 0 4px;{font}font-size:16px;font-weight:700;color:#111">{e(it["title"])}</p>'
                f'<p style="margin:0 0 4px;{font}font-size:14px;line-height:1.6;color:#333">{e(it["body"][0])}</p>'
                f'<p style="margin:0;{font}font-size:13px;line-height:1.6;color:#1f3864"><strong>우리 회사는</strong> {e(it["so_what"])}</p>'
            )
        secs.append(
            f'<tr><td style="padding:18px 24px 0;{font}"><p style="margin:0;font-size:12px;font-weight:700;color:#4472c4;letter-spacing:1px">{e(sec["title"])}</p>{"".join(rows)}</td></tr>'
        )
    radar = "".join(
        f'<tr><td width="64" style="padding:4px 0;{font}font-size:13px;font-weight:700;color:#c00000">{dday(issue["date"], r.get("deadline"))}</td>'
        f'<td style="padding:4px 0;{font}font-size:14px"><a href="{e(r["url"])}" style="color:#1f3864">{e(r["title"])}</a></td></tr>'
        for r in issue["radar"]
    )
    chk = "".join(f'<li style="margin:2px 0">{e(c)}</li>' for c in issue["checklist"])
    breaking = (
        f'<tr><td style="padding:12px 24px 0;{font}font-size:14px;color:#c00000"><strong>05시 기준 속보</strong> {e(issue["breaking"])}</td></tr>'
        if issue.get("breaking")
        else ""
    )
    sample = " (견본)" if issue.get("sample") else ""
    return f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>[{BRAND}] {short(issue['date'])} {e(issue['headline'])}</title></head>
<body style="margin:0;padding:0;background:#f3f4f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f7"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e3e6ec">
<tr><td style="padding:20px 24px 0;{font}">
<p style="margin:0;font-size:13px;color:#4472c4;font-weight:700">{BRAND} · 제{issue['issue_no']}호{sample}</p>
<p style="margin:4px 0 0;font-size:12px;color:#777">{kdate(issue['date'])} · 기준 {e(issue['cutoff'])}</p>
<h1 style="margin:12px 0 8px;font-size:21px;line-height:1.4;color:#111">{e(issue['headline'])}</h1>
<p style="margin:0;font-size:14px;line-height:1.6;color:#333">{e(issue['lead'])}</p></td></tr>
{breaking}
<tr><td style="padding:16px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{nums}</tr></table></td></tr>
<tr><td style="padding:16px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{mkt}</table></td></tr>
{''.join(secs)}
<tr><td style="padding:18px 24px 0;{font}"><p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#4472c4;letter-spacing:1px">공고·마감 레이더</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{radar}</table></td></tr>
<tr><td style="padding:18px 24px 0;{font}"><p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#4472c4;letter-spacing:1px">경영자 체크리스트</p>
<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.6;color:#333">{chk}</ul></td></tr>
<tr><td align="center" style="padding:22px 24px"><a href="{url}" style="display:inline-block;padding:12px 22px;background:#1f3864;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;{font}">웹에서 전문과 출처 보기</a></td></tr>
<tr><td style="padding:14px 24px 20px;border-top:1px solid #e3e6ec;{font}font-size:12px;line-height:1.6;color:#777">
발행: {e(PUBLISHER)} · {CONTACT} · <a href="{HOME}" style="color:#777">huntbae.com</a><br>
요약은 발행인이 새로 쓴 글이며 수치는 웹 전문에 표기한 출처 기준입니다. 투자 권유가 아닙니다.<br>
더 이상 받지 않으시려면 <a href="{{{{UNSUBSCRIBE_URL}}}}" style="color:#777">수신거부</a>를 눌러 주십시오. To unsubscribe, <a href="{{{{UNSUBSCRIBE_URL}}}}" style="color:#777">click here</a>.
</td></tr>
</table></td></tr></table>
</body></html>
"""


# --------------------------------------------------------------------- main
def write(rel: str, text: str) -> None:
    out = ROOT / rel.lstrip("/")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")


def main() -> int:
    issues = load_issues()
    if not issues:
        print("no issues", file=sys.stderr)
        return 1
    for i in issues:
        canonical = SITE_URL + issue_path(i["date"])
        title = f"[{BRAND}] {short(i['date'])} {i['headline']}"
        write(issue_path(i["date"]) + "index.html", page(title, render_issue_body(i), i["lead"], canonical))
        write(f"/mail/{i['date']}.html", render_mail(i))
    write("/index.html", render_index(issues))
    write("/archive/index.html", render_archive(issues))
    write("/about/index.html", render_about())
    write("/subscribe/index.html", render_subscribe())
    write("/feed.xml", render_feed(issues))
    print(f"built {len(issues)} issue(s); latest {issues[0]['date']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
