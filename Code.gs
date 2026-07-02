/**
 * KNO Workbench v1.0 — 신어 판별 워크벤치 백엔드 (Google Apps Script)
 * 실행: 소유자(USER_DEPLOYING). 신원: 개인 링크 토큰(?u=...). 데이터: 프로젝트 단위 시트(항목_<id>).
 */

// ── 상수 ───────────────────────────────────────────────
var SHEET_USERS = '연구원';
var SHEET_GUIDE = '지침';
var SHEET_LOG = '변경로그';
var SHEET_FAILLOG = '저장실패로그';
var SHEET_PROJECTS = '프로젝트';
var PEPPER = 'KNO_v1_pepper';
var TZ = 'Asia/Seoul';
var TS_FMT = 'yyyy-MM-dd HH:mm:ss';

var HEADERS = [
  'ID', '신어 후보', '작업자', '검수자', '배정 주차',
  '1차 판별', '1차 일시', '1차 메모', '2차 판별', '2차 일시', '2차 메모',
  '상태', '작업 구분', '출처', '추출 시기',
  'LLM 판단 결과', 'LLM 판단 기준', 'LLM 판단 근거',
  '용례', '용례 일자', '용례 URL', '검색 URL'
];
var VERDICTS = ['신어', '비신어', '판단 보류'];
var STATUS = { NONE: '미작업', FIRST: '1차완료', SECOND: '2차완료' };
var LOG_HEADERS = ['일시', 'ID', '신어 후보', '단계', '행위자', '판별', '메모', '이전 상태', '새 상태'];
var FAILLOG_HEADERS = ['일시', '행위자', '기능', 'ID', '판별', '메모', '에러', '토큰'];
var SAVE_FNS = { saveFirst: '1차', saveSecond: '2차', saveWrite: '집필' };

// 집필(M5) 항목 스키마 — 판별과 별개
var HEADERS_WRITE = [
  'ID', '신어 후보', '작업자', '검수자', '배정 주차', '상태', '작업 구분', '1차 일시', '2차 일시',
  '최초출현일', '추출 시기', 'GPT 의미 범주', 'GPT 정의문', 'GPT 설명문', 'GPT 용례',
  '색인표제어', '등재표제어', '원어', '어종 표시', '어원', '단어/구', '품사', '일상어/전문어', '전문 분야', '의미 영역',
  '뜻풀이', '용례', '용례 출처', '용례 URL', '수정 용례', 'X년 Y월 신어',
  '집필 메모(형태부)', '집필 메모(의미부)',
  '1차 뜻풀이', '2차 뜻풀이', '검수 메모(형태부)', '검수 메모(의미부)'
];
// 집필자/검토자가 입력하는 필드(검토자는 전수 수정 가능)
var WRITE_FIELDS = ['색인표제어', '등재표제어', '원어', '어종 표시', '어원', '단어/구', '품사', '일상어/전문어', '전문 분야', '의미 영역', '뜻풀이', '용례', '용례 출처', '용례 URL', '수정 용례', 'X년 Y월 신어', '집필 메모(형태부)', '집필 메모(의미부)', '검수 메모(형태부)', '검수 메모(의미부)'];
function headersFor_(kind) { return kind === '집필' ? HEADERS_WRITE : HEADERS; }

// 연구원 스키마: 구글계정1 이름2 역할3 초대일시4 응답상태5 수락일시6 token7 개인링크8 아이디9 비번해시10 소속11 성별12
var USER_HDR = ['구글 계정', '이름', '역할', '초대 일시', '응답 상태', '수락 일시', '토큰', '개인 링크', '아이디', '비밀번호 해시', '소속', '성별'];
var PROJ_HEADERS = ['프로젝트 ID', '이름', '유형', '업로드 일자', '상태', '파일 ID'];   // file_id = 프로젝트 전용 스프레드시트 ID
var DRIVE_ROOT = 'KNO 워크벤치';   // 최상위 드라이브 폴더(하위: 프로젝트/·원본 업로드/, 작업유형별)
var PRES_TTL = 100;
var WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbyJfYPkTM6YRaqUHtvrIKxaf6ObSmb6KiGSFTiMOGCRlAkideVoX-32iet9PmWuBLw8/exec';   // doPost API 엔드포인트(프론트가 fetch)
var PAGES_URL = 'https://korneo.github.io/KNO-workbench-dev/';   // 프론트(GitHub Pages) — 개인/공통 링크는 이 주소

