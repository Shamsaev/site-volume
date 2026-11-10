// Контент-скрипт: находит <audio>/<video> на странице и пропускает их звук
// через Web Audio: басы → высокие → громкость → (лимитер, если нужен) → выход.
// Пока для сайта стоят настройки по умолчанию, страницу не трогаем вообще.

(() => {
  'use strict';

  if (window.__siteVolumeLoaded) return;
  window.__siteVolumeLoaded = true;

  const DEFAULTS = { volume: 1, bass: 0, treble: 0 };
  const isDefault = (s) => s.volume === 1 && s.bass === 0 && s.treble === 0;

  let host = null;
  let settings = { ...DEFAULTS };
  let ctx = null;

  const graphs = new Map();    // элемент → цепочка узлов Web Audio
  const fallbacks = new Map(); // элемент → запасной режим через element.volume
  const pending = new WeakSet();

  // ---------- Web Audio ----------

  // Лимитер нужен, только когда сигнал может выйти за 0 дБFS: при усилении
  // или подъёме эквалайзера. Иначе звук идёт напрямую, без обработки.
  const needsLimiter = (s) => s.volume > 1 || s.bass > 0 || s.treble > 0;

  // Параметры подобраны замером: медленная атака не ломает форму волны на басах,
  // а подрезка −2.5 дБ гасит встроенный makeup gain компрессора, который иначе
  // постоянно упирает сигнал в потолок и даёт хрип.
  const LIMITER = { threshold: -4, knee: 4, ratio: 20, attack: 0.05, release: 0.8, trim: 0.75 };

  // Мягкий ограничитель: до 0.9 линейно, выше плавно прижимается к 1.0,
  // поэтому до звуковой карты не доходят значения больше 1 (жёсткий клип = хрип).
  // WaveShaper обрезает вход за пределами [-1, 1], поэтому на входе делим на HEADROOM.
  const HEADROOM = 4;
  const KNEE_START = 0.9;
  const CEILING = 0.98; // запас под выбросы фильтра передискретизации (oversample 4x)
  let softClipCurve = null;
  function getSoftClipCurve() {
    if (softClipCurve) return softClipCurve;
    const n = 4096;
    const a = KNEE_START;
    softClipCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * HEADROOM;
      const ax = Math.abs(x);
      const y = ax <= a ? ax : a + (1 - a) * Math.tanh((ax - a) / (1 - a));
      softClipCurve[i] = Math.sign(x) * y * CEILING;
    }
    return softClipCurve;
  }

  // AudioContext без действия пользователя может остаться "suspended".
  // Подключать элемент к спящему контексту нельзя — звук пропадёт.
  async function ensureContext() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'running') return true;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    } catch (_) {
      // остаёмся в suspended
    }
    return ctx.state === 'running';
  }

  // Медиа с чужого домена без CORS Web Audio отдаёт как тишину,
  // поэтому такие элементы регулируем только через element.volume (до 100%).
  function corsSafe(el) {
    if (el.srcObject) return true;
    const src = el.currentSrc || el.src;
    if (!src) return false;
    if (/^(blob|data|mediasource):/.test(src)) return true;
    try {
      if (new URL(src, location.href).origin === location.origin) return true;
    } catch (_) {
      // кривой адрес — считаем чужим
    }
    return el.crossOrigin !== null;
  }

  async function attach(el) {
    if (graphs.has(el) || fallbacks.has(el) || pending.has(el)) return;
    if (!el.srcObject && !el.currentSrc && !el.src) return; // источника ещё нет, дождёмся play

    if (!corsSafe(el)) {
      useFallback(el);
      return;
    }

    pending.add(el);
    try {
      if (!(await ensureContext())) {
        waitForGesture();
        return;
      }
      if (graphs.has(el)) return;

      const source = ctx.createMediaElementSource(el);

      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 200;

      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 3500;

      const gain = ctx.createGain();

      // Две параллельные ветки с плавным переключением:
      //   dry — напрямую (громкость ≤ 100% и эквалайзер не поднят),
      //   wet — компрессор → подрезка → мягкий ограничитель.
      // Компрессор в wet работает постоянно, поэтому при переключении нет скачка.
      const dry = ctx.createGain();

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = LIMITER.threshold;
      limiter.knee.value = LIMITER.knee;
      limiter.ratio.value = LIMITER.ratio;
      limiter.attack.value = LIMITER.attack;
      limiter.release.value = LIMITER.release;

      const trim = ctx.createGain();
      trim.gain.value = LIMITER.trim / HEADROOM;

      const clip = ctx.createWaveShaper();
      clip.curve = getSoftClipCurve();
      clip.oversample = '4x';

      const wet = ctx.createGain();

      source.connect(bass).connect(treble).connect(gain);
      gain.connect(dry).connect(ctx.destination);
      gain.connect(limiter).connect(trim).connect(clip).connect(wet).connect(ctx.destination);

      const nodes = { bass, treble, gain, dry, wet };
      graphs.set(el, nodes);
      setNodes(nodes, true);
    } catch (_) {
      // Например, сайт уже сам подключил элемент к своему AudioContext.
      useFallback(el);
    } finally {
      pending.delete(el);
    }
  }

  // Сколько ждать между переключением веток и сменой уровней, с.
  const SWITCH_GAP = 0.1;

  function setNodes(n, instant = false) {
    const on = needsLimiter(settings);
    const t = ctx.currentTime;

    // Порядок важен: прямая ветка не должна пропустить усиленный сигнал.
    // Включаем лимитер — сначала переключаем ветку, потом поднимаем уровни.
    // Выключаем — сначала опускаем уровни (они ещё идут через лимитер), потом переключаем.
    const turningOn = on && !n.on;
    const turningOff = !on && n.on;
    const tLevels = turningOn ? t + SWITCH_GAP : t;
    const tSwitch = turningOff ? t + SWITCH_GAP : t;

    const set = (param, v, at) => {
      if (instant) {
        param.value = v;
        return;
      }
      param.cancelScheduledValues(t); // отменяем отложенные шаги прошлого вызова
      param.setTargetAtTime(v, at, 0.015); // плавно, без щелчков
    };

    set(n.gain.gain, settings.volume, tLevels);
    set(n.bass.gain, settings.bass, tLevels);
    set(n.treble.gain, settings.treble, tLevels);
    set(n.wet.gain, on ? 1 : 0, tSwitch);
    set(n.dry.gain, on ? 0 : 1, tSwitch);
    n.on = on;
  }

  // ---------- Запасной режим: element.volume ----------

  // Громкость, которую выставил сам сайт, запоминаем и умножаем на нашу.
  function useFallback(el) {
    if (fallbacks.has(el)) return;
    const fb = { base: el.volume, ours: null };
    fallbacks.set(el, fb);
    el.addEventListener('volumechange', () => {
      if (fb.ours !== null && Math.abs(el.volume - fb.ours) < 1e-4) return; // это мы
      fb.base = el.volume;
      applyFallback(el, fb);
    });
    applyFallback(el, fb);
  }

  function applyFallback(el, fb) {
    const v = Math.min(1, Math.max(0, fb.base * Math.min(1, settings.volume)));
    fb.ours = v;
    if (Math.abs(el.volume - v) > 1e-4) el.volume = v;
  }

  // ---------- Обход страницы ----------

  let waitingGesture = false;
  function waitForGesture() {
    if (waitingGesture) return;
    waitingGesture = true;
    const events = ['pointerdown', 'keydown'];
    const onGesture = () => {
      events.forEach((t) => window.removeEventListener(t, onGesture, true));
      waitingGesture = false;
      if (ctx) ctx.resume().catch(() => {});
      scan();
    };
    events.forEach((t) => window.addEventListener(t, onGesture, true));
  }

  function scan() {
    if (isDefault(settings)) return;
    for (const el of document.querySelectorAll('audio, video')) attach(el);
  }

  function applyAll() {
    for (const n of graphs.values()) setNodes(n);
    for (const [el, fb] of fallbacks) applyFallback(el, fb);
    scan();
  }

  // play не всплывает, но ловится на фазе перехвата.
  document.addEventListener(
    'play',
    (e) => {
      if (!isDefault(settings) && e.target instanceof HTMLMediaElement) attach(e.target);
    },
    true
  );

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sites || !host) return;
    settings = { ...DEFAULTS, ...(changes.sites.newValue || {})[host] };
    applyAll();
  });

  // Попап проверяет, подключился ли скрипт к вкладке.
  if (window === window.top) {
    browser.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'ping') return Promise.resolve({ ok: true });
      return undefined;
    });
  }

  (async () => {
    try {
      const res = await browser.runtime.sendMessage({ type: 'get-host' });
      host = res && res.host;
      if (!host) return;
      const { sites = {} } = await browser.storage.local.get('sites');
      settings = { ...DEFAULTS, ...sites[host] };
      applyAll();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyAll, { once: true });
      }
    } catch (_) {
      // фон недоступен — просто ничего не делаем
    }
  })();
})();
