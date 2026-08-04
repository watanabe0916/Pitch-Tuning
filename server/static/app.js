"use strict";
/*
 * ボーカル・ピッチエディタ フロントエンド（Phase 3）。
 * Canvas ピアノロール + 縦ドラッグ(50cent スナップ) + /api/render 再生。
 *
 * 座標変換は View に集約する（6.5: time→x / cents→y を1箇所に）。
 */

// ---- 純粋ロジックは pitchlogic.js に集約（DOM 非依存・テスト可能） ----
const PL = window.PitchLogic;
const { hzToCents, isBlackKey, centsToName, snapCents } = PL;

// ---- state ----
const state = {
  session: null,        // {sessionId, sampleRate, durationSec, hopSec, f0Hz, rmsDb, notes}
  view: null,           // 座標変換 + 描画範囲
  drag: null,           // 進行中のドラッグ {mode, ...}
  selected: null,       // 単一選択（補正スライダーの対象。selection.length===1 のとき）
  selection: [],        // 選択中セグメント配列（範囲選択で複数になりうる）
  clipboard: null,      // コピーしたバー群
  marquee: null,        // 範囲選択の矩形 {x0,y0,x1,y1}
  master: 0.0,          // masterGainDb
  reverb: { mix: 0.0, decaySec: 1.2 },   // 出力段リバーブ
  pxPerSec: 260,        // 横ズーム率
  pxPerSemi: null,      // 縦ズーム率（1半音あたりの高さ px）。null = 全音域を画面に収める
  mouse: { clientX: 0, clientY: 0 },
  gKey: false,          // G キー押下中（音量ツール）
  aKey: false,          // A キー押下中（追加選択モード）
  rec: null,            // 録音中の状態 {active, stream, ctx, chunks, peak, meterRAF}
  audio: {
    ctx: null, buffer: null, source: null, playing: false,
    backingSrc: null, vocalGain: null, backingGain: null, startAt: 0,
    seekAt: 0,      // 今回の再生を開始した位置（秒）
    playSec: 0,     // 再生ヘッドの現在位置（秒）。停止後もここから再開する
    follow: true,   // 再生ヘッドに合わせて画面を横スクロールするか（手動スクロールで一時解除）
  },
  phDrag: false,    // 再生ヘッドを掴んでドラッグ中か
  backing: null,        // {peaks, durationSec, offsetSec, gainDb, mute, solo, buffer}
  dubs: [],             // 追加トラック [{sessionId, notes, rmsDb, buffer, dirty, enabled}]
  sessReg: {},          // sessionId → 静的解析データ（f0Hz/rmsDb 等）。削除アンドゥ・昇格に使う
  playMain: true,       // 録音1（主トラック）を再生・モニターで鳴らすか
  dirty: false,         // 未再合成の編集があるか
  tempo: { bpm: 120, beatsPerBar: 4 },   // 小節線とメトロノームのテンポ・拍子
  metronome: { on: true, timer: null },  // 録音中にメトロノームを鳴らすか
};

const els = {
  file: document.getElementById("file"),
  play: document.getElementById("play"),
  stop: document.getElementById("stop"),
  snap: document.getElementById("snap"),
  status: document.getElementById("status"),
  keys: document.getElementById("keys"),
  grid: document.getElementById("grid"),
  editor: document.getElementById("editor"),
  master: document.getElementById("master"),
  masterval: document.getElementById("masterval"),
  strength: document.getElementById("strength"),
  strengthval: document.getElementById("strengthval"),
  fmt: document.getElementById("fmt"),
  normalize: document.getElementById("normalize"),
  export: document.getElementById("export"),
  bfile: document.getElementById("bfile"),
  backinglane: document.getElementById("backinglane"),
  bcanvas: document.getElementById("bcanvas"),
  bvol: document.getElementById("bvol"),
  bmute: document.getElementById("bmute"),
  bsolo: document.getElementById("bsolo"),
  boffset: document.getElementById("boffset"),
  bremove: document.getElementById("bremove"),
  playhead: document.getElementById("playhead"),
  bplayhead: document.getElementById("bplayhead"),
  phgrab: document.querySelector(".phgrab"),
  tostart: document.getElementById("tostart"),
  record: document.getElementById("record"),
  tracksgroup: document.getElementById("tracksgroup"),
  trackssep: document.getElementById("trackssep"),
  tracks: document.getElementById("tracks"),
  bpm: document.getElementById("bpm"),
  beats: document.getElementById("beats"),
  metro: document.getElementById("metro"),
  meter: document.getElementById("meter"),
  meterbar: document.getElementById("meterbar"),
  meterlabel: document.getElementById("meterlabel"),
  reverb: document.getElementById("reverb"),
  reverbval: document.getElementById("reverbval"),
  undo: document.getElementById("undo"),
  redo: document.getElementById("redo"),
  hzoomin: document.getElementById("hzoomin"),
  hzoomout: document.getElementById("hzoomout"),
  vzoomin: document.getElementById("vzoomin"),
  vzoomout: document.getElementById("vzoomout"),
  projfile: document.getElementById("projfile"),
  projsave: document.getElementById("projsave"),
};

const RL = window.RecLogic;

const setStatus = (msg) => { els.status.textContent = msg; };

// 横方向のズーム率。内容幅 = 秒数 × pxPerSec（最低でもビューポート幅を満たす）。
// これにより長い音声は横スクロールになり、鍵盤列は固定のまま常に見える。
// 内容（スクロール範囲）の 1辺の上限。canvas ではなく空の div のサイズなので、
// 大きくしてもメモリはほぼ食わない（canvas は常に表示領域ぶんだけ確保する）。
const MAX_CONTENT_PX = 200000;

const gridwrap = () => els.grid.parentElement;
const keyswrap = () => els.keys.parentElement;

// レイアウト寸法（CSS px）。
// 横: 内容幅 = 秒数 × pxPerSec。縦: 内容高 = 半音数 × pxPerSemi。
// pxPerSemi が null のときは全音域がちょうど画面に収まる高さ（＝従来の挙動）。
function layout() {
  const gw = gridwrap();
  const viewH = gw.clientHeight, viewW = gw.clientWidth;
  const dur = state.session ? Math.max(state.session.durationSec, 0.5) : 1;
  const contentW = Math.round(Math.min(MAX_CONTENT_PX, Math.max(viewW, dur * state.pxPerSec)));

  const { lo, hi } = viewRange();
  const semis = Math.max(1, (hi - lo) / 100);
  const fitPx = viewH / semis;                       // 全音域が収まる 1半音あたりの高さ
  const per = Math.max(fitPx, state.pxPerSemi || 0); // 収まりきる高さより小さくはしない
  const contentH = Math.round(Math.min(MAX_CONTENT_PX, Math.max(viewH, semis * per)));
  return { contentW, contentH, viewW, viewH, fitPx, semis, dur };
}

// スクロール範囲を作る空の div（canvas の代わりに「内容の大きさ」を持つ役）。
// index.html に無ければ動的に作り、位置指定も JS で入れる。こうしておくと、
// ブラウザが古い HTML/CSS をキャッシュしていても app.js だけで正しく組み上がる。
function makeSpacer(id, wrap, canvas) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("div"); el.id = id; wrap.insertBefore(el, wrap.firstChild); }
  Object.assign(el.style, { position: "absolute", top: "0", left: "0", pointerEvents: "none" });
  Object.assign(canvas.style, { position: "absolute", top: "0", left: "0" });
  return el;
}
let _spacersReady = false;
function ensureSpacers() {
  if (_spacersReady) return;
  els.gridspace = makeSpacer("gridspace", gridwrap(), els.grid);
  els.bspace = makeSpacer("bspace", els.bcanvas.parentElement, els.bcanvas);
  _spacersReady = true;
}

// 内容座標（0,0）が画面上のどこに来るかを返す。canvas は表示範囲ぶんしか無く
// スクロール位置へ transform で貼り付いているので、canvas の rect は使えない。
function contentOrigin() {
  const gw = gridwrap(), r = gw.getBoundingClientRect();
  return { left: r.left - gw.scrollLeft, top: r.top - gw.scrollTop };
}

// 描画コンテキストを「内容座標で描けば、見えている範囲だけが canvas に出る」状態にする。
function applyViewTransform(ctx) {
  const dpr = window.devicePixelRatio || 1, gw = gridwrap();
  ctx.setTransform(dpr, 0, 0, dpr, -gw.scrollLeft * dpr, -gw.scrollTop * dpr);
}
function clearCanvas(cv) {
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  return ctx;
}
// いま画面に見えている時間範囲（描画の間引きに使う）。
function visibleTimeRange(v) {
  const gw = gridwrap();
  return { t0: v.xToTime(gw.scrollLeft), t1: v.xToTime(gw.scrollLeft + gw.clientWidth) };
}

// 音源を読み込んだ直後の初期表示: 縦軸そのものは固定範囲のまま、
// 「収録された音域がちょうど画面いっぱいに見える」ズーム率とスクロール位置にする。
// 上下に動かす余地は常にあり、スクロールすれば固定範囲の端まで届く。
function fitViewToNotes() {
  if (!state.session) return;
  const gw = gridwrap();
  const viewH = gw.clientHeight;
  const nr = PL.pitchRange(state.session.notes);      // 収録音源の音域（±300cent マージン込み）
  const semis = Math.max(4, (nr.hi - nr.lo) / 100);   // 極端に狭い素材でも拡大しすぎない
  state.pxPerSemi = Math.min(MAX_PX_PER_SEMI, viewH / semis);
  resizeCanvases(); draw();
  const y = state.view.centsToY((nr.lo + nr.hi) / 2);  // 収録音域の中心を画面中央へ
  gw.scrollTop = Math.max(0, Math.min(state.view.height - viewH, y - viewH / 2));
  syncVScroll();
}

// スクロールに合わせて、canvas と付随要素の位置を合わせ直す。
//  - グリッド canvas: 表示範囲ぶんしか無いので、スクロール位置へ transform で貼り付ける
//  - 再生ヘッドのつまみ: 内容の先頭ではなく、常に見えている上端に置く
function syncVScroll() {
  const gw = gridwrap();
  els.grid.style.transform = `translate(${gw.scrollLeft}px, ${gw.scrollTop}px)`;
  els.phgrab.style.top = gw.scrollTop + "px";
}

// ==========================================================================
// View: 座標変換（time↔x, cents↔y）を集約
// ==========================================================================
// 主セッション + 重ねどり全レイヤーのノートをまとめて返す（描画・ヒットテスト用）。
function allNotes() {
  let arr = state.session ? state.session.notes : [];
  for (const d of state.dubs) arr = arr.concat(d.notes);
  return arr;
}

// 縦軸（音程）の表示範囲はシステム固定にする。
// 収録音源の音域に合わせて可変にすると、バーを上下させるたびに軸が伸び縮みし、
// 狭い音域の素材では少し動かしただけでバーが画面外へ消えてしまうため。
// C2(MIDI 36, 65Hz) 〜 C6(MIDI 84, 1047Hz)。人声の基音はほぼこの中に収まる。
const PITCH_MIN_CENTS = 3600, PITCH_MAX_CENTS = 8400;

// 実際の表示範囲。原則は固定範囲。万一ノートがそれを超えた場合だけ広げる（安全網）。
function viewRange() {
  let lo = PITCH_MIN_CENTS, hi = PITCH_MAX_CENTS;
  for (const n of allNotes()) for (const s of n.segments) {
    const c = s.baseCents + s.pitchOffsetCents;
    if (c - 200 < lo) lo = Math.floor((c - 200) / 100) * 100;
    if (c + 200 > hi) hi = Math.ceil((c + 200) / 100) * 100;
  }
  return { lo, hi };
}

function makeView(session, width, height) {
  const { lo, hi } = viewRange();
  const t0 = 0, t1 = Math.max(session.durationSec, 0.5);
  return PL.makeTransforms(t0, t1, lo, hi, width, height);
}

// ==========================================================================
// 描画
// ==========================================================================
// canvas は「見えている範囲ぶん」だけを確保する（内容全体ぶんは確保しない）。
// スクロール範囲は #gridspace の寸法が作り、canvas は transform で追従する。
// これにより、どれだけ拡大してもビットマップのメモリは一定に保たれる。
function resizeCanvases() {
  ensureSpacers();
  const dpr = window.devicePixelRatio || 1;
  const { contentW, contentH, viewW, viewH } = layout();
  // スクロール範囲を作る空の div
  els.gridspace.style.width = contentW + "px";
  els.gridspace.style.height = contentH + "px";
  // グリッド: 表示範囲ぶんの canvas
  els.grid.style.width = viewW + "px";
  els.grid.style.height = viewH + "px";
  els.grid.width = Math.round(viewW * dpr);
  els.grid.height = Math.round(viewH * dpr);
  // 鍵盤: 固定幅 × 表示高さ（グリッドと同じ縦スケールで、同じ縦オフセットで描く）
  const kw = keyswrap().clientWidth;
  els.keys.style.height = viewH + "px";
  els.keys.width = Math.round(kw * dpr);
  els.keys.height = Math.round(viewH * dpr);
  // 再生ヘッドの縦線は内容高いっぱいに伸ばす（内容座標に置かれるため）
  els.playhead.style.height = contentH + "px";
  syncVScroll();
}

