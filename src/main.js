import * as THREE from 'three';
import nekoUrl from './neko.jpg';
import maskUrl from './neko-mask.webp';

/* =====================================================================
   なでボタン(実写ハイブリッド版) — neko.jpg の上に毛皮のなびきを重ねる
   ---------------------------------------------------------------------
   仕組みの概要:
   1. neko.jpg を「cover」で全面に敷く(層 0 = 実写ベース)
   2. その上に毛皮シェルを重ね、実写の色を拾った毛束を生やして揺らす
   3. カーソルの速度を 64x64 のフローマップに書き込み、
      ・実写ベースを毛流れに沿ってわずかに波打たせる(なで波紋)
      ・毛束の毛先をなびかせる / 逆撫でで逆立たせる
   4. 撫でる向きと毛並み(左→右)の一致度から「ごきげん」を計算し、
      毛づや・トーン・ゴロゴロ音・逆毛などのリアクションに反映する
   ※ 実写に合わない漫画顔は撤去し、表情はトーン変化+逆毛+吹き出しで表現
   ===================================================================== */

// ── 基本セットアップ ─────────────────────────────────────────────
const stage  = document.getElementById('stage');
const canvas = document.getElementById('fur');
const SHELLS = 20;               // 毛の層数(多いほど滑らか・重い)
const FLOW_N = 64;               // フローマップの解像度

let W = 560, H = 360;            // 論理サイズ(CSSピクセル)

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(W, H, false);

const scene  = new THREE.Scene();
// 板ポリを画面いっぱいに映すだけなので正射影カメラを使う
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
camera.position.z = 1;

// ── 実写テクスチャ(neko.jpg) ─────────────────────────────────────
const photoTex = new THREE.TextureLoader().load(nekoUrl);
photoTex.colorSpace = THREE.SRGBColorSpace;
photoTex.minFilter = THREE.LinearFilter;
photoTex.magFilter = THREE.LinearFilter;
photoTex.generateMipmaps = false;
const IMG_ASPECT = 1600 / 1066;   // neko.jpg の縦横比

// ── 猫マスク(neko-mask.webp のアルファ = 猫だけ 1 / 背景 0) ─────────
// neko.jpg と同じ縦横比なので同じ cover 変換でぴったり重なる
const maskTex = new THREE.TextureLoader().load(maskUrl);
maskTex.minFilter = THREE.LinearFilter;
maskTex.magFilter = THREE.LinearFilter;
maskTex.generateMipmaps = false;

// ── フローマップ(撫でた方向を記録するテクスチャ) ──────────────────
// CPU側は符号付き float で保持し、GPU へは 0..255 に詰め替えて送る
const flowF = new Float32Array(FLOW_N * FLOW_N * 2);      // 計算用 (x,y)
const flowU = new Uint8Array(FLOW_N * FLOW_N * 4);        // 転送用 RGBA
const flowTex = new THREE.DataTexture(flowU, FLOW_N, FLOW_N, THREE.RGBAFormat);
flowTex.minFilter = THREE.LinearFilter;
flowTex.magFilter = THREE.LinearFilter;

