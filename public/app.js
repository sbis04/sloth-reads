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
  $('briefSub').textContent = `${Math.max(1, Math.round(b.script.split(/\s+/).length / 160))} min listen · ${n} articles`;
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
  const canListen = i.has_audio || state.owner || state.voice_open;
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
      <button class="ghost small listen" type="button" data-listen="${i.id}" ${i.status === 'done' ? '' : 'disabled'} title="${canListen ? 'Open it here and read it to me' : 'Open it here (the voice is resting until tomorrow)'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l5 4V6L7 10H4zm12.5 2A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" fill="currentColor"/></svg>Read &amp; listen</button>
      ${!canListen && i.status === 'done' ? '<span class="not-voiced">Voice resting till tomorrow</span>' : ''}
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
  if (d) {
    // Update the card at once; the server catches up in the background.
    const it = state.items.find((x) => x.id === Number(d.dataset.done));
    it.finished_at = it.finished_at ? null : new Date().toISOString();
    renderTabs(); renderItems();
    toast(it.finished_at ? 'Marked done' : 'Back in your pile');
    await api(`/api/items/${it.id}/done`, { method: 'POST' });
    return load();
  }
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
    $('addUrl').value = '';
    $('addUrl').value = '';
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

// ---------- player + reader ----------
// One <audio> element plays everything. Opening something shows the reader: the spoken text on screen,
// each word lit up as it's said (timings come with the ElevenLabs audio and are cached with it).
const audio = $('audio');
let now = null;            // { kind, id, title }
let align = null;          // { chunks: [{ i, offset, words: [[t, char, len]] }], complete }
let alignTimer = null;
let words = [];            // flat, time-ordered: { t, el, chunk }
let lastLit = null;
const SPEEDS = [1, 1.25, 1.5, 1.75];

function srcFor(t) {
  const base = `/api/listen/${t.kind}/${t.id}`;
  return ownerKey ? `${base}?k=${encodeURIComponent(ownerKey)}` : base;
}

async function open(t) {
  if (now && now.kind === t.kind && now.id === t.id) { $('reader').hidden = false; document.body.classList.add('reading'); return; }
  stop();
  now = t;
  $('reader').hidden = false; document.body.classList.add('reading');
  $('rText').innerHTML = '<p class="wait"><span class="spinner"></span>Opening…</p>';
  const doc = await api(`/api/read/${t.kind}/${t.id}`).then((r) => r.json());
  if (now !== t) return;
  $('rTitle').textContent = doc.title;
  $('rSite').textContent = t.kind === 'brief' ? 'Morning brief' : doc.site;
  $('rMeta').textContent = t.kind === 'brief' ? 'Everything the sloth read overnight, in a minute.' : [doc.author, doc.read_minutes && `${doc.read_minutes} min read, or listen`].filter(Boolean).join(' · ');
  $('rCover').style.backgroundImage = doc.cover ? `url('${doc.cover.replace(/'/g, '%27')}')` : '';
  $('rCover').hidden = !doc.cover;
  $('rOpen').hidden = !doc.url; if (doc.url) $('rOpen').href = doc.url;
  renderText(doc.chunks);
  $('reader').scrollTop = 0;
  // No voice budget left and nothing cached: it's a reading view only.
  const cached = t.kind === 'brief' ? state.brief?.has_audio : state.items.find((i) => i.id === t.id)?.has_audio;
  if (!state.owner && !state.voice_open && !cached) { toast('The voice is resting until tomorrow, but you can read it here'); return; }
  audio.src = srcFor(t);
  audio.playbackRate = Number(store.get('sr.speed') ?? 1);
  $('pSpeed').textContent = `${audio.playbackRate}×`;
  $('player').hidden = false; $('pTitle').textContent = t.title;
  audio.play().catch(() => toast('Tap play to start'));
  pollAlign();
}

// Words become spans keyed by (chunk, character offset), the same coordinates the timings use.
function renderText(chunks) {
  const frag = document.createDocumentFragment();
  chunks.forEach((text, ci) => {
    let base = 0;
    for (const para of text.split(/\n\n/)) {
      const p = document.createElement('p');
      p.className = 'ahead';
      const re = /\S+|\s+/g; let m;
      while ((m = re.exec(para))) {
        if (/^\s+$/.test(m[0])) { p.append(m[0]); continue; }
        const w = document.createElement('span');
        w.className = 'w'; w.textContent = m[0];
        w.dataset.k = `${ci}:${base + m.index}`;
        p.append(w);
      }
      frag.append(p);
      base += para.length + 2;
    }
  });
  $('rText').replaceChildren(frag);
  words = []; lastLit = null;
}

function indexWords() {
  if (!align) return;
  const byKey = new Map([...$('rText').querySelectorAll('.w')].map((el) => [el.dataset.k, el]));
  words = [];
  for (const c of align.chunks) for (const [t, ch] of c.words) {
    const el = byKey.get(`${c.i}:${ch}`);
    if (el) words.push({ t: c.offset + t, el });
  }
  words.sort((x, y) => x.t - y.t);
}

