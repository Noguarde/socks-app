// Catalog: every Awesome Socks Club design, scraped live from the store's "past designs" page
// (Shopify sends Access-Control-Allow-Origin: *, so this works straight from github.io).
const CATALOG_URL = 'https://good.store/pages/awesome-socks-past-designs';

// Ownership: which designs are still in the drawer. Everyone reads the same baseline from
// owned.json on the repo's `data` branch (anonymous, no token). Only the site owner's device(s)
// write back to it, via a fine-grained token (Contents: read/write on this repo only) — that's
// what makes it "sync across devices" rather than "everyone editing the same shared list."
// Anyone else marking socks owned/missing edits a device-local copy instead (sock_owned_local
// below), so installers can track their own drawer without touching this repo at all.
const REPO = 'Noguarde/socks-app';
const OWNED_PATH = 'owned.json';
const OWNED_BRANCH = 'data';
const OWNED_API = `https://api.github.com/repos/${REPO}/contents/${OWNED_PATH}`;

const CATALOG_CACHE_KEY = 'sock_catalog_cache';
const OWNED_CACHE_KEY = 'sock_owned_cache';
const LOCAL_OWNED_KEY = 'sock_owned_local';
const TOKEN_KEY = 'sock_gh_token';
const HISTORY_KEY = 'sock_history'; // { 'YYYY-MM-DD': pairId }
const REPEAT_COOLDOWN_DAYS = 14;
const SAVE_DEBOUNCE_MS = 1200;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const mainEl = document.getElementById('main');
const recentEl = document.getElementById('recent');
const statsEl = document.getElementById('stats');
const todayEl = document.getElementById('today');
const drawerEl = document.getElementById('drawer');
const tabButtons = document.querySelectorAll('.tab');

const state = {
  catalog: [],          // [{ id, monthKey, date, image, artist }] oldest -> newest
  catalogOffline: false,
  owned: { startMonth: '2023-08', owned: {} },
  ownedSha: null,
  ownedOffline: false,
  localOverrides: {},   // monthKey -> bool, this device's own edits when there's no write token
  pending: {},          // monthKey -> bool, edits not yet written to GitHub
  saveTimer: null,
  saveStatus: '',       // '', 'saving', 'saved', 'error: ...'
  view: 'today',
};

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Catalog (store page) ----------

function parseCatalog(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const monthRe = new RegExp(`^\\s*(${MONTHS.join('|')})\\s+(20\\d\\d)\\s*$`);
  const byMonth = new Map();

  for (const card of doc.querySelectorAll('.multicolumn-card')) {
    // Newer cards put the month in an <h4> (under a design-name <h3>); pre-2023 cards use the <h3> itself.
    const heading = [...card.querySelectorAll('h3, h4')].map(h => h.textContent.match(monthRe)).find(Boolean);
    const img = card.querySelector('img');
    if (!heading || !img) continue;

    const month = MONTHS.indexOf(heading[1]) + 1;
    const year = Number(heading[2]);
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    let src = img.getAttribute('src') || '';
    if (src.startsWith('//')) src = 'https:' + src;
    src = src.replace(/([?&])width=\d+/, '$1width=550');
    // Artist is the first h4/p line that isn't the month; most say "Designed by X", a few are just "X".
    const artistLine = [...card.querySelectorAll('h4, p')]
      .map(el => el.textContent.trim())
      .find(t => t && !monthRe.test(t));
    const artist = artistLine ? artistLine.replace(/^Designed by\s+/i, '') : '';

    if (!byMonth.has(monthKey)) {
      byMonth.set(monthKey, {
        monthKey,
        id: `${monthKey}-01`, // same id format the sheet-based version used, so history carries over
        dateKey: `${monthKey}-01`,
        image: src,
        artist,
      });
    }
  }

  return [...byMonth.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}

function hydrateCatalog(list) {
  return list.map(p => {
    const [y, m, d] = p.dateKey.split('-').map(Number);
    return { ...p, date: new Date(y, m - 1, d) };
  });
}

async function loadCatalog() {
  try {
    const res = await fetch(CATALOG_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`store page HTTP ${res.status}`);
    const catalog = parseCatalog(await res.text());
    if (catalog.length < 12) throw new Error('store page layout changed — found too few designs');
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ catalog, savedAt: Date.now() }));
    return { catalog: hydrateCatalog(catalog), offline: false };
  } catch (err) {
    const cached = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || 'null');
    if (!cached) throw err;
    return { catalog: hydrateCatalog(cached.catalog), offline: true };
  }
}

// ---------- Ownership (owned.json on GitHub) ----------

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json' };
  const token = getToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

