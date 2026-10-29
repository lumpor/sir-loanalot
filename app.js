'use strict';
const VERSION = '1.0.0';
const BACKUP_EVERY_DAYS = 30; // remind about backups after this many days

/* ---------- small helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const round2 = n => Math.round(n * 100) / 100;
const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const sum = (arr, f = x => x) => arr.reduce((s, x) => s + f(x), 0);
const peso = n => {
  n = round2(n || 0);
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
};

/* ---------- dates (all stored as local 'YYYY-MM-DD' strings) ---------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
const today = () => iso(new Date());
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return iso(d); };
const dayOfWeek = s => parseDate(s).getDay(); // 0 = Sunday
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const monthOf = s => s.slice(0, 7);
const thisMonth = () => monthOf(today());
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const daysInMonth = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
const fmtDate = s => {
  if (!s) return '—';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (s.slice(0, 4) !== today().slice(0, 4)) opts.year = 'numeric';
  return parseDate(s).toLocaleDateString('en-PH', opts);
};
const fmtMonth = m => parseDate(m + '-01').toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });

/* ---------- database (IndexedDB, everything except photos is kept in memory) ---------- */
const STORES = ['borrowers', 'loans', 'payments', 'photos', 'tenants', 'rent', 'meta'];
const S = { borrowers: new Map(), loans: new Map(), payments: new Map(), tenants: new Map(), rent: new Map() };
let db;
let meta = { id: 'meta', email: '', lastBackup: null, hideInstall: false };

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sirloanalot', 1);
    r.onupgradeneeded = () => {
      for (const s of STORES) {
        const os = r.result.createObjectStore(s, { keyPath: 'id' });
        if (s === 'photos') os.createIndex('loanId', 'loanId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function loadAll() {
  for (const k of Object.keys(S)) S[k] = new Map((await req(store(k).getAll())).map(o => [o.id, o]));
  const m = await req(store('meta').get('meta'));
  if (m) meta = { ...meta, ...m };
}
async function put(name, obj) {
  if (S[name]) S[name].set(obj.id, obj);
  await req(store(name, 'readwrite').put(obj));
}
async function del(name, id) {
  if (S[name]) S[name].delete(id);
  await req(store(name, 'readwrite').delete(id));
}
const saveMeta = () => req(store('meta', 'readwrite').put(meta));

/* ---------- loan maths ---------- */
const TYPE = { term: 'Fixed term', interest: 'Interest only' };
const FREQ = { daily: 'Daily (Mon–Sat)', weekly: 'Weekly' };
const bName = l => S.borrowers.get(l.borrowerId)?.name || '?';
const loansOf = bid => [...S.loans.values()].filter(l => l.borrowerId === bid).sort((a, b) => b.startDate.localeCompare(a.startDate));
const loanPayments = id => [...S.payments.values()].filter(p => p.loanId === id).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

function nextCollectionDay(start, freq) {
  if (freq === 'weekly') return addDays(start, 7);
  let d = addDays(start, 1);
  if (dayOfWeek(d) === 0) d = addDays(d, 1);
  return d;
}

// Number of collection days from the first collection up to and including `upto`
// (capped at the last repay date for fixed-term loans). Daily loans skip Sundays.
function countDue(l, upto) {
  let end = upto;
  if (l.type === 'term' && l.endDate < end) end = l.endDate;
  if (!l.firstDue || end < l.firstDue) return 0;
  const days = daysBetween(l.firstDue, end) + 1;
  if (l.frequency === 'weekly') return Math.floor((days - 1) / 7) + 1;
  let c = Math.floor(days / 7) * 6;
  const dw = dayOfWeek(l.firstDue);
  for (let i = 0; i < days % 7; i++) if ((dw + i) % 7 !== 0) c++;
  return c;
}

// Date of the n-th collection (1 = first), skipping Sundays for daily loans.
function nthCollectionDay(firstDue, freq, n) {
  if (freq === 'weekly') return addDays(firstDue, 7 * (n - 1));
  let d = firstDue;
  if (dayOfWeek(d) === 0) d = addDays(d, 1);
  for (let i = 1; i < n; i++) { d = addDays(d, 1); if (dayOfWeek(d) === 0) d = addDays(d, 1); }
  return d;
}

// Fixed-term plan from either a last repay date or an amount per payment.
// Payments are whole ₱100s, so a date-based plan rounds the payment up and may finish a bit earlier.
function planTerm({ total, frequency, firstDue, mode, endDate, installment }) {
  if (!(total > 0) || !firstDue) return null;
  let inst = installment;
  if (mode === 'date') {
    if (!endDate || endDate < firstDue) return null;
    const n = countDue({ type: 'term', frequency, firstDue, endDate }, endDate);
    inst = Math.ceil(total / n / 100) * 100;
  }
  if (!(inst > 0)) return null;
  const n = Math.ceil(total / inst);
  return { installment: inst, n, endDate: nthCollectionDay(firstDue, frequency, n), last: total - inst * (n - 1) };
}
const installment = l => l.installment || 0;

const isRegular = p => p.kind !== 'principal';
function interestOf(p, l) {
  if (!l || !isRegular(p)) return 0;
  if (l.type === 'term') return l.total > 0 ? p.amount * (l.total - l.principal) / l.total : 0;
  return p.amount;
}

function loanStats(l) {
  const pays = loanPayments(l.id);
  const inst = installment(l);
  const paidRegular = round2(sum(pays.filter(isRegular), p => p.amount));
  const paidPrincipal = round2(sum(pays.filter(p => !isRegular(p)), p => p.amount));
  const yesterday = addDays(today(), -1);
  let expected = inst * countDue(l, yesterday);
  if (l.type === 'term') expected = yesterday >= l.endDate ? l.total : Math.min(expected, l.total);
  const behind = l.closed ? 0 : Math.max(0, round2(expected - paidRegular));
  const remaining = l.type === 'term'
    ? Math.max(0, round2(l.total - paidRegular))
    : Math.max(0, round2(l.principal - paidPrincipal));
  return {
    pays, inst, paidRegular, paidPrincipal, behind, remaining,
    missed: inst > 0 ? Math.ceil(behind / inst - 0.001) : 0,
    lastPayment: pays.length ? pays[pays.length - 1].date : null,
    interestEarned: round2(sum(pays, p => interestOf(p, l))),
    // principal still out on the street
    principalOut: l.type === 'term' ? (l.total > 0 ? remaining * l.principal / l.total : 0) : remaining,
  };
}

// What should be collected from loan `l` on day `d` (null if nothing is due that day).
function dueEntry(l, d) {
  const paidToday = loanPayments(l.id).filter(p => p.date === d);
  const st = loanStats(l);
  if (paidToday.length) return { loan: l, st, amount: sum(paidToday, p => p.amount), paid: sum(paidToday, p => p.amount) };
  if (l.closed || d < l.firstDue) return null;
  if (l.frequency === 'weekly' ? daysBetween(l.firstDue, d) % 7 !== 0 : dayOfWeek(d) === 0) return null;
  let amount = st.inst;
  if (l.type === 'term') {
    if (st.remaining <= 0) return null;
    amount = d >= l.endDate ? st.remaining : Math.min(st.inst, st.remaining);
  }
  return { loan: l, st, amount, paid: 0 };
}

// Close loans automatically once fully paid (and reopen if that payment is removed again).
async function refreshStatus(l) {
  l = S.loans.get(l.id);
  if (!l) return;
  const st = loanStats(l);
  const done = st.remaining <= 0 && (l.type === 'term' || st.paidPrincipal > 0);
  if (done && !l.closed) {
    await put('loans', { ...l, closed: true, autoClosed: true, closedOn: today() });
    toast(`${bName(l)}'s loan is fully paid ✓`);
  } else if (!done && l.closed && l.autoClosed) {
    await put('loans', { ...l, closed: false, autoClosed: false, closedOn: null });
  }
}

/* ---------- UI plumbing ---------- */
const view = $('#view');
const UI = { lastHash: null, after: null, urls: [], backHref: null, installEvt: null, prepared: null };

function setHeader(title, back) {
  $('#title').textContent = title;
  UI.backHref = back || null;
  $('#back').hidden = !back;
}
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
function openSheet(html) {
  const s = $('#sheet');
  s.innerHTML = `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet-card">${html}</div>`;
  s.hidden = false;
}
function closeSheet() { const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; }
const go = hash => { location.hash = hash; };
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const PAGES = {
  collect: a => pageCollect(a[0] || today()),
  loans: () => pageLoans(),
  borrower: a => pageBorrower(a[0]),
  loan: a => pageLoan(a[0]),
  'loan-new': a => pageLoanForm(null, a[0]),
  'loan-edit': a => pageLoanForm(a[0]),
  stats: a => pageStats(a[0] || thisMonth()),
  boarders: a => pageBoarders(a[0] || thisMonth()),
  settings: () => pageSettings(),
};
const TAB_OF = { borrower: 'loans', loan: 'loans', 'loan-new': 'loans', 'loan-edit': 'loans' };

function render() {
  const hash = location.hash.slice(1) || 'collect';
  const [name, ...args] = hash.split('/').map(decodeURIComponent);
  const page = PAGES[name] ? name : 'collect';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (TAB_OF[page] || page)));
  UI.urls.forEach(u => URL.revokeObjectURL(u)); UI.urls = [];
  UI.after = null;
  view.innerHTML = PAGES[page](args);
  if (UI.lastHash !== hash) { window.scrollTo(0, 0); UI.lastHash = hash; }
  if (UI.after) UI.after();
}
const notFound = () => { setHeader('Not found', '#collect'); return `<div class="card">This item no longer exists.</div>`; };