// ── シェーダー定義 ────────────────────────────────────────────────
const vert = `
  attribute float aLayer;   // インスタンスごとの層番号 (0 = 実写ベース)
  varying vec2 vUv;
  varying float vLayer;
  void main() {
    vUv = uv;
    vLayer = aLayer;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const frag = `
  precision highp float;
  varying vec2 vUv;
  varying float vLayer;

  uniform float uShells;     // 総層数
  uniform float uAspect;     // canvas のアスペクト比 (幅/高さ)
  uniform float uImgAspect;  // 画像のアスペクト比 (幅/高さ)
  uniform sampler2D uFlow;   // 撫でフローマップ
  uniform sampler2D uPhoto;  // 実写(neko.jpg)
  uniform sampler2D uMask;   // 猫マスク(alpha: 猫=1 / 背景=0)
  uniform float uBristle;    // 0..1 逆毛(怒り)の強さ
  uniform float uHappy;      // 0..1 ごきげん(毛づやに反映)
  uniform float uSleep;      // 0..1 睡眠(沈んで彩度が落ちる)

  // ── ハッシュ関数(毛束の乱数生成) ──
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  // ── 「cover」フィットの UV 変換 ──
  // canvas 全面を埋めるように画像をスケールし、はみ出す側を中央でトリミング
  vec2 coverUv(vec2 uv) {
    vec2 t = uv - 0.5;
    float r = uImgAspect / uAspect;
    if (uAspect > uImgAspect) t.y *= r;   // canvas が横長 → 上下をトリム
    else                      t.x /= r;   // canvas が縦長 → 左右をトリム
    return t + 0.5;
  }

  void main() {
    // 層の高さ h: 0(根元) → 1(毛先)
    float h = vLayer / (uShells - 1.0);

    // 撫でフロー(0..1 で保存 → -1..1 に復号)
    vec2 flow = texture2D(uFlow, vUv).xy * 2.0 - 1.0;

    // 毛皮ゾーン: マスクのアルファで「猫だけ」に限定(背景は毛羽立たない)
    float zone = smoothstep(0.4, 0.75, texture2D(uMask, coverUv(vUv)).a);

    // ── 層 0: 実写ベース(なで波紋つき) ──
    if (vLayer < 0.5) {
      vec2 ripple = flow * 0.012 * zone;             // 撫でた所がふわっと波打つ
      vec3 c = texture2D(uPhoto, coverUv(vUv - ripple)).rgb;
      c *= mix(1.0, 1.10, uHappy);                    // ごきげんは少し明るく
      float g = dot(c, vec3(0.30, 0.59, 0.11));
      c = mix(c, vec3(g) * 0.78, uSleep * 0.7);       // 睡眠時は沈んでモノトーン寄り
      gl_FragColor = vec4(c, 1.0);
      return;
    }

    // ── 毛皮シェル ──
    if (zone < 0.02) discard;   // 背景側は毛を生やさない

    // なびき: 基本はフローに沿って揺れる
    // 逆毛(怒り)時は「体の中心から外向き」に立たせる。細かいランダムを
    // 強くかけるとザラついて見えるので、粗めの格子で控えめに散らすだけにする
    vec2 outward = normalize(vUv - vec2(0.5, 0.46) + vec2(1e-4));
    vec2 jit = (hash22(floor(vUv * vec2(uAspect, 1.0) * 70.0) + 3.7) - 0.5) * 0.6;
    vec2 bristleDir = outward + jit;
    vec2 bend = mix(flow * 1.2, bristleDir * 1.2, uBristle * 0.85);
    float bl = length(bend);
    if (bl > 1.5) bend *= 1.5 / bl;                   // なびき過ぎ防止

    // 毛先ほど根元をずらす(pow で先端カーブ)。uv 空間で微小に動かす
    vec2 rootUv = vUv - bend * pow(h, 1.4) * 0.028;

    // ── 毛束の生成(セルごとに 1 本) ──
    float dens = 185.0;                              // 密度(高いほど毛が細い)
    vec2 g = rootUv * vec2(uAspect, 1.0) * dens;     // アスペクト補正したセル格子
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 rj = hash22(cell);
    f -= (rj - 0.5) * 0.55;                          // 毛束位置を散らす

    float len = mix(0.5, 1.0, hash12(cell + 7.31));  // 毛の長さ(層数比)
    len *= 1.0 + uBristle * 0.22;                    // 逆毛時は毛が伸びる(立つ)
    if (h > len) discard;                            // この層まで毛が届いていない

    // 毛のはみ出し防止: 根元位置のマスクで縁を締める(背景の白を拾わない)
    float zr = smoothstep(0.4, 0.75, texture2D(uMask, coverUv(rootUv)).a);
    float taper = 1.0 - h / len;                     // 先端ほど細く
    float rad = 0.42 * taper + 0.015;
    float core = length(f);                          // 毛の芯からの距離
    float alpha = smoothstep(rad, rad - 0.24, core) * zr; // 中心は濃く外周はふわっと
    if (alpha < 0.03) discard;

    // 毛の色は実写から拾う(根元寄りの位置をサンプル)
    vec3 col = texture2D(uPhoto, coverUv(rootUv)).rgb;
    // 影は根元だけごく軽く(暗く沈ませない: 0.72→0.90)
    col *= mix(0.90, 1.05, smoothstep(0.0, 0.6, h));
    // 毛先ハイライト + 毛芯に沿ったツヤ(1本1本の光沢で毛並み感を出す)
    float sheen = (1.0 - smoothstep(0.0, 0.5, core)) * smoothstep(0.3, 1.0, h);
    col += (vec3(0.15, 0.14, 0.12) * smoothstep(0.5, 1.0, h) + vec3(0.10) * sheen) * (1.0 - uSleep);
    // 毛束ごとの明暗ゆらぎ(のっぺり感を消す)
    col *= 0.93 + 0.14 * hash12(cell + 3.1);
    col *= 1.0 + uHappy * 0.08;                       // ごきげんだと毛づや up
    float sg = dot(col, vec3(0.30, 0.59, 0.11));
    col = mix(col, vec3(sg) * 0.78, uSleep * 0.7);

    // 軽く重ねて実写の質感を活かす(暗く沈ませない: 0.85→0.6)
    gl_FragColor = vec4(col, alpha * (0.6 + uBristle * 0.12));
  }