function draw() {
  if (!state.session) {
    // 空状態（全トラック削除後など）: キャンバスを消す
    clearCanvas(els.grid); clearCanvas(els.keys);
    updatePlayheadStatic();
    return;
  }
  const { contentW, contentH } = layout();
  state.view = makeView(state.session, contentW, contentH);
  const ctx = clearCanvas(els.grid);
  applyViewTransform(ctx);          // 以降は内容座標のまま描ける
  renderScene(ctx, state.view, null);
  drawKeys();
  syncVScroll();
  if (state.backing) drawBacking();
  updatePlayheadStatic();   // ズーム/スクロール後も再生ヘッドを正しい位置へ
}

// ドラッグ中の再描画を requestAnimationFrame で間引く（最大リフレッシュレート）。
// さらに、ドラッグ中は「動かさない部分」を一度だけオフスクリーンへ描いておき、
// 毎フレームはそのビットマップを貼り付け（GPUで高速）＋動かすセグメントだけを
// 上描きする。これで1フレームの負荷が内容量（音声長・ノート数）に依らず一定になる。
let _drawScheduled = false;
function scheduleDraw() {
  if (_drawScheduled) return;
  _drawScheduled = true;
  requestAnimationFrame(() => {
    _drawScheduled = false;
    if (state.drag && state.drag.bgReady) drawDragFrame();
    else draw();
  });
}

// --- オフスクリーン背景キャッシュ（ドラッグ中のみ使用） ---
// 表示 canvas と同じ寸法（＝表示範囲ぶん）。スクロールすると内容がずれるので、
// そのときは作り直す（_bgScroll でスクロール位置を覚えておく）。
let _bg = null, _bgCtx = null, _bgScroll = null;
function ensureBg() {
  if (!_bg) { _bg = document.createElement("canvas"); _bgCtx = _bg.getContext("2d"); }
  if (_bg.width !== els.grid.width || _bg.height !== els.grid.height) {
    _bg.width = els.grid.width; _bg.height = els.grid.height;
  }
  _bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  _bgCtx.clearRect(0, 0, _bg.width, _bg.height);
  applyViewTransform(_bgCtx);
  return _bgCtx;
}

// ドラッグ開始時: liveSegs 以外の全シーンを背景キャッシュに描く。
function prepareDragBackground(liveSegs) {
  const gw = gridwrap();
  renderScene(ensureBg(), state.view, liveSegs);
  state.drag.liveSegs = liveSegs;
  state.drag.bgReady = true;
  _bgScroll = { l: gw.scrollLeft, t: gw.scrollTop };
}