/* ---------- page: collect ---------- */
function backupBanner() {
  const hasData = S.loans.size || S.tenants.size;
  if (!hasData) return '';
  const age = meta.lastBackup ? daysBetween(meta.lastBackup.slice(0, 10), today()) : null;
  if (age !== null && age < BACKUP_EVERY_DAYS) return '';
  return `<div class="card alert"><b>⚠ ${age === null ? 'No backup made yet' : `Last backup was ${age} days ago`}</b>
    <p>If this phone is lost or reset, all records are gone. Please send a backup.</p>
    <a class="btn block" href="#settings">Back up now</a></div>`;
}
function installTip() {
  if (isStandalone() || meta.hideInstall) return '';
  return `<div class="card tip"><b>Add this app to your home screen</b>
    <p>${isIOS() ? 'In Safari tap the Share button, then “Add to Home Screen”.' : 'In Chrome tap the ⋮ menu, then “Install app” or “Add to Home screen”.'}
    Then always open it from the home screen icon.</p>
    <div class="btns">${UI.installEvt ? '<button class="btn" data-act="install">Install now</button>' : ''}
    <button class="btn ghost" data-act="hideInstall">OK, got it</button></div></div>`;
}

function pageCollect(d) {
  setHeader('Collect');
  const entries = [...S.loans.values()].map(l => dueEntry(l, d)).filter(Boolean)
    .sort((a, b) => bName(a.loan).localeCompare(bName(b.loan)));
  const expected = sum(entries, e => e.paid || e.amount);
  const collected = sum(entries, e => e.paid);
  const nPaid = entries.filter(e => e.paid).length;
  const isToday = d === today();
  const rows = entries.map(e => {
    const l = e.loan;
    const info = [l.frequency === 'weekly' ? 'Weekly' : 'Daily', TYPE[l.type]];
    if (e.st.behind > 0) info.push(`<span class="bad">behind ${peso(e.st.behind)}</span>`);
    if (l.type === 'term' && !l.closed && d >= l.endDate) info.push('<span class="bad">last day passed</span>');
    const right = e.paid
      ? `<button class="btn small paidbtn" data-act="unpay" data-loan="${l.id}" data-date="${d}">✓ ${peso(e.paid)}</button>`
      : `<button class="btn small ghost" data-act="payOther" data-loan="${l.id}" data-date="${d}" data-amount="${e.amount}">Other</button>
         <button class="btn small" data-act="pay" data-loan="${l.id}" data-date="${d}" data-amount="${e.amount}">Paid ${peso(e.amount)}</button>`;
    return `<div class="item ${e.paid ? 'paid' : ''}">
      <a class="item-main" href="#loan/${l.id}"><b>${esc(bName(l))}</b><small>${info.join(' · ')}</small></a>${right}</div>`;
  }).join('');
  return `${installTip()}${backupBanner()}
    <div class="datenav">
      <a class="btn ghost" href="#collect/${addDays(d, -1)}" aria-label="Previous day">‹</a>
      <input type="date" value="${d}" data-change="collectDate" aria-label="Collection date">
      <a class="btn ghost" href="#collect/${addDays(d, 1)}" aria-label="Next day">›</a>
    </div>
    <div class="card">
      <small>${isToday ? 'Today' : fmtDate(d)} · ${nPaid} of ${entries.length} paid</small>
      <div class="big">${peso(collected)} <small>of ${peso(expected)}</small></div>
      <div class="bar"><i style="width:${expected ? Math.min(100, collected / expected * 100) : 0}%"></i></div>
      ${isToday ? '' : '<p><a href="#collect">← Back to today</a></p>'}
    </div>
    ${entries.length ? `<div class="list">${rows}</div>`
      : `<div class="list"><div class="empty">${dayOfWeek(d) === 0 ? 'Sunday — no daily collections.' : 'Nothing to collect on this day.'}</div></div>`}
    <a class="btn ghost block" href="#loan-new">+ New loan</a>`;
}