async function pollAlign() {
  clearTimeout(alignTimer);
  if (!now) return;
  const t = now;
  try {
    const a = await fetch(`/api/align/${t.kind}/${t.id}`).then((r) => r.json());
    if (now !== t) return;
    align = a; indexWords();
    if (!a.complete) alignTimer = setTimeout(pollAlign, 1200);
  } catch { alignTimer = setTimeout(pollAlign, 2500); }
}

// Highlight the word being spoken; everything before it reads as "said".
function tick() {
  if (now && words.length) {
    const t = audio.currentTime;
    let lo = 0, hi = words.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (words[mid].t <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    const w = k >= 0 ? words[k].el : null;
    if (w !== lastLit) {
      lastLit?.classList.remove('now');
      if (w) {
        w.classList.add('now');
        // mark progress: words up to here are said, their paragraph is no longer "ahead"
        const from = lastLit ? words.findIndex((x) => x.el === lastLit) : 0;
        for (let i = Math.max(0, from); i <= k; i++) { words[i].el.classList.add('said'); words[i].el.parentElement.classList.remove('ahead'); }
        if ($('rFollow').getAttribute('aria-pressed') === 'true' && !$('reader').hidden) {
          const r = w.getBoundingClientRect();
          if (r.top < 90 || r.bottom > innerHeight * 0.62) w.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
      lastLit = w;
    }
  }
  if (!audio.paused) requestAnimationFrame(tick);
}

// Tap a word (or a paragraph) to jump there, once that part has been spoken and cached.
$('rText').onclick = (e) => {
  const p = e.target.closest('p'); if (!p) return;
  const w = e.target.closest('.w');
  const hit = (w && words.find((x) => x.el === w)) || words.find((x) => p.contains(x.el));
  if (!hit) return toast('The sloth hasn\'t reached that part yet');
  const seekable = audio.seekable.length && audio.seekable.end(audio.seekable.length - 1) >= hit.t;
  if (!seekable) return toast('That part is still being spoken. Jumping works once it has finished.');
  audio.currentTime = hit.t;
  words.forEach((x) => x.el.classList.toggle('said', x.t < hit.t));
  if (audio.paused) audio.play();
};
$('rFollow').onclick = () => {
  const on = $('rFollow').getAttribute('aria-pressed') !== 'true';
  $('rFollow').setAttribute('aria-pressed', String(on));
  if (on && lastLit) lastLit.scrollIntoView({ block: 'center', behavior: 'smooth' });
};
// Scrolling by hand pauses follow-along, like a music app's lyrics view.
$('reader').addEventListener('wheel', () => $('rFollow').setAttribute('aria-pressed', 'false'), { passive: true });
$('reader').addEventListener('touchmove', () => $('rFollow').setAttribute('aria-pressed', 'false'), { passive: true });
const closeReader = () => { $('reader').hidden = true; document.body.classList.remove('reading'); };
$('rClose').onclick = closeReader;
addEventListener('keydown', (e) => {
  if ($('reader').hidden) return;
  if (e.key === 'Escape') closeReader();
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
});

function toggle(t) {
  if (now && now.kind === t.kind && now.id === t.id) {
    $('reader').hidden = false; document.body.classList.add('reading');
    if (audio.paused) audio.play();
    return;
  }
  open(t);
}
function stop() {
  clearTimeout(alignTimer);
  audio.pause(); audio.removeAttribute('src'); audio.load();
  now = null; align = null; words = []; lastLit = null;
}
const syncUi = () => {
  const playing = !audio.paused;
  $('player').classList.toggle('playing', playing);
  $('briefPlay').classList.toggle('playing', playing && now?.kind === 'brief');
  if (playing) requestAnimationFrame(tick);
};
audio.onplay = audio.onpause = syncUi;
audio.onended = () => { syncUi(); $('pBar').style.width = '100%'; };
// Clearing the source on stop fires an error a moment later; only react to errors from what's playing now.
audio.onerror = () => {
  if (!now || !audio.getAttribute('src') || audio.src !== new URL(srcFor(now), location.href).href) return;
  toast('The voice is resting until tomorrow, but you can read it here'); $('player').hidden = true;
  clearTimeout(alignTimer); audio.removeAttribute('src'); syncUi();
};
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
$('pTitle').onclick = () => { if (now) { $('reader').hidden = false; document.body.classList.add('reading'); } };
$('pClose').onclick = () => { stop(); $('player').hidden = true; closeReader(); syncUi(); };

// Shared from the phone's share sheet, or a bookmarklet: /?add=<url>
const shared = qs.get('add');
if (shared) history.replaceState(null, '', location.pathname);
load().then(() => {
  if (!shared) return;
  if (!state.owner) return toast('Sign in as the owner to save links');
  $('addUrl').value = shared;
  $('addForm').requestSubmit();
});
