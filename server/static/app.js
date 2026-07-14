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
  session: null,        // {sessionId, sampleRate, durationSec, hopSec, f0Hz, notes}
  view: null,           // 座標変換 + 描画範囲
  drag: null,           // 進行中のドラッグ
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
};

const setStatus = (msg) => { els.status.textContent = msg; };

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
  for (const c of [els.grid, els.keys]) {
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function draw() {
  if (!state.session) return;
  const r = els.grid.getBoundingClientRect();
  state.view = makeView(state.session, r.width, r.height);
  drawGrid();
  drawKeys();
}

function drawGrid() {
  const v = state.view, ctx = els.grid.getContext("2d");
  ctx.clearRect(0, 0, v.width, v.height);

  // 半音行の背景（黒鍵行を薄く）
  for (let c = v.cLo; c <= v.cHi; c += 100) {
    const midi = Math.round(c / 100);
    const y = v.centsToY(c + 50);   // 行の中心を音高に合わせる
    const h = v.rowHeightPx;
    ctx.fillStyle = isBlackKey(midi) ? "#191c22" : "#1c2027";
    ctx.fillRect(0, y - h / 2, v.width, h);
    ctx.strokeStyle = "#262b33";
    ctx.beginPath(); ctx.moveTo(0, v.centsToY(c)); ctx.lineTo(v.width, v.centsToY(c)); ctx.stroke();
  }

  // 時間グリッド（0.5s ごと）
  ctx.strokeStyle = "#22262e"; ctx.fillStyle = "#555"; ctx.font = "10px sans-serif";
  for (let t = 0; t <= v.t1; t += 0.5) {
    const x = v.timeToX(t);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.height); ctx.stroke();
    ctx.fillText(t.toFixed(1) + "s", x + 2, v.height - 4);
  }

  drawF0Curve(ctx, v);
  drawNotes(ctx, v);
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

function drawNotes(ctx, v) {
  const h = Math.max(6, v.rowHeightPx * 0.8);
  for (const n of state.session.notes) {
    n.segments.forEach((s, i) => {
      const c = s.baseCents + s.pitchOffsetCents;
      const x0 = v.timeToX(s.startSec), x1 = v.timeToX(s.endSec);
      const y = v.centsToY(c);
      const active = state.drag && state.drag.seg === s;
      ctx.fillStyle = active ? "rgba(90,150,235,0.95)"
        : (i % 2 ? "rgba(70,120,200,0.75)" : "rgba(80,135,215,0.8)");
      ctx.fillRect(x0, y - h / 2, Math.max(1, x1 - x0), h);
      ctx.strokeStyle = "rgba(150,190,240,0.9)";
      ctx.strokeRect(x0 + 0.5, y - h / 2 + 0.5, Math.max(1, x1 - x0) - 1, h - 1);
      // セグメント境界の分割線
      if (i > 0) {
        ctx.strokeStyle = "rgba(230,180,90,0.9)";
        ctx.beginPath(); ctx.moveTo(x0, y - h / 2 - 3); ctx.lineTo(x0, y + h / 2 + 3); ctx.stroke();
      }
    });
  }
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
// ドラッグ操作（縦ドラッグ = pitchOffsetCents）
// ==========================================================================
const mods = (e) => ({ shift: e.shiftKey, alt: e.altKey });
function updateSnapLabel(e) {
  els.snap.textContent = PL.snapStep(mods(e)) + " cent";
}

els.grid.addEventListener("mousedown", (e) => {
  if (!state.session || state.audio.playing) return;   // 再生中は編集ロック(F-7)
  const rect = els.grid.getBoundingClientRect();
  const t = state.view.xToTime(e.clientX - rect.left);
  const seg = PL.segAtTime(state.session.notes, t);
  if (!seg) return;
  state.drag = { seg, startY: e.clientY, startOffset: seg.pitchOffsetCents };
  updateSnapLabel(e);
  draw();
});

window.addEventListener("mousemove", (e) => {
  if (!state.drag) return;
  updateSnapLabel(e);
  const dy = e.clientY - state.drag.startY;
  state.drag.seg.pitchOffsetCents = PL.computeDragOffset(
    state.drag.startOffset, dy, state.view.centsPerPixel, mods(e));
  draw();
});

window.addEventListener("mouseup", () => {
  if (!state.drag) return;
  const changed = state.drag.seg.pitchOffsetCents !== state.drag.startOffset;
  state.drag = null;
  draw();
  // ドラッグ後は再合成して準備するだけ（自動再生しない）。再生は Play で行う。
  // 自動再生すると再生中の編集ロック(F-7)がかかり、続けて他ノートを編集できなくなる。
  if (changed) { state.dirty = true; renderAndLoad(false); }
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
    await renderAndLoad(false);   // 初期プレビューを用意
  } catch (err) {
    setStatus("エラー: " + err.message);
  }
});

function buildEditState() {
  return { notes: state.session.notes, masterGainDb: 0.0 };
}

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
window.addEventListener("keydown", (e) => { if (state.drag) updateSnapLabel(e); });
window.addEventListener("keyup", (e) => { if (state.drag) updateSnapLabel(e); });