/* ---------- page: loans / borrowers ---------- */
function pageLoans() {
  setHeader('Loans');
  const rows = [...S.borrowers.values()].map(b => {
    const active = loansOf(b.id).filter(l => !l.closed);
    const stats = active.map(loanStats);
    return { b, active, remaining: sum(stats, s => s.remaining), behind: sum(stats, s => s.behind) };
  }).sort((x, y) => (y.active.length > 0) - (x.active.length > 0) || x.b.name.localeCompare(y.b.name));
  const list = rows.map(r => `<div class="item" data-name="${esc(r.b.name.toLowerCase())}">
      <a class="item-main" href="#borrower/${r.b.id}"><b>${esc(r.b.name)}</b>
      <small>${r.active.length ? `${r.active.length} active loan${r.active.length > 1 ? 's' : ''} · ${peso(r.remaining)} to collect` : 'No active loans'}</small></a>
      ${r.behind > 0 ? `<span class="badge bad">behind ${peso(r.behind)}</span>` : ''}</div>`).join('');
  return `<div class="btns"><a class="btn" href="#loan-new">+ New loan</a><button class="btn ghost" data-act="newBorrower">+ New borrower</button></div>
    ${rows.length > 6 ? '<input type="search" placeholder="Search name…" data-input="filterNames" style="margin-bottom:12px">' : ''}
    <div class="list" id="names">${list || '<div class="empty">No borrowers yet. Tap “New loan” to start.</div>'}</div>`;
}

function loanLine(l) {
  const st = loanStats(l);
  const status = l.closed ? '<span class="badge grey">Closed</span>'
    : st.behind > 0 ? `<span class="badge bad">${st.missed} missed</span>` : '<span class="badge">OK</span>';
  return `<div class="item"><a class="item-main" href="#loan/${l.id}">
    <b>${peso(l.principal)} · ${TYPE[l.type]}</b>
    <small>${fmtDate(l.startDate)} · ${l.frequency === 'weekly' ? 'weekly' : 'daily'} ${peso(st.inst)}${l.closed ? '' : ` · ${peso(st.remaining)} left`}</small></a>${status}</div>`;
}

function pageBorrower(id) {
  const b = S.borrowers.get(id);
  if (!b) return notFound();
  setHeader(b.name, '#loans');
  const loans = loansOf(id);
  const active = loans.filter(l => !l.closed), closed = loans.filter(l => l.closed);
  return `<div class="btns"><a class="btn" href="#loan-new/${id}">+ New loan for ${esc(b.name)}</a></div>
    <h2>Active loans</h2>
    <div class="list">${active.map(loanLine).join('') || '<div class="empty">No active loans</div>'}</div>
    ${closed.length ? `<h2>Closed loans</h2><div class="list">${closed.map(loanLine).join('')}</div>` : ''}
    <div class="btns"><button class="btn ghost" data-act="renameBorrower" data-id="${id}">Rename</button>
    <button class="btn danger" data-act="deleteBorrower" data-id="${id}">Delete</button></div>`;
}

/* ---------- page: loan detail ---------- */
function pageLoan(id) {
  const l = S.loans.get(id);
  if (!l) return notFound();
  setHeader(bName(l), `#borrower/${l.borrowerId}`);
  const st = loanStats(l);
  const per = l.frequency === 'weekly' ? 'week' : 'day (Mon–Sat)';
  const facts = [
    ['Type', TYPE[l.type]],
    ['Amount lent', peso(l.principal)],
    l.type === 'term' ? ['To pay back', `${peso(l.total)}<br><small>interest ${peso(l.total - l.principal)}</small>`] : ['Interest', `${peso(st.inst)} per ${per}`],
    l.type === 'term' ? ['Payment', `${peso(st.inst)} per ${per}`] : null,
    ['Loan date', fmtDate(l.startDate)],
    ['First collection', fmtDate(l.firstDue)],
    l.type === 'term' ? ['Last repay date', fmtDate(l.endDate)] : null,
    ['Paid so far', peso(st.paidRegular + st.paidPrincipal)],
    [l.type === 'term' ? 'Still to pay' : 'Principal owed', peso(st.remaining)],
    ['Status', l.closed ? `Closed ${fmtDate(l.closedOn)}` : st.behind > 0 ? `<span class="bad">Behind ${peso(st.behind)} (${st.missed} missed)</span>` : '<span class="ok">Up to date</span>'],
    ['Last payment', st.lastPayment ? fmtDate(st.lastPayment) : 'None yet'],
    ['Interest earned', peso(st.interestEarned)],
  ].filter(Boolean);
  const pays = [...st.pays].reverse();
  const payRow = p => `<div class="item"><div class="item-main"><b>${peso(p.amount)}</b>
    <small>${fmtDate(p.date)}${p.kind === 'principal' ? ' · loan paid back' : ''}</small></div>
    <button class="btn small danger" data-act="deletePayment" data-id="${p.id}" aria-label="Delete payment">✕</button></div>`;
  UI.after = () => loadPhotos(l.id);
  return `<div class="card">
      ${l.type === 'term' ? `<small>${peso(st.paidRegular)} of ${peso(l.total)} paid</small>
        <div class="bar"><i style="width:${Math.min(100, st.paidRegular / l.total * 100)}%"></i></div><br>` : ''}
      <div class="facts">${facts.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    </div>
    <div class="btns">
      <button class="btn" data-act="recordPayment" data-loan="${l.id}">Record payment</button>
      ${l.type === 'interest' && !l.closed ? `<button class="btn ghost" data-act="principalBack" data-loan="${l.id}">Principal paid back</button>` : ''}
    </div>
    <h2>Notes</h2>
    <div class="card">${l.notes ? esc(l.notes).replace(/\n/g, '<br>') : '<span class="muted">No notes</span>'}
      <button class="btn small ghost block" data-act="editNotes" data-loan="${l.id}">${l.notes ? 'Edit notes' : 'Add note'}</button></div>
    <h2>Contract photos</h2>
    <div class="card"><div class="photos" id="photos"><small>Loading…</small></div>
      <div class="btns">
        <label class="btn ghost">📷 Take photo<input type="file" accept="image/*" capture="environment" data-change="photo" data-loan="${l.id}" hidden></label>
        <label class="btn ghost">From gallery<input type="file" accept="image/*" data-change="photo" data-loan="${l.id}" hidden></label>
      </div></div>
    <h2>Payments (${pays.length})</h2>
    <div class="list">${pays.slice(0, 15).map(payRow).join('') || '<div class="empty">No payments yet</div>'}</div>
    ${pays.length > 15 ? `<details><summary>Show all ${pays.length} payments</summary><div class="list">${pays.slice(15).map(payRow).join('')}</div></details>` : ''}
    <div class="btns">
      <a class="btn ghost" href="#loan-edit/${l.id}">Edit loan</a>
      <button class="btn ghost" data-act="toggleClosed" data-loan="${l.id}">${l.closed ? 'Reopen loan' : 'Close loan'}</button>
      <button class="btn danger" data-act="deleteLoan" data-loan="${l.id}">Delete loan</button>
    </div>`;
}