// ドラッグ中フレーム: 背景をそのまま貼り付け → 動かすセグメントだけを上描き。
// 1フレームの負荷が内容量（音声長・ノート数）に依らず一定になる。
function drawDragFrame() {
  const gw = gridwrap();
  // 自動スクロールなどで表示位置が変わっていたら背景を作り直す
  const vMoved = !_bgScroll || _bgScroll.t !== gw.scrollTop;
  if (vMoved || _bgScroll.l !== gw.scrollLeft) {
    prepareDragBackground(state.drag.liveSegs);
    // 縦に動いたときは鍵盤列も同じ位置へ描き直す。
    // ここを忘れると、ドラッグ中の自動スクロール中だけ左の音階表示が止まって見え、
    // ドラッグを離した瞬間にまとめてずれる（＝グリッドと音階がずれて見える）。
    if (vMoved) drawKeys();
  }
  const ctx = clearCanvas(els.grid);
  ctx.drawImage(_bg, 0, 0);
  applyViewTransform(ctx);
  for (const seg of state.drag.liveSegs) {
    const loc = locateSeg(seg);
    if (loc) drawOneSegment(ctx, state.view, loc.note, seg, loc.i);
  }
  // 範囲選択の矩形
  if (state.drag.mode === "marquee") {
    const d = state.drag;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    ctx.fillStyle = "rgba(232,162,61,0.14)";
    ctx.strokeStyle = "rgba(244,192,107,0.85)";
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
}

function locateSeg(seg) {
  for (const note of allNotes()) {
    const i = note.segments.indexOf(seg);
    if (i >= 0) return { note, i };
  }
  return null;
}

// 全シーン（グリッド + F0曲線 + ノート）を任意の context に描く。
// skip: 省略するセグメントの Set（ドラッグ中の背景生成で使う）。
function renderScene(ctx, v, skip) {
  // 見えている範囲だけを描く。canvas は表示範囲ぶんしか無く、内容座標へ平行移動して
  // あるので、範囲外を描いても捨てられるだけ（＝拡大するほど無駄になる）。
  const vis = visibleTimeRange(v);
  const x0 = v.timeToX(vis.t0), x1 = v.timeToX(vis.t1);
  const gw = gridwrap();
  const cTop = v.yToCents(gw.scrollTop), cBot = v.yToCents(gw.scrollTop + gw.clientHeight);

  // 半音行の背景（黒鍵行を薄く）
  const rowLo = Math.max(v.cLo, Math.floor((cBot - 100) / 100) * 100);
  const rowHi = Math.min(v.cHi, Math.ceil((cTop + 100) / 100) * 100);
  for (let c = rowLo; c <= rowHi; c += 100) {
    const midi = Math.round(c / 100);
    const y = v.centsToY(c + 50);
    const h = v.rowHeightPx;
    ctx.fillStyle = isBlackKey(midi) ? "#14100b" : "#1a1510";
    ctx.fillRect(x0, y - h / 2, x1 - x0, h);
    ctx.strokeStyle = "#2a2115";
    ctx.beginPath(); ctx.moveTo(x0, v.centsToY(c)); ctx.lineTo(x1, v.centsToY(c)); ctx.stroke();
  }

  // 時間グリッド = BPM と拍子による拍線・小節線。
  // 小節線は明るく＋小節番号、拍線は細く。BPM が速く拍線が密なら間引く。
  // 小節番号は機材の表示器のようにモノスペースで（style.css の --font-data と揃える）。
  ctx.font = "10px ui-monospace, 'SF Mono', 'Roboto Mono', monospace";
  const bpm = state.tempo.bpm, beats = state.tempo.beatsPerBar;
  const spb = 60 / bpm;                       // 1拍の秒数
  const beatPx = spb * (v.width / (v.t1 || 1));
  const beatStride = beatPx < 6 ? Math.ceil(6 / beatPx) : 1;  // 拍線が詰まりすぎたら間引く
  const yTop = gw.scrollTop, yBot = gw.scrollTop + gw.clientHeight;
  let bi = Math.max(0, Math.floor(vis.t0 / spb));      // 画面に入る最初の拍から
  for (let t = bi * spb; t <= Math.min(v.t1, vis.t1) + 1e-6; t += spb, bi++) {
    const x = v.timeToX(t);
    const isBar = bi % beats === 0;
    if (!isBar && (bi % beatStride !== 0)) continue;
    ctx.strokeStyle = isBar ? "#4a3f2c" : "#221c13";
    ctx.lineWidth = isBar ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
    if (isBar) {                              // 小節番号（1始まり・画面上端に固定）
      ctx.fillStyle = "#8c8172";
      ctx.fillText(String(bi / beats + 1), x + 3, yTop + 11);
    }
  }
  ctx.lineWidth = 1;

  // フレーズ境界（無音での分割点・10.4）を薄いシアンの破線で示す
  const bounds = state.session.phraseBounds || [];
  if (bounds.length) {
    ctx.strokeStyle = "rgba(79,183,176,0.55)"; ctx.setLineDash([6, 4]);
    for (const tb of bounds) {
      if (tb < vis.t0 || tb > vis.t1) continue;
      const x = v.timeToX(tb);
      ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawF0Curve(ctx, v, vis);
  for (const note of allNotes()) {
    note.segments.forEach((s, i) => {
      if (skip && skip.has(s)) return;
      if (s.endSec < vis.t0 || s.startSec > vis.t1) return;   // 画面外のバーは描かない
      drawOneSegment(ctx, v, note, s, i);
    });
  }
}

// 白い F0 曲線（編集オフセットを反映した表示用の近似）
function drawF0Curve(ctx, v, vis) {
  const s = state.session, f0 = s.f0Hz, hop = s.hopSec;
  const primary = s.notes.filter((n) => !n.voice);   // 曲線は主ボイスのみ反映
  ctx.strokeStyle = "rgba(237,230,216,0.9)"; ctx.lineWidth = 1.3;
  ctx.beginPath();
  let pen = false;
  // 画面に入るフレームだけ辿る（拡大時に全長を走査しないため）
  const iFrom = vis ? Math.max(0, Math.floor(vis.t0 / hop) - 1) : 0;
  const iTo = vis ? Math.min(f0.length, Math.ceil(vis.t1 / hop) + 2) : f0.length;
  for (let i = iFrom; i < iTo; i++) {
    const hz = f0[i];
    if (!(hz > 0)) { pen = false; continue; }
    const t = i * hop;
    const off = PL.offsetAtTime(primary, t);
    const c = hzToCents(hz) + off;
    const x = v.timeToX(t), y = v.centsToY(c);
    if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// 重ねどりレイヤーの色（トラック2〜5）。Tracks ボタン（TRACK_HEX）と同色。
// 5トラック目以降は循環する。
const DUB_COLORS = [
  { base: "201,106,152", bright: "232,140,185", stroke: "240,170,205" },  // ローズ
  { base: "155,127,214", bright: "180,155,235", stroke: "201,184,240" },  // すみれ
  { base: "152,184,84",  bright: "175,205,110", stroke: "200,222,154" },  // 若葉
  { base: "94,159,212",  bright: "125,185,235", stroke: "168,205,240" },  // 空
];
function dubColorOf(note) {
  const i = state.dubs.findIndex((d) => d.sessionId === note.dub);
  return DUB_COLORS[(i >= 0 ? i : 0) % DUB_COLORS.length];
}

// 1 セグメント分の描画（塗り高さ・RMS背景・枠・遷移帯）。
function drawOneSegment(ctx, v, note, s, i) {
  const h = Math.max(10, v.rowHeightPx * 0.9);
  const dubOf = note.dub ? state.dubs.find((dd) => dd.sessionId === note.dub) : null;
  const rms = dubOf ? dubOf.rmsDb : state.session.rmsDb;
  const hop = state.session.hopSec;
  const c = s.baseCents + s.pitchOffsetCents;
  const x0 = v.timeToX(s.startSec), x1 = v.timeToX(s.endSec);
  const w = Math.max(1, x1 - x0);
  const yc = v.centsToY(c), yTop = yc - h / 2, yBot = yc + h / 2;
  const active = state.drag && (state.drag.seg === s ||
    (state.drag.group && state.drag.group.some((g) => g.seg === s)));
  const selected = state.selection.indexOf(s) >= 0;

  drawRmsBg(ctx, v, s, x0, x1, yBot, h, rms, hop);

  if (s.mute) {
    ctx.strokeStyle = "rgba(156,144,130,0.85)";
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, yTop + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
  } else {
    const fill = PL.gainFillFraction(s.gainDb);
    const fh = h * fill;
    // 主声部=琥珀（VUメーターの発光色）／ハモリ=ティール／重ねどり=トラックごとの4色。
    const harm = !!note.voice;
    const dub = !!note.dub;
    const dc = dub ? dubColorOf(note) : null;
    ctx.fillStyle = active
      ? (dub ? `rgba(${dc.bright},0.95)` : harm ? "rgba(94,196,189,0.95)" : "rgba(244,192,107,0.95)")
      : (selected
        ? (dub ? `rgba(${dc.bright},0.9)` : harm ? "rgba(79,183,176,0.9)" : "rgba(232,162,61,0.92)")
        : (dub ? `rgba(${dc.base},${i % 2 ? 0.66 : 0.76})`
          : harm ? "rgba(69,163,156,0.72)"
            : (i % 2 ? "rgba(196,138,58,0.68)" : "rgba(216,154,68,0.78)")));
    ctx.fillRect(x0, yBot - fh, w, fh);
    ctx.strokeStyle = selected ? "rgba(255,224,150,1)"
      : (dub ? `rgba(${dc.stroke},0.85)` : harm ? "rgba(150,224,218,0.9)" : "rgba(244,208,140,0.85)");
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(x0 + 0.5, yTop + 0.5, w - 1, h - 1);
    ctx.lineWidth = 1;
  }

  // 分割線 + 遷移区間帯（F-3 の可視化）
  if (i > 0) {
    const prev = note.segments[i - 1];
    const yPrev = v.centsToY(prev.baseCents + prev.pitchOffsetCents);
    const tau = (s.transitionInMs || 40) / 1000;
    const bx0 = v.timeToX(s.startSec - tau / 2), bx1 = v.timeToX(s.startSec + tau / 2);
    const bandTop = Math.min(yPrev, yc) - h / 2, bandBot = Math.max(yPrev, yc) + h / 2;
    ctx.fillStyle = "rgba(232,162,61,0.2)";
    ctx.fillRect(bx0, bandTop, Math.max(2, bx1 - bx0), bandBot - bandTop);
    ctx.strokeStyle = "rgba(244,192,107,0.95)";
    ctx.beginPath(); ctx.moveTo(x0, bandTop); ctx.lineTo(x0, bandBot); ctx.stroke();
  }
}

// 原音の RMS 包絡線を矩形内に薄グレーで描く（下端基準、-60..0dB を 0..1 に正規化）
function drawRmsBg(ctx, v, s, x0, x1, yBot, h, rms, hop) {
  if (!rms || !rms.length) return;
  const i0 = Math.max(0, Math.floor(s.startSec / hop));
  const i1 = Math.min(rms.length - 1, Math.ceil(s.endSec / hop));
  ctx.fillStyle = "rgba(237,230,216,0.10)";
  ctx.beginPath(); ctx.moveTo(x0, yBot);
  for (let i = i0; i <= i1; i++) {
    const norm = Math.max(0, Math.min(1, (rms[i] + 60) / 60));
    ctx.lineTo(v.timeToX(i * hop), yBot - h * norm);
  }
  ctx.lineTo(x1, yBot); ctx.closePath(); ctx.fill();
}

function drawKeys() {
  const v = state.view, gw = gridwrap();
  const ctx = clearCanvas(els.keys);
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, -gw.scrollTop * dpr);   // グリッドと同じ縦位置に揃える
  const w = els.keys.getBoundingClientRect().width;
  // 見えている行だけ描く
  const cTop = v.yToCents(gw.scrollTop), cBot = v.yToCents(gw.scrollTop + gw.clientHeight);
  const rowLo = Math.max(v.cLo, Math.floor((cBot - 100) / 100) * 100);
  const rowHi = Math.min(v.cHi, Math.ceil((cTop + 100) / 100) * 100);
  for (let c = rowLo; c <= rowHi; c += 100) {
    const midi = Math.round(c / 100);
    const y = v.centsToY(c + 50), h = v.rowHeightPx;
    ctx.fillStyle = isBlackKey(midi) ? "#120f0a" : "#ede6d8";
    ctx.fillRect(0, y - h / 2, w, h);
    ctx.strokeStyle = "#3a3226"; ctx.strokeRect(0, y - h / 2, w, h);
    if (!isBlackKey(midi)) {
      ctx.fillStyle = "#6b6153"; ctx.font = "9px ui-monospace, 'SF Mono', 'Roboto Mono', monospace";
      ctx.fillText(centsToName(c), 4, y + 3);
    }
  }
}

// ==========================================================================
// 編集操作（分割/結合/遷移区間/音高/音量）
// ==========================================================================
const mods = (e) => ({ shift: e.shiftKey, alt: e.altKey });
function updateSnapLabel(e) { els.snap.textContent = PL.snapStep(mods(e)) + " cent"; }

function noteOf(seg) {
  for (const n of allNotes()) if (n.segments.indexOf(seg) >= 0) return n;
  return null;
}
function replaceNote(oldNote, newNote) {
  const idx = state.session.notes.indexOf(oldNote);
  if (idx >= 0) { state.session.notes[idx] = newNote; return; }
  for (const d of state.dubs) {
    const j = d.notes.indexOf(oldNote);
    if (j >= 0) { newNote.dub = oldNote.dub; d.notes[j] = newNote; return; }
  }
}

// ヒットテスト: 分割線(divider) を最優先、次にセグメント本体(body)。
// cents が与えられた場合、クリックが **バー本体の縦範囲内** にあるものだけを対象にする。
// （バーの上下の空白をクリックしても、その時刻のノートを掴まないようにする）
function hitTest(px, t, cents) {
  const v = state.view;
  // バー1本の縦の半径（cent）。drawOneSegment の h = max(10, rowHeightPx*0.9) と一致させる。
  const halfCents = (Math.max(10, v.rowHeightPx * 0.9) / 2) * v.centsPerPixel;
  const within = (s) => cents == null ||
    Math.abs((s.baseCents + s.pitchOffsetCents) - cents) <= halfCents;

  const notes = allNotes();
  for (const note of notes) {
    for (let i = 1; i < note.segments.length; i++) {
      const s = note.segments[i], p = note.segments[i - 1];
      if (Math.abs(px - v.timeToX(s.startSec)) < 6 && (within(s) || within(p)))
        return { kind: "divider", note, bi: i };
    }
  }
  // クリック音高に最も近いバー（主/ハモリ/重ねどりが重なっても個別に掴める）
  if (cents == null) {
    const seg = PL.segAtTime(notes, t);
    return seg ? { kind: "body", note: noteOf(seg), seg } : null;
  }
  const seg = PL.segAtPoint(notes, t, cents);
  if (seg && within(seg)) return { kind: "body", note: noteOf(seg), seg };
  return null;
}

function commitEdit(changed) {
  if (!changed) return;
  pushUndo();             // commitEdit は全編集の合流点。ここで直前状態を undo へ。
  state.dirty = true;
  for (const d of state.dubs) d.dirty = true;   // レイヤーも次回レンダで更新
  draw();
  renderAndLoad(false);   // 再合成して準備（自動再生はしない）
}

// --- アンドゥ/リドゥ（EditState スナップショット・6.2） ---
let undoStack = [], redoStack = [], lastSnap = null;
function snapshotState() {
  return JSON.stringify({
    // トラック削除・昇格・全削除（空状態）も巻き戻せるように主 sid を記録
    mainSid: state.session ? state.session.sessionId : null,
    notes: state.session ? state.session.notes : [],
    master: state.master, reverb: state.reverb,
    dubs: state.dubs.map((d) => ({ sessionId: d.sessionId, notes: d.notes })),
  });
}
function initUndo() { undoStack = []; redoStack = []; lastSnap = snapshotState(); updateUndoButtons(); }
function pushUndo() {
  if (lastSnap !== null) {
    undoStack.push(lastSnap);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }
  lastSnap = snapshotState();   // commitEdit 後の新状態
  updateUndoButtons();
}
function applySnapshot(snap) {
  const o = JSON.parse(snap);
  // 主トラックの復元。sid が違う場合（トラック削除で昇格した/戻した/空にした）は
  // レジストリから再構築する。mainSid が null のスナップショット = 空状態。
  const mainSid = o.mainSid;
  if (!mainSid) {
    state.session = null;
    state.audio.buffer = null;
    els.play.disabled = true;
    els.export.disabled = els.projsave.disabled = true;
    setZoomEnabled(false);
  } else if ((!state.session || state.session.sessionId !== mainSid) && state.sessReg[mainSid]) {
    state.session = Object.assign({}, state.sessReg[mainSid], { notes: o.notes });
    state.audio.buffer = null;          // 主バッファは作り直し（下の renderAndLoad）
    els.export.disabled = els.projsave.disabled = false;
    setZoomEnabled(true);
  } else if (state.session) {
    state.session.notes = o.notes;
  }
  state.master = o.master;
  state.reverb = o.reverb || { mix: 0, decaySec: 1.2 };
  // 追加トラックの復元: スナップショットの一覧に合わせて再構成する。
  // 現存すればノートだけ差し替え、削除済みならレジストリから復活（バッファは dirty で再レンダ）。
  const newDubs = [];
  for (const sd of o.dubs || []) {
    const cur = state.dubs.find((x) => x.sessionId === sd.sessionId);
    if (cur) { cur.notes = sd.notes; cur.dirty = true; newDubs.push(cur); }
    else {
      const reg = state.sessReg[sd.sessionId];
      newDubs.push({ sessionId: sd.sessionId, notes: sd.notes,
        rmsDb: reg ? reg.rmsDb : null, buffer: null, dirty: true, enabled: true });
    }
  }
  state.dubs = newDubs;
  rebuildTrackButtons();
  setSelection([]);   // スナップショットのノートは別オブジェクトなので選択は解除
  // UI 同期
  els.master.value = state.master; els.masterval.textContent = state.master.toFixed(1) + "dB";
  els.reverb.value = state.reverb.mix; els.reverbval.textContent = Math.round(state.reverb.mix * 100) + "%";
  syncSliders();
  state.dirty = true;
  draw();
  renderAndLoad(false);
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(lastSnap);
  lastSnap = undoStack.pop();
  applySnapshot(lastSnap);
  updateUndoButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(lastSnap);
  lastSnap = redoStack.pop();
  applySnapshot(lastSnap);
  updateUndoButtons();
}
function updateUndoButtons() {
  els.undo.disabled = !undoStack.length;
  els.redo.disabled = !redoStack.length;
}

els.grid.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;                          // 左ボタンのみ
  if (!state.session || state.audio.playing) return;   // 再生中は編集ロック(F-7)
  e.preventDefault();                                  // テキスト/画像選択を防ぐ（mouseup 取りこぼし対策）
  // 自動スクロールは state.mouse を基準に動くので、押した時点の位置を必ず入れておく
  state.mouse = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey };
  const org = contentOrigin();
  const px = e.clientX - org.left, py = e.clientY - org.top;
  const t = state.view.xToTime(px);
  const hit = hitTest(px, t, state.view.yToCents(py));

  if (!hit) {
    // 音程バーのない場所で左ドラッグ = 範囲選択（マーキー）
    state.drag = { mode: "marquee", x0: px, y0: py, x1: px, y1: py, moved: false };
    if (!(e.shiftKey)) setSelection([]);      // Shift でなければ選択を一旦クリア
    prepareDragBackground(new Set());          // シーン全体を背景キャッシュ
    startAutoScroll();                         // 端での自動スクロール（縦横）を開始
    return;
  }

  if (hit.kind === "body" && state.aKey) {
    // A + クリック = 選択に追加/解除（ドラッグはしない）
    const idx = state.selection.indexOf(hit.seg);
    const ns = state.selection.slice();
    if (idx >= 0) ns.splice(idx, 1); else ns.push(hit.seg);
    setSelection(ns);
    setStatus(ns.length + " ノートを選択中");
    draw();
    return;
  }

  if (hit.kind === "divider") {
    const seg = hit.note.segments[hit.bi];
    if (e.ctrlKey || e.metaKey) {
      state.drag = {
        mode: "transition", seg, startX: e.clientX,
        startTrans: seg.transitionInMs || 40
      };
    } else {
      state.drag = { mode: "divider", note: hit.note, bi: hit.bi };
    }
  } else {
    // 本体クリック: 既に複数選択に含まれていればグループ操作、そうでなければ単一選択
    const inSel = state.selection.indexOf(hit.seg) >= 0;
    const group = inSel ? state.selection.slice() : [hit.seg];
    if (!inSel) setSelection([hit.seg]);
    if (state.gKey) {
      // G+縦ドラッグ = 音量（選択全バーに同じ差分を適用）
      state.drag = {
        mode: "gain", seg: hit.seg, startY: e.clientY,
        group: group.map((s) => ({ seg: s, start: s.gainDb }))
      };
    } else {
      // 縦ドラッグ = 音高（選択全バーに同じ差分を適用）
      state.drag = {
        mode: "pitch", seg: hit.seg, startY: e.clientY,
        group: group.map((s) => ({ seg: s, start: s.pitchOffsetCents }))
      };
    }
  }
  state.drag.moved = false;
  const live = state.drag.mode === "divider"
    ? [state.drag.note.segments[state.drag.bi - 1], state.drag.note.segments[state.drag.bi]]
    : (state.drag.group ? state.drag.group.map((g) => g.seg) : [state.drag.seg]);
  updateSnapLabel(e);
  draw();
  prepareDragBackground(new Set(live));
  startAutoScroll();   // 端に寄せたら自動スクロール（音程=縦 / 分割線=横）
});

function setSelection(arr) {
  state.selection = arr;
  state.selected = arr.length === 1 ? arr[0] : null;
  syncSliders();
}

// コピー: 選択バーを親ノート単位でグループ化して保持（ハモリ複製の元）。
function copySelection() {
  if (!state.selection.length) return;
  const byNote = new Map();
  for (const seg of state.selection) {
    const note = noteOf(seg);
    if (!note) continue;
    if (!byNote.has(note)) byNote.set(note, []);
    byNote.get(note).push(seg);
  }
  state.clipboard = [];
  for (const [, segs] of byNote) {
    segs.sort((a, b) => a.startSec - b.startSec);
    state.clipboard.push({ segments: segs.map((s) => Object.assign({}, s)) });
  }
  setStatus(state.selection.length + " ノートをコピー（貼りたい音程にカーソルを置いて Cmd/Ctrl+V）");
}

// ペースト: コピーしたバーを **別ボイス（ハモリ）** として複製する。
// 開始時間は元のまま。音程は **カーソルの縦位置** に合わせて全体を移調する（自由な音程で配置）。
function pasteClipboard() {
  if (!state.clipboard || !state.clipboard.length || !state.session) return;
  const org = contentOrigin();
  const cursorCents = state.view.yToCents(state.mouse.clientY - org.top);
  // アンカー = コピー群で最も早いバーの絶対音高。これをカーソル音程へ合わせて移調。
  let anchorCents = 0, anchorStart = Infinity;
  for (const cn of state.clipboard) for (const s of cn.segments) {
    if (s.startSec < anchorStart) { anchorStart = s.startSec; anchorCents = s.baseCents + s.pitchOffsetCents; }
  }
  const shift = Math.round((cursorCents - anchorCents) / 50) * 50;   // 50cent スナップ

  const voice = nextVoiceId();
  const newSel = [];
  for (const cn of state.clipboard) {
    // 各クリップボード項目（＝元の1ノート）を独立した新ノートとして追加する。
    // voice は同じでも state.session.notes 上は別ノートなので、個別に選択・編集できる。
    const note = {
      id: PL.newId(), voice, segments: cn.segments.map((s) => Object.assign({}, s, {
        id: PL.newId(), pitchOffsetCents: s.pitchOffsetCents + shift,
      }))
    };
    state.session.notes.push(note);
    for (const s of note.segments) newSel.push(s);
  }
  // 貼り付けたバーは選択したまま残す。選択中のバーをクリック＝まとめて操作、
  // 他のバーや空き領域をクリック＝この複数選択は解除（クリック処理側で自動的に）。
  setSelection(newSel);
  commitEdit(true);
  setStatus(newSel.length + " ノートを配置（選択中。まとめて操作でき、他をクリックで解除）");
}

function nextVoiceId() {
  let m = 0;
  for (const n of state.session.notes) if (n.voice && n.voice > m) m = n.voice;
  return m + 1;
}

// 選択中の **ハモリ**セグメントを削除（主ボイスは削除不可）。
function deleteSelectedHarmony() {
  if (!state.selection.length) return;
  const del = new Set(state.selection);
  let removed = 0;
  for (const note of state.session.notes.slice()) {
    if (!note.voice) continue;                 // 主ボイスは削除しない
    const kept = note.segments.filter((s) => !del.has(s));
    removed += note.segments.length - kept.length;
    if (kept.length === 0) {
      const i = state.session.notes.indexOf(note);
      if (i >= 0) state.session.notes.splice(i, 1);
    } else {
      note.segments = kept;
    }
  }
  if (removed) { setSelection([]); commitEdit(true); setStatus("ハモリを削除しました"); }
}

// マウスの画面座標だけ保持（getBoundingClientRect を毎回呼ぶと強制リフローで重い）。
// グリッド内 x や時刻は必要になった時だけ計算する。
function mouseTime() {
  return state.view.xToTime(state.mouse.clientX - contentOrigin().left);
}

window.addEventListener("mousemove", (e) => {
  // 修飾キーも一緒に覚えておく（自動スクロール中はイベントが来ないため、
  // 最後のポインタ状態を使って同じドラッグ処理を回し続ける）。
  state.mouse = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey };
  const d = state.drag;
  if (!d) return;
  // ボタンが離れているのにドラッグが残っている場合は終了（mouseup 取りこぼし対策）。
  // これで「クリックしていないのにノートが動き続ける」不具合を防ぐ。
  if (e.buttons === 0) { endDrag(); return; }
  applyDragMove(state.mouse);
  scheduleDraw();   // rAF で間引いて再描画（他タブが重くならないように）
});