// ── 진입점 ─────────────────────────────────────────────
function doGet(e) {   // /exec 접근 시 Pages 프론트로 리다이렉트
  var token = (e && e.parameter && e.parameter.u) ? String(e.parameter.u).trim() : '';
  var url = PAGES_URL + (token ? '?u=' + encodeURIComponent(token) : '');
  return HtmlService.createHtmlOutput('<script>location.replace(' + JSON.stringify(url) + ');</script><p><a href="' + url + '">KNO Workbench로 이동</a></p>')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
// ── 외부 프론트(GitHub Pages)용 JSON API ──
// Pages 프론트가 fetch(단순요청)로 호출. 익명 배포 ContentService 응답은 CORS * 허용, text/plain 본문이라 프리플라이트 없음.
var API = {
  getBootstrap: getBootstrap, ping: ping, getPresence: getPresence,
  getGuide: getGuide, setGuide: setGuide,
  getProjects: getProjects, createProject: createProject, deleteProject: deleteProject, exportProject: exportProject, getTemplate: getTemplate,
  getResearchers: getResearchers, saveResearchers: saveResearchers,
  getAssignees: getAssignees, genAgree: genAgree, genReal: genReal,
  getProgress: getProgress, getItems: getItems, getItem: getItem,
  saveFirst: saveFirst, saveSecond: saveSecond, saveWrite: saveWrite, addWriteItem: addWriteItem, deleteWriteItem: deleteWriteItem, logClientFail: logClientFail,
  requestOtp: requestOtp, registerAccount: registerAccount, login: login
};
function doPost(e) {
  var out;
  try {
    var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    var fn = API[body.fn];
    if (typeof fn !== 'function') throw new Error('허용되지 않은 함수: ' + body.fn);
    out = { ok: true, data: fn.apply(null, body.args || []) };
  } catch (err) { out = { ok: false, error: String(err && err.message ? err.message : err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ── 공통 헬퍼 ──────────────────────────────────────────
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name) { var sh = ss_().getSheetByName(name); if (!sh) throw new Error('시트 없음: ' + name); return sh; }
function headerIndex_(sh) {
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], map = {};
  for (var i = 0; i < hdr.length; i++) map[String(hdr[i]).trim()] = i;
  return map;
}
// 첫행: 고정 + 하늘색 배경 + 데이터 필터
function styleHeader_(sh, ncols) {
  try {
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, ncols).setBackground('#cfe2f3').setFontWeight('bold');
    var ex = sh.getFilter(); if (ex) ex.remove();
    sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), ncols).createFilter();
  } catch (e) {}
}
function now_() { return Utilities.formatDate(new Date(), TZ, TS_FMT); }
function cacheGet_(key) { try { var v = CacheService.getScriptCache().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cachePut_(key, obj, ttl) { try { CacheService.getScriptCache().put(key, JSON.stringify(obj), ttl || 60); } catch (e) {} }
function cacheDel_(keys) { try { CacheService.getScriptCache().removeAll([].concat(keys)); } catch (e) {} }
// 멱등키: 응답 유실로 같은 저장이 재전송돼도 1회만 적용. 적용 성공 후에만 마킹.
function opSeen_(opId) { if (!opId) return false; try { return !!CacheService.getScriptCache().get('op:' + opId); } catch (e) { return false; } }
function opMark_(opId) { if (opId) try { CacheService.getScriptCache().put('op:' + opId, '1', 3600); } catch (e) {} }
function getAppUrl_() { return PAGES_URL; }   // 개인/공통 링크는 Pages 프론트 주소
// 개인 링크: ?u=토큰 + &authuser=이메일 → 멀티계정 브라우저에서도 그 계정으로 열려 라우팅 오류 회피.
function personalLink_(url, token, email) { return (!url || !token) ? (url || '') : url + '?u=' + token + (email ? '&authuser=' + encodeURIComponent(email) : ''); }

// ── 인증 ───────────────────────────────────────────────
function hashPw_(pw) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pw) + '|' + PEPPER)); }
function usersSheet_() { return sheet_(SHEET_USERS); }
function ensureUserHeaders_(sh) { sh.getRange(1, 9, 1, 2).setValues([['아이디', '비밀번호 해시']]); }
function whoByToken_(token) {
  token = String(token || '').trim();
  var out = { token: token, known: false, email: '', name: '', role: '', isManager: false, _row: -1 };
  if (!token) return out;
  var hit = cacheGet_('who:' + token); if (hit) return hit;
  var sh = ss_().getSheetByName(SHEET_USERS);
  if (!sh || sh.getLastRow() < 2) return out;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][6]).trim() === token) {
      out.email = String(rows[i][0]).trim(); out.name = String(rows[i][1]).trim(); out.role = String(rows[i][2]).trim();
      out.isManager = /관리자/.test(out.role); out.known = true; out._row = i + 2; break;
    }
  }
  if (out.known) cachePut_('who:' + token, out, 300);
  return out;
}
function me_(token) { var me = whoByToken_(token); if (!me.known) throw new Error('세션이 만료됐거나 잘못된 링크입니다. 개인 링크로 다시 접속하세요.'); return me; }
function assertManager_(me) { if (!me.isManager) throw new Error('관리자 전용 기능입니다.'); }
function assertCanEditStage_(me, worker, reviewer, stage) {
  if (me.isManager) return;
  if (stage === 1 && me.name && me.name === String(worker).trim()) return;
  if (stage === 2 && me.name && me.name === String(reviewer).trim()) return;
  throw new Error('권한 없음: 배정된 담당자만 입력할 수 있습니다.');
}
function requestOtp(email) {
  email = String(email || '').trim();
  if (!email) throw new Error('이메일을 입력하세요.');
  var sh = usersSheet_(), n = sh.getLastRow() - 1;
  var rows = n > 0 ? sh.getRange(2, 1, n, 1).getValues() : [], found = false;
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]).trim().toLowerCase() === email.toLowerCase()) { found = true; break; }
  if (!found) throw new Error('등록된 연구원 이메일이 아닙니다. 관리자에게 문의하세요.');
  var code = String(Math.floor(Math.random() * 900000) + 100000);
  CacheService.getScriptCache().put('otp:' + email.toLowerCase(), code, 600);
  GmailApp.sendEmail(email, '[KNO Workbench] 인증번호',
    '신어 판별 및 집필 워크벤치 계정 등록을 위한 인증번호입니다.\n\n' + code + '\n\n10분 이내에 입력해 주세요. 😊',
    { name: 'KNO Workbench', htmlBody: '<p>신어 판별 및 집필 워크벤치 계정 등록을 위한 인증번호입니다.</p><p style="font-size:24px;font-weight:bold">' + code + '</p><p>10분 이내에 입력해 주세요. 😊</p>' });
  return { ok: true };
}
function registerAccount(email, code, id, pw, name) {
  email = String(email || '').trim(); id = String(id || '').trim();
  if (id.length < 2) throw new Error('아이디는 2자 이상이어야 합니다.');
  if (String(pw || '').length < 4) throw new Error('비밀번호는 4자 이상이어야 합니다.');
  var cached = CacheService.getScriptCache().get('otp:' + email.toLowerCase());
  if (!cached || cached !== String(code || '').trim()) throw new Error('인증번호가 올바르지 않거나 만료됐습니다.');
  var lock = LockService.getDocumentLock(); lock.waitLock(15000);
  try {
    var sh = usersSheet_(); ensureUserHeaders_(sh);
    var n = sh.getLastRow() - 1, data = sh.getRange(2, 1, n, 10).getValues(), myRow = -1;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][8]).trim().toLowerCase() === id.toLowerCase() && String(data[i][0]).trim().toLowerCase() !== email.toLowerCase())
        throw new Error('이미 사용 중인 아이디입니다.');
      if (String(data[i][0]).trim().toLowerCase() === email.toLowerCase()) myRow = i;
    }
    if (myRow < 0) throw new Error('등록된 연구원 이메일이 아닙니다.');
    if (name && String(data[myRow][1]).trim() !== String(name).trim()) throw new Error('이름이 등록 정보와 일치하지 않습니다.');
    if (String(data[myRow][8]).trim()) throw new Error('이미 등록된 계정입니다. 로그인하세요. (비밀번호 분실 시 관리자에게 초기화 요청.)');
    var tok = String(data[myRow][6]).trim();
    if (!tok) { tok = Utilities.getUuid().replace(/-/g, '').slice(0, 10); sh.getRange(myRow + 2, 7).setValue(tok); }
    sh.getRange(myRow + 2, 9).setValue(id);
    sh.getRange(myRow + 2, 10).setValue(hashPw_(pw));
    CacheService.getScriptCache().remove('otp:' + email.toLowerCase());
    cacheDel_('who:' + tok);
    SpreadsheetApp.flush();
    return { ok: true, token: tok };
  } finally { lock.releaseLock(); }
}
function login(id, pw) {
  id = String(id || '').trim();
  if (!id) throw new Error('아이디를 입력하세요.');
  var sh = usersSheet_(), n = sh.getLastRow() - 1;
  if (n <= 0) throw new Error('등록된 계정이 없습니다.');
  var data = sh.getRange(2, 1, n, 10).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][8]).trim().toLowerCase() === id.toLowerCase()) {
      if (String(data[i][9]).trim() && String(data[i][9]).trim() === hashPw_(pw)) return { ok: true, token: String(data[i][6]).trim() };
      break;
    }
  }
  throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
}

