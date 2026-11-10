'use strict';

/* 方仔摸鱼 — static H5, no third-party libs */

const W = 360;
const H = 640;
const SPRITE = 240;
const FRAMES = 10;
const FRAME_MS = 120;
const DAY_MS = 90000; // 09:00 → 18:00
const LS_HIGH = 'fangzai-moyu-hs';
const LS_MUTE = 'fangzai-moyu-mute';
const ASSETS = {
  idle: 'assets/fangzai-idle.png',
  work: 'assets/fangzai-work.png',
  slack: 'assets/fangzai-slack.png',
  caught: 'assets/fangzai-caught.png',
  over: 'assets/fangzai-over.png',
  leave: 'assets/fangzai-leave.png',
};

const SHOT = new URLSearchParams(location.search).get('shot');

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'),
  canvas: $('scene'),
  hud: $('hud'),
  score: $('score'),
  high: $('high'),
  titleHigh: $('title-high'),
  clock: $('clock-label'),
  combo: $('combo'),
  banner: $('banner'),
  hint: $('hint'),
  mute: $('mute'),
  boot: $('screen-boot'),
  title: $('screen-title'),
  over: $('screen-over'),
  overTitle: $('over-title'),
  overBadge: $('over-badge'),
  overScore: $('over-score'),
  overMeta: $('over-meta'),
  btnStart: $('btn-start'),
  btnRetry: $('btn-retry'),
  btnShare: $('btn-share'),
  toast: $('toast'),
};

const ctx = el.canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const images = {};
let highScore = Number(localStorage.getItem(LS_HIGH) || 0) || 0;

/* ---------- audio ---------- */
const sfx = {
  ctx: null,
  muted: localStorage.getItem(LS_MUTE) === '1',
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type, vol, when, slide) {
    if (this.muted || !this.ctx) return;
    const t0 = this.ctx.currentTime + (when || 0);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.07, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },
  warn() {
    this.tone(880, 0.09, 'square', 0.06, 0);
    this.tone(660, 0.12, 'square', 0.06, 0.1);
  },
  combo() { this.tone(520, 0.08, 'square', 0.05); this.tone(780, 0.1, 'square', 0.04, 0.06); },
  safe() { this.tone(660, 0.08, 'triangle', 0.05); this.tone(990, 0.12, 'triangle', 0.05, 0.07); },
  catch() { this.tone(320, 0.18, 'sawtooth', 0.07, 0, 90); this.tone(180, 0.28, 'square', 0.05, 0.12, 70); },
  win() {
    this.tone(523, 0.12, 'square', 0.05, 0);
    this.tone(659, 0.12, 'square', 0.05, 0.12);
    this.tone(784, 0.18, 'square', 0.06, 0.24);
  },
  start() { this.tone(392, 0.08, 'square', 0.04); this.tone(523, 0.12, 'square', 0.05, 0.08); },
};

function setMuted(flag) {
  sfx.muted = flag;
  localStorage.setItem(LS_MUTE, flag ? '1' : '0');
  el.mute.textContent = flag ? '×' : '♪';
  el.mute.setAttribute('aria-pressed', flag ? 'true' : 'false');
  el.mute.setAttribute('aria-label', flag ? '开启声音' : '关闭声音');
}

/* ---------- game state ---------- */
const G = {
  screen: 'boot', // boot | title | play | caught | over | win
  holding: false,
  score: 0,
  displayScore: 0,
  holdMs: 0,
  comboTier: 0,
  maxCombo: 0,
  elapsed: 0,
  pose: 'idle',
  poseAt: 0,
  anim: 0,
  particles: [],
  shake: 0,
  flash: 0,
  bannerUntil: 0,
  bannerKind: '',
  lastNearMiss: false,
  survived: 0,
  ended: false,
  shareText: '',
  boss: {
    phase: 'away',
    pattern: 'turn',
    timer: 0,
    dur: 2000,
    x: 88,
    targetX: 88,
    heading: -1,
    turn: 0, // 0 back, 1 front
  },
};

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function ease(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 1.35); }
function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

function difficulty(ms) {
  const u = ease(ms / 78000);
  return {
    warn: lerp(1150, 300, u),
    awayMin: lerp(2100, 520, u),
    awayMax: lerp(3900, 1150, u),
    look: lerp(680, 1550, u),
  };
}

