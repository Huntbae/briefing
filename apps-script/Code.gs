/**
 * 모닝 레이더 발송·구독 스크립트
 * 「모닝 레이더 운영」 시트에 연결해 씁니다(확장 프로그램 > Apps Script).
 *
 * 하는 일
 *  1) sendApproved: 매일 07:00. 오늘 날짜 행의 승인 칸이 Y일 때만, 구독자에게 한 통씩 보냅니다.
 *     승인이 없으면 보내지 않고 관리자에게 알립니다. 주말에는 아무것도 하지 않습니다.
 *  2) 웹앱(doGet/doPost): 구독 신청(확인 메일로 본인 확인), 구독 확인, 수신거부.
 *  3) 메뉴: 나에게 테스트 발송, 트리거 설치.
 *
 * 메일 본문은 brief.huntbae.com/mail/날짜.html 에서 가져오고,
 * {{UNSUBSCRIBE_URL}} 을 구독자별 수신거부 링크로 바꿉니다.
 */

var TZ = 'Asia/Seoul';
var SHEET_QUEUE = '발송대기';
var SHEET_SUBS = '구독자';
var SHEET_LOG = '발송기록';
var SHEET_CONF = '설정';
var TIME_BUDGET_MS = 4.5 * 60 * 1000; // 한 번 실행에 쓰는 최대 시간(제한 6분보다 여유 있게)

// 발송대기 열(1부터)
var Q = { date: 1, title: 2, web: 3, mail: 4, approve: 5, status: 6, at: 7, sent: 8, failed: 9, note: 10 };
// 구독자 열(1부터)
var S = { email: 1, name: 2, org: 3, consent: 4, consentAt: 5, status: 6, unsubAt: 7, token: 8, via: 9 };

/* ------------------------------------------------------------------ 공통 */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function cellDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '').trim();
}

function conf_() {
  var rows = ss_().getSheetByName(SHEET_CONF).getDataRange().getValues();
  var c = {};
  rows.slice(1).forEach(function (r) { c[String(r[0]).trim()] = r[1]; });
  return {
    site: String(c['사이트 주소'] || 'https://brief.huntbae.com').replace(/\/$/, ''),
    fromName: String(c['발신자 이름'] || '모닝 레이더'),
    replyTo: String(c['회신 주소'] || ''),
    admin: String(c['관리자 주소'] || Session.getEffectiveUser().getEmail()),
    prefix: String(c['제목 머리말'] || '[모닝 레이더]'),
    cap: Number(c['일일 발송 상한'] || 1400),
    webApp: String(c['구독 웹앱 주소'] || '') || ScriptApp.getService().getUrl() || ''
  };
}

function weekdayLabel_(iso) {
  var d = new Date(iso + 'T00:00:00+09:00');
  var w = '일월화수목금토'.charAt(Number(Utilities.formatDate(d, TZ, 'u')) % 7);
  return Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) + '(' + w + ')';
}

function findQueueRow_(iso) {
  var sh = ss_().getSheetByName(SHEET_QUEUE);
  var vals = sh.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) {
    if (cellDate_(vals[i][Q.date - 1]) === iso) return { sheet: sh, row: i + 1, v: vals[i] };
  }
  return null;
}

function fetchMail_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('메일 본문을 가져오지 못했습니다: HTTP ' + res.getResponseCode() + ' ' + url);
  var html = res.getContentText('UTF-8');
  if (html.indexOf('{{UNSUBSCRIBE_URL}}') < 0) throw new Error('본문에 수신거부 자리표시자가 없습니다: ' + url);
  return html;
}

function plainText_(title, web, unsub) {
  return title + '\n\n웹에서 전문 보기: ' + web + '\n\n수신거부: ' + unsub;
}

function unsubUrl_(c, email, token) {
  return c.webApp + '?a=unsub&e=' + encodeURIComponent(email) + '&t=' + encodeURIComponent(token);
}

function ensureToken_(sh, row, token) {
  if (token) return token;
  var t = Utilities.getUuid().replace(/-/g, '');
  sh.getRange(row, S.token).setValue(t);
  return t;
}