async function fetchOwnedRemote() {
  const res = await fetch(`${OWNED_API}?ref=${OWNED_BRANCH}`, { headers: ghHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const json = await res.json();
  return { data: JSON.parse(decodeBase64Utf8(json.content)), sha: json.sha };
}

async function loadOwned() {
  try {
    const { data, sha } = await fetchOwnedRemote();
    localStorage.setItem(OWNED_CACHE_KEY, JSON.stringify({ data, sha }));
    return { data, sha, offline: false };
  } catch (err) {
    const cached = JSON.parse(localStorage.getItem(OWNED_CACHE_KEY) || 'null');
    if (!cached) return { data: state.owned, sha: null, offline: true };
    return { data: cached.data, sha: cached.sha, offline: true };
  }
}

// A design with no explicit entry defaults to owned if it arrived on/after the subscription
// started, so each new month joins the rotation without any tapping. Devices without a write
// token check their own local overrides first, so they can diverge from the shared baseline
// (their drawer, their missing socks) without ever touching owned.json.
function isOwned(pair) {
  if (pair.monthKey in state.pending) return state.pending[pair.monthKey];
  if (!getToken() && pair.monthKey in state.localOverrides) return state.localOverrides[pair.monthKey];
  const explicit = state.owned.owned?.[pair.monthKey];
  if (typeof explicit === 'boolean') return explicit;
  return pair.monthKey >= state.owned.startMonth;
}

function loadLocalOverrides() {
  try { return JSON.parse(localStorage.getItem(LOCAL_OWNED_KEY) || '{}'); }
  catch { return {}; }
}

function setOwned(monthKey, value) {
  if (getToken()) {
    state.pending[monthKey] = value;
    state.saveStatus = '';
    cacheOwnedLocally();
    renderSyncStatus();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveOwned, SAVE_DEBOUNCE_MS);
  } else {
    state.localOverrides[monthKey] = value;
    localStorage.setItem(LOCAL_OWNED_KEY, JSON.stringify(state.localOverrides));
    renderSyncStatus();
  }
}

function cacheOwnedLocally() {
  const merged = { ...state.owned, owned: { ...state.owned.owned, ...state.pending } };
  localStorage.setItem(OWNED_CACHE_KEY, JSON.stringify({ data: merged, sha: state.ownedSha }));
}

async function saveOwned(retried = false) {
  const edits = { ...state.pending };
  if (!Object.keys(edits).length) return;
  state.saveStatus = 'saving';
  renderSyncStatus();

  try {
    // Re-read first so edits made on another device since this one loaded aren't clobbered.
    const remote = await fetchOwnedRemote();
    const next = { ...remote.data, owned: { ...remote.data.owned, ...edits }, updatedAt: new Date().toISOString() };
    const body = {
      message: `Update owned socks (${Object.keys(edits).join(', ')})`,
      content: encodeBase64Utf8(JSON.stringify(next, null, 2) + '\n'),
      sha: remote.sha,
      branch: OWNED_BRANCH,
    };
    const res = await fetch(OWNED_API, {
      method: 'PUT',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 && !retried) return saveOwned(true); // raced another device; try once more
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 || res.status === 404
        ? 'token missing or lacks write access' : `HTTP ${res.status}`;
      throw new Error(hint);
    }
    const json = await res.json();

    state.owned = next;
    state.ownedSha = json.content.sha;
    for (const [k, v] of Object.entries(edits)) {
      if (state.pending[k] === v) delete state.pending[k];
    }
    cacheOwnedLocally();
    state.saveStatus = 'saved';
  } catch (err) {
    state.saveStatus = `error: ${err.message}`;
  }
  renderSyncStatus();
}

// ---------- Picking ----------

function buildInventory() {
  const today = startOfDay(new Date());
  const inventory = state.catalog
    .filter(p => p.date <= today && isOwned(p))
    .map(p => ({ ...p }));
  inventory.forEach((pair, i) => {
    pair.freshRank = i + 1; // 1 = oldest ... N = newest
    pair.weight = pair.freshRank;
  });
  inventory.missingCount = state.catalog
    .filter(p => p.date <= today && p.monthKey >= state.owned.startMonth && !isOwned(p)).length;
  return inventory;
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); }
  catch { return {}; }
}

function saveHistory(hist) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
}

// Deterministic PRNG seeded from a string (mulberry32), so a given date
// reproduces the same pick if history/localStorage is ever cleared.
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(pool, rand) {
  const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
  let r = rand() * totalWeight;
  for (const pair of pool) {
    r -= pair.weight;
    if (r <= 0) return pair;
  }
  return pool[pool.length - 1];
}