// ドラッグ1フレーム分の適用。マウス移動と自動スクロールの両方から呼ぶ純粋な更新処理。
// e は {clientX, clientY, shiftKey, altKey} を持つオブジェクト（実イベントでも可）。
function applyDragMove(e) {
  const d = state.drag;
  if (!d) return;
  d.moved = true;
  const v = state.view;

  if (d.mode === "marquee") {
    const org = contentOrigin();
    d.x1 = e.clientX - org.left; d.y1 = e.clientY - org.top;
    // 端での自動スクロールは autoScrollTick が毎フレーム面倒を見る
  } else if (d.mode === "pitch") {
    updateSnapLabel(e);
    // 主バーのスナップ済み差分を全選択バーに適用（相対移動）。
    // 固定範囲（C2〜C6）を出ないよう、グループ全体で許される範囲に差分をクランプする。
    let delta = PL.computeDragOffset(0, e.clientY - d.startY, v.centsPerPixel, mods(e));
    let dMin = -Infinity, dMax = Infinity;
    for (const g of d.group) {
      const c0 = g.seg.baseCents + g.start;
      dMin = Math.max(dMin, PITCH_MIN_CENTS - c0);
      dMax = Math.min(dMax, PITCH_MAX_CENTS - c0);
    }
    delta = Math.max(dMin, Math.min(dMax, delta));
    for (const g of d.group) g.seg.pitchOffsetCents = g.start + delta;
  } else if (d.mode === "gain") {
    // 行1つ(=100cent高)を 24dB 相当にマップ。0.5dB スナップ。
    const dbPerPx = 24 / v.rowHeightPx;
    let delta = Math.round((-(e.clientY - d.startY) * dbPerPx) * 2) / 2;
    for (const g of d.group) {
      const gv = Math.max(PL.GAIN_FILL_MIN_DB, Math.min(PL.GAIN_FILL_MAX_DB, g.start + delta));
      g.seg.gainDb = gv; g.seg.mute = false;
    }
  } else if (d.mode === "divider") {
    const t = mouseTime();
    const segs = d.note.segments, minL = 0.02;
    const lo = segs[d.bi - 1].startSec + minL, hi = segs[d.bi].endSec - minL;
    const tt = Math.max(lo, Math.min(hi, t));
    segs[d.bi - 1].endSec = tt; segs[d.bi].startSec = tt;
  } else if (d.mode === "transition") {
    const msPerPx = (v.xToTime(1) - v.xToTime(0)) * 1000;   // px → ms
    let ms = d.startTrans + (e.clientX - d.startX) * msPerPx * 2;
    d.seg.transitionInMs = Math.max(5, Math.min(300, ms));
  }
}

// 実際に横スクロールしている要素を特定する。.gridwrap とは限らず、
// レイアウト次第でウィンドウ(documentElement)や別の祖先がスクローラになりうるため、
// grid から上へ辿って「overflow-x があり実際に内容がはみ出している」最初の要素を返す。
function horizontalScroller() {
  let el = els.grid.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    const ox = getComputedStyle(el).overflowX;
    if ((ox === "auto" || ox === "scroll") && el.scrollWidth - el.clientWidth > 1) return el;
    el = el.parentElement;
  }
  const doc = document.scrollingElement || document.documentElement;
  if (doc && doc.scrollWidth - doc.clientWidth > 1) return doc;
  return gridwrap();   // フォールバック（スクロール不能でも害はない）
}

// ドラッグ中、ポインタが表示領域の端（や外）に来たら自動でスクロールし、
// 画面に見えていない場所まで操作を続けられるようにする。
// ドラッグ開始時にループを起動し、終了まで毎フレーム現在のマウス位置を見て回し続ける
// （マウスを端で止めていても、画面外に出したままでも動き続ける）。
//
// モードごとに動かす軸を変える:
//   marquee   … 縦横（選択範囲を画面外まで伸ばす）
//   pitch     … 縦（音程バーを画面外まで動かす）
//   divider / transition … 横（時間軸の操作）
//   gain      … なし（縦位置と音量は無関係なのでスクロールしても意味がない）
const AUTOSCROLL_AXES = { marquee: "xy", pitch: "y", divider: "x", transition: "x" };
const AS_EDGE = 48;        // 端から何 px を加速帯とみなすか
const AS_BASE_V = 26;      // 通常時の最大速度（px/frame）
const AS_HOLD_MS = 1000;   // 画面外にこれだけ留まったら加速を始める
const AS_MAX_BOOST = 4;    // 加速の上限倍率

let _autoScrollRAF = 0, _outsideSince = 0;
function startAutoScroll() {
  _outsideSince = 0;
  if (!_autoScrollRAF) _autoScrollRAF = requestAnimationFrame(autoScrollTick);
}
function stopAutoScroll() {
  if (_autoScrollRAF) cancelAnimationFrame(_autoScrollRAF);
  _autoScrollRAF = 0; _outsideSince = 0;
}

// 端からの食い込み量に比例した速度を返す（端の外ではさらに大きくなる）。
function edgeVelocity(p, lo, hi) {
  if (p < lo + AS_EDGE) return -Math.min(AS_EDGE * 2, lo + AS_EDGE - p) / AS_EDGE * AS_BASE_V;
  if (p > hi - AS_EDGE) return Math.min(AS_EDGE * 2, p - (hi - AS_EDGE)) / AS_EDGE * AS_BASE_V;
  return 0;
}

function autoScrollTick() {
  _autoScrollRAF = 0;
  const d = state.drag;
  const ph = !d && state.phDrag;                    // 再生ヘッドのつまみをドラッグ中（横のみ）
  if (!d && !ph) return;                            // ドラッグ終了で自然に停止
  const axes = ph ? "x" : (AUTOSCROLL_AXES[d.mode] || "");
  if (!axes) return;
  // 端の判定は「実際に画面に見えている編集領域」で行う。
  // gridwrap の rect がレイアウト都合で画面外に出ていても、
  // window の寸法でクランプすれば見えている端で判定できる。
  const gw = gridwrap();
  const rect = gw.getBoundingClientRect();
  const viewLeft = Math.max(rect.left, 0), viewRight = Math.min(rect.right, window.innerWidth);
  const viewTop = Math.max(rect.top, 0), viewBottom = Math.min(rect.bottom, window.innerHeight);
  const x = state.mouse.clientX, y = state.mouse.clientY;

  // 表示領域の外に出てから AS_HOLD_MS を超えたら、そこから 1 秒かけて最大 AS_MAX_BOOST 倍まで加速。
  const outside = x < viewLeft || x > viewRight || y < viewTop || y > viewBottom;
  const now = performance.now();
  if (!outside) _outsideSince = 0;
  else if (!_outsideSince) _outsideSince = now;
  let boost = 1;
  if (_outsideSince) {
    const held = now - _outsideSince;
    if (held > AS_HOLD_MS)
      boost = 1 + Math.min(1, (held - AS_HOLD_MS) / 1000) * (AS_MAX_BOOST - 1);
  }

  const vx = axes.includes("x") ? edgeVelocity(x, viewLeft, viewRight) * boost : 0;
  const vy = axes.includes("y") ? edgeVelocity(y, viewTop, viewBottom) * boost : 0;
  let moved = false;

  if (vx !== 0) {
    const sc = horizontalScroller();   // 実際に横スクロールする要素へ適用
    const maxScroll = Math.max(0, sc.scrollWidth - sc.clientWidth);
    const ns = Math.max(0, Math.min(maxScroll, sc.scrollLeft + vx));
    if (ns !== sc.scrollLeft) { sc.scrollLeft = ns; moved = true; }
  }
  if (vy !== 0) {
    const maxScroll = Math.max(0, gw.scrollHeight - gw.clientHeight);
    const ns = Math.max(0, Math.min(maxScroll, gw.scrollTop + vy));
    if (ns !== gw.scrollTop) {
      // 画面が動いたぶんドラッグの基準点もずらす。こうするとマウスを止めていても
      // スクロールに追従してバーが動き続ける（＝画面外へはみ出さずに大きく動かせる）。
      if (d.startY != null) d.startY -= ns - gw.scrollTop;
      gw.scrollTop = ns; moved = true;
    }
  }
  // スクロールで内容が動いた ＝ ポインタの下の座標が変わったので、同じ処理をもう一度流す。
  if (moved) {
    if (ph) playheadDragMove(state.mouse);
    else { applyDragMove(state.mouse); scheduleDraw(); }
  }

  _autoScrollRAF = requestAnimationFrame(autoScrollTick);   // ドラッグ中は回し続ける
}

function endDrag() {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  stopAutoScroll();
  if (d.mode === "marquee") {
    const v = state.view;
    if (d.moved) {
      const sel = PL.segmentsInRect(
        allNotes(), v.xToTime(d.x0), v.xToTime(d.x1),
        v.yToCents(d.y0), v.yToCents(d.y1));
      setSelection(sel);
      setStatus(sel.length + " ノートのバーを選択");
    }
    draw();
    return;   // 選択は編集ではないので再合成しない
  }
  draw();
  commitEdit(d.moved);
}
window.addEventListener("mouseup", endDrag);

