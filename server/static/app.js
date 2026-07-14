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
  mouse: { clientX: 0, clientY: 0 },
  gKey: false,          // G キー押下中（音量ツール）
  aKey: false,          // A キー押下中（追加選択モード）
  rec: null,            // 録音中の状態 {active, stream, ctx, chunks, peak, meterRAF}
  audio: {
    ctx: null, buffer: null, source: null, playing: false,
    backingSrc: null, vocalGain: null, backingGain: null, startAt: 0,
    seekAt: 0,      // 今回の再生を開始した位置（秒）
    playSec: 0,     // 再生ヘッドの現在位置（秒）。停止後もここから再開する
  },
  phDrag: false,    // 再生ヘッドを掴んでドラッグ中か
  backing: null,        // {peaks, durationSec, offsetSec, gainDb, mute, solo, buffer}
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
  zoomin: document.getElementById("zoomin"),
  zoomout: document.getElementById("zoomout"),
  projfile: document.getElementById("projfile"),
  projsave: document.getElementById("projsave"),
};

const RL = window.RecLogic;

const setStatus = (msg) => { els.status.textContent = msg; };

// 横方向のズーム率。内容幅 = 秒数 × pxPerSec（最低でもビューポート幅を満たす）。
// これにより長い音声は横スクロールになり、鍵盤列は固定のまま常に見える。
const MAX_CANVAS_PX = 30000;   // canvas 幅の上限（描画バッファの安全域）

const gridwrap = () => els.grid.parentElement;
const keyswrap = () => els.keys.parentElement;

// レイアウト寸法（CSS px）: 内容幅と表示高さ。
function layout() {
  const gw = gridwrap();
  const viewH = gw.clientHeight;
  const dur = state.session ? Math.max(state.session.durationSec, 0.5) : 1;
  let contentW = Math.max(gw.clientWidth, dur * state.pxPerSec);
  contentW = Math.min(contentW, MAX_CANVAS_PX);
  return { contentW, viewH };
}

// ==========================================================================
// View: 座標変換（time↔x, cents↔y）を集約
// ==========================================================================
function makeView(session, width, height) {
  const { lo, hi } = PL.pitchRange(session.notes);
  const t0 = 0, t1 = Math.max(session.durationSec, 0.5);
  return PL.makeTransforms(t0, t1, lo, hi, width, height);
}

