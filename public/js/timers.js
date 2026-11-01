// ── Cooking timers ────────────────────────────────────────────────────────────
// Click a timer in a step ("⏱ 40 min") to start it. Timers live in a tray at
// the bottom of the window, on every page, and survive a reload: each stores
// its end time, not the time left. A range ("18-24 hours") counts to the low
// end, alerts, then counts on to the high end and alerts again.
//
// Alerts (sound + notification) only fire while AjiLab is open in a tab; the
// tray says so. Notification permission is asked on the first Start, and that
// click also unlocks sound.

const Timers = (() => {
  const KEY = 'ajilab:timers';
  const UNIT_MS = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
    h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
    d: 86400000, day: 86400000, days: 86400000,
  };
  let timers = load();
  let ticker = null;
  let audio = null;
  let tray = null;

  function load() {
    try {
      const list = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      return Array.isArray(list)
        ? list.filter((t) => t && typeof t.id === 'string' && Number.isFinite(t.minAt) && Number.isFinite(t.maxAt))
        : [];
    } catch { return []; }
  }

  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(timers)); } catch {}
  }

  // "40" + "min" → ms; "18-24" + "hours" → [low, high] in ms.
  function durations(quantity, units, rangeMin, rangeMax) {
    const per = UNIT_MS[String(units || '').trim().toLowerCase()];
    if (!per) return null;
    // An empty range ("") must not read as 0.
    const num = (v) => (v === '' || v == null ? NaN : Number(v));
    let low = num(rangeMin);
    let high = num(rangeMax);
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      const parts = String(quantity).split(/\s*[-–]\s*/).map(Number);
      low = parts[0];
      high = parts.length > 1 ? parts[1] : parts[0];
    }
    if (!Number.isFinite(low) || low <= 0) return null;
    if (!Number.isFinite(high) || high < low) high = low;
    return [low * per, high * per];
  }

  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // "40 min", "18 h", "1 h 30 min"
  function span(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return `${Math.round(ms / 1000)} s`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return `${m} min`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  // ── Sound and notifications ──

  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audio = audio || new Ctx();
      if (audio.state === 'suspended') audio.resume();
    } catch {}
  }

  function beep() {
    try {
      if (!audio) unlockAudio();
      if (!audio) return;
      const start = audio.currentTime + 0.02;
      for (let i = 0; i < 3; i++) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, start + i * 0.35);
        gain.gain.exponentialRampToValueAtTime(0.25, start + i * 0.35 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.35 + 0.25);
        osc.connect(gain).connect(audio.destination);
        osc.start(start + i * 0.35);
        osc.stop(start + i * 0.35 + 0.3);
      }
    } catch {}
  }

  function askPermission() {
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch {}
  }

  function notify(timer, message) {
    beep();
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(message, { body: `${timer.recipe ? `${timer.recipe} — ` : ''}${timer.label}`, tag: timer.id });
      }
    } catch {}
  }

  // ── State ──

  function phase(timer, now = Date.now()) {
    const ranged = timer.maxAt > timer.minAt;
    if (now < timer.minAt) return 'running';
    if (ranged && now < timer.maxAt) return 'window';
    return 'done';
  }

  function check() {
    const now = Date.now();
    let changed = false;
    for (const t of timers) {
      const ranged = t.maxAt > t.minAt;
      if (!t.firedMin && now >= t.minAt) {
        t.firedMin = true;
        changed = true;
        notify(t, ranged ? `${span(t.minAt - t.startedAt)} reached (up to ${span(t.maxAt - t.startedAt)})` : `${span(t.minAt - t.startedAt)} timer done`);
      }
      if (ranged && !t.firedMax && now >= t.maxAt) {
        t.firedMax = true;
        changed = true;
        notify(t, `${span(t.maxAt - t.startedAt)} reached — end of the range`);
      }
    }
    if (changed) save();
  }

  function statusText(t, now = Date.now()) {
    const p = phase(t, now);
    const full = span(t.maxAt - t.startedAt);
    if (p === 'running') {
      return t.maxAt > t.minAt ? `${clock(t.minAt - now)} · up to ${full}` : clock(t.minAt - now);
    }
    if (p === 'window') return `${span(t.minAt - t.startedAt)} reached · ${clock(t.maxAt - now)} to ${full}`;
    return `Done · ${clock(now - t.maxAt)} ago`;
  }

  // ── Tray ──

  function ensureTray() {
    if (tray) return tray;
    tray = document.createElement('section');
    tray.id = 'timer-tray';
    tray.className = 'timer-tray';
    tray.setAttribute('aria-label', 'Timers');
    tray.hidden = true;
    document.body.append(tray);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => syncHeight()).observe(tray);
    }
    return tray;
  }

  function syncHeight() {
    const h = tray && !tray.hidden ? tray.offsetHeight : 0;
    const prev = document.documentElement.style.getPropertyValue('--timer-tray-h');
    document.documentElement.style.setProperty('--timer-tray-h', `${h}px`);
    // Sticky sidebars re-check whether they still fit above the tray.
    if (prev !== `${h}px`) window.dispatchEvent(new Event('timer-tray-resize'));
  }

  function render() {
    const el = ensureTray();
    if (!timers.length) {
      el.hidden = true;
      el.innerHTML = '';
      syncHeight();
      return;
    }
    const now = Date.now();
    el.hidden = false;
    el.innerHTML = `<ul class="timer-list">${timers.map((t) => {
      const p = phase(t, now);
      return `<li class="timer-item timer-${p}" data-timer-id="${escHtml(t.id)}">
        <button type="button" class="timer-label" onclick="Timers.open('${escJs(t.id)}')" title="${escHtml(t.recipe ? `${t.recipe}: ` : '')}${escHtml(t.label)}">${escHtml(t.label)}</button>
        <span class="timer-time" role="timer" aria-live="off">${escHtml(statusText(t, now))}</span>
        <button type="button" class="timer-stop" onclick="Timers.stop('${escJs(t.id)}')" aria-label="${p === 'done' ? 'Dismiss' : 'Stop'} ${escHtml(t.label)}" title="${p === 'done' ? 'Dismiss' : 'Stop'}">✕</button>
      </li>`;
    }).join('')}</ul>
    <p class="timer-note">Alerts only sound while AjiLab is open in a tab.</p>`;
    syncHeight();
  }

  // Update the times in place each second (no re-render, so buttons keep focus).
  function refresh() {
    check();
    const now = Date.now();
    for (const t of timers) {
      const li = tray?.querySelector(`[data-timer-id="${CSS.escape(t.id)}"]`);
      if (!li) { render(); return; }
      const p = phase(t, now);
      if (!li.classList.contains(`timer-${p}`)) { render(); return; }
      const time = li.querySelector('.timer-time');
      const text = statusText(t, now);
      if (time && time.textContent !== text) time.textContent = text;
    }
  }

  function ensureTicker() {
    if (timers.length && !ticker) ticker = setInterval(refresh, 1000);
    if (!timers.length && ticker) { clearInterval(ticker); ticker = null; }
  }

  // ── Public ──

  function start({ key, label, recipe, path, minMs, maxMs }) {
    unlockAudio();
    askPermission();
    const running = timers.find((t) => t.key === key && phase(t) !== 'done');
    if (running) {
      const li = tray?.querySelector(`[data-timer-id="${CSS.escape(running.id)}"]`);
      li?.classList.remove('timer-flash');
      void li?.offsetWidth;
      li?.classList.add('timer-flash');
      return running;
    }
    const now = Date.now();
    const timer = {
      id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      key, label, recipe: recipe || '', path: path || '',
      startedAt: now, minAt: now + minMs, maxAt: now + maxMs,
      firedMin: false, firedMax: false,
    };
    timers.push(timer);
    save();
    render();
    ensureTicker();
    return timer;
  }

  // From a "⏱ 40 min" chip in a step: name it "Step 9 · Fold dough · 40 min".
  function startFromChip(chip) {
    const range = durations(chip.dataset.qty, chip.dataset.units, chip.dataset.min, chip.dataset.max);
    if (!range) {
      if (typeof showToast === 'function') showToast(`Can't time “${chip.dataset.value}”`);
      return;
    }
    const li = chip.closest('li.step-item');
    const list = li?.parentElement;
    const steps = list ? [...list.children].filter((el) => el.classList.contains('step-item')) : [];
    const number = li ? steps.indexOf(li) + 1 : 0;
    // First few words of the step, without a dangling "and"/"for": "Fold dough 5x".
    const filler = /^(and|or|the|a|an|for|to|of|with|in|at|on|until|then)$/i;
    const words = (li?.querySelector('.step-text')?.textContent || '')
      .replace(/⏱/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3)
      .map((w) => w.replace(/[,.;:]+$/, ''));
    while (words.length > 1 && filler.test(words[words.length - 1])) words.pop();
    const lead = words.join(' ');
    const chips = li ? [...li.querySelectorAll('.s-timer-start')] : [];
    const index = chips.indexOf(chip);
    const label = [number ? `Step ${number}` : null, lead || null, chip.dataset.value].filter(Boolean).join(' · ');
    const path = location.pathname + location.search;
    start({
      key: `${location.pathname}#${number}#${index}`,
      label,
      recipe: typeof RecipeView !== 'undefined' ? RecipeView.recipe?.title : '',
      path,
      minMs: range[0],
      maxMs: range[1],
    });
  }

  function stop(id) {
    timers = timers.filter((t) => t.id !== id);
    save();
    render();
    ensureTicker();
  }

  function open(id) {
    const t = timers.find((x) => x.id === id);
    if (t?.path && location.pathname + location.search !== t.path) Router.go(t.path);
  }

  function init() {
    // Another tab started or stopped one.
    window.addEventListener('storage', (event) => {
      if (event.key !== KEY) return;
      timers = load();
      render();
      ensureTicker();
    });
    // After a reload the page has no gesture yet; the first click unlocks sound.
    document.addEventListener('pointerdown', () => { if (timers.length) unlockAudio(); }, { once: true });
    check();
    render();
    ensureTicker();
  }

  return { start, startFromChip, stop, open, init, durations, statusText, phase };
})();

Timers.init();