// ── 부트스트랩 / 접속 현황 ─────────────────────────────
function getBootstrap(token) {
  var me = me_(token);
  return { me: me, verdicts: VERDICTS, appUrl: getAppUrl_() };
}
function ping(token) {
  var me = whoByToken_(token);
  if (me.known && me.name) { try { CacheService.getScriptCache().put('pres:' + me.name, String(Date.now()), PRES_TTL); } catch (e) {} }
  return { ok: true };
}
function getPresence(token) {
  var me = me_(token);
  try { CacheService.getScriptCache().put('pres:' + me.name, String(Date.now()), PRES_TTL); } catch (e) {}
  var roster = cacheGet_('presence:roster');
  if (!roster) {
    roster = [];
    var sh = ss_().getSheetByName(SHEET_USERS);
    if (sh && sh.getLastRow() >= 2) {
      var rows = sh.getRange(2, 2, sh.getLastRow() - 1, 2).getValues();
      for (var i = 0; i < rows.length; i++) { var nm = String(rows[i][0]).trim(); if (nm) roster.push({ name: nm, '역할': String(rows[i][1] || '').trim() }); }
    }
    cachePut_('presence:roster', roster, 300);
  }
  var keys = roster.map(function (r) { return 'pres:' + r.name; }), got = {};
  try { got = CacheService.getScriptCache().getAll(keys) || {}; } catch (e) { got = {}; }
  return roster.map(function (r) { return { name: r.name, '역할': r['역할'], online: !!got['pres:' + r.name] }; });
}

// ── 프로젝트 ───────────────────────────────────────────
function projRegSheet_() {
  var sh = ss_().getSheetByName(SHEET_PROJECTS);
  if (!sh) { sh = ss_().insertSheet(SHEET_PROJECTS); sh.getRange(1, 1, 1, PROJ_HEADERS.length).setValues([PROJ_HEADERS]); styleHeader_(sh, PROJ_HEADERS.length); return sh; }
  var hdr = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), PROJ_HEADERS.length)).getValues()[0];
  if (String(hdr[5]).trim() !== '파일 ID') sh.getRange(1, 1, 1, PROJ_HEADERS.length).setValues([PROJ_HEADERS]);   // 구 스키마→신 스키마
  return sh;
}
function fmtDate_(v) {   // Date/문자열 → 'YYYY.MM.DD'
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy.MM.dd');
  var s = String(v || '').trim(), m = s.match(/(\d{4})[-.](\d{1,2})[-.](\d{1,2})/);
  return m ? m[1] + '.' + ('0' + m[2]).slice(-2) + '.' + ('0' + m[3]).slice(-2) : s;
}
function kindLabel_(kind) { return kind === '일치도' ? '연구자 일치도 작업' : kind === '집필' ? '신어 집필 작업' : '신어 판별 작업'; }
function folder_(pathArr) {   // 중첩 폴더 get-or-create
  var f = DriveApp.getRootFolder();
  for (var i = 0; i < pathArr.length; i++) { var it = f.getFoldersByName(pathArr[i]); f = it.hasNext() ? it.next() : f.createFolder(pathArr[i]); }
  return f;
}
function projList_(kind) {
  var sh = projRegSheet_(), n = sh.getLastRow() - 1; if (n < 1) return [];
  var idx = headerIndex_(sh), rows = sh.getRange(2, 1, n, sh.getLastColumn()).getValues(), out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]; if (kind && String(r[idx['유형']]).trim() !== kind) continue;
    out.push({ id: String(r[idx['프로젝트 ID']]).trim(), name: String(r[idx['이름']]).trim(), type: String(r[idx['유형']]).trim(),
      uploaded: fmtDate_(r[idx['업로드 일자']]), status: String(r[idx['상태']]).trim(), fileId: String(r[idx['파일 ID']] || '').trim(), _row: i + 2 });
  }
  return out;
}
function projById_(id) { var a = projList_(null); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; }
function projItemSheet_(projectId) {   // 프로젝트 전용 스프레드시트의 '항목' 탭
  var p = projById_(projectId); if (!p || !p.fileId) return null;
  try { var pss = SpreadsheetApp.openById(p.fileId); return pss.getSheetByName('항목') || pss.getSheets()[0]; } catch (e) { return null; }
}
function projItemsCount_(p) { var sh = projItemSheet_(p.id); return sh ? Math.max(0, sh.getLastRow() - 1) : 0; }
function projSheetOfRow_(rowId) { return projItemSheet_(String(rowId).split('::')[0]); }
function projSetStatus_(projectId, status) { var p = projById_(projectId); if (!p) return; var reg = projRegSheet_(), idx = headerIndex_(reg); reg.getRange(p._row, idx['상태'] + 1).setValue(status); }