function eligiblePool(inventory, history, excludeIds, todayStr) {
  const cooldownStart = new Date();
  cooldownStart.setDate(cooldownStart.getDate() - REPEAT_COOLDOWN_DAYS);
  const recentIds = new Set(
    Object.entries(history)
      .filter(([dateKey]) => dateKey !== todayStr && dateKey >= todayKey(cooldownStart))
      .map(([, id]) => id)
  );
  excludeIds.forEach(id => recentIds.add(id));

  let pool = inventory.filter(p => !recentIds.has(p.id));
  if (pool.length < Math.min(5, inventory.length)) pool = inventory; // fallback if too small
  return pool;
}

function pickForToday(inventory, history, forceReshuffle) {
  const key = todayKey();
  if (!forceReshuffle && history[key]) {
    const existing = inventory.find(p => p.id === history[key]);
    if (existing) return existing;
  }

  const exclude = forceReshuffle && history[key] ? [history[key]] : [];
  const pool = eligiblePool(inventory, history, exclude, key);
  const rand = forceReshuffle ? Math.random : seededRandom(key);
  const pick = weightedPick(pool, rand);

  history[key] = pick.id;
  saveHistory(history);
  return pick;
}

function daysAgo(date) {
  const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return '1 day ago';
  return `${diff} days ago`;
}

// Shopify's CDN resizes on the fly; grid tiles only need a small copy.
function thumb(url) {
  return url.replace(/([?&])width=\d+/, '$1width=300');
}

function monthLabel(pair) {
  return pair.date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// ---------- Rendering ----------

function offlineBanner() {
  const parts = [];
  if (state.catalogOffline) parts.push('store page');
  if (state.ownedOffline) parts.push('sock list');
  if (!parts.length) return '';
  return `<div class="offline-banner">Couldn't reach the ${parts.join(' or ')} &mdash; showing last saved copy.</div>`;
}

function renderToday() {
  const inventory = buildInventory();
  const history = loadHistory();

  if (!inventory.length) {
    mainEl.innerHTML = `<div class="error">No socks marked as owned.<br>Check some off under “My socks”.</div>`;
    recentEl.innerHTML = '';
    statsEl.textContent = '';
    return;
  }

  const pick = pickForToday(inventory, history, false);
  drawToday(inventory, pick, history);
}

function drawToday(inventory, pick, history) {
  mainEl.innerHTML = `
    <div class="pick-card">
      <div class="pick-image-wrap">
        <img src="${escapeHtml(pick.image)}" alt="Today's sock pick">
      </div>
      ${pick.artist ? `<p class="pick-artist">${escapeHtml(monthLabel(pick))} · ${escapeHtml(pick.artist)}</p>` : ''}
      <div class="pick-meta">
        <span>Received <strong>${daysAgo(pick.date)}</strong></span>
        <span>Rank <strong>${pick.freshRank}</strong> of ${inventory.length}</span>
      </div>
      <button class="shuffle-btn" id="shuffleBtn">Shuffle again</button>
    </div>
    ${offlineBanner()}
  `;

  document.getElementById('shuffleBtn').addEventListener('click', () => {
    drawToday(inventory, pickForToday(inventory, history, true), history);
  });

  // Look up in the full catalog so a pair worn before being marked missing still shows here.
  const byId = new Map(state.catalog.map(p => [p.id, p]));
  const recentEntries = Object.entries(history)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 7);

  if (recentEntries.length > 1) {
    const items = recentEntries.map(([dateKey, id]) => {
      const pair = byId.get(id);
      if (!pair) return '';
      const isToday = dateKey === todayKey();
      const [y, m, d] = dateKey.split('-').map(Number);
      const label = isToday ? 'Today' : new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `
        <div class="recent-item${isToday ? ' is-today' : ''}">
          <img src="${escapeHtml(pair.image)}" alt="">
          <span>${label}</span>
        </div>`;
    }).join('');
    recentEl.innerHTML = `<h2>Recently worn</h2><div class="recent-strip">${items}</div>`;
  } else {
    recentEl.innerHTML = '';
  }

  const missingNote = inventory.missingCount
    ? ` · ${inventory.missingCount} marked missing`
    : '';
  statsEl.textContent = `${inventory.length} pairs in rotation${missingNote}`;
}