/* ---------- page: new / edit loan ---------- */
function pageLoanForm(id, borrowerId) {
  const l = id ? S.loans.get(id) : null;
  if (id && !l) return notFound();
  setHeader(l ? 'Edit loan' : 'New loan', l ? `#loan/${id}` : borrowerId ? `#borrower/${borrowerId}` : '#loans');
  const t = today();
  const v = l || { type: 'term', frequency: 'daily', startDate: t, firstDue: nextCollectionDay(t, 'daily'), borrowerId: borrowerId || '' };
  const borrowers = [...S.borrowers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const sel = v.borrowerId || (borrowers.length ? '' : '__new');
  UI.after = () => updateLoanCalc($('form[data-form=loan]'));
  return `<form class="card" data-form="loan" data-type="${v.type}" data-mode="${v.mode === 'amount' ? 'amount' : 'date'}" data-id="${l ? l.id : ''}" data-new="${l ? '' : '1'}">
    <label class="field"><span>Borrower</span>
      <select name="borrower" required data-change="borrowerSelect">
        <option value="" ${sel === '' ? 'selected' : ''} disabled>Choose…</option>
        ${borrowers.map(b => `<option value="${b.id}" ${b.id === sel ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        <option value="__new" ${sel === '__new' ? 'selected' : ''}>＋ New borrower…</option>
      </select></label>
    <label class="field" id="newNameField" ${sel === '__new' ? '' : 'hidden'}><span>New borrower's name</span>
      <input name="newName" autocomplete="off"></label>
    <div class="seg">
      <label><input type="radio" name="type" value="term" ${v.type === 'term' ? 'checked' : ''}><span>Fixed term</span></label>
      <label><input type="radio" name="type" value="interest" ${v.type === 'interest' ? 'checked' : ''}><span>Interest only</span></label>
    </div>
    <label class="field"><span>Amount lent (₱)</span>
      <input name="principal" type="number" inputmode="numeric" min="100" step="100" required value="${v.principal ?? ''}"></label>
    <label class="field f-term"><span>Total to be paid back (₱)</span>
      <input name="total" type="number" inputmode="numeric" min="100" step="100" value="${v.total || ''}">
      <small>Amount lent + interest</small></label>
    <span class="field" style="display:block"><b style="font-size:14px">Payments</b></span>
    <div class="seg">
      <label><input type="radio" name="frequency" value="daily" ${v.frequency === 'daily' ? 'checked' : ''}><span>Daily (Mon–Sat)</span></label>
      <label><input type="radio" name="frequency" value="weekly" ${v.frequency === 'weekly' ? 'checked' : ''}><span>Weekly</span></label>
    </div>
    <label class="field f-int"><span>Interest per <span class="per">week</span> (₱)</span>
      <input name="interest" type="number" inputmode="numeric" min="100" step="100" value="${v.type === 'interest' && v.installment ? v.installment : ''}"></label>
    <div class="row2">
      <label class="field"><span>Loan date</span><input name="startDate" type="date" required value="${v.startDate}"></label>
      <label class="field"><span>First collection</span><input name="firstDue" type="date" required value="${v.firstDue}"></label>
    </div>
    <div class="seg f-term">
      <label><input type="radio" name="mode" value="date" ${v.mode !== 'amount' ? 'checked' : ''}><span>Set last date</span></label>
      <label><input type="radio" name="mode" value="amount" ${v.mode === 'amount' ? 'checked' : ''}><span>Set amount</span></label>
    </div>
    <label class="field f-term m-date"><span>Last repay date</span><input name="endDate" type="date" value="${v.type === 'term' ? v.endDate || '' : ''}"></label>
    <label class="field f-term m-amt"><span>Amount per <span class="per">day</span> (₱)</span>
      <input name="installment" type="number" inputmode="numeric" min="100" step="100" value="${v.type === 'term' && v.installment ? v.installment : ''}"></label>
    <div class="calc" id="loanCalc"></div>
    <label class="field"><span>Notes</span><textarea name="notes">${esc(v.notes || '')}</textarea></label>
    <button class="btn block" type="submit">${l ? 'Save changes' : 'Save loan'}</button>
  </form>`;
}

function readLoanForm(f) {
  const fd = new FormData(f);
  return {
    type: fd.get('type'), frequency: fd.get('frequency'), mode: fd.get('mode'),
    principal: num(fd.get('principal')), total: num(fd.get('total')), interest: num(fd.get('interest')),
    startDate: fd.get('startDate'), firstDue: fd.get('firstDue'), endDate: fd.get('endDate') || null,
    installment: num(fd.get('installment')), notes: (fd.get('notes') || '').trim(),
  };
}
const isHundreds = n => n > 0 && n % 100 === 0;

function updateLoanCalc(f) {
  if (!f) return;
  const v = readLoanForm(f);
  f.dataset.type = v.type;
  f.dataset.mode = v.mode;
  const per = v.frequency === 'weekly' ? 'week' : 'day';
  f.querySelectorAll('.per').forEach(el => { el.textContent = per; });
  let text;
  if (v.type === 'term') {
    const plan = planTerm(v);
    if (!(v.principal > 0 && v.total > 0)) text = 'Enter amount lent and total to pay back.';
    else if (!plan) text = v.mode === 'date' ? 'Enter the last repay date.' : `Enter the amount per ${per}.`;
    else {
      // fill in the other field so he can see the result of either choice
      if (v.mode === 'date') f.installment.value = plan.installment; else f.endDate.value = plan.endDate;
      text = `Interest: <b>${peso(v.total - v.principal)}</b><br>
        <b>${peso(plan.installment)} per ${per}${v.frequency === 'daily' ? ' (Mon–Sat)' : ''}</b>, ${plan.n} payment${plan.n === 1 ? '' : 's'}
        ${plan.last !== plan.installment ? ` (last one ${peso(plan.last)})` : ''}<br>
        Last payment: <b>${fmtDate(plan.endDate)}</b>`;
    }
  } else if (v.principal > 0 && v.interest > 0) {
    const perMonth = v.frequency === 'weekly' ? v.interest * 52 / 12 : v.interest * 313 / 12;
    text = `About <b>${peso(Math.round(perMonth))}</b> interest per month.<br>The ${peso(v.principal)} is paid back separately.`;
  } else text = `Enter amount lent and interest per ${per}.`;
  $('#loanCalc').innerHTML = text;
}

/* ---------- page: stats ---------- */
function pageStats(month) {
  setHeader('Stats');
  const byDay = new Map(), byMonth = new Map();
  const add = (map, k, c, i) => { const o = map.get(k) || { c: 0, i: 0 }; o.c += c; o.i += i; map.set(k, o); };
  for (const p of S.payments.values()) {
    const i = interestOf(p, S.loans.get(p.loanId));
    add(byDay, p.date, p.amount, i);
    add(byMonth, monthOf(p.date), p.amount, i);
  }
  const t = today(), m = thisMonth();
  const all = [...byMonth.values()];
  const tile = (label, v) => `<div class="tile"><small>${label}</small><b>${peso(v)}</b></div>`;
  const active = [...S.loans.values()].filter(l => !l.closed);
  const st = active.map(loanStats);
  const months = [];
  const first = [...byMonth.keys()].sort()[0] || m;
  for (let k = m; k >= first; k = addMonths(k, -1)) months.push(k);
  const days = [...byDay.keys()].filter(d => monthOf(d) === month).sort().reverse();
  const sel = byMonth.get(month) || { c: 0, i: 0 };
  return `<h2>Interest earned</h2>
    <div class="tiles">${tile('Today', byDay.get(t)?.i)}${tile('This month', byMonth.get(m)?.i)}${tile('All time', sum(all, o => o.i))}</div>
    <h2>Money collected</h2>
    <div class="tiles">${tile('Today', byDay.get(t)?.c)}${tile('This month', byMonth.get(m)?.c)}${tile('All time', sum(all, o => o.c))}</div>
    <h2>Right now</h2>
    <div class="card"><div class="facts">
      <div><small>Active loans</small><b>${active.length}</b></div>
      <div><small>Lent out (principal)</small><b>${peso(sum(st, s => s.principalOut))}</b></div>
      <div><small>Still to collect</small><b>${peso(sum(st, s => s.remaining))}</b><br><small>excl. future interest on interest-only loans</small></div>
      <div><small>Behind on payments</small><b class="${sum(st, s => s.behind) > 0 ? 'bad' : ''}">${peso(sum(st, s => s.behind))}</b></div>
    </div></div>
    <h2>By month</h2>
    <div class="card"><table><tr><th>Month</th><th>Collected</th><th>Interest</th></tr>
      ${months.map(k => { const o = byMonth.get(k) || { c: 0, i: 0 };
        return `<tr class="${k === month ? 'sel' : ''}"><td><a href="#stats/${k}">${fmtMonth(k)}</a></td><td>${peso(o.c)}</td><td>${peso(o.i)}</td></tr>`; }).join('')}
    </table></div>
    <h2>Days in ${fmtMonth(month)}</h2>
    <div class="card"><table><tr><th>Day</th><th>Collected</th><th>Interest</th></tr>
      ${days.map(d => `<tr><td><a href="#collect/${d}">${fmtDate(d)}</a></td><td>${peso(byDay.get(d).c)}</td><td>${peso(byDay.get(d).i)}</td></tr>`).join('')
        || '<tr><td colspan="3" class="muted">No payments this month</td></tr>'}
      ${days.length ? `<tr><td><b>Total</b></td><td><b>${peso(sel.c)}</b></td><td><b>${peso(sel.i)}</b></td></tr>` : ''}
    </table></div>`;
}

/* ---------- page: boarders ---------- */
const rentId = (tid, m) => `${tid}|${m}`;
const tenantInMonth = (t, m) => monthOf(t.startDate) <= m && (!t.endDate || m <= monthOf(t.endDate));
const rentDueDate = (t, m) => `${m}-${pad(Math.min(t.payDay, daysInMonth(m)))}`;

function pageBoarders(month) {
  setHeader('Boarders');
  const t0 = today();
  const tenants = [...S.tenants.values()].sort((a, b) => a.name.localeCompare(b.name));
  const here = tenants.filter(t => tenantInMonth(t, month));
  const rows = here.map(t => {
    const p = S.rent.get(rentId(t.id, month));
    const due = rentDueDate(t, month);
    const status = p ? `<span class="ok">Paid ${fmtDate(p.paidOn)}</span>`
      : t0 > due ? `<span class="bad">Overdue since ${fmtDate(due)}</span>` : `Due ${fmtDate(due)}`;
    return `<div class="item ${p ? 'paid' : ''}">
      <a class="item-main" href="javascript:" data-act="editTenant" data-id="${t.id}"><b>${esc(t.name)}</b><small>${peso(t.rent)} · ${status}</small></a>
      ${p ? `<button class="btn small paidbtn" data-act="unpayRent" data-id="${t.id}" data-month="${month}">✓ ${peso(p.amount)}</button>`
          : `<button class="btn small" data-act="payRent" data-id="${t.id}" data-month="${month}">Paid</button>`}</div>`;
  }).join('');
  const expected = sum(here, t => S.rent.get(rentId(t.id, month))?.amount ?? t.rent);
  const collected = sum(here, t => S.rent.get(rentId(t.id, month))?.amount || 0);
  const nPaid = here.filter(t => S.rent.has(rentId(t.id, month))).length;
  const others = tenants.filter(t => !tenantInMonth(t, month));
  return `<div class="datenav">
      <a class="btn ghost" href="#boarders/${addMonths(month, -1)}" aria-label="Previous month">‹</a>
      <input type="month" value="${month}" data-change="boarderMonth" aria-label="Month">
      <a class="btn ghost" href="#boarders/${addMonths(month, 1)}" aria-label="Next month">›</a>
    </div>
    <div class="card"><small>${fmtMonth(month)} · ${nPaid} of ${here.length} paid</small>
      <div class="big">${peso(collected)} <small>of ${peso(expected)}</small></div>
      <div class="bar"><i style="width:${expected ? Math.min(100, collected / expected * 100) : 0}%"></i></div></div>
    <div class="list">${rows || '<div class="empty">No boarders this month</div>'}</div>
    <button class="btn block" data-act="editTenant">+ Add boarder</button>
    ${others.length ? `<details><summary>Other boarders (${others.length})</summary><div class="list">
      ${others.map(t => `<div class="item"><a class="item-main" href="javascript:" data-act="editTenant" data-id="${t.id}"><b>${esc(t.name)}</b>
        <small>${fmtDate(t.startDate)} – ${t.endDate ? fmtDate(t.endDate) : 'ongoing'}</small></a></div>`).join('')}</div></details>` : ''}`;
}

function tenantSheet(id) {
  const t = id ? S.tenants.get(id) : { name: '', rent: 1000, payDay: new Date().getDate(), startDate: today(), endDate: '' };
  openSheet(`<form data-form="tenant" data-id="${id || ''}">
    <h3>${id ? 'Edit boarder' : 'New boarder'}</h3>
    <label class="field"><span>Name</span><input name="name" required value="${esc(t.name)}" autocomplete="off"></label>
    <div class="row2">
      <label class="field"><span>Rent per month (₱)</span><input name="rent" type="number" inputmode="numeric" min="0" step="100" required value="${t.rent}"></label>
      <label class="field"><span>Pay day</span><input name="payDay" type="number" inputmode="numeric" min="1" max="31" required value="${t.payDay}">
        <small>Day of the month</small></label>
    </div>
    <div class="row2">
      <label class="field"><span>Start date</span><input name="startDate" type="date" required value="${t.startDate}"></label>
      <label class="field"><span>End date (optional)</span><input name="endDate" type="date" value="${t.endDate || ''}"></label>
    </div>
    <button class="btn block" type="submit">Save</button>
    ${id ? `<button class="btn danger block" type="button" data-act="deleteTenant" data-id="${id}">Delete boarder</button>` : ''}
  </form>`);
}

/* ---------- page: backup / settings ---------- */
function pageSettings() {
  setHeader('Backup & settings');
  const age = meta.lastBackup ? daysBetween(meta.lastBackup.slice(0, 10), today()) : null;
  UI.prepared = null;
  UI.after = async () => {
    const text = await exportData();
    UI.prepared = text;
    const el = $('#backupSize');
    if (el) el.textContent = `Backup size: ${(text.length / 1048576).toFixed(1)} MB`;
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    const s = $('#storageInfo');
    if (s) s.textContent = `${persisted ? 'Storage is protected.' : 'Storage may be cleared by the phone if space runs low.'}${est ? ` Using ${(est.usage / 1048576).toFixed(1)} MB.` : ''}`;
  };
  return `<h2>Send backup by e-mail</h2>
    <div class="card">
      <p class="${age === null || age >= BACKUP_EVERY_DAYS ? 'bad' : 'ok'}"><b>${age === null ? 'No backup made yet' : age === 0 ? 'Last backup: today' : `Last backup: ${age} day${age === 1 ? '' : 's'} ago`}</b></p>
      <label class="field"><span>Send backups to</span>
        <input id="email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" value="${esc(meta.email)}" data-change="email"></label>
      <button class="btn block" data-act="sendBackup">Send backup</button>
      <p><small>Pick Gmail (or another mail app) in the list that opens. The address above is copied — paste it into “To”.
        <span id="backupSize"></span></small></p>
      <button class="btn ghost block" data-act="saveBackup">Save backup file on this phone</button>
    </div>
    <h2>Restore</h2>
    <div class="card"><p><small>Load a backup file. This <b>replaces</b> everything currently in the app.</small></p>
      <label class="btn ghost block">Restore from backup file<input type="file" accept=".txt,.json,text/plain,application/json" data-change="restore" hidden></label></div>
    <h2>App</h2>
    <div class="card">
      ${isStandalone() ? '<p class="ok">Installed on home screen ✓</p>'
        : `<p><b>Not installed yet.</b> ${isIOS() ? 'In Safari tap Share → “Add to Home Screen”.' : 'In Chrome tap ⋮ → “Install app”.'}</p>
           ${UI.installEvt ? '<button class="btn block" data-act="install">Install now</button>' : ''}`}
      <p><small id="storageInfo"></small></p>
      <p><small>${S.borrowers.size} borrowers · ${S.loans.size} loans · ${S.payments.size} payments · ${S.tenants.size} boarders · version ${VERSION}</small></p>
    </div>`;
}

async function exportData() {
  const photos = await req(store('photos').getAll());
  const toDataURL = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  return JSON.stringify({
    app: 'sir-loanalot', format: 1, exportedAt: new Date().toISOString(),
    borrowers: [...S.borrowers.values()], loans: [...S.loans.values()], payments: [...S.payments.values()],
    tenants: [...S.tenants.values()], rent: [...S.rent.values()],
    photos: await Promise.all(photos.map(async p => ({ id: p.id, loanId: p.loanId, createdAt: p.createdAt, data: await toDataURL(p.blob) }))),
  });
}
// Backups use .txt because Android's share sheet refuses .json files.
const backupFile = () => new File([UI.prepared], `hornymafia-backup-${today()}.txt`, { type: 'text/plain' });

function downloadFile(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function backupDone() {
  meta.lastBackup = new Date().toISOString();
  await saveMeta();
  render();
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return alert('This is not a valid backup file.'); }
  if (data?.app !== 'sir-loanalot') return alert('This is not a Horny Mafia backup file.');
  const when = new Date(data.exportedAt).toLocaleString('en-PH');
  if (!confirm(`Restore backup from ${when}?\n\n${data.loans.length} loans, ${data.payments.length} payments, ${data.tenants.length} boarders.\n\nEverything currently in the app will be REPLACED.`)) return;
  const photos = await Promise.all((data.photos || []).map(async p => ({ id: p.id, loanId: p.loanId, createdAt: p.createdAt, blob: await (await fetch(p.data)).blob() })));
  const t = db.transaction(STORES, 'readwrite');
  for (const s of STORES) if (s !== 'meta') t.objectStore(s).clear();
  for (const s of ['borrowers', 'loans', 'payments', 'tenants', 'rent']) for (const o of data[s] || []) t.objectStore(s).put(o);
  for (const p of photos) t.objectStore('photos').put(p);
  meta.lastBackup = data.exportedAt;
  t.objectStore('meta').put(meta);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  await loadAll();
  toast('Backup restored ✓');
  go('#collect');
  render();
}

/* ---------- photos ---------- */
async function compressImage(file, max = 1600, quality = 0.78) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return await new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', quality));
  } catch { return file; }
}
async function loadPhotos(loanId) {
  const el = $('#photos');
  const photos = (await req(store('photos').index('loanId').getAll(loanId))).sort((a, b) => a.createdAt - b.createdAt);
  if (!el || !el.isConnected) return;
  el.innerHTML = photos.map(p => {
    const u = URL.createObjectURL(p.blob); UI.urls.push(u);
    return `<img src="${u}" alt="Contract photo" data-act="viewPhoto" data-id="${p.id}">`;
  }).join('') || '<small>No photos yet</small>';
}
async function viewPhoto(id) {
  const p = await req(store('photos').get(id));
  if (!p) return;
  const u = URL.createObjectURL(p.blob);
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<div class="vbar"><button class="btn danger small" data-act="deletePhoto" data-id="${id}" data-loan="${p.loanId}">Delete</button>
    <button class="btn small" data-act="closeViewer">Close</button></div>
    <div class="vimg" data-act="zoomPhoto"><img src="${u}" alt="Contract photo"></div>`;
  v.dataset.url = u;
  document.body.appendChild(v);
}
function closeViewer() {
  const v = $('.viewer');
  if (v) { URL.revokeObjectURL(v.dataset.url); v.remove(); }
}

/* ---------- payment sheets ---------- */
// withPrincipal: interest-only loans can pay back part of the loan together with the interest.
function amountSheet({ title, loan, date, amount, kind, showDate, withPrincipal }) {
  openSheet(`<form data-form="payment">
    <h3>${title}</h3>
    <input type="hidden" name="loan" value="${loan}"><input type="hidden" name="kind" value="${kind}">
    <label class="field"><span>${withPrincipal ? 'Interest paid (₱)' : 'Amount (₱)'}</span>
      <input name="amount" type="number" inputmode="numeric" min="0" step="100" required value="${amount}"></label>
    ${withPrincipal ? `<label class="field"><span>Loan paid back (₱)</span>
      <input name="principal" type="number" inputmode="numeric" min="0" step="100" value="0">
      <small>Part of the ${peso(loanStats(S.loans.get(loan)).remaining)} still owed. Leave 0 if only interest was paid.</small></label>` : ''}
    <label class="field" ${showDate ? '' : 'hidden'}><span>Date</span><input name="date" type="date" required value="${date}"></label>
    <button class="btn block" type="submit">Save payment</button></form>`);
  setTimeout(() => $('#sheet input[name=amount]')?.select(), 60);
}
async function addPayment(loanId, date, amount, kind = 'installment') {
  await put('payments', { id: uid(), loanId, date, amount: round2(amount), kind, createdAt: Date.now() });
  await refreshStatus(S.loans.get(loanId));
}

/* ---------- actions (buttons with data-act) ---------- */
const ACT = {
  back: () => (UI.backHref ? go(UI.backHref) : history.back()),
  closeSheet,
  closeViewer,
  zoomPhoto: (d, el) => el.classList.toggle('zoom'),
  install: async () => { if (UI.installEvt) { UI.installEvt.prompt(); UI.installEvt = null; render(); } },
  hideInstall: async () => { meta.hideInstall = true; await saveMeta(); render(); },

  pay: async d => { await addPayment(d.loan, d.date, num(d.amount)); render(); },
  payOther: d => amountSheet({
    title: `${bName(S.loans.get(d.loan))} — ${fmtDate(d.date)}`, loan: d.loan, date: d.date, amount: d.amount, kind: 'installment',
    withPrincipal: S.loans.get(d.loan).type === 'interest',
  }),
  unpay: async d => {
    const l = S.loans.get(d.loan);
    const pays = loanPayments(d.loan).filter(p => p.date === d.date);
    if (!confirm(`Remove ${peso(sum(pays, p => p.amount))} paid by ${bName(l)} on ${fmtDate(d.date)}?`)) return;
    for (const p of pays) await del('payments', p.id);
    await refreshStatus(l); render();
  },
  recordPayment: d => {
    const l = S.loans.get(d.loan);
    amountSheet({ title: 'Record payment', loan: d.loan, date: today(), amount: installment(l), kind: 'installment', showDate: true, withPrincipal: l.type === 'interest' });
  },
  principalBack: d => amountSheet({ title: 'Principal paid back', loan: d.loan, date: today(), amount: loanStats(S.loans.get(d.loan)).remaining, kind: 'principal', showDate: true }),
  deletePayment: async d => {
    const p = S.payments.get(d.id);
    if (!p || !confirm(`Delete payment of ${peso(p.amount)} on ${fmtDate(p.date)}?`)) return;
    await del('payments', p.id); await refreshStatus(S.loans.get(p.loanId)); render();
  },
  editNotes: d => {
    const l = S.loans.get(d.loan);
    openSheet(`<form data-form="notes" data-loan="${l.id}"><h3>Notes</h3>
      <label class="field"><textarea name="notes" rows="6">${esc(l.notes || '')}</textarea></label>
      <button class="btn block" type="submit">Save</button></form>`);
    setTimeout(() => $('#sheet textarea')?.focus(), 60);
  },
  toggleClosed: async d => {
    const l = S.loans.get(d.loan);
    if (!l.closed && !confirm('Close this loan? It will no longer appear on the collection list.')) return;
    await put('loans', { ...l, closed: !l.closed, autoClosed: false, closedOn: l.closed ? null : today() }); render();
  },
  deleteLoan: async d => {
    const l = S.loans.get(d.loan);
    if (!confirm(`Delete this loan of ${peso(l.principal)} to ${bName(l)}, with all its payments and photos? This cannot be undone.`)) return;
    for (const p of loanPayments(l.id)) await del('payments', p.id);
    for (const key of await req(store('photos').index('loanId').getAllKeys(l.id))) await del('photos', key);
    await del('loans', l.id); go(`#borrower/${l.borrowerId}`);
  },
  newBorrower: () => openSheet(`<form data-form="borrower"><h3>New borrower</h3>
    <label class="field"><span>Name</span><input name="name" required autocomplete="off"></label>
    <button class="btn block" type="submit">Save</button></form>`),
  renameBorrower: d => openSheet(`<form data-form="borrower" data-id="${d.id}"><h3>Rename</h3>
    <label class="field"><span>Name</span><input name="name" required autocomplete="off" value="${esc(S.borrowers.get(d.id).name)}"></label>
    <button class="btn block" type="submit">Save</button></form>`),
  deleteBorrower: async d => {
    if (loansOf(d.id).length) return alert('Delete this person’s loans first.');
    if (!confirm('Delete this borrower?')) return;
    await del('borrowers', d.id); go('#loans');
  },

  viewPhoto: d => viewPhoto(d.id),
  deletePhoto: async d => {
    if (!confirm('Delete this photo?')) return;
    await req(store('photos', 'readwrite').delete(d.id)); closeViewer(); render();
  },

  editTenant: d => tenantSheet(d.id),
  deleteTenant: async d => {
    const t = S.tenants.get(d.id);
    if (!confirm(`Delete ${t.name} and all their rent records? (To keep history, set an end date instead.)`)) return;
    for (const r of [...S.rent.values()].filter(r => r.tenantId === d.id)) await del('rent', r.id);
    await del('tenants', d.id); closeSheet(); render();
  },
  payRent: async d => {
    const t = S.tenants.get(d.id);
    await put('rent', { id: rentId(t.id, d.month), tenantId: t.id, month: d.month, amount: t.rent, paidOn: today() }); render();
  },
  unpayRent: async d => {
    if (!confirm(`Mark ${S.tenants.get(d.id).name} as NOT paid for ${fmtMonth(d.month)}?`)) return;
    await del('rent', rentId(d.id, d.month)); render();
  },

  sendBackup: () => {
    const email = $('#email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { toast('Enter a valid e-mail address first'); $('#email').focus(); return; }
    if (email !== meta.email) { meta.email = email; saveMeta(); }
    if (!UI.prepared) { toast('Preparing backup… try again in a moment'); return; }
    const file = backupFile();
    navigator.clipboard?.writeText(email).catch(() => {});
    if (navigator.canShare?.({ files: [file] })) {
      toast(`Address copied: ${email}`, 4000);
      navigator.share({ files: [file], title: `Horny Mafia backup ${today()}`, text: `Horny Mafia backup ${today()}` })
        .then(backupDone)
        .catch(err => { if (err.name !== 'AbortError') toast('Sharing failed: ' + err.message); });
    } else {
      // No share sheet (e.g. desktop): save the file and open a mail draft to attach it to.
      downloadFile(file);
      setTimeout(() => {
        location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Horny Mafia backup ' + today())}`
          + `&body=${encodeURIComponent(`Please attach the file ${file.name} from Downloads.`)}`;
      }, 600);
      backupDone();
    }
  },
  saveBackup: () => {
    if (!UI.prepared) return toast('Preparing backup… try again in a moment');
    downloadFile(backupFile()); toast('Backup saved to Downloads');
  },
};

/* ---------- forms (data-form) ---------- */
const FORMS = {
  loan: async f => {
    const v = readLoanForm(f);
    const fd = new FormData(f);
    let borrowerId = fd.get('borrower');
    if (!borrowerId) return alert('Choose a borrower.');
    if (!isHundreds(v.principal)) return alert('Amount lent must be in whole ₱100s.');
    if (v.firstDue < v.startDate) return alert('First collection cannot be before the loan date.');
    if (v.type === 'term') {
      if (!isHundreds(v.total)) return alert('Total to pay back must be in whole ₱100s.');
      if (v.total < v.principal) return alert('Total to pay back must be at least the amount lent.');
      if (v.mode === 'amount' && !isHundreds(v.installment)) return alert('Amount per payment must be in whole ₱100s.');
      const plan = planTerm(v);
      if (!plan) return alert(v.mode === 'date' ? 'Last repay date must be on or after the first collection.' : 'Enter the amount per payment.');
      v.installment = plan.installment;
      v.endDate = plan.endDate;
    } else {
      if (!isHundreds(v.interest)) return alert('Interest must be in whole ₱100s.');
      v.installment = v.interest;
      v.endDate = null; v.total = 0; v.mode = null;
    }
    delete v.interest;
    if (borrowerId === '__new') {
      const name = (fd.get('newName') || '').trim();
      if (!name) return alert('Enter the borrower’s name.');
      borrowerId = uid();
      await put('borrowers', { id: borrowerId, name, createdAt: Date.now() });
    }
    const old = f.dataset.id ? S.loans.get(f.dataset.id) : null;
    const loan = { ...(old || { id: uid(), closed: false, createdAt: Date.now() }), ...v, borrowerId };
    await put('loans', loan);
    await refreshStatus(loan);
    toast('Loan saved ✓');
    go(`#loan/${loan.id}`);
  },
  payment: async f => {
    const fd = new FormData(f);
    const amount = num(fd.get('amount'));
    const principal = num(fd.get('principal'));
    const ok = n => n === 0 || isHundreds(n);
    if (!ok(amount) || !ok(principal) || amount + principal <= 0) return alert('Enter an amount in whole ₱100s.');
    const l = S.loans.get(fd.get('loan'));
    if (principal > loanStats(l).remaining) return alert(`Only ${peso(loanStats(l).remaining)} of the loan is still owed.`);
    if (amount) await addPayment(l.id, fd.get('date'), amount, fd.get('kind'));
    if (principal) await addPayment(l.id, fd.get('date'), principal, 'principal');
    closeSheet(); render();
  },
  notes: async f => {
    const l = S.loans.get(f.dataset.loan);
    await put('loans', { ...l, notes: new FormData(f).get('notes').trim() });
    closeSheet(); render();
  },
  borrower: async f => {
    const name = new FormData(f).get('name').trim();
    if (!name) return;
    const b = f.dataset.id ? { ...S.borrowers.get(f.dataset.id), name } : { id: uid(), name, createdAt: Date.now() };
    await put('borrowers', b);
    closeSheet();
    if (f.dataset.id) render(); else go(`#borrower/${b.id}`);
  },
  tenant: async f => {
    const fd = new FormData(f);
    const t = {
      ...(f.dataset.id ? S.tenants.get(f.dataset.id) : { id: uid(), createdAt: Date.now() }),
      name: fd.get('name').trim(), rent: num(fd.get('rent')),
      payDay: Math.min(31, Math.max(1, Math.round(num(fd.get('payDay'))) || 1)),
      startDate: fd.get('startDate'), endDate: fd.get('endDate') || null,
    };
    if (t.endDate && t.endDate < t.startDate) return alert('End date is before the start date.');
    await put('tenants', t);
    closeSheet(); render();
  },
};

/* ---------- inputs that react on change (data-change) ---------- */
const CHANGE = {
  collectDate: el => el.value && go(`#collect/${el.value}`),
  boarderMonth: el => el.value && go(`#boarders/${el.value}`),
  email: async el => { meta.email = el.value.trim(); await saveMeta(); },
  borrowerSelect: el => { $('#newNameField').hidden = el.value !== '__new'; if (el.value === '__new') $('input[name=newName]').focus(); },
  photo: async el => {
    const file = el.files[0];
    if (!file) return;
    toast('Saving photo…');
    const blob = await compressImage(file);
    await req(store('photos', 'readwrite').put({ id: uid(), loanId: el.dataset.loan, blob, createdAt: Date.now() }));
    toast('Photo saved ✓'); render();
  },
  restore: async el => { const f = el.files[0]; el.value = ''; if (f) await importBackup(f); },
};

const guard = fn => (...a) => Promise.resolve(fn(...a)).catch(err => { console.error(err); alert('Something went wrong: ' + err.message); });

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACT[el.dataset.act]) return;
  e.preventDefault();
  guard(ACT[el.dataset.act])({ ...el.dataset }, el, e);
});
document.addEventListener('submit', e => {
  const f = e.target;
  if (!FORMS[f.dataset.form]) return;
  e.preventDefault();
  guard(FORMS[f.dataset.form])(f);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (CHANGE[el.dataset.change]) guard(CHANGE[el.dataset.change])(el);
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.input === 'filterNames') {
    const q = el.value.trim().toLowerCase();
    document.querySelectorAll('#names .item').forEach(r => { r.hidden = !r.dataset.name.includes(q); });
  }
  const f = el.form;
  if (f?.dataset.form === 'loan') {
    // New loans: keep first collection in step with loan date / frequency until it's edited by hand,
    // and default to weekly for interest-only loans and daily for fixed-term loans.
    if (f.dataset.new) {
      if (el.name === 'type' && !f.dataset.freqTouched) {
        $(`input[name=frequency][value=${el.value === 'interest' ? 'weekly' : 'daily'}]`, f).checked = true;
      }
      if (el.name === 'frequency') f.dataset.freqTouched = '1';
      if (el.name === 'firstDue') f.dataset.dueTouched = '1';
      if (!f.dataset.dueTouched && ['type', 'frequency', 'startDate'].includes(el.name)) {
        const fd = new FormData(f);
        if (fd.get('startDate')) f.firstDue.value = nextCollectionDay(fd.get('startDate'), fd.get('frequency'));
      }
    }
    // Typing in either the last date or the amount per payment makes that one the one that counts.
    if (el.name === 'endDate' || el.name === 'installment') {
      $(`input[name=mode][value=${el.name === 'endDate' ? 'date' : 'amount'}]`, f).checked = true;
    }
    updateLoanCalc(f);
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeViewer(); closeSheet(); } });

window.addEventListener('hashchange', () => { closeSheet(); closeViewer(); render(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); UI.installEvt = e; render(); });
// Re-render when the app comes back to the foreground, so "today" is always right.
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#sheet').hidden) render(); });

(async function init() {
  try {
    db = await openDB();
    await loadAll();
  } catch (err) {
    view.innerHTML = `<div class="card alert">Could not open storage: ${esc(err.message)}</div>`;
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();