function getProjects(token, kind) {
  me_(token);
  return projList_(kind).map(function (p) { return { id: p.id, name: p.name, type: p.type, uploaded: p.uploaded, status: p.status, items: projItemsCount_(p) }; });
}
function createProject(token, kind, name, csvText) {
  assertManager_(me_(token));
  name = String(name || '').trim() || '새 프로젝트';
  var H = headersFor_(kind);
  var pid = (kind === '일치도' ? 'ag' : kind === '집필' ? 'wr' : 'rl') + '-' + Date.now().toString(36);
  try { folder_([DRIVE_ROOT, '원본 업로드', kindLabel_(kind)]).createFile(Utilities.newBlob(String(csvText || ''), 'text/csv', name + '.csv')); } catch (e) {}   // 원본 보관(재현성)
  var pss = SpreadsheetApp.create(name), fileId = pss.getId();   // 프로젝트 전용 스프레드시트
  try { var file = DriveApp.getFileById(fileId); folder_([DRIVE_ROOT, '프로젝트', kindLabel_(kind)]).addFile(file); DriveApp.getRootFolder().removeFile(file); } catch (e) {}
  var sh = pss.getSheets()[0]; sh.setName('항목');
  sh.getRange(1, 1, 1, H.length).setValues([H]);
  var t = Utilities.parseCsv(String(csvText || '').replace(/^﻿/, ''));
  var hdr = (t[0] || []).map(function (h) { return String(h).replace(/^﻿/, '').trim(); });
  var col = {}; hdr.forEach(function (h, i) { if (H.indexOf(h) >= 0) col[h] = i; });
  var CLEAR = ['작업자', '검수자', '배정 주차', '1차 판별', '1차 메모', '1차 일시', '2차 판별', '2차 메모', '2차 일시'];   // 배정·판별 추적만 초기화(집필 내용·1차/2차 뜻풀이·메모는 보존)
  var out = [];
  for (var r = 1; r < t.length; r++) {
    var row = t[r]; if (!row || row.join('') === '') continue;
    var cand = col['신어 후보'] != null ? String(row[col['신어 후보']] || '').trim() : ''; if (!cand) continue;
    var o = [];
    for (var c = 0; c < H.length; c++) {
      var key = H[c], ci = col[key], v = (ci != null && row[ci] != null) ? row[ci] : '';
      if (key === 'ID') v = pid + '::' + (v || r);
      else if (key === '작업 구분') v = kind;
      else if (key === '상태') v = STATUS.NONE;
      else if (CLEAR.indexOf(key) >= 0) v = '';
      o.push(v);
    }
    out.push(o);
  }
  if (out.length) sh.getRange(2, 1, out.length, H.length).setValues(out);
  styleHeader_(sh, H.length);
  projRegSheet_().appendRow([pid, name, kind, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), '미배분', fileId]);
  return { id: pid, name: name, items: out.length };
}
function deleteProject(token, kind, id) {
  assertManager_(me_(token));
  var p = projById_(id); if (!p) return { ok: true };
  if (p.fileId) { try { DriveApp.getFileById(p.fileId).setTrashed(true); } catch (e) {} }   // 파일 → 휴지통(영구삭제 아님)
  projRegSheet_().deleteRow(p._row);
  return { ok: true };
}
function exportProject(token, kind, id) {
  assertManager_(me_(token));
  var sh = projItemSheet_(id); if (!sh) throw new Error('프로젝트 없음');
  return toCsv_(sh.getDataRange().getValues());
}
function getTemplate(token, kind) {
  me_(token);
  return '작업 구분,작업자,검수자,배정 주차,상태,1차 판별,1차 메모,1차 일시,2차 판별,2차 메모,2차 일시,ID,신어 후보,출처,추출 시기,LLM 판단 결과,LLM 판단 기준,LLM 판단 근거,용례,용례 일자,용례 URL,검색 URL';
}

// ── 지침 ───────────────────────────────────────────────
function getGuide(token, which) {
  me_(token);
  var sh = ss_().getSheetByName(SHEET_GUIDE); if (!sh || sh.getLastRow() < 1) return '';
  var vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === which) return String(vals[i][1] || '');
  return '';
}
function setGuide(token, which, md) {
  assertManager_(me_(token));
  var sh = ss_().getSheetByName(SHEET_GUIDE) || ss_().insertSheet(SHEET_GUIDE);
  var vals = sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), 2).getValues() : [];
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === which) { sh.getRange(i + 1, 2).setValue(String(md || '')); return { ok: true }; }
  sh.appendRow([which, String(md || '')]); return { ok: true };
}

// ── 진행률 ─────────────────────────────────────────────
function researcherOrder_() {
  var map = {}, sh = ss_().getSheetByName(SHEET_USERS);
  if (!sh || sh.getLastRow() < 2) return map;
  var names = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < names.length; i++) map[String(names[i][0]).trim()] = i;
  return map;
}
function getProgress(token, kind, projectId) {
  me_(token);
  var sh = projItemSheet_(projectId), idx = sh ? headerIndex_(sh) : {}, n = sh ? sh.getLastRow() - 1 : 0;
  var overall = { total: 0, 미작업: 0, '1차완료': 0, '2차완료': 0, weeks: {} }, groups = {};
  if (sh && n > 0) {
    var need = ['작업자', '검수자', '배정 주차', '상태'], cmin = Infinity, cmax = -1;
    for (var ni = 0; ni < need.length; ni++) { var ci = idx[need[ni]]; if (ci != null) { if (ci < cmin) cmin = ci; if (ci > cmax) cmax = ci; } }
    var data = sh.getRange(2, cmin + 1, n, cmax - cmin + 1).getValues();
    var dW = idx['작업자'] - cmin, dR = idx['검수자'] - cmin, dWk = idx['배정 주차'] - cmin, dS = idx['상태'] - cmin;
    for (var r = 0; r < data.length; r++) {
      var st = String(data[r][dS]).trim() || '미작업';
      overall.total++; if (overall[st] !== undefined) overall[st]++;
      var wk = String(data[r][dWk]).trim(); if (wk) overall.weeks[wk] = (overall.weeks[wk] || 0) + 1;
      var w = String(data[r][dW]).trim(), rv = String(data[r][dR]).trim();
      var key = (kind === '일치도') ? (w || '(미배정)') : ((w || '?') + ' / ' + (rv || '?'));
      if (!groups[key]) groups[key] = { label: key, worker: w, reviewer: rv, total: 0, 미작업: 0, '1차완료': 0, '2차완료': 0, weeks: {} };
      groups[key].total++; if (groups[key][st] !== undefined) groups[key][st]++;
      if (wk) groups[key].weeks[wk] = (groups[key].weeks[wk] || 0) + 1;
    }
  }
  var order = researcherOrder_(), arr = Object.keys(groups).map(function (k) { return groups[k]; });
  arr.sort(function (a, b) { var ia = order[a.worker], ib = order[b.worker]; ia = (ia == null ? 9999 : ia); ib = (ib == null ? 9999 : ib); return ia !== ib ? ia - ib : a.label.localeCompare(b.label, 'ko'); });
  var weekList = Object.keys(overall.weeks).sort(function (a, b) { return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0); });
  return { overall: overall, groups: arr, weeks: weekList };
}