function comboFromHold(ms) {
  if (ms >= 5500) return 5;
  if (ms >= 3500) return 4;
  if (ms >= 2000) return 3;
  if (ms >= 800) return 2;
  return 1;
}

function workClock(ms) {
  const m = 9 * 60 + (clamp(ms, 0, DAY_MS) / DAY_MS) * 9 * 60;
  const hh = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function setPose(name) {
  if (G.pose !== name) {
    G.pose = name;
    G.poseAt = G.anim;
  }
}

function showBanner(text, kind, ms) {
  el.banner.hidden = false;
  el.banner.textContent = text;
  el.banner.className = kind || '';
  el.banner.id = 'banner';
  G.bannerKind = kind || '';
  G.bannerUntil = G.anim + (ms || 700);
}

function hideBanner() {
  el.banner.hidden = true;
  el.banner.textContent = '';
  G.bannerUntil = 0;
}

function spawnFloater(text, color, x) {
  G.particles.push({
    kind: 'text',
    text,
    color: color || '#ffd15a',
    x: x == null ? 180 + rand(-30, 30) : x,
    y: 360,
    vy: -55,
    life: 0,
    max: 800,
  });
}

function toast(msg) {
  el.toast.hidden = false;
  el.toast.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

/* ---------- boss ---------- */
function resetBoss(initial) {
  const b = G.boss;
  b.pattern = initial ? 'turn' : pick(['turn', 'turn', 'walkL', 'walkR']);
  b.phase = 'away';
  b.turn = 0;
  const d = difficulty(G.elapsed);
  b.dur = initial ? 2200 : rand(d.awayMin, d.awayMax);
  b.timer = 0;
  if (b.pattern === 'turn') {
    b.x = 86;
    b.targetX = 86;
    b.heading = -1;
  } else if (b.pattern === 'walkL') {
    b.x = -40;
    b.targetX = 150;
    b.heading = 1;
  } else {
    b.x = 380;
    b.targetX = 200;
    b.heading = -1;
  }
}

function setPhase(phase) {
  const b = G.boss;
  const d = difficulty(G.elapsed);
  b.phase = phase;
  b.timer = 0;
  if (phase === 'away') {
    resetBoss(false);
    return;
  }
  if (phase === 'warning') {
    b.dur = d.warn;
    b.turn = 0.25;
    sfx.warn();
    if (navigator.vibrate) navigator.vibrate(25);
    showBanner('有人来了！', 'warn', d.warn);
  } else if (phase === 'looking') {
    b.dur = d.look;
    b.turn = 1;
    showBanner('老板在看！', 'look', d.look);
  }
}

function updateBoss(dt) {
  const b = G.boss;
  b.timer += dt * 1000;
  const walk = b.pattern !== 'turn' && b.phase === 'away';
  if (walk || (b.pattern !== 'turn' && b.phase !== 'looking')) {
    const speed = b.phase === 'warning' ? 55 : 70;
    const dir = b.targetX > b.x ? 1 : -1;
    if (Math.abs(b.targetX - b.x) > 1) {
      b.x += dir * speed * dt;
      b.heading = dir;
    } else {
      b.x = b.targetX;
    }
  }
  if (b.phase === 'warning') {
    b.turn = Math.min(1, 0.2 + (b.timer / b.dur) * 0.5);
  }
  if (b.phase === 'looking') b.turn = 1;

  if (b.timer >= b.dur) {
    if (b.phase === 'away') setPhase('warning');
    else if (b.phase === 'warning') setPhase('looking');
    else if (b.phase === 'looking') {
      // survived a look
      if (G.screen === 'play' && !G.holding) {
        G.survived += 1;
        const bonus = 15 + Math.floor(G.elapsed / 20000) * 10;
        G.score += bonus;
        spawnFloater('+' + bonus + ' 安全', '#6bcf7a');
      }
      hideBanner();
      setPhase('away');
    }
  }
}

/* ---------- flow ---------- */
function showScreen(name) {
  G.screen = name;
  el.boot.hidden = name !== 'boot';
  el.title.hidden = name !== 'title';
  el.over.hidden = name !== 'over' && name !== 'win';
  const playing = name === 'play' || name === 'caught';
  el.hud.hidden = !playing && name !== 'caught';
  el.hint.hidden = name !== 'play';
  if (name === 'title' || name === 'boot') {
    el.hud.hidden = true;
    el.hint.hidden = true;
  }
}

function resetRun() {
  G.holding = false;
  G.score = 0;
  G.displayScore = 0;
  G.holdMs = 0;
  G.comboTier = 0;
  G.maxCombo = 0;
  G.elapsed = 0;
  G.particles = [];
  G.shake = 0;
  G.flash = 0;
  G.ended = false;
  G.survived = 0;
  G.lastNearMiss = false;
  hideBanner();
  resetBoss(true);
  setPose('work');
  el.hint.classList.remove('holding');
  el.hint.textContent = '按住屏幕摸鱼 · 松开认真干活';
  el.score.textContent = '0';
  el.combo.textContent = '';
  el.clock.textContent = '09:00';
}

function startGame() {
  sfx.unlock();
  sfx.start();
  resetRun();
  showScreen('play');
}

function endCaught() {
  if (G.ended) return;
  G.ended = true;
  G.holding = false;
  G.screen = 'caught';
  setPose('caught');
  G.shake = 14;
  G.flash = 1;
  sfx.catch();
  if (navigator.vibrate) navigator.vibrate([40, 40, 90]);
  showBanner('被抓到了！', 'look', 1200);
  el.hint.hidden = true;
  setTimeout(() => finish('caught'), 1100);
}

function endWin() {
  if (G.ended) return;
  G.ended = true;
  G.holding = false;
  G.elapsed = DAY_MS;
  setPose('leave');
  sfx.win();
  showBanner('下班啦！', 'ok', 1200);
  el.hint.hidden = true;
  setTimeout(() => finish('win'), 1000);
}

function finish(kind) {
  const score = Math.floor(G.score);
  const isNew = score > highScore;
  if (isNew) {
    highScore = score;
    localStorage.setItem(LS_HIGH, String(highScore));
  }
  el.high.textContent = String(highScore);
  el.titleHigh.textContent = String(highScore);
  el.overTitle.textContent = kind === 'win' ? '下班啦！' : '被老板抓到了！';
  el.overBadge.hidden = !isNew;
  el.overScore.textContent = String(score);
  const sec = Math.max(1, Math.round((kind === 'win' ? DAY_MS : G.elapsed) / 1000));
  const bits = ['坚持 ' + sec + ' 秒'];
  if (G.maxCombo >= 2) bits.push('连击 ×' + G.maxCombo);
  if (G.survived) bits.push('躲开 ' + G.survived + ' 次');
  if (kind === 'win' && score < 80) bits.unshift('今天几乎没摸到鱼');
  el.overMeta.textContent = bits.join(' · ');
  if (kind === 'win') {
    G.shareText = score < 80
      ? '我在「方仔摸鱼」摸鱼摸到下班，却只赚了 ' + score + ' 分。太老实了。'
      : '我在「方仔摸鱼」活到下班，摸到 ' + score + ' 分（最高连击 ×' + Math.max(1, G.maxCombo) + '）！你能摸得比我久吗？';
    setPose('leave');
  } else {
    G.shareText = '我在「方仔摸鱼」坚持了 ' + sec + ' 秒，摸到 ' + score + ' 分（最高连击 ×' + Math.max(1, G.maxCombo) + '）！你也来试试？';
    setPose('over');
  }
  showScreen(kind === 'win' ? 'win' : 'over');
}

async function shareScore() {
  const text = G.shareText || '我在玩「方仔摸鱼」！';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast('战绩已复制到剪贴板');
      return;
    }
  } catch (err) { /* fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;width:1px;height:1px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      toast('战绩已复制到剪贴板');
      return;
    }
  } catch (err) { /* last resort */ }
  toast('复制失败，请手动长按复制');
  window.prompt('复制这段战绩：', text);
}

