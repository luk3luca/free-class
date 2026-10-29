/* Free classrooms — UniBS Engineering (ING1 · ING2 · ING3 · ING6)
 * Reads the public booking data of the UniBS "UP" portal and shows ONLY free classrooms,
 * each with the time range during which it is free.
 *
 * Data notes:
 *  - API times are UTC -> converted here to absolute minutes and then to local time;
 *  - `stato: "A"` = cancelled booking -> the room is free again, so it is ignored;
 *  - one booking can hold several rooms: it is split into one row per room;
 *  - the `limit` parameter is mandatory: the portal default (150) truncates the results.
 */

const API = 'https://unibs-public.prod.up.cineca.it/api';

const BUILDINGS = [
  { code: 'ING1', id: '65d5a89e95ff13011395ec33', addr: 'via Branze 38' },
  { code: 'ING2', id: '65d5a89e95ff13011395ec36', addr: 'via Branze 43' },
  { code: 'ING3', id: '65d5a89e95ff13011395ec39', addr: 'via Valotti 9' },
  { code: 'ING6', id: '65d5a89e95ff13011395ec3c', addr: 'via Valotti 11' },
];

const TYPE_GROUPS = {
  aule: { label: 'Aule', tipi: ['Aula Lezioni', 'Aula Media', 'Aula Disegno'] },
  lab:  { label: 'Laboratori', tipi: ['Laboratorio', 'Laboratorio Informatico', 'Laboratorio Elettronico', 'Laboratorio sensori', 'Laboratorio di automazione', 'Laboratorio Optoelettronica'] },
  sale: { label: 'Sale', tipi: ['Sala'] },
};

// fake / unusable rooms
const EXCLUDE_ROOMS = new Set(['ON LINE']);
const BOOKING_LIMIT = 2000;

const state = {
  view: 'day',
  date: todayISO(),
  buildings: new Set(BUILDINGS.map(b => b.code)),
  groups: new Set(['aule']),
  from: 8 * 60,
  to: 20 * 60,
  minCap: 0,
  q: '',
  rooms: [],
  bookings: new Map(),   // `${edificio}|${aula}` -> [{s,e,label}]
  fetchedAt: null,
  truncated: false,
  loading: false,
  error: null,
  week: null,            // { days:[iso...], data:Map }
  weekKey: null,
};

/* ---------------- date helpers (everything in Europe/Rome) ---------------- */

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function romeOffset(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  const v = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'longOffset' })
    .formatToParts(d).find(p => p.type === 'timeZoneName').value;   // "GMT+02:00"
  return v.replace('GMT', '') || '+00:00';
}
// absolute instant (in minutes) of the local midnight of day `iso`
function dayStartAbs(iso) {
  return Date.parse(iso + 'T00:00:00' + romeOffset(iso)) / 60000;
}
function fmtHM(min) {
  const m = Math.round(min);
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function fmtDur(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60), r = m % 60;
  if (h === 0) return r + 'min';
  return r === 0 ? h + 'h' : h + 'h' + String(r).padStart(2, '0');
}
function longDate(iso) {
  return new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(iso + 'T12:00:00Z'));
}
function shortDate(iso) {
  return new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' })
    .format(new Date(iso + 'T12:00:00Z'));
}
function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

/* ---------------- network ---------------- */

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data && data.error) throw new Error(data.error.message || 'errore API');
  return data;
}

// bookings in [fromISO, toISO] for one building -> map keyed by room
async function fetchBookings(bldg, fromISO, toISO) {
  const off1 = romeOffset(fromISO), off2 = romeOffset(addDays(toISO, 1));
  const url = `${API}/Impegni/getImpegniPublic?edificio=${bldg.id}`
    + `&dataInizio=${encodeURIComponent(fromISO + 'T00:00:00' + off1)}`
    + `&dataFine=${encodeURIComponent(addDays(toISO, 1) + 'T00:00:00' + off2)}`
    + `&limit=${BOOKING_LIMIT}`;
  const raw = await fetchJSON(url);
  if (!Array.isArray(raw)) return { map: new Map(), truncated: false };

  const map = new Map();
  for (const imp of raw) {
    if (imp.stato === 'A') continue;                       // cancelled -> the room is free
    const s = Date.parse(imp.dataInizio) / 60000;
    const e = Date.parse(imp.dataFine) / 60000;
    if (!isFinite(s) || !isFinite(e)) continue;
    const label = imp.evento?.dettagliDidattici?.[0]?.nome
      || imp.evento?.tipoAttivita?.descrizione
      || imp.evento?.tipoEvento?.descrizione || '';
    for (const a of imp.aule || []) {
      const key = bldg.code + '|' + a.codice;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ s, e, label });
    }
  }
  return { map, truncated: raw.length >= BOOKING_LIMIT };
}