// ── 항목 조회 ──────────────────────────────────────────
// 일치도 작업자→행범위 인덱스(genAgree가 작업자별 연속 정렬). 재배분 시 무효화.
function agreeIndex_(sh) {
  var props = PropertiesService.getScriptProperties(), key = 'idx:' + sh.getParent().getId(), raw = props.getProperty(key);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  var idx = headerIndex_(sh), n = sh.getLastRow() - 1; if (n <= 0) return {};
  var ws = sh.getRange(2, idx['작업자'] + 1, n, 1).getValues(), ks = sh.getRange(2, idx['작업 구분'] + 1, n, 1).getValues(), map = {};
  for (var i = 0; i < n; i++) {
    if (String(ks[i][0]).trim() !== '일치도') continue;
    var w = String(ws[i][0]).trim(); if (!w) continue; var row = i + 2;
    if (!map[w]) map[w] = [row, row]; else { if (row < map[w][0]) map[w][0] = row; if (row > map[w][1]) map[w][1] = row; }
  }
  try { props.setProperty(key, JSON.stringify(map)); } catch (e) {}
  return map;
}
var LIST_FIELDS = ['ID', '신어 후보', '출처', '추출 시기', '작업 구분', '작업자', '검수자', '배정 주차', '상태', '1차 판별', '2차 판별'];
function getItems(token, opts) {
  var me = me_(token); opts = opts || {};
  if (opts.kind === '일치도') opts.onlyMine = true;
  var sh = projItemSheet_(opts.projectId); if (!sh) return [];
  var n = sh.getLastRow() - 1; if (n <= 0) return [];
  var idx = headerIndex_(sh), lastCol = sh.getLastColumn();
  var startRow = 2, numRows = n;
  if (opts.kind === '일치도' && !me.isManager && me.name) {
    try { var rng = agreeIndex_(sh)[me.name];
      if (rng && rng[0] >= 2 && rng[1] >= rng[0]) { startRow = rng[0]; numRows = Math.min(rng[1], n + 1) - rng[0] + 1;
        if (numRows < 1 || startRow > n + 1) { startRow = 2; numRows = n; } }
    } catch (e) { startRow = 2; numRows = n; }
  }
  var full = !!opts.full, blkCols = lastCol;
  if (!full) { var maxc = 0; for (var li = 0; li < LIST_FIELDS.length; li++) { var ci = idx[LIST_FIELDS[li]]; if (ci != null && ci > maxc) maxc = ci; } blkCols = Math.min(maxc + 1, lastCol); }
  var BLK = sh.getRange(startRow, 1, numRows, blkCols).getValues();
  function g(r, key) { var c = idx[key]; if (c == null || c >= blkCols) return ''; return String(BLK[r][c] || '').trim(); }
  var qy = opts.q ? String(opts.q).toLowerCase() : '', out = [];
  for (var r = 0; r < numRows; r++) {
    var k = g(r, '작업 구분'), w = g(r, '작업자'), rv = g(r, '검수자'), st = g(r, '상태'), wk = g(r, '배정 주차');
    if (opts.kind && k !== opts.kind) continue;
    if (opts.worker && w !== opts.worker) continue;
    if (opts.week && wk !== String(opts.week)) continue;
    if (opts.status && st !== opts.status) continue;
    if (opts.onlyMine && !me.isManager && me.name !== w && me.name !== rv) continue;
    if (qy && g(r, '신어 후보').toLowerCase().indexOf(qy) === -1) continue;
    var obj = {}, fields = full ? Object.keys(idx) : LIST_FIELDS;   // full=시트 실제 컬럼(판별·집필 공용)
    for (var h = 0; h < fields.length; h++) obj[fields[h]] = g(r, fields[h]);
    out.push(obj);
  }
  return out;
}
function getItem(token, rowId) {
  me_(token);
  var sh = projSheetOfRow_(rowId); if (!sh) throw new Error('프로젝트 없음: ' + rowId);
  var idx = headerIndex_(sh), rownum = findRow_(sh, idx, rowId);
  if (rownum < 0) throw new Error('행 없음: ' + rowId);
  var row = sh.getRange(rownum, 1, 1, sh.getLastColumn()).getValues()[0], obj = {};
  for (var key in idx) obj[key] = String(row[idx[key]]);   // 시트 실제 컬럼 전부(판별·집필 공용)
  return obj;
}
function getAssignees(kind, projectId) {   // 프론트가 (kind, pid)로 호출(토큰 없음)
  var sh = projItemSheet_(projectId); if (!sh) return [];
  var idx = headerIndex_(sh), n = sh.getLastRow() - 1; if (n <= 0) return [];
  var need = ['작업자', '검수자'], cmin = Infinity, cmax = -1;
  for (var ni = 0; ni < need.length; ni++) { var ci = idx[need[ni]]; if (ci != null) { if (ci < cmin) cmin = ci; if (ci > cmax) cmax = ci; } }
  var data = sh.getRange(2, cmin + 1, n, cmax - cmin + 1).getValues(), dW = idx['작업자'] - cmin, dR = idx['검수자'] - cmin, seen = {}, out = [];
  for (var r = 0; r < data.length; r++) {
    var w = String(data[r][dW]).trim(), rv = String(data[r][dR]).trim();
    if (!w || seen[w]) continue; seen[w] = true;
    out.push({ worker: w, reviewer: rv, label: kind === '일치도' ? w : (w + ' - ' + rv) });
  }
  return out;   // 정렬 안 함 — 시트 등장 순서(=genReal 팀 블록/배분 순서) 유지
}