function notifyAdmin_(subject, body) {
  var c = conf_();
  MailApp.sendEmail(c.admin, '[모닝 레이더 알림] ' + subject, body);
}

/* ------------------------------------------------------------- 정기 발송 */

/** 시간 트리거로 매일 07:00 실행. 주말은 건너뜀. */
function sendApproved() {
  var dow = Number(Utilities.formatDate(new Date(), TZ, 'u')); // 1=월 ... 7=일
  if (dow >= 6) return;
  runSend_(today_(), false);
}

/** 이어 보내기용(시간 초과 시 1분 뒤 자동 예약). */
function continueSend() {
  clearContinueTriggers_();
  var iso = PropertiesService.getScriptProperties().getProperty('CONTINUE_DATE');
  if (iso) runSend_(iso, false);
}

function runSend_(iso, force) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var c = conf_();
    var q = findQueueRow_(iso);
    if (!q) {
      notifyAdmin_(iso + ' 회차 없음', iso + ' 날짜의 발송대기 행이 없어 메일을 보내지 않았습니다. 새벽 제작 작업이 실패했는지 확인해 주십시오.');
      return;
    }
    var status = String(q.v[Q.status - 1]);
    if (status === '발송완료') return;
    var approved = String(q.v[Q.approve - 1]).trim().toUpperCase() === 'Y';
    if (!approved && !force) {
      if (status !== '미승인') {
        q.sheet.getRange(q.row, Q.status).setValue('미승인');
        q.sheet.getRange(q.row, Q.at).setValue(now_());
        notifyAdmin_(iso + ' 회차 미승인', '승인 칸이 Y가 아니어서 ' + iso + ' 회차를 보내지 않았습니다.\n시트에서 Y를 입력한 뒤 메뉴의 「오늘 회차 지금 발송」을 누르면 바로 보냅니다.\n' + ss_().getUrl());
      }
      return;
    }
    if (!c.webApp) throw new Error('설정 탭의 「구독 웹앱 주소」가 비어 있어 수신거부 링크를 만들 수 없습니다.');

    var title = String(q.v[Q.title - 1]);
    var web = String(q.v[Q.web - 1]);
    var html = fetchMail_(String(q.v[Q.mail - 1]));
    var subject = c.prefix + ' ' + weekdayLabel_(iso) + ' ' + title;

    // 이미 보낸 주소는 건너뜀(재실행·이어 보내기 대비)
    var logSh = ss_().getSheetByName(SHEET_LOG);
    var done = {};
    logSh.getDataRange().getValues().slice(1).forEach(function (r) {
      if (cellDate_(r[0]) === iso && r[2] === '성공') done[String(r[1]).toLowerCase()] = true;
    });

    var subSh = ss_().getSheetByName(SHEET_SUBS);
    var subs = subSh.getDataRange().getValues();
    var started = Date.now();
    var sent = 0, failed = 0, logs = [], unfinished = false;
    q.sheet.getRange(q.row, Q.status).setValue('발송중');

    for (var i = 1; i < subs.length; i++) {
      var r = subs[i];
      var email = String(r[S.email - 1]).trim();
      if (!email || r[S.status - 1] !== '구독' || String(r[S.consent - 1]).toUpperCase() !== 'Y') continue;
      if (done[email.toLowerCase()]) continue;
      if (Date.now() - started > TIME_BUDGET_MS) { unfinished = true; break; }
      if (MailApp.getRemainingDailyQuota() < 1 || sent >= c.cap) {
        logs.push([iso, email, '보류', now_(), '하루 발송 한도 도달']);
        unfinished = true;
        break;
      }
      try {
        var token = ensureToken_(subSh, i + 1, String(r[S.token - 1]));
        var u = unsubUrl_(c, email, token);
        GmailApp.sendEmail(email, subject, plainText_(title, web, u), {
          htmlBody: html.split('{{UNSUBSCRIBE_URL}}').join(u),
          name: c.fromName,
          replyTo: c.replyTo || undefined
        });
        sent++;
        logs.push([iso, email, '성공', now_(), '']);
      } catch (err) {
        failed++;
        logs.push([iso, email, '실패', now_(), String(err).slice(0, 300)]);
      }
    }
    if (logs.length) logSh.getRange(logSh.getLastRow() + 1, 1, logs.length, 5).setValues(logs);

    var prevSent = Number(q.v[Q.sent - 1]) || 0, prevFail = Number(q.v[Q.failed - 1]) || 0;
    q.sheet.getRange(q.row, Q.sent).setValue(prevSent + sent);
    q.sheet.getRange(q.row, Q.failed).setValue(prevFail + failed);
    q.sheet.getRange(q.row, Q.at).setValue(now_());

    if (unfinished) {
      q.sheet.getRange(q.row, Q.status).setValue('발송중(이어서)');
      PropertiesService.getScriptProperties().setProperty('CONTINUE_DATE', iso);
      clearContinueTriggers_();
      ScriptApp.newTrigger('continueSend').timeBased().after(60 * 1000).create();
    } else {
      q.sheet.getRange(q.row, Q.status).setValue('발송완료');
      PropertiesService.getScriptProperties().deleteProperty('CONTINUE_DATE');
      if (failed > 0) notifyAdmin_(iso + ' 발송 실패 ' + failed + '건', '발송기록 탭에서 실패 사유를 확인해 주십시오.\n' + ss_().getUrl());
    }
  } catch (err) {
    notifyAdmin_(iso + ' 발송 오류', String(err) + '\n' + ss_().getUrl());
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function clearContinueTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'continueSend') ScriptApp.deleteTrigger(t);
  });
}

