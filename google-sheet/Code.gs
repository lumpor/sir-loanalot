// Google Sheet backend for Horny Mafia and King of Baboy (and the read-only status app).
//
// Setup: in the Google Sheet choose Extensions → Apps Script, paste this file, fill in
// USERS and VIEWER_KEY below, then Deploy → New deployment → Web app
// (Execute as: Me, Who has access: Anyone) and copy the /exec URL.
//
// Adding a friend later: add a line to USERS, then Deploy → Manage deployments → edit (pencil)
// → Version: New version → Deploy. The URL stays the same.
//
// Every user gets their own tabs ("Baboy Juan entries", "HM Pedro loans", ...), so nobody's
// data is mixed. The last column, _json, is the full record the apps read back; the other
// columns are only there for reading.

const USERS = [
  // { app: 'horny-mafia', name: 'Pedro', key: 'his password' },
  // { app: 'king-of-baboy', name: 'Juan', key: 'another password' },
];
// Bohol Watch Tower uses this password. It can only read, never write.
const VIEWER_KEY = 'PUT-SECRET-CODE-HERE';
const PREFIX = { 'horny-mafia': 'HM', 'king-of-baboy': 'Baboy' };

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'bad request' }); }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (req.action === 'pullAll') {
      if (String(req.key || '').trim().toLowerCase() !== VIEWER_KEY.trim().toLowerCase() || VIEWER_KEY === 'PUT-SECRET-CODE-HERE') return reply({ ok: false, error: 'wrong secret code' });
      return reply({ ok: true, users: USERS.map(u => ({ app: u.app, name: u.name, data: pull(tabPrefix(u)) })) });
    }
    // Passwords are not case sensitive, and spaces around them are ignored.
    const given = String(req.key || '').trim().toLowerCase();
    const user = USERS.find(u => u.key.trim().toLowerCase() === given && u.app === req.app);
    if (!user) return reply({ ok: false, error: 'wrong secret code' });
    if (req.action === 'push') { push(tabPrefix(user), req.ops || []); return reply({ ok: true, user: user.name }); }
    if (req.action === 'pull') return reply({ ok: true, user: user.name, data: pull(tabPrefix(user)) });
    return reply({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

const tabPrefix = user => PREFIX[user.app] + ' ' + user.name + ' ';

// Records in a tab, read from the _json column.
function readRecords(sheet) {
  const values = sheet.getDataRange().getValues();
  const col = values[0].indexOf('_json');
  if (col < 0) return [];
  return values.slice(1).filter(r => r[col]).map(r => JSON.parse(r[col]));
}

function push(prefix, ops) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const byStore = {};
  ops.forEach(op => { (byStore[op.store] = byStore[op.store] || []).push(op); });
  Object.keys(byStore).forEach(storeName => {
    const sheet = ss.getSheetByName(prefix + storeName) || ss.insertSheet(prefix + storeName);
    const records = new Map(readRecords(sheet).map(r => [r.id, r]));
    byStore[storeName].forEach(op => {
      if (op.op === 'delete') records.delete(op.id);
      else records.set(op.id, op.data);
    });
    writeRecords(sheet, [...records.values()]);
  });
}

function writeRecords(sheet, records) {
  const when = r => String(r.date || r.startDate || r.month || '');
  records.sort((a, b) => when(a).localeCompare(when(b)) || (a.createdAt || 0) - (b.createdAt || 0));
  const cols = [];
  records.forEach(r => Object.keys(r).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
  cols.push('_json');
  const cell = v => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v);
  const rows = [cols].concat(records.map(r => cols.map(c => (c === '_json' ? JSON.stringify(r) : cell(r[c])))));
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, cols.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, cols.length).setFontWeight('bold');
}

function pull(prefix) {
  const data = {};
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(sheet => {
    const name = sheet.getName();
    if (name.indexOf(prefix) === 0) data[name.slice(prefix.length)] = readRecords(sheet);
  });
  return data;
}