/* ---------- input ---------- */
function isUi(target) {
  return !!(target && target.closest && target.closest('button, a, .card, .screen'));
}

function onHoldStart(ev) {
  sfx.unlock();
  if (G.screen !== 'play' || G.ended) return;
  if (ev && ev.cancelable) ev.preventDefault();
  G.holding = true;
  el.hint.classList.add('holding');
  el.hint.textContent = '摸鱼中…';
}

function onHoldEnd() {
  if (!G.holding) return;
  const was = G.holding;
  G.holding = false;
  el.hint.classList.remove('holding');
  if (G.screen === 'play') el.hint.textContent = '按住屏幕摸鱼 · 松开认真干活';
  if (!was || G.screen !== 'play' || G.ended) return;
  // near-miss: released during warning or just as he looks
  const b = G.boss;
  if (b.phase === 'warning' || (b.phase === 'looking' && b.timer < 90)) {
    const bonus = 40 * Math.max(1, G.comboTier);
    G.score += bonus;
    spawnFloater('+' + bonus + ' 好险！', '#ffd15a');
    sfx.safe();
    G.lastNearMiss = true;
  }
  G.holdMs = 0;
  G.comboTier = 0;
  el.combo.textContent = '';
}

function bindInput() {
  const stage = el.stage;
  stage.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    if (isUi(ev.target)) return;
    onHoldStart(ev);
  });
  window.addEventListener('pointerup', onHoldEnd);
  window.addEventListener('pointercancel', onHoldEnd);
  window.addEventListener('blur', onHoldEnd);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onHoldEnd();
  });
  window.addEventListener('contextmenu', (ev) => ev.preventDefault());
  window.addEventListener('touchmove', (ev) => ev.preventDefault(), { passive: false });
  window.addEventListener('gesturestart', (ev) => ev.preventDefault());

  el.btnStart.addEventListener('click', startGame);
  el.btnRetry.addEventListener('click', startGame);
  el.btnShare.addEventListener('click', shareScore);
  el.mute.addEventListener('click', (ev) => {
    ev.stopPropagation();
    sfx.unlock();
    setMuted(!sfx.muted);
  });
}

