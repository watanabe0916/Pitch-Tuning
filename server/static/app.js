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
  selected: null,       // 選択中セグメント（補正スライダー/M の対象）
  master: 0.0,          // masterGainDb
  reverb: { mix: 0.0, decaySec: 1.2 },   // 出力段リバーブ
  pxPerSec: 260,        // 横ズーム率
  mouse: { clientX: 0, clientY: 0 },
  gKey: false,          // G キー押下中（音量ツール）
  rec: null,            // 録音中の状態 {active, stream, ctx, chunks, peak, meterRAF}
  audio: { ctx: null, buffer: null, source: null, playing: false,
           backingSrc: null, vocalGain: null, backingGain: null, startAt: 0 },
  backing: null,        // {peaks, durationSec, offsetSec, gainDb, mute, solo, buffer}
  dirty: false,         // 未再合成の編集があるか
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
  record: document.getElementById("record"),
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

  // 時間グリッド（画面幅に応じ間隔を選び、見える範囲だけ描く）
  ctx.strokeStyle = "#22262e"; ctx.fillStyle = "#555"; ctx.font = "10px sans-serif";
  const step = v.t1 > 30 ? 5 : (v.t1 > 12 ? 1 : 0.5);
  for (let t = 0; t <= v.t1; t += step) {
    const x = v.timeToX(t);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.height); ctx.stroke();
    ctx.fillText(t.toFixed(step < 1 ? 1 : 0) + "s", x + 2, v.height - 4);
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
  ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.3;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < f0.length; i++) {
    const hz = f0[i];
    if (!(hz > 0)) { pen = false; continue; }
    const t = i * hop;
    const off = PL.offsetAtTime(s.notes, t);
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
  const active = state.drag && state.drag.seg === s;
  const selected = state.selected === s;

  drawRmsBg(ctx, v, s, x0, x1, yBot, h, rms, hop);

  if (s.mute) {
    ctx.strokeStyle = "rgba(170,170,180,0.85)";
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, yTop + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
  } else {
    const fill = PL.gainFillFraction(s.gainDb);
    const fh = h * fill;
    ctx.fillStyle = active ? "rgba(95,155,240,0.95)"
      : (selected ? "rgba(88,148,232,0.9)"
        : (i % 2 ? "rgba(70,120,200,0.72)" : "rgba(80,135,215,0.8)"));
    ctx.fillRect(x0, yBot - fh, w, fh);
    ctx.strokeStyle = selected ? "rgba(255,225,130,1)" : "rgba(150,190,240,0.9)";
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
function hitTest(px, t) {
  const v = state.view;
  for (const note of state.session.notes) {
    for (let i = 1; i < note.segments.length; i++) {
      if (Math.abs(px - v.timeToX(note.segments[i].startSec)) < 6)
        return { kind: "divider", note, bi: i };
    }
  }
  const seg = PL.segAtTime(state.session.notes, t);
  if (seg) return { kind: "body", note: noteOf(seg), seg };
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
  state.selected = null;
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
  if (!state.session || state.audio.playing) return;   // 再生中は編集ロック(F-7)
  const rect = els.grid.getBoundingClientRect();
  const px = e.clientX - rect.left, t = state.view.xToTime(px);
  const hit = hitTest(px, t);
  if (!hit) return;

  if (hit.kind === "divider") {
    const seg = hit.note.segments[hit.bi];
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+分割線ドラッグ = 遷移区間長(transitionInMs)を伸縮（F-3）
      state.drag = { mode: "transition", seg, startX: e.clientX,
                     startTrans: seg.transitionInMs || 40 };
    } else {
      // 分割線ドラッグ = 分割位置の移動
      state.drag = { mode: "divider", note: hit.note, bi: hit.bi };
    }
  } else {
    state.selected = hit.seg; syncSliders();
    if (state.gKey) {
      // G+縦ドラッグ = 音量(gainDb)（F-4）
      state.drag = { mode: "gain", seg: hit.seg, startY: e.clientY, startGain: hit.seg.gainDb };
    } else {
      // 縦ドラッグ = 音高(pitchOffsetCents)
      state.drag = { mode: "pitch", seg: hit.seg, startY: e.clientY,
                     startOffset: hit.seg.pitchOffsetCents };
    }
  }
  state.drag.moved = false;
  // ドラッグ中に動かすセグメント（これらを除いた背景を1回だけキャッシュ）。
  const live = state.drag.mode === "divider"
    ? [state.drag.note.segments[state.drag.bi - 1], state.drag.note.segments[state.drag.bi]]
    : [state.drag.seg];
  updateSnapLabel(e);
  draw();                                   // まず通常描画（選択ハイライト等を反映）
  prepareDragBackground(new Set(live));     // 動かさない部分を背景キャッシュへ
});