/* ------------------------------------------------------------------ 메뉴 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('모닝 레이더')
    .addItem('나에게 테스트 발송(최신 회차)', 'sendTestToMe')
    .addItem('오늘 회차 지금 발송(승인된 경우)', 'sendTodayNow')
    .addSeparator()
    .addItem('매일 07:00 발송 트리거 설치', 'installTriggers')
    .addToUi();
}

/** 승인과 무관하게 관리자 주소로만 최신 회차를 보냄. */
function sendTestToMe() {
  var c = conf_();
  var sh = ss_().getSheetByName(SHEET_QUEUE);
  var last = sh.getLastRow();
  if (last < 2) throw new Error('발송대기 행이 없습니다.');
  var v = sh.getRange(last, 1, 1, Q.note).getValues()[0];
  var iso = cellDate_(v[Q.date - 1]);
  var html = fetchMail_(String(v[Q.mail - 1]));
  var u = (c.webApp || c.site) + (c.webApp ? '?a=unsub&e=test&t=test' : '');
  GmailApp.sendEmail(c.admin, '[테스트] ' + c.prefix + ' ' + weekdayLabel_(iso) + ' ' + v[Q.title - 1],
    plainText_(String(v[Q.title - 1]), String(v[Q.web - 1]), u),
    { htmlBody: html.split('{{UNSUBSCRIBE_URL}}').join(u), name: c.fromName });
  SpreadsheetApp.getActive().toast('테스트 메일을 ' + c.admin + '로 보냈습니다.');
}

/** 오늘 회차를 지금 보냄. 승인 칸이 Y여야 함. */
function sendTodayNow() {
  runSend_(today_(), false);
  SpreadsheetApp.getActive().toast('발송 처리를 마쳤습니다. 발송대기·발송기록 탭을 확인해 주십시오.');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendApproved') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendApproved').timeBased().atHour(7).nearMinute(0).everyDays(1).inTimezone(TZ).create();
  SpreadsheetApp.getActive().toast('매일 07:00(서울) 발송 트리거를 설치했습니다. 주말에는 보내지 않습니다.');
}

/* ------------------------------------------------------------------ 웹앱 */