/* ---------- update ---------- */
function update(dt) {
  G.anim += dt * 1000;
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 40);
  if (G.flash > 0) G.flash = Math.max(0, G.flash - dt * 2.2);
  if (G.bannerUntil && G.anim > G.bannerUntil && G.screen === 'play' && G.boss.phase === 'away') {
    hideBanner();
  }

  for (let i = G.particles.length - 1; i >= 0; i--) {
    const p = G.particles[i];
    p.life += dt * 1000;
    p.y += p.vy * dt;
    p.vy += 40 * dt;
    if (p.life >= p.max) G.particles.splice(i, 1);
  }

  if (G.screen !== 'play') {
    if (G.screen === 'title' || G.screen === 'boot') setPose('idle');
    return;
  }

  G.elapsed += dt * 1000;
  el.clock.textContent = workClock(G.elapsed);
  if (G.elapsed >= DAY_MS) {
    endWin();
    return;
  }

  updateBoss(dt);

  if (G.holding) {
    el.hint.textContent = '摸鱼中…';
    el.hint.classList.add('holding');
    setPose('slack');
    G.holdMs += dt * 1000;
    const tier = comboFromHold(G.holdMs);
    if (tier > G.comboTier) {
      G.comboTier = tier;
      if (tier >= 2) {
        sfx.combo();
        spawnFloater('连击 ×' + tier, '#ffd15a');
      }
    }
    G.maxCombo = Math.max(G.maxCombo, G.comboTier);
    const rate = 22 * G.comboTier; // points / sec
    G.score += rate * dt;
    if (G.comboTier >= 2) el.combo.textContent = '连击 ×' + G.comboTier;
    else el.combo.textContent = '摸鱼中';
    if (G.boss.phase === 'looking' && G.boss.timer > 50) {
      endCaught();
      return;
    }
  } else {
    setPose('work');
    el.hint.classList.remove('holding');
    el.hint.textContent = '按住屏幕摸鱼 · 松开认真干活';
    if (!G.ended) {
      G.holdMs = 0;
      G.comboTier = 0;
      if (G.boss.phase !== 'looking') el.combo.textContent = '';
    }
  }

  G.displayScore += (G.score - G.displayScore) * Math.min(1, dt * 12);
  el.score.textContent = String(Math.floor(G.displayScore + 0.001));
}

/* ---------- render ---------- */
function px(c, x, y, w, h, color) {
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}