// マウスの画面座標だけ保持（getBoundingClientRect を毎回呼ぶと強制リフローで重い）。
// グリッド内 x や時刻は必要になった時だけ計算する。
function mouseTime() {
  return state.view.xToTime(state.mouse.clientX - els.grid.getBoundingClientRect().left);
}

window.addEventListener("mousemove", (e) => {
  state.mouse = { clientX: e.clientX, clientY: e.clientY };
  const d = state.drag;
  if (!d) return;
  d.moved = true;
  const v = state.view;

  if (d.mode === "pitch") {
    updateSnapLabel(e);
    d.seg.pitchOffsetCents = PL.computeDragOffset(
      d.startOffset, e.clientY - d.startY, v.centsPerPixel, mods(e));
  } else if (d.mode === "gain") {
    // 行1つ(=100cent高)を 24dB 相当にマップ。0.5dB スナップ。
    const dbPerPx = 24 / v.rowHeightPx;
    let g = d.startGain - (e.clientY - d.startY) * dbPerPx;
    g = Math.max(PL.GAIN_FILL_MIN_DB, Math.min(PL.GAIN_FILL_MAX_DB, Math.round(g * 2) / 2));
    d.seg.gainDb = g; d.seg.mute = false;
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

window.addEventListener("mouseup", () => {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  draw();
  commitEdit(d.moved);
});

// 分割線ダブルクリック = 結合（F-2）
els.grid.addEventListener("dblclick", (e) => {
  if (!state.session || state.audio.playing) return;
  const rect = els.grid.getBoundingClientRect();
  const px = e.clientX - rect.left, t = state.view.xToTime(px);
  const hit = hitTest(px, t);
  if (hit && hit.kind === "divider") {
    replaceNote(hit.note, PL.mergeNote(hit.note, hit.bi));
    state.selected = null; syncSliders();
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
  if (state.drag) updateSnapLabel(e);
  if (e.key === "g" || e.key === "G") state.gKey = true;
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
    const seg = state.selected || PL.segAtTime(state.session.notes, t);
    if (seg) { seg.mute = !seg.mute; commitEdit(true); }
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "g" || e.key === "G") state.gKey = false;
  if (state.drag) updateSnapLabel(e);
});

// --- 補正スライダー / マスターフェーダー ---
function syncSliders() {
  const s = state.selected;
  els.strength.disabled = !s;
  els.strength.value = s ? s.correctStrength : 0;
  els.strengthval.textContent = s ? Number(s.correctStrength).toFixed(2) : "–";
}
els.strength.addEventListener("input", () => {
  if (!state.selected) return;
  state.selected.correctStrength = parseFloat(els.strength.value);
  els.strengthval.textContent = state.selected.correctStrength.toFixed(2);
});
els.strength.addEventListener("change", () => { if (state.selected) commitEdit(true); });
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
  const proj = { version: 1, fileName: state.session.fileName || "vocal",
                 durationSec: state.session.durationSec, editState: buildEditState() };
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
    state.selected = null; syncSliders();
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
    resizeCanvases(); draw();
    const nSeg = j.notes.reduce((a, n) => a + n.segments.length, 0);
    setStatus(`${j.durationSec.toFixed(2)}s / ${j.sampleRate}Hz / ${j.notes.length}ノート ${nSeg}セグメント`);
    els.export.disabled = false;
    els.bfile.disabled = false;   // 伴奏追加を有効化
    els.zoomin.disabled = els.zoomout.disabled = els.projsave.disabled = false;
    initUndo();                   // アンドゥ履歴を初期化
    await renderAndLoad(false);   // 初期プレビューを用意
  } catch (err) {
    setStatus("エラー: " + err.message);
  }
});

