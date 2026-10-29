// Попап: громкость и эквалайзер для сайта в активной вкладке.

const $ = (id) => document.getElementById(id);

let tab = null;
let host = null;
let cur = { ...DEFAULTS };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pctOf = (s) => Math.round(s.volume * 100);
// Позиция внутри хода ползунка (бегунок 20px), чтобы заливка доходила ровно до его центра.
const along = (frac) => `calc(10px + (100% - 20px) * ${frac})`;
const fmtDb = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0') + ' дБ';

// ---------- ввод процентов ----------

const pctInput = $('pct');
let editing = false; // пока человек печатает, не перетираем поле

function fitPct() {
  pctInput.style.width = `${Math.max(1, pctInput.value.length)}ch`;
}

function commitPct() {
  if (!editing) return;
  editing = false;
  const v = pctInput.value.trim();
  if (v === '') render();
  else setVolume(Number(v));
}

pctInput.addEventListener('focus', () => {
  editing = false;
  pctInput.select();
});

pctInput.addEventListener('input', () => {
  editing = true;
  pctInput.value = pctInput.value.replace(/\D/g, '').slice(0, 3);
  fitPct();
});

pctInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    commitPct();
    pctInput.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    editing = false;
    pctInput.blur();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    editing = false;
    const step = e.shiftKey ? 10 : 1;
    setVolume(pctOf(cur) + (e.key === 'ArrowUp' ? step : -step));
  }
});

pctInput.addEventListener('blur', () => {
  commitPct();
  render();
});

// ---------- отрисовка ----------

function render() {
  const pct = pctOf(cur);

  if (!editing) pctInput.value = pct;
  fitPct();

  const vol = $('vol');
  vol.value = pct;
  vol.style.setProperty('--p', along(pct / 600));

  for (const b of $('presets').children) {
    b.classList.toggle('active', Number(b.dataset.v) === pct);
  }

  renderEq('bass', cur.bass);
  renderEq('treble', cur.treble);
  $('reset').disabled = !host || isDefault(cur);
}

function renderEq(id, v) {
  const input = $(id);
  input.value = v;
  const f = (v + 15) / 30;
  input.style.setProperty('--lo', along(Math.min(0.5, f)));
  input.style.setProperty('--hi', along(Math.max(0.5, f)));
  $(`${id}Out`).textContent = fmtDb(v);
}

function make(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function renderList(sites) {
  const list = $('list');
  const hosts = Object.keys(sites).sort();
  $('count').textContent = hosts.length;
  list.replaceChildren();

  if (!hosts.length) {
    list.append(make('li', 'empty', 'Пока пусто — настройте звук на любом сайте.'));
    return;
  }

  for (const h of hosts) {
    const s = sites[h];
    const li = make('li', h === host ? 'current' : '');
    const eq = s.bass || s.treble ? ' · EQ' : '';
    const x = make('button', 'x', '×');
    x.title = 'Удалить настройки сайта';
    x.addEventListener('click', () => removeSite(h));
    li.append(make('span', 'h', h), make('span', 'v', `${pctOf(s)}%${eq}`), x);
    list.append(li);
  }
}

function setFavicon() {
  const box = $('fav');
  box.textContent = host ? host[0] : '?';
  const url = tab && tab.favIconUrl;
  if (!url || !/^(https?|data):/.test(url)) return;
  const img = new Image();
  img.alt = '';
  img.onload = () => box.replaceChildren(img);
  img.src = url;
}

// ---------- сохранение ----------

// Пока тянут ползунок, пишем в storage не чаще раза в 40 мс.
let saveQueued = false;
function save() {
  if (!host || saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    const { sites = {} } = await browser.storage.local.get('sites');
    if (isDefault(cur)) delete sites[host];
    else sites[host] = { ...cur };
    await browser.storage.local.set({ sites });
    renderList(sites);
  }, 40);
}

async function removeSite(h) {
  const { sites = {} } = await browser.storage.local.get('sites');
  delete sites[h];
  await browser.storage.local.set({ sites });
  if (h === host) {
    cur = { ...DEFAULTS };
    render();
  }
  renderList(sites);
}

function setVolume(pct) {
  cur.volume = clamp(Math.round(pct), 0, 600) / 100;
  render();
  save();
}

function setEq(key, v) {
  cur[key] = clamp(Math.round(v), -15, 15);
  render();
  save();
}

// ---------- события ----------

$('vol').addEventListener('input', (e) => setVolume(Number(e.target.value)));

$('dial').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    setVolume(pctOf(cur) + (e.deltaY < 0 ? 5 : -5));
  },
  { passive: false }
);

for (const b of $('presets').children) {
  b.addEventListener('click', () => setVolume(Number(b.dataset.v)));
}

for (const key of ['bass', 'treble']) {
  const input = $(key);
  input.addEventListener('input', () => setEq(key, Number(input.value)));
  input.addEventListener('dblclick', () => setEq(key, 0));
}

$('reset').addEventListener('click', () => {
  cur = { ...DEFAULTS };
  render();
  save();
});

$('grant').addEventListener('click', async () => {
  const ok = await browser.permissions.request({ origins: ['<all_urls>'] });
  if (ok) {
    $('perm').hidden = true;
    $('hint').hidden = false;
  }
});

// ---------- старт ----------

async function checkTab() {
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'ping' });
  } catch (_) {
    $('hint').hidden = false;
  }
}

async function init() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  host = hostFromUrl(tab && tab.url);

  const granted = await browser.permissions.contains({ origins: ['<all_urls>'] });
  $('perm').hidden = granted;

  const { sites = {} } = await browser.storage.local.get('sites');

  if (!host) {
    $('host').textContent = 'Служебная страница';
    $('fav').textContent = '·';
    $('unsupported').hidden = false;
    document.body.classList.add('disabled');
    render();
    renderList(sites);
    return;
  }

  $('host').textContent = host;
  setFavicon();
  cur = { ...DEFAULTS, ...sites[host] };
  render();
  renderList(sites);
  if (granted) checkTab();
}

init();
