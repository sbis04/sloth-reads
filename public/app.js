const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const toast = (m) => { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800); };

// ---------- theme ----------
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme(store.get('sr.theme'));
$('themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'light' : 'dark'); store.set('sr.theme', dark ? 'light' : 'dark');
};

// ---------- owner ----------
// The owner key is set once (from ?key= or the button) and kept in this browser only.
const qs = new URLSearchParams(location.search);
if (qs.get('key')) { store.set('sr.owner', qs.get('key')); history.replaceState(null, '', location.pathname); }
let ownerKey = store.get('sr.owner') ?? '';
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { ...(ownerKey && { 'x-owner': ownerKey }), ...(opts.body && { 'content-type': 'application/json' }), ...opts.headers } });
$('ownerBtn').onclick = () => {
  if (state?.owner) {
    if (confirmOut()) { ownerKey = ''; store.set('sr.owner', null); load(); toast('Signed out'); }
    return;
  }
  const form = $('addForm');
  form.hidden = false;
  form.dataset.mode = 'key';
  $('addUrl').type = 'password'; $('addUrl').placeholder = 'Owner key'; $('addUrl').value = '';
  form.querySelector('button').textContent = 'Sign in';
  $('addUrl').focus();
};
let outArmed = 0;
const confirmOut = () => { if (Date.now() - outArmed < 3000) return true; outArmed = Date.now(); toast('Tap again to sign out'); return false; };

// ---------- state ----------
let state = null, tab = 'all', results = null;
const fmtMin = (m) => (m >= 90 ? `${(m / 60).toFixed(1).replace(/\.0$/, '')} h` : `${Math.round(m)} min`);

async function load() {
  state = await api('/api/state').then((r) => r.json());
  $('ownerBtn').classList.toggle('on', state.owner);
  $('ownerBtn').title = state.owner ? 'Signed in as owner (tap twice to sign out)' : 'Owner sign in';
  const form = $('addForm');
  if (state.owner) { form.hidden = false; form.dataset.mode = 'url'; $('addUrl').type = 'url'; $('addUrl').placeholder = 'Paste a link to read later'; form.querySelector('button').textContent = 'Save for the sloth'; }
  else if (form.dataset.mode !== 'key') form.hidden = true;
  $('footModel').textContent = /gemma/i.test(state.model) ? 'Gemma 4' : state.model;
  renderHero(); renderStats(); renderTabs(); renderItems(); renderRuns();
  clearTimeout(load.t);
  if (state.items.some((i) => i.status === 'queued')) load.t = setTimeout(load, 4000);
}

function renderHero() {
  const b = state.brief, t = state.totals;
  const day = b ? new Date(`${b.day}T12:00:00`) : new Date();
  $('heroDate').textContent = day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  if (!b) { $('briefCard').hidden = true; return; }
  const n = b.item_ids.length;
  $('heroTitle').textContent = `While you slept, the sloth read ${n} thing${n === 1 ? '' : 's'} for you.`;
  $('heroLede').textContent = `That's ${fmtMin(b.read_minutes)} of reading, down to a one-minute brief. ${t.saved_minutes ? `${fmtMin(t.saved_minutes)} of your time saved so far.` : ''}`;
  $('briefCard').hidden = false;
  $('briefSub').textContent = b.has_audio || state.owner ? `${Math.max(1, Math.round(b.script.split(/\s+/).length / 160))} min listen · ${n} articles` : 'Not read aloud yet';
  $('briefPlay').disabled = !(b.has_audio || state.owner);
  $('transcript').textContent = b.script;
}
$('transcriptBtn').onclick = () => {
  const t = $('transcript'); t.hidden = !t.hidden;
  $('transcriptBtn').setAttribute('aria-expanded', String(!t.hidden));
  $('transcriptBtn').textContent = t.hidden ? 'Transcript' : 'Hide transcript';
};
$('briefPlay').onclick = () => toggle({ kind: 'brief', id: state.brief.day, title: 'Your morning brief' });