// ==========================================================================
// 描画
// ==========================================================================
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const { contentW, viewH } = layout();
  // グリッド: 内容幅ぶんの横長 canvas（ラッパが横スクロールする）
  els.grid.style.width = contentW + "px";
  els.grid.style.height = viewH + "px";
  els.grid.width = Math.round(contentW * dpr);
  els.grid.height = Math.round(viewH * dpr);
  els.grid.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  // 鍵盤: 固定幅 × 表示高さ
  const kw = keyswrap().clientWidth;
  els.keys.width = Math.round(kw * dpr);
  els.keys.height = Math.round(viewH * dpr);
  els.keys.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw() {
  if (!state.session) return;
  const { contentW, viewH } = layout();
  state.view = makeView(state.session, contentW, viewH);
  renderScene(els.grid.getContext("2d"), state.view, null);
  drawKeys();
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
let _bg = null, _bgCtx = null;
function ensureBg() {
  if (!_bg) { _bg = document.createElement("canvas"); _bgCtx = _bg.getContext("2d"); }
  if (_bg.width !== els.grid.width || _bg.height !== els.grid.height) {
    _bg.width = els.grid.width; _bg.height = els.grid.height;
  }
  const dpr = window.devicePixelRatio || 1;
  _bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return _bgCtx;
}

// ドラッグ開始時: liveSegs 以外の全シーンを背景キャッシュに描く。
function prepareDragBackground(liveSegs) {
  renderScene(ensureBg(), state.view, liveSegs);
  state.drag.liveSegs = liveSegs;
  state.drag.bgReady = true;
}

// ドラッグ中フレーム: 見えている範囲だけ背景を貼り付け → 動かすセグメントを上描き。
// 更新範囲をビューポート幅に限定するので、音声が長く canvas が横に巨大でも
// 1フレームの負荷は一定（画面に見えている部分だけ）になる。
function drawDragFrame() {
  const ctx = els.grid.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const gw = gridwrap();
  // 可視範囲（デバイスピクセル）
  const dx = Math.max(0, Math.floor(gw.scrollLeft * dpr));
  const dw = Math.min(els.grid.width - dx, Math.ceil(gw.clientWidth * dpr) + 1);
  const dh = els.grid.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(dx, 0, dw, dh);
  ctx.drawImage(_bg, dx, 0, dw, dh, dx, 0, dw, dh);   // 同じ矩形をコピー
  ctx.restore();                                        // dpr 変換に戻す
  for (const seg of state.drag.liveSegs) {
    const loc = locateSeg(seg);
    if (loc) drawOneSegment(ctx, state.view, loc.note, seg, loc.i);
  }
  // 範囲選択の矩形
  if (state.drag.mode === "marquee") {
    const d = state.drag;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    ctx.fillStyle = "rgba(120,180,240,0.15)";
    ctx.strokeStyle = "rgba(140,190,240,0.9)";
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
}

function locateSeg(seg) {
  for (const note of state.session.notes) {
    const i = note.segments.indexOf(seg);
    if (i >= 0) return { note, i };
  }
  return null;
}

// 全シーン（グリッド + F0曲線 + ノート）を任意の context に描く。
// skip: 省略するセグメントの Set（ドラッグ中の背景生成で使う）。
function renderScene(ctx, v, skip) {
  ctx.clearRect(0, 0, v.width, v.height);

  // 半音行の背景（黒鍵行を薄く）
  for (let c = v.cLo; c <= v.cHi; c += 100) {
    const midi = Math.round(c / 100);
    const y = v.centsToY(c + 50);
    const h = v.rowHeightPx;
    ctx.fillStyle = isBlackKey(midi) ? "#191c22" : "#1c2027";
    ctx.fillRect(0, y - h / 2, v.width, h);
    ctx.strokeStyle = "#262b33";
    ctx.beginPath(); ctx.moveTo(0, v.centsToY(c)); ctx.lineTo(v.width, v.centsToY(c)); ctx.stroke();
  }

  // 時間グリッド = BPM と拍子による拍線・小節線。
  // 小節線は明るく＋小節番号、拍線は細く。BPM が速く拍線が密なら間引く。
  ctx.font = "10px sans-serif";
  const bpm = state.tempo.bpm, beats = state.tempo.beatsPerBar;
  const spb = 60 / bpm;                       // 1拍の秒数
  const beatPx = spb * (v.width / (v.t1 || 1));
  const beatStride = beatPx < 6 ? Math.ceil(6 / beatPx) : 1;  // 拍線が詰まりすぎたら間引く
  let bi = 0;
  for (let t = 0; t <= v.t1 + 1e-6; t += spb, bi++) {
    const x = v.timeToX(t);
    const isBar = bi % beats === 0;
    if (!isBar && (bi % beatStride !== 0)) continue;
    ctx.strokeStyle = isBar ? "#39414f" : "#242932";
    ctx.lineWidth = isBar ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.height); ctx.stroke();
    if (isBar) {                              // 小節番号（1始まり）
      ctx.fillStyle = "#6b7280";
      ctx.fillText(String(bi / beats + 1), x + 3, 11);
    }
  }
  ctx.lineWidth = 1;

  // フレーズ境界（無音での分割点・10.4）を薄いシアンの破線で示す
  const bounds = state.session.phraseBounds || [];
  if (bounds.length) {
    ctx.strokeStyle = "rgba(90,200,220,0.5)"; ctx.setLineDash([6, 4]);
    for (const tb of bounds) {
      const x = v.timeToX(tb);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.height); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawF0Curve(ctx, v);
  for (const note of state.session.notes) {
    note.segments.forEach((s, i) => {
      if (skip && skip.has(s)) return;
      drawOneSegment(ctx, v, note, s, i);
    });
  }
}

// 白い F0 曲線（編集オフセットを反映した表示用の近似）
function drawF0Curve(ctx, v) {
  const s = state.session, f0 = s.f0Hz, hop = s.hopSec;
  const primary = s.notes.filter((n) => !n.voice);   // 白い曲線は主ボイスのみ反映
  ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.3;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < f0.length; i++) {
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

// 1 セグメント分の描画（塗り高さ・RMS背景・枠・遷移帯）。
function drawOneSegment(ctx, v, note, s, i) {
  const h = Math.max(10, v.rowHeightPx * 0.9);
  const rms = state.session.rmsDb, hop = state.session.hopSec;
  const c = s.baseCents + s.pitchOffsetCents;
  const x0 = v.timeToX(s.startSec), x1 = v.timeToX(s.endSec);
  const w = Math.max(1, x1 - x0);
  const yc = v.centsToY(c), yTop = yc - h / 2, yBot = yc + h / 2;
  const active = state.drag && (state.drag.seg === s ||
    (state.drag.group && state.drag.group.some((g) => g.seg === s)));
  const selected = state.selection.indexOf(s) >= 0;

  drawRmsBg(ctx, v, s, x0, x1, yBot, h, rms, hop);

  if (s.mute) {
    ctx.strokeStyle = "rgba(170,170,180,0.85)";
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, yTop + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
  } else {
    const fill = PL.gainFillFraction(s.gainDb);
    const fh = h * fill;
    const harm = !!note.voice;               // ハモリ副ボイスは橙系で区別
    ctx.fillStyle = active ? (harm ? "rgba(235,160,80,0.95)" : "rgba(95,155,240,0.95)")
      : (selected ? (harm ? "rgba(225,150,75,0.9)" : "rgba(88,148,232,0.9)")
        : (harm ? "rgba(210,140,70,0.78)" : (i % 2 ? "rgba(70,120,200,0.72)" : "rgba(80,135,215,0.8)")));
    ctx.fillRect(x0, yBot - fh, w, fh);
    ctx.strokeStyle = selected ? "rgba(255,225,130,1)"
      : (harm ? "rgba(240,190,120,0.9)" : "rgba(150,190,240,0.9)");
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
    ctx.fillStyle = "rgba(230,180,90,0.22)";
    ctx.fillRect(bx0, bandTop, Math.max(2, bx1 - bx0), bandBot - bandTop);
    ctx.strokeStyle = "rgba(235,185,95,0.95)";
    ctx.beginPath(); ctx.moveTo(x0, bandTop); ctx.lineTo(x0, bandBot); ctx.stroke();
  }
}

// 原音の RMS 包絡線を矩形内に薄グレーで描く（下端基準、-60..0dB を 0..1 に正規化）
function drawRmsBg(ctx, v, s, x0, x1, yBot, h, rms, hop) {
  if (!rms || !rms.length) return;
  const i0 = Math.max(0, Math.floor(s.startSec / hop));
  const i1 = Math.min(rms.length - 1, Math.ceil(s.endSec / hop));
  ctx.fillStyle = "rgba(205,208,215,0.12)";
  ctx.beginPath(); ctx.moveTo(x0, yBot);
  for (let i = i0; i <= i1; i++) {
    const norm = Math.max(0, Math.min(1, (rms[i] + 60) / 60));
    ctx.lineTo(v.timeToX(i * hop), yBot - h * norm);
  }
  ctx.lineTo(x1, yBot); ctx.closePath(); ctx.fill();
}

function drawKeys() {
  const v = state.view, ctx = els.keys.getContext("2d");
  const w = els.keys.getBoundingClientRect().width;
  ctx.clearRect(0, 0, w, v.height);
  for (let c = v.cLo; c <= v.cHi; c += 100) {
    const midi = Math.round(c / 100);
    const y = v.centsToY(c + 50), h = v.rowHeightPx;
    ctx.fillStyle = isBlackKey(midi) ? "#14161b" : "#e8e8ea";
    ctx.fillRect(0, y - h / 2, w, h);
    ctx.strokeStyle = "#333"; ctx.strokeRect(0, y - h / 2, w, h);
    if (!isBlackKey(midi)) {
      ctx.fillStyle = "#666"; ctx.font = "9px sans-serif";
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
  for (const n of state.session.notes) if (n.segments.indexOf(seg) >= 0) return n;
  return null;
}
function replaceNote(oldNote, newNote) {
  const idx = state.session.notes.indexOf(oldNote);
  if (idx >= 0) state.session.notes[idx] = newNote;
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

  for (const note of state.session.notes) {
    for (let i = 1; i < note.segments.length; i++) {
      const s = note.segments[i], p = note.segments[i - 1];
      if (Math.abs(px - v.timeToX(s.startSec)) < 6 && (within(s) || within(p)))
        return { kind: "divider", note, bi: i };
    }
  }
  // クリック音高に最も近いバー（主/ハモリが重なっても個別に掴める）
  if (cents == null) {
    const seg = PL.segAtTime(state.session.notes, t);
    return seg ? { kind: "body", note: noteOf(seg), seg } : null;
  }
  const seg = PL.segAtPoint(state.session.notes, t, cents);
  if (seg && within(seg)) return { kind: "body", note: noteOf(seg), seg };
  return null;
}

function commitEdit(changed) {
  if (!changed) return;
  pushUndo();             // commitEdit は全編集の合流点。ここで直前状態を undo へ。
  state.dirty = true;
  draw();
  renderAndLoad(false);   // 再合成して準備（自動再生はしない）
}

// --- アンドゥ/リドゥ（EditState スナップショット・6.2） ---
let undoStack = [], redoStack = [], lastSnap = null;
function snapshotState() {
  return JSON.stringify({ notes: state.session.notes, master: state.master, reverb: state.reverb });
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
  state.session.notes = o.notes;
  state.master = o.master;
  state.reverb = o.reverb || { mix: 0, decaySec: 1.2 };
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
  const rect = els.grid.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const t = state.view.xToTime(px);
  const hit = hitTest(px, t, state.view.yToCents(py));

  if (!hit) {
    // 音程バーのない場所で左ドラッグ = 範囲選択（マーキー）
    state.drag = { mode: "marquee", x0: px, y0: py, x1: px, y1: py, moved: false };
    if (!(e.shiftKey)) setSelection([]);      // Shift でなければ選択を一旦クリア
    prepareDragBackground(new Set());          // シーン全体を背景キャッシュ
    startMarqueeAutoScroll();                  // 端での自動横スクロールを開始
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
  const rect = els.grid.getBoundingClientRect();
  const cursorCents = state.view.yToCents(state.mouse.clientY - rect.top);
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
  return state.view.xToTime(state.mouse.clientX - els.grid.getBoundingClientRect().left);
}

window.addEventListener("mousemove", (e) => {
  state.mouse = { clientX: e.clientX, clientY: e.clientY };
  const d = state.drag;
  if (!d) return;
  // ボタンが離れているのにドラッグが残っている場合は終了（mouseup 取りこぼし対策）。
  // これで「クリックしていないのにノートが動き続ける」不具合を防ぐ。
  if (e.buttons === 0) { endDrag(); return; }
  d.moved = true;
  const v = state.view;

  if (d.mode === "marquee") {
    const r = els.grid.getBoundingClientRect();
    d.x1 = e.clientX - r.left; d.y1 = e.clientY - r.top;
    // 端での自動スクロールは marqueeAutoScrollTick が毎フレーム面倒を見る
  } else if (d.mode === "pitch") {
    updateSnapLabel(e);
    // 主バーのスナップ済み差分を全選択バーに適用（相対移動）
    const delta = PL.computeDragOffset(0, e.clientY - d.startY, v.centsPerPixel, mods(e));
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
  scheduleDraw();   // rAF で間引いて再描画（他タブが重くならないように）
});

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

// 範囲選択中、ポインタがビューポート左右端に来たら自動で横スクロールし、
// 画面外の内容まで選択範囲を伸ばせるようにする。マーキー開始時にループを起動し、
// 終了まで毎フレーム現在のマウス位置を見て回し続ける（マウスを端で止めても効く）。
let _marqueeScrollRAF = 0;
function startMarqueeAutoScroll() {
  if (!_marqueeScrollRAF) _marqueeScrollRAF = requestAnimationFrame(marqueeAutoScrollTick);
}
function marqueeAutoScrollTick() {
  _marqueeScrollRAF = 0;
  const d = state.drag;
  if (!d || d.mode !== "marquee") return;   // ドラッグ終了で自然に停止
  // 端の判定は「実際に画面に見えている編集領域」で行う。
  // gridwrap の rect.right がレイアウト都合で画面外に出ていても、
  // window.innerWidth でクランプすれば見えている右端で判定できる。
  const rect = gridwrap().getBoundingClientRect();
  const viewLeft = Math.max(rect.left, 0);
  const viewRight = Math.min(rect.right, window.innerWidth);
  const EDGE = 48, MAXV = 26;   // 端から EDGE px を加速帯、最大 MAXV px/frame
  const x = state.mouse.clientX;
  let v = 0;
  if (x < viewLeft + EDGE) v = -Math.min(EDGE, viewLeft + EDGE - x) / EDGE * MAXV;
  else if (x > viewRight - EDGE) v = Math.min(EDGE, x - (viewRight - EDGE)) / EDGE * MAXV;
  if (v !== 0) {
    const sc = horizontalScroller();   // 実際にスクロールする要素へ適用
    const maxScroll = Math.max(0, sc.scrollWidth - sc.clientWidth);
    const ns = Math.max(0, Math.min(maxScroll, sc.scrollLeft + v));
    if (ns !== sc.scrollLeft) {
      sc.scrollLeft = ns;
      // スクロールで grid の位置がずれるので、静止したマウスでも矩形端が内容側へ伸びる
      const r = els.grid.getBoundingClientRect();
      d.x1 = state.mouse.clientX - r.left;
      d.y1 = state.mouse.clientY - r.top;
      scheduleDraw();
    }
  }
  _marqueeScrollRAF = requestAnimationFrame(marqueeAutoScrollTick);   // ドラッグ中は回し続ける
}
function stopMarqueeAutoScroll() {
  if (_marqueeScrollRAF) { cancelAnimationFrame(_marqueeScrollRAF); _marqueeScrollRAF = 0; }
}

function endDrag() {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  stopMarqueeAutoScroll();
  if (d.mode === "marquee") {
    const v = state.view;
    if (d.moved) {
      const sel = PL.segmentsInRect(
        state.session.notes, v.xToTime(d.x0), v.xToTime(d.x1),
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
  const rect = els.grid.getBoundingClientRect();
  const px = e.clientX - rect.left, t = state.view.xToTime(px);
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

function zoomBy(factor) {
  if (!state.session) return;
  state.pxPerSec = Math.max(40, Math.min(2000, state.pxPerSec * factor));
  resizeCanvases(); draw();
}
els.zoomin.addEventListener("click", () => zoomBy(1.4));
els.zoomout.addEventListener("click", () => zoomBy(1 / 1.4));
// Cmd/Ctrl + ホイールで拡大縮小
gridwrap().addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !state.session) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
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
    els.zoomin.disabled = els.zoomout.disabled = els.projsave.disabled = false;
    setSelection([]); state.clipboard = null;   // 選択・クリップボードをリセット
    initUndo();                   // アンドゥ履歴を初期化
    await renderAndLoad(false);   // 初期プレビューを用意
  } catch (err) {
    setStatus("エラー: " + err.message);
  }
});

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
els.bfile.addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f || !state.session) return;
  setStatus("伴奏を解析中…");
  const fd = new FormData();
  fd.append("sessionId", state.session.sessionId);
  fd.append("audio", f);
  try {
    const res = await fetch("/api/backing", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    j.peaks = b64ToF32(j.peaks);
    // 再生用オーディオを取得してデコード
    const ab = await (await fetch(`/api/backing/${state.session.sessionId}/audio`)).arrayBuffer();
    const buffer = await ensureAudioCtx().decodeAudioData(ab);
    state.backing = {
      peaks: j.peaks, durationSec: j.durationSec, buffer,
      offsetSec: 0, gainDb: 0, mute: false, solo: false,
    };
    els.backinglane.hidden = false;
    els.boffset.value = "0"; els.bvol.value = "0";
    els.bmute.classList.remove("on"); els.bsolo.classList.remove("on");
    resizeCanvases(); draw(); drawBacking();
    setStatus("伴奏を追加しました");
  } catch (err) {
    setStatus("伴奏エラー: " + err.message);
  }
  els.bfile.value = "";
});

// 伴奏波形（peaks から描画）。グリッドと同じ時間軸・幅で並べる。
function drawBacking() {
  if (!state.backing || !state.view) return;
  const v = state.view, dpr = window.devicePixelRatio || 1;
  const cw = v.width, ch = els.bcanvas.parentElement.clientHeight;
  els.bcanvas.style.width = cw + "px"; els.bcanvas.style.height = ch + "px";
  els.bcanvas.width = Math.round(cw * dpr); els.bcanvas.height = Math.round(ch * dpr);
  const ctx = els.bcanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const peaks = state.backing.peaks, dur = state.backing.durationSec;
  const mid = ch / 2;
  ctx.strokeStyle = "rgba(120,180,140,0.85)";
  ctx.beginPath();
  for (let i = 0; i < peaks.length; i++) {
    const t = (i / peaks.length) * dur + state.backing.offsetSec;  // 頭合わせを反映
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

// グリッドと伴奏レーンの横スクロールを同期（時間軸を揃える）。
els.grid.parentElement.addEventListener("scroll", () => {
  if (!state.backing) return;
  els.bcanvas.parentElement.scrollLeft = els.grid.parentElement.scrollLeft;
});
els.bcanvas.parentElement.addEventListener("scroll", () => {
  els.grid.parentElement.scrollLeft = els.bcanvas.parentElement.scrollLeft;
});

// ==========================================================================
// 録音（AudioWorklet で生 PCM を取得・11章。アカペラのみ）
// ==========================================================================
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

    const chunks = [];
    state.rec = { active: true, stream, ctx, node, chunks, peak: 0, meterRAF: 0 };
    node.port.onmessage = (e) => {
      const d = e.data; chunks.push(d);
      let p = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
      state.rec.peak = p;
    };

    els.record.classList.add("on"); els.record.textContent = "■ 録音停止";
    els.meter.hidden = false;
    if (state.metronome.on) startMetronome(ctx);   // 録音中のメトロノーム（ヘッドホン前提）
    setStatus("録音中… ピークが -12dBFS 付近になるように（0dBFS でクリップ）");
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
  const samples = RL.concatFloat32(r.chunks);
  const sr = r.ctx.sampleRate;         // 11.3: 実際の SR を使う
  try { r.stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
  try { await r.ctx.close(); } catch (_) { }
  state.rec = null;
  els.record.classList.remove("on"); els.record.textContent = "● 録音";
  els.meter.hidden = true;

  if (!samples.length) { setStatus("録音が空でした"); return; }
  // 32bit float WAV へエンコード → ファイル読み込みと同じ /api/session 経路へ流す（11章）
  const wav = RL.encodeWavFloat32(samples, sr);
  const file = new File([new Blob([wav], { type: "audio/wav" })], "recording.wav", { type: "audio/wav" });
  const dt = new DataTransfer(); dt.items.add(file);
  els.file.files = dt.files;
  els.file.dispatchEvent(new Event("change"));
}

function startMeter() {
  const render = () => {
    if (!state.rec || !state.rec.active) return;
    const m = RL.meterFromPeak(state.rec.peak);
    const norm = Math.max(0, Math.min(1, (m.db + 48) / 48));   // -48..0 dBFS
    els.meterbar.style.width = (norm * 100) + "%";
    els.meterbar.style.background = m.clip ? "#ff4d4d" : (m.hot ? "#e0b33a" : "#5ac06c");
    els.meterlabel.textContent = isFinite(m.db) ? Math.round(m.db) + "dB" : "-∞";
    if (m.clip) setStatus("⚠ クリップ検出（0dBFS）! 入力レベルを下げてください");   // AC-14
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
  return state.audio.buffer ? state.audio.buffer.duration
    : (state.session ? state.session.durationSec : 0);
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

  // ボーカル
  a.vocalGain = ctx.createGain();
  a.vocalGain.connect(ctx.destination);
  const vsrc = ctx.createBufferSource();
  vsrc.buffer = a.buffer; vsrc.connect(a.vocalGain);

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

  // 末尾まで再生し終えたら、再生開始位置に戻して停止（もう一度 Play で同じ所から再生できる）
  vsrc.onended = () => { if (a.source === vsrc) { a.playSec = a.seekAt; stopAudio(true); } };
  vsrc.start(sched.vocalStart, sched.vocalOffset);
  if (bsrc) bsrc.start(Math.max(ctx.currentTime, sched.backingStart),
    Math.max(0, sched.backingOffset));

  a.source = vsrc; a.backingSrc = bsrc; a.playing = true; a.startAt = t0; a.seekAt = seek;
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
  for (const s of [a.source, a.backingSrc]) {
    if (s) { try { s.onended = null; s.stop(); } catch (_) { } }
  }
  a.source = a.backingSrc = null;
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
  const tick = () => {
    if (!state.audio.playing) return;
    positionPlayhead(currentPlaySec());
    _playheadRAF = requestAnimationFrame(tick);
  };
  _playheadRAF = requestAnimationFrame(tick);
}
function stopPlayhead() {
  cancelAnimationFrame(_playheadRAF);
  updatePlayheadStatic();   // 停止位置に固定して表示し続ける
}

// 再生ヘッドのつまみをドラッグして再生位置を移動（停止中のみ）。
function playheadDragMove(e) {
  if (!state.phDrag || !state.session) return;
  const rect = els.grid.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = Math.max(0, Math.min(playDur(), state.view.xToTime(x)));
  state.audio.playSec = t;
  positionPlayhead(t);
  setStatus("再生位置 " + t.toFixed(2) + "s");
}
function playheadDragEnd() {
  state.phDrag = false;
  window.removeEventListener("mousemove", playheadDragMove);
  window.removeEventListener("mouseup", playheadDragEnd);
}
els.phgrab.addEventListener("mousedown", (e) => {
  if (!state.session || state.audio.playing) return;   // 再生中は移動不可
  e.preventDefault(); e.stopPropagation();
  state.phDrag = true;
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

window.addEventListener("resize", () => { resizeCanvases(); draw(); });