// 分割線ダブルクリック = 結合（F-2）
els.grid.addEventListener("dblclick", (e) => {
  if (!state.session || state.audio.playing) return;
  const px = e.clientX - contentOrigin().left, t = state.view.xToTime(px);
  const hit = hitTest(px, t);
  if (hit && hit.kind === "divider") {
    replaceNote(hit.note, PL.mergeNote(hit.note, hit.bi));
    setSelection([]);
    commitEdit(true);
  }
});

// キーボード: S=分割 / M=ミュート / G=音量ツール（押下中）/ Cmd|Ctrl+Z=アンドゥ
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (!state.session || state.audio.playing) return;
    e.shiftKey ? redo() : undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
    e.preventDefault(); if (state.session && !state.audio.playing) redo(); return;
  }
  // コピー/ペースト（音程バー）
  if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
    if (state.session && state.selection.length) { e.preventDefault(); copySelection(); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) {
    if (state.session && !state.audio.playing) { e.preventDefault(); pasteClipboard(); }
    return;
  }
  // Delete/Backspace: 選択中のハモリを削除
  if (e.key === "Delete" || e.key === "Backspace") {
    if (state.session && !state.audio.playing && state.selection.length) {
      e.preventDefault(); deleteSelectedHarmony();
    }
    return;
  }
  if (state.drag) updateSnapLabel(e);
  if (e.key === "g" || e.key === "G") state.gKey = true;
  if ((e.key === "a" || e.key === "A") && !e.metaKey && !e.ctrlKey) state.aKey = true;
  if (!state.session || state.audio.playing || !state.view) return;
  const t = mouseTime();
  if (e.key === "s" || e.key === "S") {
    const seg = PL.segAtTime(state.session.notes, t);
    if (seg) {
      const note = noteOf(seg);
      replaceNote(note, PL.splitNote(note, note.segments.indexOf(seg), t));
      commitEdit(true);
    }
  } else if (e.key === "m" || e.key === "M") {
    // 選択があれば全バーをまとめてミュート切替、なければカーソル下のバー
    let targets = state.selection.length ? state.selection.slice() : [];
    if (!targets.length) { const s = PL.segAtTime(state.session.notes, t); if (s) targets = [s]; }
    if (targets.length) {
      const muteAll = targets.some((s) => !s.mute);   // 1つでも鳴っていれば全ミュート
      for (const s of targets) s.mute = muteAll;
      commitEdit(true);
    }
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "g" || e.key === "G") state.gKey = false;
  if (e.key === "a" || e.key === "A") state.aKey = false;
  if (state.drag) updateSnapLabel(e);
});

// --- 補正スライダー / マスターフェーダー ---
function syncSliders() {
  const n = state.selection.length;
  els.strength.disabled = n === 0;
  const val = n ? state.selection[0].correctStrength : 0;
  els.strength.value = val;
  els.strengthval.textContent = n ? Number(val).toFixed(2) : "–";
}
els.strength.addEventListener("input", () => {
  if (!state.selection.length) return;
  const v = parseFloat(els.strength.value);
  for (const s of state.selection) s.correctStrength = v;   // 選択全バーに適用
  els.strengthval.textContent = v.toFixed(2);
});
els.strength.addEventListener("change", () => { if (state.selection.length) commitEdit(true); });
els.master.addEventListener("input", () => {
  state.master = parseFloat(els.master.value);
  els.masterval.textContent = state.master.toFixed(1) + "dB";
});
els.master.addEventListener("change", () => commitEdit(true));
els.reverb.addEventListener("input", () => {
  state.reverb.mix = parseFloat(els.reverb.value);
  els.reverbval.textContent = Math.round(state.reverb.mix * 100) + "%";
});
els.reverb.addEventListener("change", () => commitEdit(true));

// --- アンドゥ/リドゥ・ズーム・プロジェクト保存/読込 ---
els.undo.addEventListener("click", undo);
els.redo.addEventListener("click", redo);

// 4つのズームボタンをまとめて有効化/無効化する。
function setZoomEnabled(on) {
  els.hzoomin.disabled = els.hzoomout.disabled = !on;
  els.vzoomin.disabled = els.vzoomout.disabled = !on;
}

// 横（時間軸）ズーム: 1秒あたりの幅を変える。
// 縮小しきると曲全体を見渡せ、拡大しきると 1 フレーム（5ms）単位の揺れまで見える。
// 画面中央の時刻を保ったままスケールするので、見ている場所を見失わない。
const MAX_PX_PER_SEC = 12000;
function zoomBy(factor) {
  if (!state.session) return;
  const gw = gridwrap();
  const before = layout();
  const viewW = before.viewW;
  const centerRatio = (gw.scrollLeft + viewW / 2) / before.contentW;
  // 下限は「全体が画面に収まる幅」。それ以上縮めても見た目が変わらないので、
  // 押し続けても状態だけが際限なく小さくなる（＝拡大に戻すのに何度も押す）のを防ぐ。
  const fitSec = viewW / before.dur;
  state.pxPerSec = Math.max(fitSec, Math.min(MAX_PX_PER_SEC, state.pxPerSec * factor));
  resizeCanvases(); draw();
  const after = layout();
  gw.scrollLeft = Math.max(0, Math.min(after.contentW - viewW, centerRatio * after.contentW - viewW / 2));
  _followScrollLeft = -1;   // 内容幅が変わると scrollLeft も動くので、追従の基準を取り直す
  // 実際に適用された値で状態を上書きし、そのまま表示する
  // （canvas の上限で頭打ちになったことが分かり、次の縮小もすぐ効く）。
  const eff = after.contentW / after.dur;
  const capped = eff < state.pxPerSec * 0.99;
  state.pxPerSec = eff;
  setStatus(`横ズーム ${eff.toFixed(eff < 100 ? 1 : 0)}px/秒` + (capped ? "（上限）" : ""));
}

// 縦ズーム（＋/－ボタン）: 1半音あたりの高さを変える。
// 行が高くなるほど、音程バーがどの音階の行にあるかが読み取りやすくなる。
// 画面中央にある音程を保ったままスケールするので、見ている場所を見失わない。
const MAX_PX_PER_SEMI = 600;
function zoomVBy(factor) {
  if (!state.session) return;
  const gw = gridwrap();
  const before = layout();
  const viewH = before.viewH;
  // ズーム前に画面中央に見えていた位置（内容高に対する比率）
  const centerRatio = (gw.scrollTop + viewH / 2) / before.contentH;
  const per = Math.max(before.fitPx, Math.min(MAX_PX_PER_SEMI, (state.pxPerSemi || before.fitPx) * factor));
  // 収まりきる高さまで縮めたら auto-fit に戻す（ウィンドウ幅変更にも追従するように）
  state.pxPerSemi = per <= before.fitPx * 1.001 ? null : per;
  resizeCanvases(); draw();
  const after = layout();
  gw.scrollTop = Math.max(0, Math.min(after.contentH - viewH, centerRatio * after.contentH - viewH / 2));
  syncVScroll();
  if (!state.pxPerSemi) {
    const { lo, hi } = viewRange();
    setStatus(`縦ズーム: 全範囲を表示（${centsToName(lo)}〜${centsToName(hi)}）`);
    return;
  }
  const eff = after.contentH / after.semis;   // 実際に適用された 1半音あたりの高さ
  const capped = eff < state.pxPerSemi * 0.99;
  state.pxPerSemi = eff;                      // 頭打ちなら状態も実効値に揃える
  setStatus(`縦ズーム ${eff.toFixed(0)}px/半音` + (capped ? "（上限）" : ""));
}
els.hzoomin.addEventListener("click", () => zoomBy(1.4));
els.hzoomout.addEventListener("click", () => zoomBy(1 / 1.4));
els.vzoomin.addEventListener("click", () => zoomVBy(1.4));
els.vzoomout.addEventListener("click", () => zoomVBy(1 / 1.4));
// Cmd/Ctrl + ホイール = 横（時間軸）ズーム、Shift も足すと縦（音程軸）ズーム
gridwrap().addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !state.session) return;
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  if (e.shiftKey) zoomVBy(f); else zoomBy(f);
}, { passive: false });

// プロジェクト保存: EditState を JSON でダウンロード（音声は含まない・13.4）
els.projsave.addEventListener("click", () => {
  if (!state.session) return;
  const proj = {
    version: 1, fileName: state.session.fileName || "vocal",
    durationSec: state.session.durationSec, editState: buildEditState()
  };
  const blob = new Blob([JSON.stringify(proj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"),
    { href: url, download: (proj.fileName) + "_project.json" });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  setStatus("プロジェクトを保存しました");
});
// プロジェクト読込: JSON を現在のセッションへ適用（同じ音声を先に読み込んでおく）
els.projfile.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f || !state.session) { setStatus("先に音声を読み込んでください"); return; }
  try {
    const proj = JSON.parse(await f.text());
    const es = proj.editState || {};
    state.session.notes = es.notes || state.session.notes;
    state.master = es.masterGainDb || 0;
    state.reverb = es.reverb || { mix: 0, decaySec: 1.2 };
    els.master.value = state.master; els.masterval.textContent = state.master.toFixed(1) + "dB";
    els.reverb.value = state.reverb.mix; els.reverbval.textContent = Math.round(state.reverb.mix * 100) + "%";
    setSelection([]); state.clipboard = null;
    initUndo(); draw(); state.dirty = true; renderAndLoad(false);
    setStatus("プロジェクトを読み込みました");
  } catch (err) { setStatus("プロジェクト読込エラー: " + err.message); }
  els.projfile.value = "";
});

// ==========================================================================
// /api/session, /api/render
// ==========================================================================
function b64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

els.file.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  setStatus("解析中…");
  els.play.disabled = els.stop.disabled = true;
  const oldSid = state.session && state.session.sessionId;   // 置き換え後に削除する
  const fd = new FormData();
  fd.append("audio", f);
  try {
    const res = await fetch("/api/session", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    j.f0Hz = b64ToF32(j.f0Hz);
    j.rmsDb = b64ToF32(j.rmsDb);
    state.session = j;
    state.dirty = false;
    state.audio.playSec = 0; state.audio.seekAt = 0;   // 再生位置を先頭へ
    els.tostart.disabled = false;
    resizeCanvases(); draw();
    const nSeg = j.notes.reduce((a, n) => a + n.segments.length, 0);
    setStatus(`${j.durationSec.toFixed(2)}s / ${j.sampleRate}Hz / ${j.notes.length}ノート ${nSeg}セグメント`);
    els.export.disabled = false;
    els.bfile.disabled = false;   // 伴奏追加を有効化
    setZoomEnabled(true); els.projsave.disabled = false;
    setSelection([]); state.clipboard = null;   // 選択・クリップボードをリセット

    // 新しい曲を開いた: 以前の全セッション（主 + 追加トラック + 削除アンドゥ用の保持分）を
    // サーバーから削除し（sp/ap のメモリ解放）、レジストリを作り直す。
    for (const sid of Object.keys(state.sessReg)) {
      if (sid !== j.sessionId)
        fetch(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
    }
    if (oldSid && oldSid !== j.sessionId && !state.sessReg[oldSid])
      fetch(`/api/session/${oldSid}`, { method: "DELETE" }).catch(() => {});
    state.dubs = [];
    state.sessReg = {}; state.sessReg[j.sessionId] = regFromSession(j);
    state.playMain = true;
    fitViewToNotes();               // 収録音域が画面いっぱいに見える縦ズーム・位置にする
    rebuildTrackButtons();          // ヘッダーの 録音1/録音2… ボタンを更新
    initUndo();                   // アンドゥ履歴を初期化
    // 伴奏の引き継ぎ: 旧セッションに伴奏があれば、新セッションへ自動で再アップロード
    // （再録音で「録音だけ」置き換えるため）。元ファイルが無ければ外す。
    if (state.backing) {
      const b = state.backing;
      if (b.file) {
        setStatus("伴奏を引き継いでいます…");
        try { await uploadBacking(b.file, b); }
        catch (_) { state.backing = null; els.backinglane.hidden = true; }
      } else {
        state.backing = null; els.backinglane.hidden = true;
      }
    }
    await renderAndLoad(false);   // 初期プレビューを用意
  } catch (err) {
    setStatus("エラー: " + err.message);
  }
});

// セッション応答から静的解析データ（描画・昇格に必要な分）を取り出してレジストリへ。
// f0Hz / rmsDb はデコード済み Float32Array を保持する。
function regFromSession(j) {
  return {
    sessionId: j.sessionId, sampleRate: j.sampleRate, durationSec: j.durationSec,
    hopSec: j.hopSec, f0Hz: j.f0Hz, rmsDb: j.rmsDb,
    phraseBounds: j.phraseBounds || [], numPhrases: j.numPhrases,
  };
}

