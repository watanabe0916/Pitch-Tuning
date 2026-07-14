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

  // 音高スナップ（F-1）: 既定 50cent、Shift=1cent(微調整)、Alt=100cent(粗)。
  const FINE_SNAP_CENTS = 1;

  function snapStep(mods) {
    if (mods && mods.shift) return FINE_SNAP_CENTS;
    if (mods && mods.alt) return 100;
    return 50;
  }
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

  // 時刻 t を含むセグメントのうち、音高が cents に最も近いものを返す。
  // ハモリ(副ボイス)が主ボイスと時間的に重なっても、個別に掴めるようにする。
  function segAtPoint(notes, t, cents) {
    let best = null, bestD = Infinity;
    for (const n of notes) for (const s of n.segments) {
      if (t >= s.startSec && t < s.endSec) {
        const d = Math.abs((s.baseCents + s.pitchOffsetCents) - cents);
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    return best;
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

  // --- 編集操作（分割・結合・ゲイン）: 純粋関数で持ちテスト可能にする ---

  let _idCounter = 0;
  function newId() { return "s" + (Date.now().toString(36)) + (_idCounter++).toString(36); }

  function cloneSeg(s) { return Object.assign({}, s); }

  // セグメント上端ドラッグ用: gainDb → 塗り高さ比率（6.3）。
  // 0dB=1.0(行いっぱい), -12dB=0.5(半分), +12dB=1.5(はみ出す)。
  const GAIN_FILL_MAX_DB = 12, GAIN_FILL_MIN_DB = -24;
  function gainFillFraction(gainDb) {
    return Math.max(0, Math.min(2, 1 + gainDb / 24));
  }
  function fillFractionToGainDb(frac) {
    const db = (Math.max(0, Math.min(2, frac)) - 1) * 24;
    return Math.max(GAIN_FILL_MIN_DB, Math.min(GAIN_FILL_MAX_DB, db));
  }

  // 分割(F-2): note.segments[i] を時刻 t で 2 分割する（非破壊: 新配列を返す）。
  // 分割された 2 セグメントは独立した pitchOffsetCents / gainDb を持てる。
  function splitNote(note, i, tSec) {
    const seg = note.segments[i];
    if (!(tSec > seg.startSec && tSec < seg.endSec)) return note;  // 範囲外は無視
    const left = cloneSeg(seg), right = cloneSeg(seg);
    left.id = newId(); right.id = newId();
    left.endSec = tSec; right.startSec = tSec;
    if (right.transitionInMs == null) right.transitionInMs = 40;
    const segs = note.segments.slice();
    segs.splice(i, 1, left, right);
    return Object.assign({}, note, { segments: segs });
  }

  // 結合(F-2): 分割線(i と i-1 の境界)で 2 セグメントを1つに。
  function mergeNote(note, boundaryIndex) {
    const i = boundaryIndex;             // seg[i-1] と seg[i] を結合
    if (i < 1 || i >= note.segments.length) return note;
    const a = note.segments[i - 1], b = note.segments[i];
    const merged = cloneSeg(a);
    merged.id = newId(); merged.endSec = b.endSec;
    const segs = note.segments.slice();
    segs.splice(i - 1, 2, merged);
    return Object.assign({}, note, { segments: segs });
  }

  // 同時再生のスケジュール（12.2）: 単一 AudioContext 上で両ソースに
  // 同じ基準時刻 t0 を渡す。offsetSec 正 = 伴奏を遅らせる（書き出しと一致）。
  // offset=0 のとき両者は完全に同一 t0 で開始する（AC-18）。
  function computePlaybackSchedule(t0, offsetSec, seekSec) {
    seekSec = seekSec || 0;
    if (offsetSec >= 0) {
      return {
        vocalStart: t0, vocalOffset: seekSec,
        backingStart: t0 + offsetSec, backingOffset: seekSec,
      };
    }
    return {
      vocalStart: t0, vocalOffset: seekSec,
      backingStart: t0, backingOffset: seekSec - offsetSec,  // 先頭を切り詰める
    };
  }

  // 再生中は編集を受け付けない（F-7 / AC-19）。transport が編集可能か。
  function canEdit(transport) {
    return transport === "stopped" || transport === "dirty";
  }

  // 範囲選択（マーキー）: 矩形 [t0,t1]×[cLo,cHi] に重なるセグメントを返す。
  function segmentsInRect(notes, t0, t1, cLo, cHi) {
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    const clo = Math.min(cLo, cHi), chi = Math.max(cLo, cHi);
    const sel = [];
    for (const n of notes) for (const s of n.segments) {
      const c = s.baseCents + s.pitchOffsetCents;
      if (s.startSec < hi && s.endSec > lo && c >= clo && c <= chi) sel.push(s);
    }
    return sel;
  }

  // ペースト用: note を時刻 a, b で分割し、[a,b] を占める1セグメントを切り出す。
  // 戻り値 { note: 新Note, seg: 対象セグメント } または対象外なら null。
  function carveSegment(note, a, b) {
    const segs0 = note.segments;
    a = Math.max(a, segs0[0].startSec);
    b = Math.min(b, segs0[segs0.length - 1].endSec);
    if (!(b > a + 1e-6)) return null;
    let nn = note;
    let idx = nn.segments.findIndex((s) => a > s.startSec + 1e-6 && a < s.endSec - 1e-6);
    if (idx >= 0) nn = splitNote(nn, idx, a);
    idx = nn.segments.findIndex((s) => b > s.startSec + 1e-6 && b < s.endSec - 1e-6);
    if (idx >= 0) nn = splitNote(nn, idx, b);
    const seg = nn.segments.find((s) => s.startSec >= a - 1e-6 && s.endSec <= b + 1e-6);
    return seg ? { note: nn, seg } : null;
  }

  // 分割線の移動: seg[i-1].endSec と seg[i].startSec を同時に t へ（最小長でクランプ）。
  function moveDivider(note, boundaryIndex, tSec, minLenSec) {
    const i = boundaryIndex, segs = note.segments;
    if (i < 1 || i >= segs.length) return note;
    const minL = minLenSec == null ? 0.02 : minLenSec;
    const lo = segs[i - 1].startSec + minL, hi = segs[i].endSec - minL;
    const t = Math.max(lo, Math.min(hi, tSec));
    const ns = segs.slice();
    ns[i - 1] = Object.assign({}, ns[i - 1], { endSec: t });
    ns[i] = Object.assign({}, ns[i], { startSec: t });
    return Object.assign({}, note, { segments: ns });
  }

  return { A4_CENTS, hzToCents, centsToHz, isBlackKey, centsToName,
           snapStep, snapCents, computeDragOffset,
           segAtTime, segAtPoint, offsetAtTime, pitchRange, makeTransforms,
           newId, gainFillFraction, fillFractionToGainDb,
           GAIN_FILL_MAX_DB, GAIN_FILL_MIN_DB, FINE_SNAP_CENTS,
           splitNote, mergeNote, moveDivider,
           computePlaybackSchedule, canEdit,
           segmentsInRect, carveSegment };
});