function renderDrawer() {
  const today = startOfDay(new Date());
  const newestFirst = [...state.catalog].reverse();
  const ownedCount = state.catalog.filter(p => p.date <= today && isOwned(p)).length;
  const hasToken = !!getToken();

  drawerEl.innerHTML = `
    <div class="drawer-head">
      <p>Tap a pair to mark it <strong>owned</strong> or <strong>missing</strong>. ${ownedCount} owned.</p>
      <p id="syncStatus" class="sync-status"></p>
    </div>
    ${offlineBanner()}
    <div class="sock-grid">
      ${newestFirst.map(p => {
        const owned = isOwned(p);
        const future = p.date > today;
        return `
          <button class="sock-tile${owned ? ' is-owned' : ' is-missing'}" data-month="${p.monthKey}"
                  aria-pressed="${owned}">
            <span class="sock-img"><img src="${escapeHtml(thumb(p.image))}" alt="" loading="lazy"></span>
            <span class="sock-badge">${owned ? '✓ Owned' : 'Missing'}</span>
            <span class="sock-label">${escapeHtml(monthLabel(p))}${future ? ' · upcoming' : ''}</span>
            ${p.artist ? `<span class="sock-artist">${escapeHtml(p.artist)}</span>` : ''}
          </button>`;
      }).join('')}
    </div>
    <details class="sync-settings">
      <summary>Sync across your own devices</summary>
      <p>Marking socks above saves to this device only. If this repo is yours and you want
         those picks to follow you across your own phone/tablet/etc., paste a fine-grained
         GitHub token with <em>Contents: read and write</em> on <code>${REPO}</code> only —
         it'll write to <code>${OWNED_PATH}</code> on the <code>${OWNED_BRANCH}</code> branch
         instead of just this browser. Everyone else should leave this blank.</p>
      <div class="token-row">
        <input id="tokenInput" type="password" autocomplete="off" placeholder="${hasToken ? 'Token saved on this device' : 'github_pat_… (owner only)'}">
        <button id="tokenSave">Save</button>
        ${hasToken ? '<button id="tokenClear" class="secondary">Remove</button>' : ''}
      </div>
    </details>
  `;

  drawerEl.querySelectorAll('.sock-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const pair = state.catalog.find(p => p.monthKey === tile.dataset.month);
      const owned = !isOwned(pair);
      setOwned(pair.monthKey, owned);
      tile.classList.toggle('is-owned', owned);
      tile.classList.toggle('is-missing', !owned);
      tile.setAttribute('aria-pressed', owned);
      tile.querySelector('.sock-badge').textContent = owned ? '✓ Owned' : 'Missing';
      const n = state.catalog.filter(p => p.date <= today && isOwned(p)).length;
      drawerEl.querySelector('.drawer-head p').innerHTML =
        `Tap a pair to mark it <strong>owned</strong> or <strong>missing</strong>. ${n} owned.`;
    });
  });

  document.getElementById('tokenSave').addEventListener('click', async () => {
    const value = document.getElementById('tokenInput').value.trim();
    if (!value) return;
    localStorage.setItem(TOKEN_KEY, value);
    await refreshOwned();
    renderDrawer();
  });
  document.getElementById('tokenClear')?.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    renderDrawer();
  });

  renderSyncStatus();
}

function renderSyncStatus() {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const s = state.saveStatus;
  el.className = 'sync-status';
  if (!getToken()) {
    el.textContent = Object.keys(state.localOverrides).length
      ? 'Saved on this device only.'
      : 'Tracking your own list on this device.';
  } else if (s.startsWith('error')) {
    el.textContent = `Not saved (${s.slice(7)}). Tap a pair again to retry.`;
    el.classList.add('is-error');
  } else if (s === 'saving' || Object.keys(state.pending).length) {
    el.textContent = 'Saving…';
  } else if (s === 'saved') {
    el.textContent = 'Saved — synced to all devices.';
  } else {
    el.textContent = 'Synced.';
  }
}

function showView(view) {
  state.view = view;
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const onToday = view === 'today';
  mainEl.hidden = !onToday;
  recentEl.hidden = !onToday;
  statsEl.hidden = !onToday;
  drawerEl.hidden = onToday;
  if (onToday) renderToday(); else renderDrawer();
}

async function refreshOwned() {
  const { data, sha, offline } = await loadOwned();
  state.owned = { startMonth: '2023-08', owned: {}, ...data };
  state.ownedSha = sha;
  state.ownedOffline = offline;
}

async function init() {
  todayEl.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  });
  tabButtons.forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  state.localOverrides = loadLocalOverrides();

  try {
    const [{ catalog, offline }] = await Promise.all([loadCatalog(), refreshOwned()]);
    state.catalog = catalog;
    state.catalogOffline = offline;
    showView(state.view);
  } catch (err) {
    mainEl.innerHTML = `<div class="error">Couldn't load sock data.<br>${escapeHtml(err.message)}</div>`;
  }
}

init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