function buildEditState() {
  // 主ボイス(voice 未設定)とハモリ(voice≥1)を分離して送る
  const all = state.session.notes;
  const primary = all.filter((n) => !n.voice);
  const voices = {};
  for (const n of all) if (n.voice) (voices[n.voice] = voices[n.voice] || []).push(n);
  const es = { notes: primary, masterGainDb: state.master };
  const harms = Object.values(voices);
  if (harms.length) es.harmonies = harms.map((notes) => ({ notes }));
  if (state.reverb.mix > 0) es.reverb = { mix: state.reverb.mix, decaySec: state.reverb.decaySec };
  if (state.backing) es.backing = {
    offsetSec: state.backing.offsetSec, gainDb: state.backing.gainDb,
    mute: state.backing.mute, solo: state.backing.solo,
  };
  return es;
}

// ==========================================================================
// 伴奏（バッキング）トラック（12章）
// ==========================================================================
// 伴奏をサーバーへアップロードし state.backing を構築する。
// 元の File を保持し、再録音などでセッションが作り直されても引き継げるようにする。
// opts に前回の offset/gain/mute/solo を渡すと復元する。
async function uploadBacking(f, opts) {
  const fd = new FormData();
  fd.append("sessionId", state.session.sessionId);
  fd.append("audio", f);
  const res = await fetch("/api/backing", { method: "POST", body: fd });
  if (!res.ok) throw new Error(await res.text());
  const j = await res.json();
  j.peaks = b64ToF32(j.peaks);
  // 再生用オーディオを取得してデコード
  const ab = await (await fetch(`/api/backing/${state.session.sessionId}/audio`)).arrayBuffer();
  const buffer = await ensureAudioCtx().decodeAudioData(ab);
  const o = opts || {};
  state.backing = {
    peaks: j.peaks, durationSec: j.durationSec, buffer, file: f,
    offsetSec: o.offsetSec || 0, gainDb: o.gainDb || 0,
    mute: !!o.mute, solo: !!o.solo,
  };
  els.backinglane.hidden = false;
  els.boffset.value = String(state.backing.offsetSec);
  els.bvol.value = String(state.backing.gainDb);
  els.bmute.classList.toggle("on", state.backing.mute);
  els.bsolo.classList.toggle("on", state.backing.solo);
  resizeCanvases(); draw(); drawBacking();
}

els.bfile.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f || !state.session) return;
  setStatus("伴奏を解析中…");
  try {
    await uploadBacking(f);
    setStatus("伴奏を追加しました");
  } catch (err) {
    setStatus("伴奏エラー: " + err.message);
  }
  els.bfile.value = "";
});

// 伴奏波形（peaks から描画）。グリッドと同じ時間軸・幅で並べる。
function drawBacking() {
  if (!state.backing || !state.view) return;
  ensureSpacers();
  const v = state.view, dpr = window.devicePixelRatio || 1;
  const wrap = els.bcanvas.parentElement;
  const ch = wrap.clientHeight, vw = wrap.clientWidth;
  // グリッドと同じ方式: スクロール範囲は spacer が作り、canvas は見えている幅だけ持つ。
  els.bspace.style.width = v.width + "px"; els.bspace.style.height = ch + "px";
  els.bcanvas.style.width = vw + "px"; els.bcanvas.style.height = ch + "px";
  els.bcanvas.width = Math.round(vw * dpr); els.bcanvas.height = Math.round(ch * dpr);
  els.bcanvas.style.transform = `translateX(${wrap.scrollLeft}px)`;
  const ctx = els.bcanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, -wrap.scrollLeft * dpr, 0);
  ctx.clearRect(wrap.scrollLeft, 0, vw, ch);
  const peaks = state.backing.peaks, dur = state.backing.durationSec;
  const mid = ch / 2;
  const t0 = v.xToTime(wrap.scrollLeft), t1 = v.xToTime(wrap.scrollLeft + vw);
  ctx.strokeStyle = "rgba(200,190,172,0.8)";
  ctx.beginPath();
  for (let i = 0; i < peaks.length; i++) {
    const t = (i / peaks.length) * dur + state.backing.offsetSec;  // 頭合わせを反映
    if (t < t0 || t > t1) continue;                                // 画面外は描かない
    const x = v.timeToX(t), a = peaks[i] * (mid - 2);
    ctx.moveTo(x, mid - a); ctx.lineTo(x, mid + a);
  }
  ctx.stroke();
}

// 伴奏コントロール
els.bvol.addEventListener("input", () => {
  if (!state.backing) return;
  state.backing.gainDb = parseFloat(els.bvol.value);
  applyMixGains();
});
els.bmute.addEventListener("click", () => {
  if (!state.backing) return;
  state.backing.mute = !state.backing.mute;
  els.bmute.classList.toggle("on", state.backing.mute);
  applyMixGains();
});
els.bsolo.addEventListener("click", () => {
  if (!state.backing) return;
  state.backing.solo = !state.backing.solo;
  els.bsolo.classList.toggle("on", state.backing.solo);
  applyMixGains();
});
els.boffset.addEventListener("change", () => {
  if (!state.backing) return;
  state.backing.offsetSec = parseFloat(els.boffset.value) || 0;
  drawBacking();
});
els.bremove.addEventListener("click", async () => {
  if (!state.backing || !state.session) return;
  await fetch(`/api/backing/${state.session.sessionId}`, { method: "DELETE" });
  state.backing = null;
  els.backinglane.hidden = true;
});

// グリッドのスクロール: 縦は鍵盤列、横は伴奏レーン（時間軸）と同期させる。
els.grid.parentElement.addEventListener("scroll", () => {
  syncVScroll();
  scheduleDraw();   // canvas は表示範囲ぶんしか無いので、スクロールしたら描き直す
  if (!state.backing) return;
  els.bcanvas.parentElement.scrollLeft = els.grid.parentElement.scrollLeft;
});
els.bcanvas.parentElement.addEventListener("scroll", () => {
  els.grid.parentElement.scrollLeft = els.bcanvas.parentElement.scrollLeft;
  if (state.backing) drawBacking();
});

// ==========================================================================
// 録音（AudioWorklet で生 PCM を取得・11章。アカペラのみ）
// ==========================================================================
// 録音 = 常に「新しいトラックを追加」。1本目は主トラック（録音1）になり、
// 2本目以降は既存の音声を聴きながらの重ね録りで 録音2、3…として追加される。
// 録り直したいトラックは Tracks の × で削除してから録音し直す。
els.record.addEventListener("click", () => {
  if (state.rec && state.rec.active) stopRecording(); else startRecording();
});

// --- テンポ・拍子・メトロノーム ---
function retempoMetronome() {   // 録音中なら新テンポでメトロノームを張り直す
  if (state.rec && state.rec.active && state.metronome.on) startMetronome(state.rec.ctx);
}
els.bpm.addEventListener("input", () => {
  const b = Math.max(30, Math.min(300, parseInt(els.bpm.value, 10) || 120));
  state.tempo.bpm = b;
  if (state.session) draw();   // 小節線を引き直す
  retempoMetronome();
});
els.beats.addEventListener("change", () => {
  state.tempo.beatsPerBar = parseInt(els.beats.value, 10) || 4;
  if (state.session) draw();
  retempoMetronome();
});
els.metro.addEventListener("click", () => {
  state.metronome.on = !state.metronome.on;
  els.metro.classList.toggle("on", state.metronome.on);
  els.metro.title = "メトロノーム（録音中に鳴らす）: " + (state.metronome.on ? "ON" : "OFF");
  // 録音中に切り替えたら即反映（フレッシュに開始/停止して連打を防ぐ）
  if (state.rec && state.rec.active) {
    if (state.metronome.on) startMetronome(state.rec.ctx); else stopMetronome();
  }
});

// メトロノーム: 録音用 AudioContext 上で先読みスケジュールする（11.4）。
// クリック音は OscillatorNode（1拍目=高め＝アクセント）。出力先は destination
// （ヘッドホン前提。マイクには入らない。録音は worklet がマイクを別途取得）。
function startMetronome(ctx) {
  const m = state.metronome;
  stopMetronome();
  const spb = 60 / state.tempo.bpm, beats = state.tempo.beatsPerBar;
  let beat = 0, next = ctx.currentTime + 0.15;
  const tick = () => {
    if (!m.on) return;                       // 途中で OFF にされたら鳴らさない
    while (next < ctx.currentTime + 0.12) {  // 120ms 先まで先読み
      scheduleClick(ctx, next, beat % beats === 0);
      next += spb; beat++;
    }
  };
  tick();
  m.timer = setInterval(tick, 25);
}
function scheduleClick(ctx, time, accent) {
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.32, time + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(time); osc.stop(time + 0.06);
}
function stopMetronome() {
  if (state.metronome.timer) { clearInterval(state.metronome.timer); state.metronome.timer = null; }
}

async function startRecording() {
  if (state.audio.playing) stopAudio();
  const mode = state.session ? "overdub" : "new";   // 2本目以降は常にトラック追加
  try {
    // 11.1: 通話向け前処理をすべて無効化してマイクを取得
    const stream = await navigator.mediaDevices.getUserMedia({ audio: RL.AUDIO_CONSTRAINTS });
    const track = stream.getAudioTracks()[0];
    const warns = RL.checkAudioConstraints(track.getSettings ? track.getSettings() : {});
    if (warns.length) setStatus("⚠ 前処理が有効: " + warns.join(" / ") + "（品質が落ちます）");

    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule("/static/recorder-worklet.js");   // 11.2
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "rec-processor");
    // 無音のゲインを介して destination へ繋ぐ（process を回すため。モニタはしない）
    const silent = ctx.createGain(); silent.gain.value = 0;
    src.connect(node); node.connect(silent); silent.connect(ctx.destination);

    // すでにある音声を聴きながら重ね録りする（11.4）。
    // 鳴らすのは Tracks ボタンで ON のトラック（録音1 + 重ねどり）+ 伴奏。
    // 同じ ctx 上で t0 に再生開始し、停止時に録音の頭を t0 へ揃える（11.5 の近似補正）。
    // スピーカーだと再生音がマイクに回り込むため、ヘッドホン前提。
    await ctx.resume();   // サスペンド状態だとモニターもメトロノームも無音になるため明示的に起こす
    let monitorT0 = 0;
    const monGains = {};
    const monBufs = [];
    if (state.playMain && state.audio.buffer) monBufs.push(["main", state.audio.buffer]);
    for (const d of state.dubs)
      if (d.enabled !== false && d.buffer) monBufs.push([d.sessionId, d.buffer]);
    const bbuf = state.backing && !state.backing.mute && state.backing.buffer;
    if (monBufs.length || bbuf) {
      monitorT0 = ctx.currentTime + 0.25;
      const solo = state.backing && state.backing.solo;   // 伴奏ソロ中はボーカル系を無音に
      for (const [key, buf] of monBufs) {
        const s = ctx.createBufferSource(), g = ctx.createGain();
        g.gain.value = solo ? 0 : 1;
        s.buffer = buf; s.connect(g); g.connect(ctx.destination);
        s.start(monitorT0);
        monGains[key] = g;
      }
      if (bbuf) {
        const sch = PL.computePlaybackSchedule(monitorT0, state.backing.offsetSec, 0);
        const s = ctx.createBufferSource(), g = ctx.createGain();
        g.gain.value = Math.pow(10, state.backing.gainDb / 20);
        s.buffer = bbuf; s.connect(g); g.connect(ctx.destination);
        s.start(Math.max(ctx.currentTime, sch.backingStart), Math.max(0, sch.backingOffset));
      }
    }

    const chunks = [];
    state.rec = { active: true, mode, stream, ctx, node, chunks,
                  peak: 0, meterRAF: 0, monitorT0, monGains,
                  firstChunkTime: 0, firstChunkLen: 0,
                  t0ms: performance.now(), maxDb: -Infinity };
    node.port.onmessage = (e) => {
      const r = state.rec;
      if (!r) return;
      const d = e.data; chunks.push(d);
      if (!r.firstChunkTime) { r.firstChunkTime = ctx.currentTime; r.firstChunkLen = d.length; }
      let p = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
      r.peak = p;
    };

    els.record.classList.add("on"); els.record.textContent = "■ 停止";
    els.meter.hidden = false;
    rebuildTrackButtons();      // 録音中は × を無効化
    if (state.metronome.on) startMetronome(ctx);   // 録音中のメトロノーム（ヘッドホン前提）
    setStatus(mode === "overdub"
      ? "録音中…（既存の音声を再生中。ヘッドホン推奨）停止すると 録音" +
        (state.dubs.length + 2) + " として追加されます"
      : "録音中… ピークが -12dBFS 付近になるように（0dBFS でクリップ）");
    startMeter();
  } catch (err) {
    // 11.7: 権限拒否時はファイル読み込みへ誘導
    setStatus("マイクを使用できません（" + err.message + "）。「音声を開く」から読み込んでください。");
  }
}