// ── 배분(프로젝트 시트 재구성) ─────────────────────────
function genAgree(token, projectId, names) {
  assertManager_(me_(token));
  if (!names || !names.length) throw new Error('참여자를 선택하세요.');
  var p = projById_(projectId); if (!p) throw new Error('프로젝트 없음');
  var sh = projItemSheet_(projectId); if (!sh) throw new Error('시트 없음');
  var idx = headerIndex_(sh), lastCol = sh.getLastColumn(), n = sh.getLastRow() - 1, C = {};
  HEADERS.forEach(function (h) { C[h] = idx[h]; });
  var base = {};
  if (n > 0) { var data = sh.getRange(2, 1, n, lastCol).getValues();
    for (var r = 0; r < data.length; r++) { var b = String(data[r][C['ID']]).trim().split('#')[0]; if (!base[b]) base[b] = data[r]; } }
  var out = [];
  Object.keys(base).forEach(function (b) { var src = base[b];
    names.forEach(function (nm) { var o = src.slice();
      o[C['ID']] = b + '#' + nm; o[C['작업 구분']] = '일치도'; o[C['작업자']] = nm; o[C['검수자']] = '';
      o[C['배정 주차']] = ''; o[C['상태']] = STATUS.NONE;
      o[C['1차 판별']] = ''; o[C['1차 메모']] = ''; o[C['1차 일시']] = ''; o[C['2차 판별']] = ''; o[C['2차 메모']] = ''; o[C['2차 일시']] = '';
      out.push(o); }); });
  out.sort(function (a, b) { var aw = String(a[C['작업자']]), bw = String(b[C['작업자']]); return aw !== bw ? aw.localeCompare(bw, 'ko') : String(a[C['ID']]).localeCompare(String(b[C['ID']])); });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, lastCol).setValues(out);
  styleHeader_(sh, HEADERS.length);
  try { PropertiesService.getScriptProperties().deleteProperty('idx:' + sh.getParent().getId()); } catch (e) {}
  projSetStatus_(projectId, '배분완료');
  return { ok: true, rows: out.length };
}
function genReal(token, projectId, cfg) {
  assertManager_(me_(token));
  cfg = cfg || {}; var pairs = cfg.pairs || [], weeks = Math.max(1, parseInt(cfg.weeks, 10) || 4);
  if (!pairs.length) throw new Error('팀을 지정하세요.');
  var p = projById_(projectId); if (!p) throw new Error('프로젝트 없음');
  var sh = projItemSheet_(projectId); if (!sh) throw new Error('시트 없음');
  var idx = headerIndex_(sh), lastCol = sh.getLastColumn(), n = sh.getLastRow() - 1, C = {};
  HEADERS.forEach(function (h) { C[h] = idx[h]; });
  var base = {};
  if (n > 0) { var data = sh.getRange(2, 1, n, lastCol).getValues();
    for (var r = 0; r < data.length; r++) { var b = String(data[r][C['ID']]).trim().split('#')[0]; if (!base[b]) base[b] = data[r].slice(); } }
  var rows = Object.keys(base).map(function (k) { return base[k]; });
  rows.sort(function (a, b) { return String(a[C['신어 후보']]).localeCompare(String(b[C['신어 후보']]), 'ko'); });
  var P = pairs.length, N = rows.length, per = Math.floor(N / P), rem = N % P, pos = 0;
  for (var pi = 0; pi < P; pi++) {
    var cnt = per + (pi < rem ? 1 : 0), block = rows.slice(pos, pos + cnt); pos += cnt;
    var m = block.length, wb = Math.floor(m / weeks), wr = m % weeks, bp = 0;
    for (var wk = 0; wk < weeks; wk++) { var take = wb + (wk < wr ? 1 : 0);
      for (var bi = 0; bi < take; bi++) { var rr = block[bp + bi];
        rr[C['ID']] = String(rr[C['ID']]).split('#')[0];
        rr[C['작업 구분']] = p.type; rr[C['작업자']] = pairs[pi][0]; rr[C['검수자']] = pairs[pi][1];
        rr[C['배정 주차']] = String(wk + 1); rr[C['상태']] = STATUS.NONE; }
      bp += take; }
  }
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, lastCol).setValues(rows);
  styleHeader_(sh, lastCol);
  projSetStatus_(projectId, '배분완료');
  return { ok: true, rows: rows.length };
}

