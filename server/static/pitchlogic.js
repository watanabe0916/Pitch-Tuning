/*
 * DOM 非依存の純粋ロジック（座標変換・スナップ・ヒットテスト）。
 * ブラウザでは window.PitchLogic、Node ではテスト用に module.exports で公開する。
 * ここを app.js から使うことで、UI とは独立に自動テストできる（6.5 の集約方針）。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.PitchLogic = lib;
})(typeof self !== "undefined" ? self : this, function () {
  const A4_CENTS = 6900;
  const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  const hzToCents = (hz) => hz > 0 ? 1200 * Math.log2(hz / 440) + A4_CENTS : NaN;
  const centsToHz = (c) => 440 * Math.pow(2, (c - A4_CENTS) / 1200);
  const isBlackKey = (midi) => [1,3,6,8,10].includes(((midi % 12) + 12) % 12);
  const centsToName = (c) => {
    const midi = Math.round(c / 100);
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  };

  // 音高スナップ: 既定 50cent、Shift=1cent(微調整)、Alt=100cent(粗)（F-1）。
  function snapStep(mods) { return mods && mods.shift ? 1 : (mods && mods.alt ? 100 : 50); }
  function snapCents(cents, mods) {
    const step = snapStep(mods);
    return Math.round(cents / step) * step;
  }

  // 縦ドラッグ量 → スナップ済み pitchOffsetCents（上方向=音高↑）。
  function computeDragOffset(startOffset, dyPixels, centsPerPixel, mods) {
    const raw = startOffset - dyPixels * centsPerPixel;
    return snapCents(raw, mods);
  }

  // 時刻 t を含むセグメントを返す（notes は時間で重ならない前提）。
  function segAtTime(notes, t) {
    for (const n of notes) for (const s of n.segments)
      if (t >= s.startSec && t < s.endSec) return s;
    return null;
  }
  function offsetAtTime(notes, t) {
    const s = segAtTime(notes, t);
    return s ? s.pitchOffsetCents : 0;
  }

  // 描画範囲(cent)を全セグメントの音高から決める（± マージン、100cent 丸め）。
  function pitchRange(notes, marginCents) {
    let lo = Infinity, hi = -Infinity;
    for (const n of notes) for (const s of n.segments) {
      const c = s.baseCents + s.pitchOffsetCents;
      lo = Math.min(lo, c); hi = Math.max(hi, c);
    }
    if (!isFinite(lo)) { lo = 5700; hi = 7200; }
    const m = marginCents == null ? 300 : marginCents;
    return { lo: Math.floor((lo - m) / 100) * 100, hi: Math.ceil((hi + m) / 100) * 100 };
  }

  // 座標変換（time↔x, cents↔y）を1箇所に集約。
  function makeTransforms(t0, t1, cLo, cHi, width, height) {
    const dt = (t1 - t0) || 1, dc = (cHi - cLo) || 1;
    return {
      width, height, t0, t1, cLo, cHi,
      timeToX: (t) => (t - t0) / dt * width,
      xToTime: (x) => t0 + x / width * dt,
      centsToY: (c) => (1 - (c - cLo) / dc) * height,
      yToCents: (y) => cLo + (1 - y / height) * dc,
      centsPerPixel: dc / height,
      rowHeightPx: 100 / (dc / height),
    };
  }

  return { A4_CENTS, hzToCents, centsToHz, isBlackKey, centsToName,
           snapStep, snapCents, computeDragOffset, segAtTime, offsetAtTime,
           pitchRange, makeTransforms };
});