function renderStats() {
  const t = state.totals;
  const days = state.daily;
  const max = Math.max(1, ...days.map((d) => d.minutes));
  const W = 200, H = 46, bw = W / Math.max(days.length, 7);
  const today = new Date().toISOString().slice(0, 10);
  const bars = days.map((d, i) => {
    const h = Math.max(2, (d.minutes / max) * (H - 2));
    return `<rect class="${d.day === today ? 'today' : ''}" x="${i * bw + 1}" y="${H - h}" width="${Math.max(2, bw - 3)}" height="${h}" rx="2"><title>${d.day}: ${Math.round(d.minutes)} min saved</title></rect>`;
  }).join('');
  $('stats').innerHTML = `
    <div class="stat"><b>${fmtMin(t.saved_minutes)}</b><span>of reading you didn't have to do</span></div>
    <div class="stat"><b>${t.done}<small style="font-size:.5em;color:var(--ink-3)"> / ${t.items}</small></b><span>read for you${t.queued ? `, ${t.queued} waiting` : ''}</span></div>
    <div class="stat"><b>${state.items.filter((i) => i.verdict === 'skip').length}</b><span>you can safely skip</span></div>
    <div class="stat chart"><span>Minutes saved per day</span><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Minutes saved per day">${bars}</svg></div>`;
}