// ── 저장 ───────────────────────────────────────────────
function findRow_(sh, idx, rowId) {
  var n = sh.getLastRow() - 1; if (n <= 0) return -1;
  var ids = sh.getRange(2, idx['ID'] + 1, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === String(rowId).trim()) return i + 2;
  return -1;
}
function setCell_(sh, rownum, idx, header, value) { sh.getRange(rownum, idx[header] + 1).setValue(value); }
function saveFirst(token, payload) {
  var me = me_(token);
  if (VERDICTS.indexOf(payload.verdict) === -1) throw new Error('판별 값 오류');
  var lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    if (opSeen_(payload.op_id)) return { ok: true, dup: true };
    var sh = projSheetOfRow_(payload.row_id); if (!sh) throw new Error('프로젝트 없음');
    var idx = headerIndex_(sh), rownum = findRow_(sh, idx, payload.row_id);
    if (rownum < 0) throw new Error('행 없음: ' + payload.row_id);
    assertCanEditStage_(me, sh.getRange(rownum, idx['작업자'] + 1).getValue(), sh.getRange(rownum, idx['검수자'] + 1).getValue(), 1);
    var cand = String(sh.getRange(rownum, idx['신어 후보'] + 1).getValue());
    var prev = String(sh.getRange(rownum, idx['상태'] + 1).getValue()).trim();
    setCell_(sh, rownum, idx, '1차 판별', payload.verdict);
    setCell_(sh, rownum, idx, '1차 메모', payload.memo || '');
    setCell_(sh, rownum, idx, '1차 일시', now_());
    var ns = String(sh.getRange(rownum, idx['2차 판별'] + 1).getValue()).trim() ? STATUS.SECOND : STATUS.FIRST;
    setCell_(sh, rownum, idx, '상태', ns);
    appendLog_(me, payload.row_id, cand, '1차', payload.verdict, payload.memo || '', prev, ns);
    SpreadsheetApp.flush(); opMark_(payload.op_id);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function saveSecond(token, payload) {
  var me = me_(token);
  if (VERDICTS.indexOf(payload.verdict) === -1) throw new Error('판별 값 오류');
  var lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    if (opSeen_(payload.op_id)) return { ok: true, dup: true };
    var sh = projSheetOfRow_(payload.row_id); if (!sh) throw new Error('프로젝트 없음');
    var idx = headerIndex_(sh), rownum = findRow_(sh, idx, payload.row_id);
    if (rownum < 0) throw new Error('행 없음: ' + payload.row_id);
    assertCanEditStage_(me, sh.getRange(rownum, idx['작업자'] + 1).getValue(), sh.getRange(rownum, idx['검수자'] + 1).getValue(), 2);
    var cand = String(sh.getRange(rownum, idx['신어 후보'] + 1).getValue());
    var prev = String(sh.getRange(rownum, idx['상태'] + 1).getValue()).trim();
    setCell_(sh, rownum, idx, '2차 판별', payload.verdict);
    setCell_(sh, rownum, idx, '2차 메모', payload.memo || '');
    setCell_(sh, rownum, idx, '2차 일시', now_());
    setCell_(sh, rownum, idx, '상태', STATUS.SECOND);
    appendLog_(me, payload.row_id, cand, '2차', payload.verdict, payload.memo || '', prev, STATUS.SECOND);
    SpreadsheetApp.flush(); opMark_(payload.op_id);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
// 집필 저장: payload={row_id, stage(1|2), fields:{컬럼:값}, op_id}. 검토자(2차)는 전 필드 수정 가능.
function saveWrite(token, payload) {
  var me = me_(token);
  var lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    if (opSeen_(payload.op_id)) return { ok: true, dup: true };
    var sh = projSheetOfRow_(payload.row_id); if (!sh) throw new Error('프로젝트 없음');
    var idx = headerIndex_(sh), rownum = findRow_(sh, idx, payload.row_id);
    if (rownum < 0) throw new Error('행 없음: ' + payload.row_id);
    var stage = (parseInt(payload.stage, 10) === 2) ? 2 : 1;
    assertCanEditStage_(me, sh.getRange(rownum, idx['작업자'] + 1).getValue(), sh.getRange(rownum, idx['검수자'] + 1).getValue(), stage);
    var cand = String(sh.getRange(rownum, idx['신어 후보'] + 1).getValue());
    var prev = String(sh.getRange(rownum, idx['상태'] + 1).getValue()).trim();
    var fields = payload.fields || {};
    for (var k = 0; k < WRITE_FIELDS.length; k++) { var f = WRITE_FIELDS[k]; if (f in idx && f in fields) setCell_(sh, rownum, idx, f, fields[f] == null ? '' : fields[f]); }
    var def = fields['뜻풀이'] == null ? '' : fields['뜻풀이'], ns;
    if (stage === 1) {
      if ('1차 뜻풀이' in idx) setCell_(sh, rownum, idx, '1차 뜻풀이', def);
      if ('1차 일시' in idx) setCell_(sh, rownum, idx, '1차 일시', now_());
      ns = ('2차 뜻풀이' in idx && String(sh.getRange(rownum, idx['2차 뜻풀이'] + 1).getValue()).trim()) ? STATUS.SECOND : STATUS.FIRST;
    } else {
      if ('2차 뜻풀이' in idx) setCell_(sh, rownum, idx, '2차 뜻풀이', def);
      if ('2차 일시' in idx) setCell_(sh, rownum, idx, '2차 일시', now_());
      ns = STATUS.SECOND;
    }
    if ('상태' in idx) setCell_(sh, rownum, idx, '상태', ns);
    appendLog_(me, payload.row_id, cand, stage === 1 ? '집필1차' : '집필2차', String(def).slice(0, 40), '', prev, ns);
    SpreadsheetApp.flush(); opMark_(payload.op_id);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
// 집필 새 항목 추가
function addWriteItem(token, projectId, cand) {
  var me = me_(token);
  cand = String(cand || '').trim(); if (!cand) throw new Error('신어 후보를 입력하세요.');
  var p = projById_(projectId); if (!p || p.type !== '집필') throw new Error('집필 프로젝트가 아닙니다.');
  var sh = projItemSheet_(projectId); if (!sh) throw new Error('시트 없음');
  var rid = projectId + '::new-' + Date.now().toString(36);
  var row = HEADERS_WRITE.map(function (k) {
    if (k === 'ID') return rid;
    if (k === '신어 후보') return cand;
    if (k === '작업 구분') return '집필';
    if (k === '상태') return STATUS.NONE;
    if (k === '작업자') return me.isManager ? '' : me.name;
    return '';
  });
  sh.appendRow(row); styleHeader_(sh, HEADERS_WRITE.length); SpreadsheetApp.flush();
  return { id: rid, cand: cand };
}
// 집필 새 항목 삭제 — 새로 추가한 항목(::new-)만 허용, 배분된 항목은 불가
function deleteWriteItem(token, rowId) {
  me_(token);
  if (String(rowId || '').indexOf('::new-') < 0) throw new Error('배분된 항목은 삭제할 수 없습니다.');
  var sh = projSheetOfRow_(rowId); if (!sh) throw new Error('프로젝트 없음');
  var idx = headerIndex_(sh), rownum = findRow_(sh, idx, rowId);
  if (rownum < 0) throw new Error('행 없음: ' + rowId);
  sh.deleteRow(rownum); SpreadsheetApp.flush();
  return { ok: true };
}

// ── 로그 ───────────────────────────────────────────────
function logSheet_() {
  var sh = ss_().getSheetByName(SHEET_LOG);
  if (!sh) { sh = ss_().insertSheet(SHEET_LOG); sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]); styleHeader_(sh, LOG_HEADERS.length); }
  return sh;
}
function appendLog_(me, rowId, cand, stage, verdict, memo, prevStatus, newStatus) {
  var row = [now_(), rowId, cand, stage, me.name, verdict, memo, prevStatus, newStatus];
  try { logSheet_().appendRow(row); return; } catch (e) {}
  // 폴백: 관리 시트 셀 한계로 append 실패 → 별도 로그 파일로 롤오버(그 파일도 차면 다음 번호). 로그 유실 방지.
  for (var k = 0; k < 3; k++) { try { overflowLogSheet_(k > 0).appendRow(row); return; } catch (e2) {} }
}
function overflowLogSheet_(roll) {
  var props = PropertiesService.getScriptProperties(), n = parseInt(props.getProperty('overflow_log_n') || '1', 10);
  if (roll) { n++; props.setProperty('overflow_log_n', String(n)); }
  var key = 'overflow_log_id_' + n, id = props.getProperty(key), lss = null;
  if (id) { try { lss = SpreadsheetApp.openById(id); } catch (e) { lss = null; } }
  if (!lss) {
    lss = SpreadsheetApp.create('KNO_변경로그_오버플로_' + n);
    try { var f = DriveApp.getFileById(lss.getId()); folder_([DRIVE_ROOT]).addFile(f); DriveApp.getRootFolder().removeFile(f); } catch (e) {}
    var s0 = lss.getSheets()[0]; s0.setName(SHEET_LOG); s0.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]); styleHeader_(s0, LOG_HEADERS.length);
    props.setProperty(key, lss.getId());
  }
  return lss.getSheets()[0];
}
function failLogSheet_() {
  var sh = ss_().getSheetByName(SHEET_FAILLOG);
  if (!sh) { sh = ss_().insertSheet(SHEET_FAILLOG); sh.getRange(1, 1, 1, FAILLOG_HEADERS.length).setValues([FAILLOG_HEADERS]); styleHeader_(sh, FAILLOG_HEADERS.length); }
  return sh;
}
// 클라이언트가 저장 후 행을 다시 읽어 '확정 미저장'으로 판정하면 호출 → 실패 로그 1행.
function logClientFail(token, info) {
  var name = '(미확인)';
  try { var who = whoByToken_(token); if (who.known) name = who.name || who.email; } catch (e) {}
  try { info = info || {};
    failLogSheet_().appendRow([now_(), name, (SAVE_FNS[info.fn] || info.fn || '') + '(클라)', String(info.row_id || ''),
      String(info.verdict || ''), String(info.memo || ''), String(info.reason || '클라이언트 확정 미저장'), token ? String(token).slice(0, 6) + '…' : '']);
  } catch (e) {}
  return { ok: true };
}