function drawSky(c, tDay) {
  // tDay 0 morning-ish afternoon, 1 evening
  const top = mix('#6eb7d9', '#3a2a6a', tDay);
  const mid = mix('#c8e6f0', '#e09060', tDay);
  const bot = mix('#eef6ff', '#f2b070', tDay);
  const g = c.createLinearGradient(0, 0, 0, 200);
  g.addColorStop(0, top);
  g.addColorStop(0.55, mid);
  g.addColorStop(1, bot);
  c.fillStyle = g;
  c.fillRect(0, 0, W, 230);
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = ((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t;
  const g = ((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t;
  const bl = (pa & 255) + ((pb & 255) - (pa & 255)) * t;
  return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (bl | 0) + ')';
}

function drawBuildings(c, x0, y0, w, h, tDay) {
  const col = tDay > 0.7 ? '#2a3048' : '#4a5a78';
  const win = tDay > 0.65 ? '#f0d878' : '#d8ecf8';
  let x = x0;
  while (x < x0 + w) {
    const bw = 16 + ((x * 13) % 10);
    const bh = 30 + ((x * 7) % 36);
    px(c, x, y0 + h - bh, bw - 2, bh, col);
    for (let wy = y0 + h - bh + 4; wy < y0 + h - 6; wy += 8) {
      for (let wx = x + 3; wx < x + bw - 6; wx += 6) {
        if (((wx + wy) * 11) % 5 !== 0) px(c, wx, wy, 3, 3, win);
      }
    }
    x += bw;
  }
}

function drawOffice(c) {
  const tDay = G.screen === 'play' || G.screen === 'caught' || G.screen === 'win'
    ? clamp(G.elapsed / DAY_MS, 0, 1)
    : 0.2;

  // far wall
  px(c, 0, 0, W, 268, '#d8c4a0');
  px(c, 0, 248, W, 20, '#cbb18a');

  // window (left)
  const wx = 22, wy = 64, ww = 124, wh = 88;
  px(c, wx - 6, wy - 6, ww + 12, wh + 12, '#6a4326');
  px(c, wx - 3, wy - 3, ww + 6, wh + 6, '#8a5a32');
  // clip sky + city into window by drawing a rect sky
  const prev = c.save();
  c.beginPath();
  c.rect(wx, wy, ww, wh);
  c.clip();
  drawSky(c, tDay);
  c.fillStyle = tDay > 0.7 ? '#3a2a6a' : '#6eb7d9';
  // reuse already-painted? fill the clipped area with a mini sky
  const sg = c.createLinearGradient(0, wy, 0, wy + wh);
  sg.addColorStop(0, tDay > 0.75 ? '#2a2458' : '#6eb7d9');
  sg.addColorStop(1, tDay > 0.75 ? '#e09060' : '#e8f4ff');
  c.fillStyle = sg;
  c.fillRect(wx, wy, ww, wh);
  // sun / dusk disc
  c.fillStyle = tDay > 0.6 ? '#f0c060' : '#ffe28a';
  c.fillRect(wx + 78, wy + 12 + tDay * 28, 16, 16);
  drawBuildings(c, wx - 4, wy + 18, ww + 10, wh - 18, tDay);
  c.restore();
  // window muntins
  px(c, wx + ww / 2 - 2, wy, 4, wh, '#8a5a32');
  px(c, wx, wy + wh / 2 - 2, ww, 4, '#8a5a32');
  px(c, wx, wy, ww, 3, 'rgba(255,255,255,0.25)');

  // wall clock
  drawClock(c, 188, 94, tDay);

  // poster
  px(c, 228, 74, 28, 36, '#6b3e1f');
  px(c, 230, 76, 24, 32, '#f4e4c1');
  px(c, 234, 82, 16, 4, '#e85d4c');
  px(c, 234, 90, 16, 3, '#c4ad86');
  px(c, 234, 96, 12, 3, '#c4ad86');

  // door (right)
  px(c, 286, 86, 54, 162, '#6a4326');
  px(c, 290, 90, 46, 154, '#8a5a32');
  px(c, 292, 94, 42, 60, '#7a4c2a');
  px(c, 292, 160, 42, 80, '#7a4c2a');
  px(c, 326, 168, 6, 6, '#d4b06a'); // knob
  // door frame
  px(c, 284, 84, 58, 6, '#4a2a14');
  px(c, 284, 84, 4, 164, '#4a2a14');
  px(c, 338, 84, 4, 164, '#4a2a14');

  // filing cabinet
  px(c, 156, 166, 52, 82, '#6d7388');
  px(c, 158, 168, 48, 24, '#7c849c');
  px(c, 158, 194, 48, 24, '#7c849c');
  px(c, 158, 220, 48, 24, '#7c849c');
  px(c, 176, 178, 12, 4, '#d4b06a');
  px(c, 176, 204, 12, 4, '#d4b06a');
  px(c, 176, 230, 12, 4, '#d4b06a');

  // plant
  px(c, 246, 214, 18, 14, '#6b3e1f');
  px(c, 250, 218, 10, 8, '#4a2a14');
  px(c, 248, 188, 6, 28, '#3d8b4a');
  px(c, 242, 196, 10, 8, '#4aa35a');
  px(c, 252, 192, 12, 8, '#2f7a3c');
  px(c, 250, 202, 10, 8, '#4aa35a');

  // floor
  px(c, 0, 248, W, H - 248, '#a56b3a');
  for (let y = 248; y < H; y += 16) {
    px(c, 0, y, W, 2, '#8a542c');
  }
  for (let x = 0; x < W; x += 36) {
    px(c, x, 248, 2, H - 248, '#8a542c');
    // stagger
  }
  // darker foreground floor
  px(c, 0, 500, W, 8, '#7a4a26');

  // cubicle low wall behind fangzai (desk height ≈ character waist)
  px(c, 18, 348, 324, 78, '#c4ad86');
  px(c, 18, 348, 324, 8, '#d8c4a0');
  px(c, 18, 348, 6, 78, '#b89a6e');
  px(c, 336, 348, 6, 78, '#b89a6e');

  // desk
  px(c, 28, 422, 304, 16, '#8b5a32');
  px(c, 28, 438, 304, 8, '#6b3e22');
  px(c, 36, 446, 16, 76, '#6b3e22');
  px(c, 308, 446, 16, 76, '#6b3e22');
  // desk edge highlight
  px(c, 28, 422, 304, 3, '#a87040');
  // papers / cup on the side (left / right of character)
  px(c, 48, 408, 22, 14, '#f4e4c1');
  px(c, 50, 410, 18, 2, '#e85d4c');
  px(c, 292, 404, 14, 18, '#e8e4d9');
  px(c, 294, 400, 10, 6, '#d4b06a');
  px(c, 298, 396, 3, 6, '#d4b06a');

  // soft shadow where fangzai sits
  c.fillStyle = 'rgba(42, 24, 16, 0.22)';
  c.fillRect(110, 508, 140, 16);
}

function drawClock(c, cx, cy, tDay) {
  px(c, cx - 22, cy - 22, 44, 44, '#6a4326');
  px(c, cx - 18, cy - 18, 36, 36, '#f4e4c1');
  px(c, cx - 2, cy - 2, 4, 4, '#3a2a1c');
  const ms = (G.screen === 'play' || G.screen === 'caught' || G.screen === 'win' || G.screen === 'over')
    ? (G.screen === 'title' ? 0 : G.elapsed) : 0;
  const totalMin = 9 * 60 + (clamp(ms, 0, DAY_MS) / DAY_MS) * 9 * 60;
  const hour = (totalMin / 60) % 12;
  const minute = totalMin % 60;
  const ha = (-Math.PI / 2) + (hour / 12) * Math.PI * 2;
  const ma = (-Math.PI / 2) + (minute / 60) * Math.PI * 2;
  c.strokeStyle = '#3a2a1c';
  c.lineWidth = 3;
  c.lineCap = 'square';
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(ha) * 10, cy + Math.sin(ha) * 10);
  c.stroke();
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(ma) * 14, cy + Math.sin(ma) * 14);
  c.stroke();
}

function drawBoss(c) {
  const b = G.boss;
  if (G.screen === 'boot') return;
  // hide fully off-screen
  if (b.x < -50 || b.x > 410) return;

  const feetY = 248;
  const bob = (b.pattern !== 'turn' && Math.abs(b.targetX - b.x) > 2)
    ? (((G.anim / 140) | 0) % 2) * 2
    : 0;
  const scale = 2; // 16x28 sprite * 2 = 32x56, let's use 3 → 48x84
  const s = 3;
  const facingFront = b.turn > 0.55;
  const turning = b.turn > 0.2 && b.turn <= 0.55;
  const flip = b.heading < 0 && !facingFront ? -1 : 1;

  c.save();
  c.translate(Math.round(b.x), feetY - bob);
  if (flip < 0) c.scale(-1, 1);

  const ox = -8 * s;
  const oy = -28 * s;
  const P = (x, y, w, h, col) => px(c, ox + x * s, oy + y * s, w * s, h * s, col);

  const suit = '#2c3148';
  const suitD = '#1c2030';
  const shirt = '#ece6d8';
  const tie = '#9b2b2b';
  const hair = '#2b241c';
  const face = '#f0c9a0';
  const shoe = '#1a1a1a';

  // legs
  const step = ((G.anim / 160) | 0) % 2;
  const walking = Math.abs((b.targetX - b.x)) > 2 && b.phase !== 'looking';
  const lOff = walking ? (step ? 1 : -1) : 0;
  P(4 + lOff, 20, 3, 7, suitD);
  P(9 - lOff, 20, 3, 7, suitD);
  P(4 + lOff, 26, 3, 2, shoe);
  P(9 - lOff, 26, 3, 2, shoe);

  // body
  P(3, 11, 10, 10, suit);
  if (facingFront || turning) {
    P(6, 11, 4, 8, shirt);
    P(7, 12, 2, 7, tie);
  } else {
    // back seam
    P(7, 12, 2, 8, suitD);
  }

  // arms
  if (facingFront) {
    P(1, 12, 3, 8, suit);
    P(12, 12, 3, 8, suit);
  } else {
    P(1, 12, 3, 8, suit);
    P(12, 12, 3, 8, suit);
  }

  // head
  if (facingFront) {
    P(4, 1, 8, 3, hair);
    P(3, 3, 10, 3, hair);
    P(4, 4, 8, 7, face);
    P(5, 6, 2, 2, '#1c1410');
    P(9, 6, 2, 2, '#1c1410');
    if (b.phase === 'looking') {
      P(5, 6, 2, 2, '#fff8e8');
      P(9, 6, 2, 2, '#fff8e8');
      P(6, 7, 1, 1, '#1c1410');
      P(10, 7, 1, 1, '#1c1410');
      P(7, 9, 2, 1, '#c45c5c');
    }
  } else if (turning) {
    P(5, 1, 8, 3, hair);
    P(4, 3, 9, 3, hair);
    P(7, 5, 6, 6, face);
    P(10, 6, 2, 2, '#1c1410');
  } else {
    // back of head
    P(4, 1, 8, 9, hair);
    P(3, 3, 10, 6, hair);
  }

  // warning bang
  if (b.phase === 'warning' || (b.phase === 'looking' && b.timer < 400)) {
    const blink = ((G.anim / 120) | 0) % 2 === 0;
    if (blink) {
      c.fillStyle = '#1c1410';
      c.fillRect(-10, oy - 22, 22, 22);
      c.fillStyle = '#ffd15a';
      c.fillRect(-8, oy - 20, 18, 18);
      c.fillStyle = '#1c1410';
      c.font = 'bold 16px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('!', 1, oy - 10);
    }
  }

  c.restore();
}

function drawFangzai(c) {
  const img = images[G.pose] || images.idle;
  if (!img) return;
  const t = Math.max(0, G.anim - G.poseAt);
  const frame = Math.floor(t / FRAME_MS) % FRAMES;
  const overlay = G.screen === 'title' || G.screen === 'boot'
    || G.screen === 'over' || G.screen === 'win';
  const size = overlay ? 184 : 210;
  const x = (W - size) / 2;
  const y = overlay ? 228 : 318;
  c.imageSmoothingEnabled = false;
  c.drawImage(img, frame * SPRITE, 0, SPRITE, SPRITE, x, y, size, size);
}

function drawParticles(c) {
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const p of G.particles) {
    const a = 1 - p.life / p.max;
    c.globalAlpha = Math.max(0, a);
    c.font = 'bold 16px "Noto Sans CJK SC", "PingFang SC", sans-serif';
    c.lineWidth = 4;
    c.strokeStyle = '#1c1410';
    c.fillStyle = p.color;
    c.strokeText(p.text, p.x, p.y);
    c.fillText(p.text, p.x, p.y);
  }
  c.globalAlpha = 1;
}

function drawVignette(c) {
  const b = G.boss;
  let danger = 0;
  if (G.screen === 'play' || G.screen === 'caught') {
    if (b.phase === 'warning') danger = 0.35 + 0.25 * Math.sin(G.anim / 70);
    if (b.phase === 'looking') danger = 0.7;
    if (G.screen === 'caught') danger = 0.85;
  }
  if (danger > 0) {
    const g = c.createRadialGradient(W / 2, H * 0.55, 80, W / 2, H * 0.5, 280);
    g.addColorStop(0, 'rgba(200,40,30,0)');
    g.addColorStop(1, 'rgba(160,20,16,' + (0.45 * danger) + ')');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }
  if (G.flash > 0) {
    c.fillStyle = 'rgba(255,240,230,' + (0.35 * G.flash) + ')';
    c.fillRect(0, 0, W, H);
  }
}

function render() {
  const scale = el.canvas.width / W;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingEnabled = false;

  let ox = 0, oy = 0;
  if (G.shake > 0) {
    ox = (Math.random() - 0.5) * G.shake;
    oy = (Math.random() - 0.5) * G.shake;
    ctx.translate(ox, oy);
  }

  ctx.clearRect(-20, -20, W + 40, H + 40);
  drawOffice(ctx);
  drawBoss(ctx);
  drawFangzai(ctx);
  drawParticles(ctx);
  drawVignette(ctx);
}

/* ---------- loop ---------- */
let lastTs = 0;
function frame(ts) {
  if (!lastTs) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.05) dt = 0.05;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

/* ---------- boot ---------- */
function preload() {
  const entries = Object.entries(ASSETS);
  return Promise.all(entries.map(([key, src]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { images[key] = img; resolve(true); };
    img.onerror = () => { console.warn('asset failed', src); resolve(false); };
    img.src = src;
  })));
}