`;

// ── シェル(層)をインスタンス描画するジオメトリ ──────────────────
const plane = new THREE.PlaneGeometry(2, 2);
const geo = new THREE.InstancedBufferGeometry();
geo.index = plane.index;
geo.setAttribute('position', plane.attributes.position);
geo.setAttribute('uv', plane.attributes.uv);
const layers = new Float32Array(SHELLS);
for (let i = 0; i < SHELLS; i++) layers[i] = i;   // 0(実写) → 最上(毛先)
geo.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layers, 1));
geo.instanceCount = SHELLS;

const uniforms = {
  uShells:    { value: SHELLS },
  uAspect:    { value: W / H },
  uImgAspect: { value: IMG_ASPECT },
  uFlow:      { value: flowTex },
  uPhoto:     { value: photoTex },
  uMask:      { value: maskTex },
  uBristle:   { value: 0 },
  uHappy:     { value: 0 },
  uSleep:     { value: 0 },
};
const mat = new THREE.ShaderMaterial({
  vertexShader: vert,
  fragmentShader: frag,
  uniforms,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});
scene.add(new THREE.Mesh(geo, mat));

// ── 状態管理 ─────────────────────────────────────────────────────
const state = {
  mood: 0,            // -1(怒) .. +1(喜)
  activity: 0,        // 直近の撫で活動量 0..1
  hovering: false,
  pointer: null,      // {u, v} canvas 内の正規化座標(v は下が 0)
  vel: { x: 0, y: 0 },// uv/秒
  lastMove: 0,
  awake: false,
  lastHeart: 0,
  lastZzz: 0,
};

const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── ポインタ処理: 位置と速度を追跡 ────────────────────────────────
let prevPos = null, prevT = 0;

function toUv(e) {
  const r = canvas.getBoundingClientRect();
  return {
    u: (e.clientX - r.left) / r.width,
    v: 1 - (e.clientY - r.top) / r.height,   // フローマップと同じく下原点
  };
}

canvas.addEventListener('pointerenter', () => {
  state.hovering = true;
  wake();
});
canvas.addEventListener('pointerleave', () => {
  state.hovering = false;
  state.pointer = null;
  prevPos = null;
});
canvas.addEventListener('pointermove', (e) => {
  const pos = toUv(e);
  const now = performance.now() / 1000;
  if (prevPos) {
    const dt = Math.max(now - prevT, 1e-3);
    // 速度は少しなまして(ローパス)ガタつきを抑える
    state.vel.x = state.vel.x * 0.5 + ((pos.u - prevPos.u) / dt) * 0.5;
    state.vel.y = state.vel.y * 0.5 + ((pos.v - prevPos.v) / dt) * 0.5;
  }
  prevPos = pos; prevT = now;
  state.pointer = pos;
  state.lastMove = now;
});
canvas.addEventListener('pointerdown', () => {
  wake();
  onPoke();
});

// ── 起きる/寝る ──
function wake() {
  if (!state.awake) {
    state.awake = true;
    showBubble('！', 600);
  }
  state.lastMove = performance.now() / 1000;
}

// ── クリック時のリアクション ──
function onPoke() {
  if (state.mood > 0.35) { showBubble('にゃ〜♡', 900); meow(); }
  else if (state.mood < -0.25) { showBubble('シャーッ!!', 900); hiss(); shake(); }
  else { showBubble('…なに？', 800); meow(0.6); }
}

// ── フローマップ更新(撫での流れを書き込む) ─────────────────────────
function updateFlow(dt) {
  const decay = Math.pow(0.06, dt);   // 約 1 秒で 6% まで減衰
  for (let i = 0; i < flowF.length; i++) flowF[i] *= decay;

  // カーソル周辺にガウス状に速度をスタンプする
  if (state.pointer && state.hovering) {
    const speed = Math.hypot(state.vel.x, state.vel.y);
    if (speed > 0.02) {
      const cx = state.pointer.u * FLOW_N;
      const cy = state.pointer.v * FLOW_N;
      const R = 7;                       // スタンプ半径(テクセル)
      const sx = clamp(state.vel.x * 0.55, -1, 1);
      const sy = clamp(state.vel.y * 0.55, -1, 1);
      const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(FLOW_N - 1, Math.ceil(cx + R));
      const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(FLOW_N - 1, Math.ceil(cy + R));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy;
          const w = Math.exp(-(dx * dx + dy * dy) / (R * R * 0.4));
          const idx = (y * FLOW_N + x) * 2;
          flowF[idx]     = clamp(flowF[idx]     + sx * w, -1, 1);
          flowF[idx + 1] = clamp(flowF[idx + 1] + sy * w, -1, 1);
        }
      }
    }
  }
  // float(-1..1) → byte(0..255) に詰め替えて GPU へ
  for (let i = 0, j = 0; i < flowF.length; i += 2, j += 4) {
    flowU[j]     = flowF[i]     * 127 + 128;
    flowU[j + 1] = flowF[i + 1] * 127 + 128;
    flowU[j + 2] = 128;
    flowU[j + 3] = 255;
  }
  flowTex.needsUpdate = true;
}

// ── ごきげん計算 ──────────────────────────────────────────────────
// 毛並み(+X)に沿ってゆっくり撫でる → 加点 / 逆撫で → 減点(重め)
function updateMood(dt) {
  const speed = Math.hypot(state.vel.x, state.vel.y);
  const stroking = state.hovering && state.pointer && speed > 0.05;

  if (stroking) {
    const align = state.vel.x / (speed + 1e-6);   // +1: 毛並み方向 / -1: 逆撫で
    const gentle = smooth01((speed - 0.05) / 0.5) * (1 - smooth01((speed - 1.6) / 1.2)); // 速すぎは効果減
    if (align > 0.35) state.mood += 0.45 * gentle * dt;
    else if (align < -0.35) state.mood -= 0.9 * smooth01((speed - 0.05) / 0.4) * dt;
    state.activity = Math.min(1, state.activity + dt * 3);
  } else {
    state.activity = Math.max(0, state.activity - dt * 1.5);
  }
  // 何もしないと徐々に平常心へ
  state.mood += (0 - state.mood) * (state.hovering ? 0.06 : 0.25) * dt;
  state.mood = clamp(state.mood, -1, 1);

  // 速度は入力が途絶えたら減衰させる
  const now = performance.now() / 1000;
  if (now - state.lastMove > 0.08) {
    state.vel.x *= 0.8; state.vel.y *= 0.8;
  }
}

// ── 吹き出し / ハート / zzz ──────────────────────────────────────
const bubble = document.getElementById('bubble');
let bubbleTimer = null;
function showBubble(text, ms, cls) {
  bubble.textContent = text;
  bubble.classList.toggle('heart', cls === 'heart');
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
}

function spawnFloat(text, x, y, cls) {
  if (prefersReduced) return;
  const el = document.createElement('span');
  el.className = 'float-item ' + (cls || '');
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  stage.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

function shake() {
  if (prefersReduced) return;
  canvas.animate(
    [ { transform: 'translateX(0)' }, { transform: 'translateX(-5px)' },
      { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' },
      { transform: 'translateX(0)' } ],
    { duration: 300 }
  );
}

// ── サウンド(Web Audio) ───────────────────────────────────────────
// ブラウザの自動再生制限のため、トグルボタンのクリックで初期化する
let actx = null, soundOn = false;
let purrAmp = null, lfoDepth = null;

const soundBtn = document.getElementById('soundToggle');
soundBtn.addEventListener('click', () => {
  if (!actx) initAudio();
  soundOn = !soundOn;
  if (soundOn) actx.resume();
  soundBtn.classList.toggle('on', soundOn);
  soundBtn.textContent = soundOn ? '🔊 音 ON（撫でてみて）' : '🔈 音を出す（ゴロゴロ）';
});

function initAudio() {
  actx = new (window.AudioContext || window.webkitAudioContext)();

  // ゴロゴロ: ブラウンノイズ → ローパス → 25Hz で振幅変調
  const len = actx.sampleRate * 2;
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;   // ブラウンノイズ(低域寄り)
    data[i] = last * 3.5;
  }
  const src = actx.createBufferSource();
  src.buffer = buf; src.loop = true;

  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 240; lp.Q.value = 0.7;

  purrAmp = actx.createGain(); purrAmp.gain.value = 0;

  // 25Hz の LFO を gain に接続して「ゴロ…ゴロ…」の脈動を作る
  const lfo = actx.createOscillator(); lfo.frequency.value = 25;
  lfoDepth = actx.createGain(); lfoDepth.gain.value = 0;
  lfo.connect(lfoDepth); lfoDepth.connect(purrAmp.gain);

  src.connect(lp).connect(purrAmp).connect(actx.destination);
  src.start(); lfo.start();
}

// にゃ〜(クリック時): のこぎり波のピッチを山なりに動かす
function meow(vol) {
  if (!actx || !soundOn) return;
  vol = vol || 1;
  const t = actx.currentTime;
  const o = actx.createOscillator(); o.type = 'sawtooth';
  const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1300; f.Q.value = 3;
  const g = actx.createGain();
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(880, t + 0.12);
  o.frequency.exponentialRampToValueAtTime(430, t + 0.38);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16 * vol, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  o.connect(f); f.connect(g); g.connect(actx.destination);
  o.start(t); o.stop(t + 0.45);
}

// シャーッ(怒り): ハイパスを通したノイズバースト
function hiss() {
  if (!actx || !soundOn) return;
  const t = actx.currentTime;
  const len = actx.sampleRate * 0.4;
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = buf;
  const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  src.connect(hp); hp.connect(g); g.connect(actx.destination);
  src.start(t);
}

// ── UI 反映(メーター) ─────────────────────────────────────────────
const moodFill = document.getElementById('moodFill');
function updateUI() {
  const m = state.mood;
  if (m >= 0) {
    moodFill.style.left = '50%';
    moodFill.style.width = (m * 50) + '%';
    moodFill.style.background = '#d2802f';
  } else {
    moodFill.style.left = (50 + m * 50) + '%';
    moodFill.style.width = (-m * 50) + '%';
    moodFill.style.background = '#b04a4a';
  }
}

// ── メインループ ─────────────────────────────────────────────────
let angryFlag = false;
let happyFlag = false;
let prevFrame = performance.now() / 1000;

function tick() {
  const now = performance.now() / 1000;
  const dt = Math.min(now - prevFrame, 0.05);
  prevFrame = now;

  updateFlow(dt);
  updateMood(dt);
  updateUI();

  // 怒り状態に「入った瞬間」だけシャー演出
  const angry = state.mood < -0.25;
  if (angry && !angryFlag) { showBubble('シャーッ!!', 800); hiss(); shake(); }
  angryFlag = angry;

  // ごきげんが上がって喜び状態に「入った瞬間」だけ吹き出しにハート
  const happy = state.mood > 0.5;
  if (happy && !happyFlag) { showBubble('♡', 1000, 'heart'); }
  happyFlag = happy;

  // シェーダーの uniform を目標値へなめらかに追従させる
  const sleepTarget = state.awake ? 0 : 1;
  uniforms.uBristle.value += ((angry ? 1 : 0) - uniforms.uBristle.value) * Math.min(dt * 8, 1);
  uniforms.uHappy.value   += (Math.max(0, state.mood) - uniforms.uHappy.value) * Math.min(dt * 4, 1);
  uniforms.uSleep.value   += (sleepTarget - uniforms.uSleep.value) * Math.min(dt * 3, 1);

  // ゴロゴロ音量: ごきげん × 撫で活動量
  if (purrAmp) {
    const level = soundOn ? Math.max(0, state.mood - 0.25) / 0.75 * state.activity * 0.5 : 0;
    purrAmp.gain.setTargetAtTime(level * 0.55, actx.currentTime, 0.08);
    lfoDepth.gain.setTargetAtTime(level * 0.45, actx.currentTime, 0.08);
  }

  // ゴロゴロ中は canvas がかすかに震える(触覚の視覚化)
  if (!prefersReduced) {
    const purring = state.mood > 0.35 && state.activity > 0.3;
    canvas.style.transform = purring
      ? 'translateY(' + ((Math.random() - 0.5) * 1.2) + 'px)'
      : '';
  }

  // ハート: ごきげんに撫でている間、ときどきカーソル位置から湧く
  if (state.mood > 0.45 && state.activity > 0.4 && state.pointer && now - state.lastHeart > 0.35) {
    state.lastHeart = now;
    const r = canvas.getBoundingClientRect();
    spawnFloat('♡', state.pointer.u * r.width, (1 - state.pointer.v) * r.height - 10, '');
  }

  // 睡眠判定: 7 秒操作がなければ寝る + zzz
  if (state.awake && !state.hovering && now - state.lastMove > 7) state.awake = false;
  if (!state.awake && now - state.lastZzz > 1.4) {
    state.lastZzz = now;
    spawnFloat('z', 350 + Math.random() * 30, 110, 'zzz');
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ── リサイズ対応(モバイルで縮む場合) ──────────────────────────────
function resize() {
  const r = stage.getBoundingClientRect();
  W = r.width; H = r.height;
  renderer.setSize(W, H, false);
  uniforms.uAspect.value = W / H;
}
window.addEventListener('resize', resize);

// ── ユーティリティ ──
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }

// WebGL 非対応フォールバック
try {
  renderer.getContext();
  resize();
  tick();
} catch (e) {
  stage.innerHTML = '<p style="text-align:center;padding-top:150px;">WebGL が利用できない環境です</p>';
}
