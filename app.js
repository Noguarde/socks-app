const SHEET_ID = '179ZWy3_yE3OS7tN10a0lc1UYXRQKknmfoWMZkiOkFY8';
const GID = '545142870';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`;

const CACHE_KEY = 'sock_inventory_cache';
const HISTORY_KEY = 'sock_history'; // { 'YYYY-MM-DD': pairId }
const REPEAT_COOLDOWN_DAYS = 14;

const mainEl = document.getElementById('main');
const recentEl = document.getElementById('recent');
const statsEl = document.getElementById('stats');
const todayEl = document.getElementById('today');

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Minimal CSV line parser: handles quoted fields, no embedded quotes-within-quotes needed here.
function parseCsv(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const fields = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') { inQuotes = false; }
          else { cur += ch; }
        } else {
          if (ch === '"') { inQuotes = true; }
          else if (ch === ',') { fields.push(cur); cur = ''; }
          else { cur += ch; }
        }
      }
      fields.push(cur);
      return fields;
    });
}

function parseDate(str) {
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, month, day, year] = m;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

function buildInventory(rows) {
  const today = startOfDay(new Date());
  const candidates = [];
  let lostCount = 0;

  for (const row of rows) {
    const [dateStr, imageUrl, rankStr] = row;
    const date = parseDate((dateStr || '').trim());
    const image = (imageUrl || '').trim();
    const rank = (rankStr || '').trim();

    if (!date || !image) continue;       // not yet received / no photo
    if (date > today) continue;           // scheduled for the future
    if (!rank || rank.toLowerCase() === 'missing') { lostCount++; continue; } // lost pair, skip

    candidates.push({ date, image, receivedKey: todayKey(date) });
  }

  candidates.sort((a, b) => a.date - b.date);
  candidates.forEach((pair, i) => {
    pair.id = pair.receivedKey; // one pair per month, unique
    pair.freshRank = i + 1;      // 1 = oldest ... N = newest
    pair.weight = pair.freshRank;
  });

  candidates.lostCount = lostCount;
  return candidates;
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

function render(inventory, pick, history, offline) {
  todayEl.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  mainEl.innerHTML = `
    <div class="pick-card">
      <div class="pick-image-wrap">
        <img src="${pick.image}" alt="Today's sock pick">
      </div>
      <div class="pick-meta">
        <span>Received <strong>${daysAgo(pick.date)}</strong></span>
        <span>Rank <strong>${pick.freshRank}</strong> of ${inventory.length}</span>
      </div>
      <button class="shuffle-btn" id="shuffleBtn">Shuffle again</button>
    </div>
    ${offline ? '<div class="offline-banner">Offline &mdash; showing last saved inventory.</div>' : ''}
  `;

  document.getElementById('shuffleBtn').addEventListener('click', () => {
    const newPick = pickForToday(inventory, history, true);
    render(inventory, newPick, history, offline);
  });

  const recentEntries = Object.entries(history)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 7);

  if (recentEntries.length > 1) {
    const items = recentEntries.map(([dateKey, id]) => {
      const pair = inventory.find(p => p.id === id);
      if (!pair) return '';
      const isToday = dateKey === todayKey();
      const [y, m, d] = dateKey.split('-').map(Number);
      const label = isToday ? 'Today' : new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return `
        <div class="recent-item${isToday ? ' is-today' : ''}">
          <img src="${pair.image}" alt="">
          <span>${label}</span>
        </div>`;
    }).join('');
    recentEl.innerHTML = `<h2>Recently worn</h2><div class="recent-strip">${items}</div>`;
  } else {
    recentEl.innerHTML = '';
  }

  const missingNote = inventory.lostCount
    ? ` · ${inventory.lostCount} lost pair${inventory.lostCount === 1 ? '' : 's'} skipped`
    : '';
  statsEl.textContent = `${inventory.length} pairs in rotation${missingNote}`;
}

async function loadInventory() {
  try {
    const res = await fetch(CSV_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCsv(text);
    const inventory = buildInventory(rows);
    if (!inventory.length) throw new Error('No valid sock pairs found');
    localStorage.setItem(CACHE_KEY, JSON.stringify({ rows, savedAt: Date.now() }));
    return { inventory, offline: false };
  } catch (err) {
    const cachedRaw = localStorage.getItem(CACHE_KEY);
    if (!cachedRaw) throw err;
    const { rows } = JSON.parse(cachedRaw);
    const inventory = buildInventory(rows);
    if (!inventory.length) throw err;
    return { inventory, offline: true };
  }
}

async function init() {
  try {
    const { inventory, offline } = await loadInventory();
    const history = loadHistory();
    const pick = pickForToday(inventory, history, false);
    render(inventory, pick, history, offline);
  } catch (err) {
    mainEl.innerHTML = `<div class="error">Couldn't load sock data.<br>${err.message}</div>`;
  }
}

init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