const TABS = [['all', 'All'], ['read', 'Worth reading'], ['skim', 'Skim'], ['skip', 'Skip'], ['done', 'Done']];
function renderTabs() {
  const count = (k) => state.items.filter((i) => match(i, k)).length;
  $('tabs').innerHTML = TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${label}<small>${count(k)}</small></button>`).join('');
}
const match = (i, k) => (k === 'all' ? !i.finished_at : k === 'done' ? Boolean(i.finished_at) : i.verdict === k && !i.finished_at);
$('tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; results = null; $('q').value = ''; $('searchNote').hidden = true; renderTabs(); renderItems(); };

const VERDICT = { read: 'Worth reading', skim: 'Skim it', skip: 'Skip it', queued: 'Reading…', failed: 'Couldn\'t read' };
function card(i) {
  const v = i.status === 'done' ? i.verdict : i.status;
  const canListen = i.has_audio || state.owner;
  return `<li class="card ${i.finished_at ? 'finished' : ''}" data-id="${i.id}">
    ${i.cover ? `<div class="card-cover" style="background-image:url('${esc(i.cover)}')"></div>` : ''}
    <div class="card-body">
      <div class="card-meta"><span>${esc(i.site)} · ${i.read_minutes} min read</span><span class="verdict ${v}">${v === 'queued' ? '<span class="spinner"></span>' : ''}${VERDICT[v] ?? v}</span></div>
      <h3><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></h3>
      ${i.reason ? `<div class="reason">${esc(i.reason)}</div>` : ''}
      ${i.summary ? `<p class="summary">${esc(i.summary)}</p>` : i.status === 'failed' ? `<p class="summary">${esc(i.error)}</p>` : ''}
      ${i.takeaways?.length ? `<ul class="takeaways">${i.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="card-actions">
      <button class="ghost small listen" type="button" data-listen="${i.id}" ${canListen && i.status === 'done' ? '' : 'disabled'} title="${canListen ? 'Read the whole article to me' : 'Not read aloud yet'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l5 4V6L7 10H4zm12.5 2A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" fill="currentColor"/></svg>Listen</button>
      <span class="grow"></span>
      ${state.owner && i.status === 'failed' ? `<button class="ghost small" type="button" data-retry="${i.id}">Retry</button>` : ''}
      ${state.owner ? `<button class="ghost small" type="button" data-done="${i.id}">${i.finished_at ? 'Undo' : 'Done'}</button>` : ''}
    </div></li>`;
}
function renderItems() {
  const list = results ?? state.items.filter((i) => match(i, tab));
  $('items').innerHTML = list.length ? list.map(card).join('') : `<li class="empty">${results ? 'Nothing matches that.' : tab === 'done' ? 'Nothing marked done yet.' : 'Nothing here. Save a link and the sloth will read it tonight.'}</li>`;
}
$('items').onclick = async (e) => {
  const l = e.target.closest('[data-listen]');
  if (l) { const it = state.items.find((x) => x.id === Number(l.dataset.listen)); return toggle({ kind: 'item', id: it.id, title: it.title }); }
  const d = e.target.closest('[data-done]');
  if (d) { await api(`/api/items/${d.dataset.done}/done`, { method: 'POST' }); return load(); }
  const r = e.target.closest('[data-retry]');
  if (r) { await api(`/api/items/${r.dataset.retry}/retry`, { method: 'POST' }); return load(); }
};

// ---------- search (pgvector + full text on Tiger Data) ----------
let sTimer;
$('q').oninput = () => { clearTimeout(sTimer); sTimer = setTimeout(runSearch, 300); };
$('searchForm').onsubmit = (e) => { e.preventDefault(); runSearch(); };
async function runSearch() {
  const q = $('q').value.trim();
  if (!q) { results = null; $('searchNote').hidden = true; return renderItems(); }
  const rows = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
  results = rows.map((r) => state.items.find((i) => i.id === r.id)).filter(Boolean);
  $('searchNote').hidden = false;
  $('searchNote').textContent = `${results.length} match${results.length === 1 ? '' : 'es'} for “${q}”, by meaning and by words.`;
  renderItems();
}

// ---------- add a link / owner key ----------
$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const v = $('addUrl').value.trim();
  if ($('addForm').dataset.mode === 'key') {
    ownerKey = v; store.set('sr.owner', v);
    await load();
    if (!state.owner) { ownerKey = ''; store.set('sr.owner', null); toast('That key didn\'t work'); } else toast('Signed in');
    return;
  }
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Fetching…';
  try {
    const r = await api('/api/items', { method: 'POST', body: JSON.stringify({ url: v }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(d.existed ? 'Already in your pile' : 'Saved. The sloth is reading it…');
    $('addUrl').value = ''; tab = 'all'; await load();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = 'Save for the sloth'; }
};

// ---------- runs ----------
function renderRuns() {
  $('nights').hidden = !state.runs.length;
  $('runs').innerHTML = state.runs.map((r) => `<li><time>${new Date(r.time).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</time>
    <span>${r.processed} read${r.synced ? ` · ${r.synced} new from DEV` : ''}${r.failed ? ` · ${r.failed} failed` : ''}${r.briefed ? ' · wrote the brief' : ''} <small style="color:var(--ink-3)">${(r.ms / 1000).toFixed(0)} s, ${r.trigger === 'schedule' ? 'scheduled' : 'by hand'}</small></span></li>`).join('');
}

// ---------- player ----------
const audio = $('audio');
let now = null;
const SPEEDS = [1, 1.25, 1.5, 1.75];
function srcFor(t) {
  const base = t.kind === 'brief' ? `/api/listen/brief/${t.id}` : `/api/listen/item/${t.id}`;
  return ownerKey ? `${base}?k=${encodeURIComponent(ownerKey)}` : base;
}
function toggle(t) {
  if (now && now.kind === t.kind && now.id === t.id) {
    if (audio.paused) audio.play(); else audio.pause();
    return;
  }
  now = t;
  audio.src = srcFor(t);
  audio.playbackRate = Number(store.get('sr.speed') ?? 1);
  $('pSpeed').textContent = `${audio.playbackRate}×`;
  audio.play().catch(() => toast('Couldn\'t start the audio'));
  $('player').hidden = false;
  $('pTitle').textContent = t.title;
  $('pBar').style.width = '0'; $('briefBar').querySelector('i').style.width = '0';
}
const syncUi = () => {
  const playing = !audio.paused;
  $('player').classList.toggle('playing', playing);
  $('briefPlay').classList.toggle('playing', playing && now?.kind === 'brief');
  document.querySelectorAll('[data-listen]').forEach((b) => b.classList.toggle('on', playing && now?.kind === 'item' && now.id === Number(b.dataset.listen)));
};
audio.onplay = audio.onpause = syncUi;
audio.onended = () => { syncUi(); $('pBar').style.width = '100%'; };
audio.onerror = () => { toast('That audio isn\'t available'); $('player').hidden = true; now = null; syncUi(); };
audio.ontimeupdate = () => {
  const t = audio.currentTime;
  $('pTime').textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  // Streams grow while they play, so the bar measures against what's arrived so far.
  const d = Number.isFinite(audio.duration) ? audio.duration : (audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0);
  const pct = d ? Math.min(100, (t / d) * 100) : 0;
  $('pBar').style.width = `${pct}%`;
  if (now?.kind === 'brief') $('briefBar').querySelector('i').style.width = `${pct}%`;
};
$('pPlay').onclick = () => (audio.paused ? audio.play() : audio.pause());
$('pSpeed').onclick = () => {
  const i = (SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length;
  audio.playbackRate = SPEEDS[i]; store.set('sr.speed', String(SPEEDS[i])); $('pSpeed').textContent = `${SPEEDS[i]}×`;
};
$('pClose').onclick = () => { audio.pause(); audio.removeAttribute('src'); audio.load(); now = null; $('player').hidden = true; syncUi(); };

// Shared from the phone's share sheet, or a bookmarklet: /?add=<url>
const shared = qs.get('add');
if (shared) history.replaceState(null, '', location.pathname);
load().then(() => {
  if (!shared) return;
  if (!state.owner) return toast('Sign in as the owner to save links');
  $('addUrl').value = shared;
  $('addForm').requestSubmit();
});