// ── CSV 헬퍼(exportProject 백업 다운로드용) ────────────
function toCsv_(rows) { return rows.map(function (r) { return r.map(csvCell_).join(','); }).join('\r\n'); }
function csvCell_(v) { v = String(v == null ? '' : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

// ── 연구원 명단(관리자) ────────────────────────────────
function getResearchers(token) {
  assertManager_(me_(token));
  var sh = sheet_(SHEET_USERS), n = sh.getLastRow() - 1; if (n <= 0) return [];
  var lc = sh.getLastColumn(), data = sh.getRange(2, 1, n, lc).getValues(), url = getAppUrl_(), out = [];
  for (var i = 0; i < data.length; i++) {
    var tok = String(data[i][6] || '').trim(), email = String(data[i][0]).trim();
    out.push({ email: email, name: String(data[i][1]).trim(), role: String(data[i][2]).trim(),
      '소속': lc > 10 ? String(data[i][10] || '').trim() : '', '성별': lc > 11 ? String(data[i][11] || '').trim() : '',
      token: tok, link: personalLink_(url, tok, email), id: String(data[i][8] || '').trim() });
  }
  return out;
}
// 목록으로 시트 재작성. 계정정보(token/링크/아이디/비번)는 이메일 기준 보존.
function saveResearchers(token, list) {
  assertManager_(me_(token));
  list = list || [];
  var sh = sheet_(SHEET_USERS), prev = {}, n = sh.getLastRow() - 1;
  if (n > 0) { var lc = sh.getLastColumn(), old = sh.getRange(2, 1, n, lc).getValues();
    for (var i = 0; i < old.length; i++) { var em = String(old[i][0]).trim().toLowerCase();
      if (em) prev[em] = { token: old[i][6] || '', link: old[i][7] || '', id: old[i][8] || '', pw: old[i][9] || '' }; } }
  var rows = [];
  list.forEach(function (r) { var em = String(r.email || '').trim(), pv = prev[em.toLowerCase()] || {};
    rows.push([em, String(r.name || '').trim(), String(r.role || '').trim(), '', '', '', pv.token || '', pv.link || '', pv.id || '', pv.pw || '', String(r['소속'] || '').trim(), String(r['성별'] || '').trim()]); });
  sh.clearContents();
  sh.getRange(1, 1, 1, USER_HDR.length).setValues([USER_HDR]);
  if (rows.length) sh.getRange(2, 1, rows.length, USER_HDR.length).setValues(rows);
  styleHeader_(sh, USER_HDR.length);
  cacheDel_('presence:roster');
  return { ok: true, count: rows.length };
}
// ── 편집기 전용: 연구원 명단 15명 고정 시드 ────────────
// 편집기에서 setupInit 실행 → 연구원 시트를 이 명단으로 세팅.
// 기존 계정정보(token/링크/아이디/비번)는 이메일 기준 보존하므로 재실행해도 안전.
var SEED_ROSTER = [
  { email: 'nki@yonsei.ac.kr', name: '남길임', role: '검수자', '소속': '연세대학교', '성별': '여성' },
  { email: 'camus0101@gmail.com', name: '송현주', role: '검수자', '소속': '경북대학교', '성별': '여성' },
  { email: 'cjuni2000@gmail.com', name: '최준', role: '검수자', '소속': '전남대학교', '성별': '남성' },
  { email: 'fbih02@gmail.com', name: '현영희', role: '검수자', '소속': '경북대학교', '성별': '여성' },
  { email: 'sjmano27@gmail.com', name: '이수진', role: '검수자', '소속': '경북대학교', '성별': '여성' },
  { email: 'bmg0128@gmail.com', name: '백미경', role: '검수자', '소속': '경북대학교', '성별': '여성' },
  { email: 'chunghaeyun1006@gmail.com', name: '정해윤', role: '검수자', '소속': '연세대학교', '성별': '여성' },
  { email: 'leejun0624@gmail.com', name: '이준', role: '작업자', '소속': '연세대학교', '성별': '남성' },
  { email: 'a01082406803@gmail.com', name: '김유정', role: '작업자', '소속': '전남대학교', '성별': '여성' },
  { email: 'saenu@yonsei.ac.kr', name: '김선우', role: '작업자', '소속': '연세대학교', '성별': '여성' },
  { email: 'goyelin08@gmail.com', name: '고예린', role: '작업자', '소속': '전남대학교', '성별': '여성' },
  { email: 'qhal7041@gmail.com', name: '김보미', role: '작업자', '소속': '전남대학교', '성별': '여성' },
  { email: 'sul010907@gmail.com', name: '남궁설', role: '작업자', '소속': '연세대학교', '성별': '여성' },
  { email: 'siveking@gmail.com', name: '안진산', role: '검수자', '소속': '경북대학교', '성별': '남성' },
  { email: 'koreanneology@gmail.com', name: '관리자', role: '관리자', '소속': '경북대학교', '성별': '남성' }
];
function setupInit() {
  var sh = ss_().getSheetByName(SHEET_USERS) || ss_().insertSheet(SHEET_USERS);
  var prev = {}, n = sh.getLastRow() - 1;
  if (n > 0) { var lc = sh.getLastColumn(), old = sh.getRange(2, 1, n, lc).getValues();
    for (var i = 0; i < old.length; i++) { var em = String(old[i][0]).trim().toLowerCase();
      if (em) prev[em] = { token: old[i][6] || '', link: old[i][7] || '', id: old[i][8] || '', pw: old[i][9] || '' }; } }
  var url = getAppUrl_(), rows = SEED_ROSTER.map(function (r) {
    var pv = prev[r.email.toLowerCase()] || {};
    var token = pv.token || Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    var link = pv.link || personalLink_(url, token, r.email);
    return [r.email, r.name, r.role, '', '', '', token, link, pv.id || '', pv.pw || '', r['소속'], r['성별']];
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, USER_HDR.length).setValues([USER_HDR]);
  sh.getRange(2, 1, rows.length, USER_HDR.length).setValues(rows);
  styleHeader_(sh, USER_HDR.length);
  cacheDel_('presence:roster');
  SpreadsheetApp.flush();
  for (var j = 0; j < rows.length; j++) Logger.log(rows[j][1] + ' (' + rows[j][2] + '): ' + rows[j][7]);
  return SEED_ROSTER.length + '명 시드 완료. 위 로그에서 각자 개인 링크 확인(관리자=koreanneology).';
}