/* ---------------- room inventory ---------------- */

function loadRooms() {
  const cached = localStorage.getItem('fc.rooms.v1');
  if (cached) {
    try {
      const p = JSON.parse(cached);
      if (Array.isArray(p.rooms) && p.rooms.length) { state.roomsAt = p.ts; return p.rooms; }
    } catch (_) {}
  }
  return (window.ROOMS || []).slice();
}

async function refreshInventory() {
  const out = [];
  for (const b of BUILDINGS) {
    const list = await fetchJSON(`${API}/Aule/getPerAutoCompletePublic?valore=&lookupFields=codice&lookupFields=descrizione&edificio=${b.id}`);
    const details = await mapLimit(list, 8, async (r) => {
      try {
        const d = await fetchJSON(`${API}/Aule/getByIdPublic?id=${r.id}`);
        return { edificio: b.code, aula: d.codice, nome: d.descrizione, tipo: d.tipoAula?.descrizione || '-', piano: d.piano?.descrizione || '-', capienza: d.capienzaEffettiva ?? d.capienza ?? 0, id: d.id };
      } catch (_) {
        return { edificio: b.code, aula: r.codice, nome: r.descrizione, tipo: '-', piano: '-', capienza: r.capienzaEffettiva ?? r.capienza ?? 0, id: r.id };
      }
    });
    out.push(...details);
  }
  out.sort((a, b) => a.edificio.localeCompare(b.edificio) || a.aula.localeCompare(b.aula, undefined, { numeric: true }));
  localStorage.setItem('fc.rooms.v1', JSON.stringify({ ts: Date.now(), rooms: out }));
  state.rooms = out;
  state.roomsAt = Date.now();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ---------------- free-room computation ---------------- */

function freeIntervals(busy, winS, winE) {
  const ev = (busy || [])
    .filter(b => b.s < winE && b.e > winS)
    .map(b => [Math.max(b.s, winS), Math.min(b.e, winE)])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = winS;
  for (const [s, e] of ev) {
    if (s > cur) out.push([cur, s]);
    cur = Math.max(cur, e);
  }
  if (cur < winE) out.push([cur, winE]);
  return out;
}

function visibleRooms() {
  const tipi = new Set();
  for (const g of state.groups) (TYPE_GROUPS[g]?.tipi || []).forEach(t => tipi.add(t));
  const q = state.q.trim().toLowerCase();
  return state.rooms.filter(r =>
    state.buildings.has(r.edificio) &&
    tipi.has(r.tipo) &&
    !EXCLUDE_ROOMS.has(r.aula) &&
    (r.capienza || 0) >= Math.max(1, state.minCap) &&   // capacity 0 = not a usable seat (e.g. the machine shop)
    (!q || (r.aula + ' ' + r.nome + ' ' + (r.piano || '')).toLowerCase().includes(q))
  );
}

function freeForDay(rooms, dateISO) {
  const base = dayStartAbs(dateISO);
  const winS = base + state.from, winE = base + state.to;
  const res = [];
  for (const r of rooms) {
    const iv = freeIntervals(state.bookings.get(r.edificio + '|' + r.aula), winS, winE)
      .map(([s, e]) => ({ from: fmtHM(s - base), to: fmtHM(e - base), mins: e - s }));
    if (iv.length) res.push({ room: r, intervals: iv });
  }
  return res;
}

/* ---------------- rendering ---------------- */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderStatus() {
  const el = $('#status');
  if (state.loading) { el.innerHTML = '<span class="dot" style="background:var(--muted)"></span> aggiornamento…'; return; }
  if (state.error) { el.innerHTML = `<span class="dot" style="background:var(--danger)"></span> ${esc(state.error)}`; return; }
  const t = state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '—';
  el.innerHTML = `<span class="dot"></span> dati aggiornati alle ${t}`
    + (state.truncated ? ' · <span style="color:var(--warn)">possibile troncamento dati</span>' : '');
}

function renderNow(free) {
  const panel = $('#nowPanel');
  if (state.view !== 'day' || state.date !== todayISO()) { panel.hidden = true; return; }
  const base = dayStartAbs(state.date);
  const nowAbs = Date.now() / 60000;
  const nowMin = nowAbs - base;
  if (nowMin < state.from || nowMin > state.to) {
    panel.hidden = false;
    panel.innerHTML = `<div class="now-head"><b>Adesso ${fmtHM(nowMin)}</b><span class="muted">fuori dalla fascia selezionata (${fmtHM(state.from)}–${fmtHM(state.to)})</span></div>`;
    return;
  }
  const rows = [];
  const winS = base + state.from, winE = base + state.to;
  for (const f of free) {
    const iv = freeIntervals(state.bookings.get(f.room.edificio + '|' + f.room.aula), winS, winE);
    const hit = iv.find(([s, e]) => s <= nowAbs && e > nowAbs);
    if (hit) rows.push({ room: f.room, until: fmtHM(hit[1] - base), left: hit[1] - nowAbs });
  }
  rows.sort((a, b) => b.left - a.left);
  panel.hidden = false;
  if (!rows.length) {
    panel.innerHTML = `<div class="now-head"><b>Adesso ${fmtHM(nowMin)}</b><span class="muted">nessuna aula libera nella fascia selezionata</span></div>`;
    return;
  }
  panel.innerHTML = `<div class="now-head"><b>Adesso ${fmtHM(nowMin)} · ${rows.length} aule libere</b>
      <span class="muted">ordinate per quanto restano libere</span></div>
    <div class="now-list">${rows.map(r => `<span class="now-item">
        <span class="room">${esc(r.room.nome)}</span>
        <span class="bldgTag">${esc(r.room.edificio)} · ${esc(r.room.aula)}</span>
        <span class="until">fino alle ${r.until}</span>
        <span class="bldgTag">(${fmtDur(r.left)})</span>
      </span>`).join('')}</div>`;
}

function roomLabel(r) {
  return `<div class="rname">${esc(r.nome)}</div>
    <div class="rsub">${esc(r.edificio)} · ${esc(r.aula)}${r.piano && r.piano !== '-' ? ' · ' + esc(r.piano) : ''}${r.capienza ? ' · ' + r.capienza + ' posti' : ''}</div>`;
}

function renderDay(free) {
  const content = $('#content');
  if (!free.length) {
    content.innerHTML = `<div class="empty">Nessuna aula libera con questi filtri in questa giornata.</div>`;
    renderNow([]);
    return;
  }
  const span = state.to - state.from;
  const ticks = [];
  for (let m = state.from; m <= state.to; m += 60) ticks.push(m);

  let nBusy = 0;
  for (const v of state.bookings.values()) nBusy += v.length;
  const notice = nBusy === 0
    ? `<div class="notice">Nessuna prenotazione in questa giornata: le aule risultano tutte libere. Se la data è lontana, l'orario potrebbe non essere ancora pubblicato dal portale.</div>`
    : '';

  const byBldg = new Map();
  for (const f of free) {
    if (!byBldg.has(f.room.edificio)) byBldg.set(f.room.edificio, []);
    byBldg.get(f.room.edificio).push(f);
  }

  let html = '';
  for (const b of BUILDINGS) {
    const rows = byBldg.get(b.code);
    if (!rows || !rows.length) continue;
    rows.sort((a, x) => a.room.aula.localeCompare(x.room.aula, undefined, { numeric: true }));
    html += `<section class="bldg">
      <div class="bldg-head"><b>${esc(b.code)}</b><span>${esc(b.addr)} · ${rows.length} aule con spazi liberi</span></div>
      <div class="axis"><div class="axis-room"></div><div class="axis-track">
        ${ticks.map(m => `<span class="tick" style="left:${((m - state.from) / span * 100).toFixed(3)}%">${fmtHM(m)}</span>`).join('')}
      </div></div>
      <div class="rows">${rows.map(f => `<div class="row">
        <div class="rmeta">${roomLabel(f.room)}</div>
        <div class="track">
          ${f.intervals.map(iv => {
            const left = (parseHM(iv.from) - state.from) / span * 100;
            const w = iv.mins / span * 100;
            const mode = w < 4.5 ? 'mini' : w < 9.5 ? 'short' : '';
            const inner = mode === 'mini' ? ''
              : mode === 'short' ? `<span>${iv.from}</span>`
              : `<span>${iv.from}–${iv.to}</span><span class="dur">${fmtDur(iv.mins)}</span>`;
            return `<div class="blk ${mode}" style="left:${left.toFixed(3)}%;width:${w.toFixed(3)}%"
              title="${esc(f.room.nome)} · libera dalle ${iv.from} alle ${iv.to} (${fmtDur(iv.mins)})">${inner}</div>`;
          }).join('')}
        </div>
        <div class="ranges rowrng">${f.intervals.map(iv =>
          `<span class="range">${iv.from}–${iv.to}<span class="dur">${fmtDur(iv.mins)}</span></span>`
        ).join('')}</div></div>`).join('')}
      </div></section>`;
  }
  content.innerHTML = notice + html;
  renderNow(free);
}

function parseHM(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }

function weekIntervals(room, dateISO) {
  const base = dayStartAbs(dateISO);
  return freeIntervals(state.week.data.get(room.edificio + '|' + room.aula), base + state.from, base + state.to)
    .map(([s, e]) => ({ from: fmtHM(s - base), to: fmtHM(e - base), mins: e - s }));
}

function renderWeek() {
  const content = $('#content');
  const w = state.week;
  if (!w) { content.innerHTML = `<div class="loading">Carico la settimana…</div>`; return; }
  const rooms = visibleRooms().filter(r => state.buildings.has(r.edificio));
  if (!rooms.length) { content.innerHTML = `<div class="empty">Nessuna aula con questi filtri.</div>`; return; }

  // compute each room/day once, then render both the table (desktop) and the cards (mobile)
  const groups = [];
  for (const b of BUILDINGS) {
    const list = rooms.filter(r => r.edificio === b.code)
      .sort((a, x) => a.aula.localeCompare(x.aula, undefined, { numeric: true }))
      .map(r => ({ room: r, days: w.days.map(d => weekIntervals(r, d)) }));
    if (list.length) groups.push({ b, list });
  }

  const cellContent = (iv) => iv.length
    ? `<div class="ranges">${iv.map(x => `<span class="range">${x.from}–${x.to}</span>`).join('')}</div>`
    : `<span class="free-none">—</span>`;

  let body = '', cards = '';
  for (const { b, list } of groups) {
    body += `<tr class="bldg-row"><td class="room-col">${esc(b.code)}</td><td colspan="${w.days.length}">${esc(b.addr)}</td></tr>`;
    body += list.map(({ room, days }) => `<tr><td class="room-col">${roomLabel(room)}</td>${
      days.map((iv, i) => `<td class="cell" data-day="${w.days[i]}">${cellContent(iv)}</td>`).join('')
    }</tr>`).join('');

    cards += `<section class="wc-group">
      <div class="wc-group-head"><b>${esc(b.code)}</b><span>${esc(b.addr)}</span></div>
      ${list.map(({ room, days }) => `<article class="wc-room">
        <div class="wc-head">${roomLabel(room)}</div>
        <div class="wc-days">${days.map((iv, i) => `<button type="button" class="wc-day" data-day="${w.days[i]}">
          <span class="wc-dname">${esc(shortDate(w.days[i]))}</span>
          <span class="wc-val">${iv.length
            ? iv.map(x => `<span class="wc-pill">${x.from}–${x.to}<span class="dur">${fmtDur(x.mins)}</span></span>`).join('')
            : `<span class="free-none">—</span>`}</span>
          <span class="wc-chev" aria-hidden="true">›</span>
        </button>`).join('')}</div>
      </article>`).join('')}
    </section>`;
  }

  content.innerHTML = `<div class="week"><table class="wt">
      <thead><tr><th class="room-col">Aula</th>${w.days.map(d => `<th>${esc(shortDate(d))}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div>
      <div class="week-cards">${cards}</div>
      <p class="muted wk-hint">Seleziona un giorno per aprirlo. «—» = nessuno spazio libero nella fascia selezionata.</p>`;

  content.querySelectorAll('td.cell, .wc-day').forEach(el => el.addEventListener('click', () => {
    state.date = el.dataset.day;
    setView('day');
  }));
}

/* ---------------- loading ---------------- */

async function load() {
  state.loading = true; state.error = null; renderStatus();
  const content = $('#content');
  if (!state.rooms.length) content.innerHTML = `<div class="loading">Carico l'inventario delle aule…</div>`;
  else if (state.view === 'day') content.innerHTML = `<div class="loading">Carico le prenotazioni del ${esc(longDate(state.date))}…</div>`;

  try {
    const active = BUILDINGS.filter(b => state.buildings.has(b.code));
    if (state.view === 'day') {
      const results = await Promise.all(active.map(b => fetchBookings(b, state.date, state.date)));
      const map = new Map();
      for (const r of results) for (const [k, v] of r.map) map.set(k, v);
      state.bookings = map;
      state.truncated = results.some(r => r.truncated);
      state.week = null; state.weekKey = null;
    } else {
      const mon = mondayOf(state.date);
      const days = [0, 1, 2, 3, 4].map(i => addDays(mon, i));
      const results = await Promise.all(active.map(b => fetchBookings(b, days[0], days[4])));
      const map = new Map();
      for (const r of results) for (const [k, v] of r.map) map.set(k, v);
      state.week = { days, data: map };
      state.weekKey = mon;
      state.truncated = results.some(r => r.truncated);
    }
    state.fetchedAt = Date.now();
  } catch (err) {
    state.error = 'errore di caricamento: ' + (err.message || err);
  }
  state.loading = false;
  render();
}

function render() {
  const free = state.view === 'day' ? freeForDay(visibleRooms(), state.date) : null;
  if (state.view === 'day') renderDay(free || []);
  else renderWeek();
  $('#dateTitle').textContent = state.view === 'day' ? longDate(state.date) : 'Settimana del ' + shortDate(mondayOf(state.date));
  const today = todayISO();
  const diff = Math.round((Date.parse(state.date + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
  $('#dateHint').textContent = diff === 0 ? 'oggi' : diff === 1 ? 'domani' : diff === -1 ? 'ieri' : (diff > 0 ? `fra ${diff} giorni` : `${-diff} giorni fa`);
  $('#portalLink').href = 'https://unibs-public.prod.up.cineca.it/aule?tipologiaRicerca=aula';
  renderStatus();
}

/* ---------------- controls ---------------- */

function setView(v) {
  state.view = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-on', t.dataset.view === v));
  load();
}

function buildControls() {
  const fb = $('#fBuildings');
  fb.innerHTML = BUILDINGS.map(b => `<button class="chip is-on" data-b="${b.code}">${b.code}</button>`).join('');
  fb.addEventListener('click', e => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    const c = btn.dataset.b;
    if (state.buildings.has(c)) { if (state.buildings.size === 1) return; state.buildings.delete(c); }
    else state.buildings.add(c);
    btn.classList.toggle('is-on', state.buildings.has(c));
    load();
  });

  const ft = $('#fTypes');
  ft.innerHTML = Object.entries(TYPE_GROUPS).map(([k, g]) => `<button class="chip${k === 'aule' ? ' is-on' : ''}" data-g="${k}" title="${esc(g.tipi.join(', '))}">${esc(g.label)}</button>`).join('');
  $('#buildingsSub').textContent = BUILDINGS.map(b => b.code).join(' · ');
  ft.addEventListener('click', e => {
    const btn = e.target.closest('.chip'); if (!btn) return;
    const g = btn.dataset.g;
    if (state.groups.has(g)) { if (state.groups.size === 1) return; state.groups.delete(g); }
    else state.groups.add(g);
    btn.classList.toggle('is-on', state.groups.has(g));
    render();
  });

  const sel = (id, val) => { const s = $(id); for (let m = 6 * 60; m <= 23 * 60; m += 30) s.insertAdjacentHTML('beforeend', `<option value="${m}">${fmtHM(m)}</option>`); s.value = String(val); };
  sel('#fFrom', state.from); sel('#fTo', state.to);
  $('#fFrom').addEventListener('change', e => { state.from = +e.target.value; if (state.to <= state.from) { state.to = Math.min(state.from + 60, 23 * 60); $('#fTo').value = String(state.to); } render(); });
  $('#fTo').addEventListener('change', e => { state.to = +e.target.value; if (state.to <= state.from) { state.from = Math.max(state.to - 60, 6 * 60); $('#fFrom').value = String(state.from); } render(); });

  let capT;
  $('#fCap').addEventListener('input', e => { clearTimeout(capT); capT = setTimeout(() => { state.minCap = Math.max(0, +e.target.value || 0); render(); }, 250); });

  let qT;
  $('#fQuery').addEventListener('input', e => { clearTimeout(qT); qT = setTimeout(() => { state.q = e.target.value; render(); }, 200); });

  $('#prev').addEventListener('click', () => { state.date = addDays(state.date, -1); load(); });
  $('#next').addEventListener('click', () => { state.date = addDays(state.date, 1); load(); });
  $('#todayBtn').addEventListener('click', () => { state.date = todayISO(); load(); });
  $('#refresh').addEventListener('click', () => load());
  $('#invLink').addEventListener('click', async (e) => {
    e.preventDefault();
    const el = e.target;
    el.textContent = 'aggiornamento inventario…';
    try { await refreshInventory(); el.textContent = 'Inventario aggiornato (' + state.rooms.length + ' aule)'; render(); }
    catch (err) { el.textContent = 'Inventario: errore di aggiornamento'; }
    setTimeout(() => { el.textContent = 'Aggiorna inventario aule'; }, 5000);
  });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));
}

/* ---------------- bootstrap ---------------- */

state.rooms = loadRooms();
buildControls();
load();

// silent realign every 5 minutes while the page is showing today
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (state.view !== 'day' || state.date !== todayISO()) return;
  load();
}, 5 * 60 * 1000);