function page_(title, bodyHtml) {
  var html = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc_(title) + '</title><style>' +
    'body{font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif;max-width:520px;margin:40px auto;padding:0 20px;color:#16191f;line-height:1.7}' +
    'h1{font-size:22px;color:#1f3864}label{display:block;margin:14px 0 4px;font-weight:600}' +
    'input[type=email],input[type=text]{width:100%;padding:10px;border:1px solid #c8ccd4;font-size:16px;box-sizing:border-box}' +
    'button{margin-top:18px;padding:12px 22px;background:#1f3864;color:#fff;border:0;font-size:16px;font-weight:700;cursor:pointer}' +
    '.muted{color:#5f6673;font-size:14px}.hp{position:absolute;left:-9999px}.box{background:#f5f7fb;padding:12px 14px;font-size:14px}' +
    '</style></head><body>' + bodyHtml + '<p class="muted" style="margin-top:32px"><a href="https://brief.huntbae.com">brief.huntbae.com</a></p></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function findSub_(email) {
  var sh = ss_().getSheetByName(SHEET_SUBS);
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][S.email - 1]).trim().toLowerCase() === email.toLowerCase()) return { sheet: sh, row: i + 1, v: vals[i] };
  }
  return null;
}

function formHtml_(msg) {
  var action = ScriptApp.getService().getUrl();
  return '<h1>모닝 레이더 구독 신청</h1>' +
    '<p>평일 아침 07시, 전날까지의 경제·테크·모빌리티 뉴스와 정부 공고를 경영자가 할 일과 함께 보내 드립니다.</p>' +
    (msg ? '<p class="box">' + esc_(msg) + '</p>' : '') +
    '<form method="post" action="' + esc_(action) + '">' +
    '<label for="e">이메일(필수)</label><input id="e" type="email" name="email" required maxlength="120">' +
    '<label for="n">이름(선택)</label><input id="n" type="text" name="name" maxlength="40">' +
    '<label for="o">소속(선택)</label><input id="o" type="text" name="org" maxlength="60">' +
    '<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off">' +
    '<div class="box" style="margin-top:18px"><strong>개인정보 수집·이용 동의(필수)</strong><br>' +
    '수집 항목: 이메일(필수), 이름·소속(선택)<br>이용 목적: 모닝 레이더 메일 발송<br>' +
    '보유 기간: 구독 해지 시까지(해지 즉시 발송 중단)<br>동의하지 않을 수 있으며, 이 경우 메일을 받을 수 없습니다.</div>' +
    '<label style="font-weight:400"><input type="checkbox" name="consent" value="Y" required> 위 내용에 동의합니다.</label>' +
    '<button type="submit">구독 신청</button></form>' +
    '<p class="muted">신청하시면 확인 메일이 갑니다. 메일 속 링크를 눌러야 구독이 완료됩니다.</p>';
}

