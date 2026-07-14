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
  mouse: { clientX: 0, clientY: 0 },
  gKey: false,          // G キー押下中（音量ツール）
  audio: { ctx: null, buffer: null, source: null, playing: false },
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
};

const setStatus = (msg) => { els.status.textContent = msg; };

// 横方向のズーム率。内容幅 = 秒数 × PX_PER_SEC（最低でもビューポート幅を満たす）。
// これにより長い音声は横スクロールになり、鍵盤列は固定のまま常に見える。
const PX_PER_SEC = 260;
const MAX_CANVAS_PX = 30000;   // canvas 幅の上限（描画バッファの安全域）

const gridwrap = () => els.grid.parentElement;
const keyswrap = () => els.keys.parentElement;

// レイアウト寸法（CSS px）: 内容幅と表示高さ。
function layout() {
  const gw = gridwrap();
  const viewH = gw.clientHeight;
  const dur = state.session ? Math.max(state.session.durationSec, 0.5) : 1;
  let contentW = Math.max(gw.clientWidth, dur * PX_PER_SEC);
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
  state.dirty = true;
  draw();
  renderAndLoad(false);   // 再合成して準備（自動再生はしない）
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

// キーボード: S=分割 / M=ミュート / G=音量ツール（押下中）
window.addEventListener("keydown", (e) => {
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
    await renderAndLoad(false);   // 初期プレビューを用意
  } catch (err) {
    setStatus("エラー: " + err.message);
  }
});

function buildEditState() {
  return { notes: state.session.notes, masterGainDb: state.master };
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
        target: "vocal",              // 伴奏ミックスは Phase 6
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
// 再生（Web Audio）
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
  const src = ctx.createBufferSource();
  src.buffer = a.buffer; src.connect(ctx.destination);
  src.onended = () => { a.playing = false; els.grid.classList.remove("locked"); els.stop.disabled = true; };
  src.start();
  a.source = src; a.playing = true;
  els.grid.classList.add("locked"); els.stop.disabled = false;
}
function stopAudio() {
  const a = state.audio;
  if (a.source) { try { a.source.onended = null; a.source.stop(); } catch (_) {} a.source = null; }
  a.playing = false; els.grid.classList.remove("locked"); els.stop.disabled = true;
}
els.play.addEventListener("click", () => {
  ensureAudioCtx().resume();
  if (state.dirty) renderAndLoad(true); else playAudio();
});
els.stop.addEventListener("click", stopAudio);

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