function buildEditState() {
  const es = { notes: state.session.notes, masterGainDb: state.master };
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
  const samples = RL.concatFloat32(r.chunks);
  const sr = r.ctx.sampleRate;         // 11.3: 実際の SR を使う
  try { r.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { await r.ctx.close(); } catch (_) {}
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
      body: JSON.stringify({ sessionId: state.session.sessionId,
                             editState: buildEditState(), mode: "preview" }),
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

function playAudio() {
  const a = state.audio;
  if (!a.buffer) return;
  stopAudio();
  const ctx = ensureAudioCtx();
  const t0 = ctx.currentTime + 0.1;   // 100ms ルックアヘッド（12.2）

  // ボーカル
  a.vocalGain = ctx.createGain();
  a.vocalGain.connect(ctx.destination);
  const vsrc = ctx.createBufferSource();
  vsrc.buffer = a.buffer; vsrc.connect(a.vocalGain);

  // 伴奏（あれば）: 単一 AudioContext 上で同じ t0 基準に開始（AC-18）
  let bsrc = null, sched = { vocalStart: t0, vocalOffset: 0, backingStart: t0, backingOffset: 0 };
  if (state.backing && state.backing.buffer) {
    sched = PL.computePlaybackSchedule(t0, state.backing.offsetSec, 0);
    a.backingGain = ctx.createGain();
    a.backingGain.connect(ctx.destination);
    bsrc = ctx.createBufferSource();
    bsrc.buffer = state.backing.buffer; bsrc.connect(a.backingGain);
  }
  applyMixGains();   // ミュート/ソロ/音量をゲインノードへ

  vsrc.onended = () => { if (a.source === vsrc) stopAudio(); };
  vsrc.start(sched.vocalStart, sched.vocalOffset);
  if (bsrc) bsrc.start(Math.max(ctx.currentTime, sched.backingStart),
                       Math.max(0, sched.backingOffset));

  a.source = vsrc; a.backingSrc = bsrc; a.playing = true; a.startAt = t0;
  setTransportPlaying(true);
  startPlayhead();
}

function stopAudio() {
  const a = state.audio;
  for (const s of [a.source, a.backingSrc]) {
    if (s) { try { s.onended = null; s.stop(); } catch (_) {} }
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
  els.strength.disabled = playing || !state.selected;
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
els.stop.addEventListener("click", stopAudio);

// --- 再生ヘッド（両レーンを貫く縦線・12.4） ---
let _playheadRAF = 0;
function startPlayhead() {
  els.playhead.hidden = false;
  if (state.backing) els.bplayhead.hidden = false;
  const tick = () => {
    if (!state.audio.playing) return;
    const t = state.audio.ctx.currentTime - state.audio.startAt;   // 経過秒（seek=0）
    if (t >= 0 && state.view) {
      const x = state.view.timeToX(t);
      els.playhead.style.left = x + "px";
      if (!els.bplayhead.hidden) els.bplayhead.style.left = x + "px";
    }
    _playheadRAF = requestAnimationFrame(tick);
  };
  _playheadRAF = requestAnimationFrame(tick);
}
function stopPlayhead() {
  cancelAnimationFrame(_playheadRAF);
  els.playhead.hidden = true; els.bplayhead.hidden = true;
}

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