/**
 * 메일 보안 검사기가 링크를 미리 열어도 해지·확인이 일어나지 않도록,
 * GET 은 확인 버튼만 보여 주고 실제 처리는 버튼을 누른 POST 에서 한다.
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.a === 'unsub' || p.a === 'confirm') {
    var label = p.a === 'unsub' ? '수신거부' : '구독 확인';
    var desc = p.a === 'unsub'
      ? esc_(p.e || '') + ' 주소로 더 이상 모닝 레이더를 받지 않으시려면 아래 버튼을 눌러 주십시오.'
      : esc_(p.e || '') + ' 주소의 구독을 완료하려면 아래 버튼을 눌러 주십시오.';
    return page_('모닝 레이더 ' + label, '<h1>' + label + '</h1><p>' + desc + '</p>' +
      '<form method="post" action="' + esc_(ScriptApp.getService().getUrl()) + '">' +
      '<input type="hidden" name="a" value="' + esc_(p.a) + '"><input type="hidden" name="e" value="' + esc_(p.e || '') + '">' +
      '<input type="hidden" name="t" value="' + esc_(p.t || '') + '"><button type="submit">' + label + '</button></form>');
  }
  return page_('모닝 레이더 구독 신청', formHtml_(''));
}

function doAction_(p) {
  var c = conf_();
  {
    var email = String(p.e || '').trim();
    var s = email ? findSub_(email) : null;
    if (!s || !p.t || String(s.v[S.token - 1]) !== String(p.t)) {
      return page_('모닝 레이더', '<h1>링크를 확인할 수 없습니다</h1><p>메일에 있는 링크를 그대로 눌러 주십시오. 계속 안 되면 ' + esc_(c.replyTo || c.admin) + '로 알려 주십시오.</p>');
    }
    if (p.a === 'unsub') {
      s.sheet.getRange(s.row, S.status).setValue('해지');
      s.sheet.getRange(s.row, S.unsubAt).setValue(now_());
      return page_('수신거부 완료', '<h1>수신거부되었습니다</h1><p>' + esc_(email) + ' 주소로는 더 이상 모닝 레이더를 보내지 않습니다.</p><p class="muted">You have been unsubscribed.</p>');
    }
    s.sheet.getRange(s.row, S.status).setValue('구독');
    s.sheet.getRange(s.row, S.consentAt).setValue(now_());
    return page_('구독 완료', '<h1>구독이 완료되었습니다</h1><p>다음 평일 아침 07시부터 ' + esc_(email) + ' 주소로 모닝 레이더를 보내 드립니다.</p>');
  }
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p.a === 'unsub' || p.a === 'confirm') return doAction_(p);
  if (p.website) return page_('모닝 레이더', formHtml_('신청이 접수되었습니다.')); // 자동 입력 차단
  var email = String(p.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
    return page_('모닝 레이더 구독 신청', formHtml_('이메일 주소를 다시 확인해 주십시오.'));
  }
  if (p.consent !== 'Y') return page_('모닝 레이더 구독 신청', formHtml_('개인정보 수집·이용에 동의해 주셔야 구독할 수 있습니다.'));

  var cache = CacheService.getScriptCache();
  var key = 'sub_' + Utilities.base64EncodeWebSafe(email.toLowerCase());
  if (cache.get(key)) return page_('모닝 레이더', '<h1>확인 메일을 보냈습니다</h1><p>잠시 후 메일함(스팸함 포함)을 확인해 주십시오.</p>');
  cache.put(key, '1', 600);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var c = conf_();
    var s = findSub_(email);
    if (s && s.v[S.status - 1] === '구독') {
      return page_('모닝 레이더', '<h1>이미 구독 중입니다</h1><p>' + esc_(email) + ' 주소로 이미 받아 보고 계십니다.</p>');
    }
    var token = Utilities.getUuid().replace(/-/g, '');
    var name = String(p.name || '').slice(0, 40), org = String(p.org || '').slice(0, 60);
    var sh = ss_().getSheetByName(SHEET_SUBS);
    if (s) {
      sh.getRange(s.row, 1, 1, 9).setValues([[email, name || s.v[S.name - 1], org || s.v[S.org - 1], 'Y', now_(), '보류', '', token, '웹 신청(재구독)']]);
    } else {
      sh.appendRow([email, name, org, 'Y', now_(), '보류', '', token, '웹 신청']);
    }
    var link = ScriptApp.getService().getUrl() + '?a=confirm&e=' + encodeURIComponent(email) + '&t=' + token;
    MailApp.sendEmail({
      to: email,
      subject: '[모닝 레이더] 구독 확인을 부탁드립니다',
      name: c.fromName,
      replyTo: c.replyTo || undefined,
      htmlBody: '<p>모닝 레이더 구독을 신청해 주셔서 감사합니다.</p><p>아래 버튼을 눌러야 구독이 완료됩니다. 직접 신청하지 않으셨다면 이 메일을 무시해 주십시오.</p>' +
        '<p><a href="' + link + '" style="display:inline-block;padding:10px 18px;background:#1f3864;color:#fff;text-decoration:none;font-weight:700">구독 확인</a></p>' +
        '<p style="color:#777;font-size:12px">모닝 레이더 · ' + esc_(c.replyTo || c.admin) + ' · https://brief.huntbae.com</p>',
      body: '모닝 레이더 구독 확인 링크: ' + link
    });
  } finally {
    lock.releaseLock();
  }
  return page_('모닝 레이더', '<h1>확인 메일을 보냈습니다</h1><p>' + esc_(email) + ' 메일함(스팸함 포함)에서 「구독 확인」 버튼을 눌러 주십시오.</p>');
}