async function stopRecording() {
  const r = state.rec;
  if (!r || !r.active) return;
  r.active = false;
  cancelAnimationFrame(r.meterRAF);
  stopMetronome();                     // ctx.close() の前にメトロノームを止める
  let samples = RL.concatFloat32(r.chunks);
  const sr = r.ctx.sampleRate;         // 11.3: 実際の SR を使う
  // モニター再生しながらの重ね録りは、録音の頭をモニター開始時刻 t0 へ揃える。
  // 補正 = (t0 - 最初のチャンク先頭時刻) + 入出力レイテンシ（11.5 の近似）。
  if (r.monitorT0 && r.firstChunkTime && samples.length) {
    const latency = (r.ctx.outputLatency || 0) + (r.ctx.baseLatency || 0);
    const chunk0Start = r.firstChunkTime - r.firstChunkLen / sr;
    const trim = Math.round(((r.monitorT0 - chunk0Start) + latency) * sr);
    if (trim > 0 && trim < samples.length) samples = samples.subarray(trim);
  }
  // 入力レベルの自動補正: AGC 無効（11.1）のため録音が小さくなりがち。
  // 取り込み時に全テイクをピーク -6dBFS へ正規化する（上限 +24dB ブースト）。
  // テイク間の音量が揃い、再生音量も十分になる。
  // 注意: SNR は変わらない（ノイズも同量上がる）。根本対策は OS の入力音量を上げること。
  let boostDb = 0;
  {
    const target = Math.pow(10, -6 / 20);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]); if (a > peak) peak = a;
    }
    if (peak > 0 && peak < target) {
      const g = Math.min(target / peak, Math.pow(10, 24 / 20));
      boostDb = Math.round(20 * Math.log10(g));
      if (boostDb >= 1) {
        const out = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g;
        samples = out;
      }
    }
  }
  state.lastRecBoostDb = boostDb;
  try { r.stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
  try { await r.ctx.close(); } catch (_) { }
  const mode = r.mode;
  state.rec = null;
  els.record.classList.remove("on");
  els.record.textContent = "● 録音";
  els.record.disabled = false;
  els.meter.hidden = true;
  rebuildTrackButtons();          // × を再度有効化

  if (!samples.length) { setStatus("録音が空でした"); return; }
  // 32bit float WAV へエンコード（11章）
  const wav = RL.encodeWavFloat32(samples, sr);
  const file = new File([new Blob([wav], { type: "audio/wav" })], "recording.wav", { type: "audio/wav" });

  if (mode === "overdub" && state.session) {
    await createDubFromRecording(file);          // 新しいトラックとして追加
    return;
  }
  // 1本目: ファイル読み込みと同じ /api/session 経路で主トラックを作る。
  const dt = new DataTransfer(); dt.items.add(file);
  els.file.files = dt.files;
  els.file.dispatchEvent(new Event("change"));
}

// --- 重ねどり（オーバーダブ）レイヤー ---------------------------------------
// 録音を独立したセッションとしてサーバーで解析し、主ボーカルと同期再生する。
// ノートはローズ色のバーで表示され、主ボーカルと同様にピッチ・音量を編集できる。

function buildDubEditState(d) {
  const es = { notes: d.notes, masterGainDb: state.master };
  if (state.reverb.mix > 0) es.reverb = { mix: state.reverb.mix, decaySec: state.reverb.decaySec };
  return es;
}

async function renderDub(d) {
  const res = await fetch("/api/render", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: d.sessionId, editState: buildDubEditState(d), mode: "preview" }),
  });
  if (!res.ok) throw new Error(await res.text());
  d.buffer = await ensureAudioCtx().decodeAudioData(await res.arrayBuffer());
  d.dirty = false;
}

async function createDubFromRecording(file) {
  setStatus("新しいトラックを解析中…");
  const fd = new FormData();
  fd.append("audio", file);
  try {
    const res = await fetch("/api/session", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    j.f0Hz = b64ToF32(j.f0Hz);
    j.rmsDb = b64ToF32(j.rmsDb);
    state.sessReg[j.sessionId] = regFromSession(j);   // 削除アンドゥ・昇格に備えて登録
    const dub = {
      sessionId: j.sessionId, notes: j.notes, rmsDb: j.rmsDb,
      buffer: null, dirty: true, enabled: true,
    };
    for (const n of dub.notes) n.dub = dub.sessionId;   // 描画・編集でトラックを識別
    state.dubs.push(dub);
    pushUndo();
    rebuildTrackButtons();          // 録音N ボタンを追加
    resizeCanvases(); draw();
    await renderDub(dub);
    const boostNote = state.lastRecBoostDb >= 1
      ? "。入力が小さかったため +" + state.lastRecBoostDb + "dB 自動ブースト（OS の入力音量を上げると音質が改善します）"
      : "";
    setStatus("録音" + (state.dubs.length + 1) +
      " を追加しました（Tracks ボタンと同色のバー。× で削除できます）" + boostNote);
  } catch (err) {
    setStatus("トラック追加エラー: " + err.message);
  }
}

function startMeter() {
  const render = () => {
    if (!state.rec || !state.rec.active) return;
    const m = RL.meterFromPeak(state.rec.peak);
    const norm = Math.max(0, Math.min(1, (m.db + 48) / 48));   // -48..0 dBFS
    els.meterbar.style.width = (norm * 100) + "%";
    els.meterbar.style.background = m.clip ? "#e1543c" : (m.hot ? "#e8a23d" : "#7fb66b");
    els.meterlabel.textContent = isFinite(m.db) ? Math.round(m.db) + "dB" : "-∞";
    if (m.clip) setStatus("⚠ クリップ検出（0dBFS）! 入力レベルを下げてください");   // AC-14
    // 入力レベル低すぎ警告: AGC を切っている（11.1）ため OS の入力音量が低いと
    // 小さく録れてしまい、後からブーストするとノイズだけ目立つ。録音中に知らせる。
    if (isFinite(m.db) && m.db > state.rec.maxDb) state.rec.maxDb = m.db;
    if (!m.clip && performance.now() - state.rec.t0ms > 2500 && state.rec.maxDb < -30) {
      setStatus("⚠ 入力レベルが小さすぎます（ここまでのピーク " + Math.round(state.rec.maxDb) +
        " dBFS。目標 -12 dBFS）。OS のサウンド設定で入力音量を上げるか、マイクに近づいてください");
    }
    state.rec.meterRAF = requestAnimationFrame(render);
  };
  state.rec.meterRAF = requestAnimationFrame(render);
}

// ==========================================================================
// 書き出し（/api/export）+ ダウンロード（13.3）
// ==========================================================================
async function exportAudio() {
  if (!state.session) return;
  if (state.audio.playing) stopAudio();
  const fmt = els.fmt.value;
  setStatus("書き出し中…");
  els.export.disabled = true;
  try {
    const res = await fetch("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.session.sessionId,
        editState: buildEditState(),
        target: state.backing ? "mix" : "vocal",   // 伴奏があればミックス書き出し
        format: fmt,
        bitDepth: fmt === "mp3" ? 16 : 24,
        mp3Bitrate: 256,
        normalize: els.normalize.checked,
        // 重ねどりレイヤーをリミッター前で合算してもらう
        extraVocals: state.dubs.map((d) => ({
          sessionId: d.sessionId, editState: buildDubEditState(d),
        })),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^"]+)"?/);
    const name = m ? m[1] : `vocal_tuned.${fmt}`;
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);          // 必ず解放（メモリリーク防止）
    setStatus("書き出し完了: " + name);
  } catch (err) {
    setStatus("書き出しエラー: " + err.message);
  } finally {
    els.export.disabled = false;
  }
}
els.export.addEventListener("click", exportAudio);