function applyShot() {
  if (!SHOT) return;
  if (SHOT === 'title') {
    showScreen('title');
    setPose('idle');
    resetBoss(true);
    return;
  }
  resetRun();
  if (SHOT === 'play') {
    showScreen('play');
    G.elapsed = 28000;
    G.score = 486;
    G.displayScore = 486;
    G.holding = true;
    G.holdMs = 2600;
    G.comboTier = 3;
    G.maxCombo = 3;
    setPose('slack');
    el.score.textContent = '486';
    el.combo.textContent = '连击 ×3';
    el.clock.textContent = workClock(G.elapsed);
    G.boss.pattern = 'turn';
    G.boss.phase = 'away';
    G.boss.x = 88;
    G.boss.turn = 0;
    G.boss.dur = 99999;
    G.boss.timer = 0;
    return;
  }
  if (SHOT === 'warn') {
    showScreen('play');
    G.elapsed = 40000;
    G.score = 820;
    G.displayScore = 820;
    G.holding = true;
    G.holdMs = 1800;
    G.comboTier = 2;
    setPose('slack');
    el.score.textContent = '820';
    el.combo.textContent = '连击 ×2';
    el.clock.textContent = workClock(G.elapsed);
    G.boss.pattern = 'turn';
    G.boss.phase = 'warning';
    G.boss.x = 88;
    G.boss.turn = 0.45;
    G.boss.dur = 99999;
    G.boss.timer = 200;
    showBanner('有人来了！', 'warn', 99999);
    return;
  }
  if (SHOT === 'over') {
    G.elapsed = 42000;
    G.score = 966;
    G.maxCombo = 4;
    G.survived = 7;
    G.boss.phase = 'looking';
    G.boss.turn = 1;
    G.boss.x = 88;
    setPose('over');
    finish('caught');
    return;
  }
  if (SHOT === 'win') {
    G.elapsed = DAY_MS;
    G.score = 1580;
    G.maxCombo = 5;
    G.survived = 14;
    setPose('leave');
    finish('win');
  }
}

async function boot() {
  setMuted(sfx.muted);
  el.high.textContent = String(highScore);
  el.titleHigh.textContent = String(highScore);
  bindInput();
  await preload();
  resetBoss(true);
  setPose('idle');
  showScreen('title');
  applyShot();
  requestAnimationFrame(frame);
}

boot();