let renderSeq = 0;
async function renderAndLoad(autoplay) {
  if (!state.session) return;
  const seq = ++renderSeq;
  setStatus("再合成中…");
  try {
    const res = await fetch("/api/render", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.session.sessionId,
        editState: buildEditState(), mode: "preview"
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const arr = await res.arrayBuffer();
    if (seq !== renderSeq) return;   // 古い結果は破棄
    const ctx = ensureAudioCtx();
    state.audio.buffer = await ctx.decodeAudioData(arr);
    // 重ねどりレイヤーも編集があれば再レンダ（サーバー側キャッシュで無編集フレーズは軽い）
    for (const d of state.dubs) if (d.dirty) await renderDub(d);
    if (seq !== renderSeq) return;
    state.dirty = false;
    els.play.disabled = false;
    setStatus("準備完了");
    if (autoplay) playAudio();
  } catch (err) {
    setStatus("再合成エラー: " + err.message);
  }
}

// ==========================================================================
// 再生（Web Audio）— ボーカル + 伴奏をサンプル精度で同期（12.2）
// ==========================================================================
function ensureAudioCtx() {
  if (!state.audio.ctx) state.audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audio.ctx;
}

function playDur() {
  let d = state.audio.buffer ? state.audio.buffer.duration
    : (state.session ? state.session.durationSec : 0);
  for (const dub of state.dubs) if (dub.buffer) d = Math.max(d, dub.buffer.duration);
  return d;
}

// --- トラック選択（録音1 = 主ボーカル、録音2〜 = 重ねどり） ---------------
// ヘッダーのボタンで各トラックの再生 ON/OFF を切り替える。
// 再生中・録音モニター中でも GainNode の値を書き換えて即反映する。

function trackEnabled(key) {
  if (key === "main") return state.playMain;
  const d = state.dubs.find((x) => x.sessionId === key);
  return d ? d.enabled !== false : false;
}

function onTrackToggle(key) {
  rebuildTrackButtons();
  const on = trackEnabled(key) ? 1 : 0;
  const pg = state.audio.trackGains && state.audio.trackGains[key];
  if (pg) pg.gain.value = on;                       // 再生中に即反映
  const mg = state.rec && state.rec.monGains && state.rec.monGains[key];
  if (mg) mg.gain.value = on;                       // 録音モニター中に即反映
}

// トラック色（ボタン用 hex）。0 = 録音1(琥珀)、1〜 = 重ねどり（DUB_COLORS と同色）。
const TRACK_HEX = ["#e8a23d", "#c96a98", "#9b7fd6", "#98b854", "#5e9fd4"];
function trackColorHex(trackIdx) {
  return trackIdx === 0 ? TRACK_HEX[0] : TRACK_HEX[1 + (trackIdx - 1) % 4];
}

function rebuildTrackButtons() {
  const show = !!state.session;
  els.tracksgroup.hidden = !show; els.trackssep.hidden = !show;
  els.tracks.innerHTML = "";
  if (!show) return;
  // ON = トラック色で塗りつぶし + ●、OFF = アウトラインのみ + ○。
  // 色は CSS ではなくインラインで塗る（DUB_COLORS と同一ソースで確実に同期させる）。
  // 各トラックの横に小さな × （削除。Cmd/Ctrl+Z で戻せる）。
  const mk = (label, trackIdx, on, sid, fn) => {
    const wrap = document.createElement("span");
    wrap.className = "trackwrap";
    const b = document.createElement("button");
    b.className = "trackbtn " + (on ? "on" : "off");
    const col = trackColorHex(trackIdx);
    b.textContent = (on ? "● " : "○ ") + label;
    if (on) {
      b.style.background = col;
      b.style.borderColor = col;
      b.style.color = "#14100b";
      b.style.fontWeight = "700";
      b.style.boxShadow = "0 0 0 2px " + col + "44";
    } else {
      b.style.background = "transparent";
      b.style.borderColor = col + "88";
      b.style.color = col;
      b.style.opacity = "0.8";
    }
    b.title = (on ? "再生 ON（クリックで OFF）" : "再生 OFF（クリックで ON）") +
      "。録音中のモニターにも反映";
    b.addEventListener("click", fn);
    wrap.appendChild(b);
    const x = document.createElement("button");
    x.className = "trackx"; x.textContent = "×";
    x.disabled = !!(state.rec && state.rec.active) || state.audio.playing;
    x.title = label + " を削除（Cmd/Ctrl+Z で戻せます）";
    x.addEventListener("click", (e) => { e.stopPropagation(); deleteTrack(sid); });
    wrap.appendChild(x);
    els.tracks.appendChild(wrap);
  };
  mk("録音1", 0, state.playMain, state.session.sessionId,
    () => { state.playMain = !state.playMain; onTrackToggle("main"); });
  state.dubs.forEach((d, i) => mk("録音" + (i + 2), i + 1, d.enabled !== false, d.sessionId,
    () => { d.enabled = d.enabled === false; onTrackToggle(d.sessionId); }));
}

// トラック削除。サーバー側セッションはアンドゥ用に残す（曲を開き直すまで）。
// 録音1 を削除した場合は次のトラックを主トラックへ昇格させる。
function deleteTrack(sid) {
  if (state.audio.playing || (state.rec && state.rec.active)) return;
  if (state.session && sid === state.session.sessionId) {
    if (state.dubs.length) {
      const d = state.dubs.shift();                // 録音2 を昇格
      const reg = state.sessReg[d.sessionId];
      if (!reg) {
        state.dubs.unshift(d);
        setStatus("内部エラー: トラックの解析データが見つからず削除できません");
        return;
      }
      for (const n of d.notes) delete n.dub;       // 主トラックの印に付け替え
      state.session = Object.assign({}, reg, { notes: d.notes });
      state.playMain = d.enabled !== false;
      state.audio.buffer = null;                   // 主バッファは作り直し
      // 伴奏は新しい主セッションへ付け替え（元ファイルを保持している場合のみ）
      if (state.backing && state.backing.file) {
        uploadBacking(state.backing.file, state.backing).catch(() => {});
      } else if (state.backing) {
        state.backing = null; els.backinglane.hidden = true;
      }
    } else {
      // 最後のトラックの削除 = 空の状態へ（Cmd/Ctrl+Z で復活できる）
      state.session = null;
      state.audio.buffer = null;
      state.playMain = true;
      els.play.disabled = els.stop.disabled = true;
      els.export.disabled = els.projsave.disabled = true;
      setZoomEnabled(false);
    }
  } else {
    state.dubs = state.dubs.filter((x) => x.sessionId !== sid);
  }
  setSelection([]);
  rebuildTrackButtons();
  resizeCanvases(); draw();
  commitEdit(true);                              // アンドゥ可能 + 再レンダ
  setStatus("トラックを削除しました（Cmd/Ctrl+Z で戻せます）");
}

function playAudio() {
  const a = state.audio;
  if (!a.buffer) return;
  stopAudio(true);   // 位置は保持したまま停止
  const ctx = ensureAudioCtx();
  const t0 = ctx.currentTime + 0.1;   // 100ms ルックアヘッド（12.2）

  // 停止位置(playSec)から再生。末尾に張り付いていたら先頭から。
  const dur = playDur();
  let seek = a.playSec || 0;
  if (seek >= dur - 0.02 || seek < 0) seek = 0;

  // トラック（録音1 = 主ボーカル、録音2〜 = 重ねどり）:
  // すべて同じ t0/seek で開始し（サンプル精度の同期・12.2）、
  // Tracks ボタンの ON/OFF は各トラックの GainNode で反映する
  // （再生中に切り替えても即座に効く。ソース自体は常に走らせる）。
  a.vocalGain = ctx.createGain();
  a.vocalGain.connect(ctx.destination);
  a.trackGains = {};
  const srcs = [];
  const addTrack = (key, buffer) => {
    if (!buffer || seek >= buffer.duration - 0.005) return;   // シークが尻を越えたトラックは鳴らせない
    const s = ctx.createBufferSource(), g = ctx.createGain();
    g.gain.value = trackEnabled(key) ? 1 : 0;
    s.buffer = buffer; s.connect(g); g.connect(a.vocalGain);
    a.trackGains[key] = g;
    srcs.push(s);
  };
  addTrack("main", a.buffer);
  for (const d of state.dubs) addTrack(d.sessionId, d.buffer);
  if (!srcs.length) return;                       // 開始できるトラックがない

  // 伴奏（あれば）: 単一 AudioContext 上で同じ t0 基準に開始（AC-18）
  let bsrc = null, sched = { vocalStart: t0, vocalOffset: seek, backingStart: t0, backingOffset: seek };
  if (state.backing && state.backing.buffer) {
    sched = PL.computePlaybackSchedule(t0, state.backing.offsetSec, seek);
    a.backingGain = ctx.createGain();
    a.backingGain.connect(ctx.destination);
    bsrc = ctx.createBufferSource();
    bsrc.buffer = state.backing.buffer; bsrc.connect(a.backingGain);
  }
  applyMixGains();   // ミュート/ソロ/音量をゲインノードへ

  // 最も長いトラックをクロックとし、それが終わったら停止して開始位置へ戻す
  let clock = srcs[0];
  for (const s of srcs) if (s.buffer.duration > clock.buffer.duration) clock = s;
  clock.onended = () => { if (a.source === clock) { a.playSec = a.seekAt; stopAudio(true); } };
  for (const s of srcs) s.start(sched.vocalStart, sched.vocalOffset);
  if (bsrc) bsrc.start(Math.max(ctx.currentTime, sched.backingStart),
    Math.max(0, sched.backingOffset));

  a.source = clock; a.srcs = srcs; a.backingSrc = bsrc;
  a.playing = true; a.startAt = t0; a.seekAt = seek;
  setTransportPlaying(true);
  startPlayhead();
}

// 再生ヘッドの現在位置（秒）: 再生中は経過時間から、停止中は保存値。
function currentPlaySec() {
  const a = state.audio;
  if (a.playing && a.ctx) {
    const t = a.seekAt + (a.ctx.currentTime - a.startAt);
    return Math.max(0, Math.min(playDur(), t));
  }
  return a.playSec || 0;
}

// keepPos=false（手動停止）: 現在の再生位置を playSec に固定して、そこから再開できるようにする。
// keepPos=true: 呼び出し側が playSec を既に決めている（再合成前の一時停止・末尾到達など）。
function stopAudio(keepPos) {
  const a = state.audio;
  if (a.playing && !keepPos) a.playSec = currentPlaySec();
  for (const s of [...(a.srcs || []), a.backingSrc]) {
    if (s) { try { s.onended = null; s.stop(); } catch (_) { } }
  }
  a.source = a.backingSrc = null; a.srcs = []; a.trackGains = {};
  a.playing = false;
  setTransportPlaying(false);
  stopPlayhead();
}

// 再生中は編集をロック（F-7 / AC-19）: グリッド・各コントロールを無効化。
function setTransportPlaying(playing) {
  els.grid.classList.toggle("locked", playing);
  els.stop.disabled = !playing;
  els.master.disabled = playing;
  els.strength.disabled = playing || !state.selection.length;
  els.reverb.disabled = playing;
  els.export.disabled = playing || !state.session;
  els.projfile.disabled = playing;
  if (playing) { els.undo.disabled = els.redo.disabled = true; } else { updateUndoButtons(); }
  const hasBacking = !!state.backing;
  for (const el of [els.bvol, els.bmute, els.bsolo, els.boffset, els.bremove])
    el.disabled = playing || !hasBacking;
  els.bfile.disabled = playing || !state.session;
  // トラックの × の有効/無効を再生状態に追従させる
  // （再生中に作られたボタンが「無効のまま固定」される不具合の防止）
  rebuildTrackButtons();
}

function applyMixGains() {
  const a = state.audio, b = state.backing;
  if (a.vocalGain) {
    // 伴奏ソロ中はボーカルを無音に
    const v = (b && b.solo) ? 0 : 1;
    a.vocalGain.gain.value = v;
  }
  if (a.backingGain && b) {
    const g = b.mute ? 0 : Math.pow(10, b.gainDb / 20);
    a.backingGain.gain.value = g;
  }
}

els.play.addEventListener("click", () => {
  ensureAudioCtx().resume();
  if (state.dirty) renderAndLoad(true); else playAudio();   // AC-20: dirty なら必ず再合成
});
els.stop.addEventListener("click", () => stopAudio(false));

// 先頭に戻る（↩︎）: 再生ヘッドを 0 秒へ。再生中なら止めてから戻す。
els.tostart.addEventListener("click", () => {
  if (state.audio.playing) stopAudio(true);
  state.audio.playSec = 0;
  updatePlayheadStatic();
  const sc = horizontalScroller();      // 表示も先頭へ戻す（ヘッドを画面外に置き去りにしない）
  if (sc) sc.scrollLeft = 0;
});

// --- 再生ヘッド（両レーンを貫く縦線・12.4） ---
// 停止中も常に表示し、playSec の位置に置く。再生中は RAF で動かす。
let _playheadRAF = 0;
function positionPlayhead(t) {
  if (!state.view) return;
  const x = state.view.timeToX(t);
  els.playhead.style.left = x + "px";
  els.bplayhead.style.left = x + "px";
}
// 停止中の静的表示。session があれば表示、伴奏があれば伴奏レーンにも表示。
function updatePlayheadStatic() {
  const on = !!state.session;
  els.playhead.hidden = !on;
  els.bplayhead.hidden = !(on && state.backing);
  if (on) positionPlayhead(currentPlaySec());
}
function startPlayhead() {
  els.playhead.hidden = false;
  if (state.backing) els.bplayhead.hidden = false;
  state.audio.follow = true;            // 再生開始のたびに追従を復帰させる
  _followScrollLeft = -1;
  const tick = () => {
    if (!state.audio.playing) return;
    const t = currentPlaySec();
    positionPlayhead(t);
    followPlayhead(t);
    _playheadRAF = requestAnimationFrame(tick);
  };
  _playheadRAF = requestAnimationFrame(tick);
}

// --- 再生ヘッド追従スクロール ---
// 再生ヘッドが表示領域の左から 60% を超えたら、超えたぶんだけ横スクロールする。
// 毎フレーム「60% の位置に戻す」ため、スクロール速度は再生ヘッドの速度と自動的に一致し、
// ヘッドは 60% の線に貼り付いたまま、内容だけが流れていくように見える。
const FOLLOW_RATIO = 0.6;
let _followScrollLeft = -1;   // 直近に自分で設定した scrollLeft（手動スクロール検出用）

function followPlayhead(t) {
  const a = state.audio;
  if (!a.follow || !state.view) return;
  const sc = horizontalScroller();
  const maxScroll = Math.max(0, sc.scrollWidth - sc.clientWidth);
  if (maxScroll <= 0) return;   // スクロール不要（全体が画面に収まっている）
  // 前フレームで自分が設定した値から動いていたら、ユーザーが手動スクロールした
  // ということなので追従を解除する（再生中でも自由に別の場所を見られる）。
  if (_followScrollLeft >= 0 && Math.abs(sc.scrollLeft - _followScrollLeft) > 1.5) {
    a.follow = false;
    setStatus("追従スクロールを解除しました（再生し直すと復帰します）");
    return;
  }
  // 画面上での再生ヘッド位置（内容座標の原点 + 時刻→x）。
  const screenX = contentOrigin().left + state.view.timeToX(t);
  const rect = gridwrap().getBoundingClientRect();
  const viewLeft = Math.max(rect.left, 0);
  const viewRight = Math.min(rect.right, window.innerWidth);
  const target = viewLeft + (viewRight - viewLeft) * FOLLOW_RATIO;
  // 60% を超えたら追従。左に外れた場合（先頭へ戻した直後など）も 60% へ引き戻す。
  const delta = screenX - target;
  if (delta <= 0.5 && screenX >= viewLeft) { _followScrollLeft = sc.scrollLeft; return; }
  const ns = Math.max(0, Math.min(maxScroll, sc.scrollLeft + delta));
  if (ns !== sc.scrollLeft) sc.scrollLeft = ns;
  _followScrollLeft = sc.scrollLeft;   // 読み戻して端数丸めのぶんも吸収する
}
function stopPlayhead() {
  cancelAnimationFrame(_playheadRAF);
  updatePlayheadStatic();   // 停止位置に固定して表示し続ける
}

// 再生ヘッドのつまみをドラッグして再生位置を移動（停止中のみ）。
function playheadDragMove(e) {
  if (!state.phDrag || !state.session) return;
  const x = e.clientX - contentOrigin().left;
  const t = Math.max(0, Math.min(playDur(), state.view.xToTime(x)));
  state.audio.playSec = t;
  positionPlayhead(t);
  setStatus("再生位置 " + t.toFixed(2) + "s");
}
function playheadDragEnd() {
  state.phDrag = false;
  stopAutoScroll();
  window.removeEventListener("mousemove", playheadDragMove);
  window.removeEventListener("mouseup", playheadDragEnd);
}
els.phgrab.addEventListener("mousedown", (e) => {
  if (!state.session || state.audio.playing) return;   // 再生中は移動不可
  e.preventDefault(); e.stopPropagation();
  state.phDrag = true;
  state.mouse = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey };
  startAutoScroll();   // 画面端まで持っていったら自動で横スクロールする
  window.addEventListener("mousemove", playheadDragMove);
  window.addEventListener("mouseup", playheadDragEnd);
});

// 開発用: URL に #demo を付けるとサンプル音声を自動読み込みする。
async function loadFromUrl(url) {
  setStatus("解析中…");
  const blob = await (await fetch(url)).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "sample.wav", { type: "audio/wav" }));
  els.file.files = dt.files;
  els.file.dispatchEvent(new Event("change"));
}
if (location.hash === "#demo") window.addEventListener("load", () => loadFromUrl("/api/dev/sample"));

window.addEventListener("resize", () => { resizeCanvases(); draw(); _followScrollLeft = -1; });
