/*
 * pitchlogic.js の自動テスト（Phase 3 の縦ドラッグ/スナップ/座標変換）。
 * 実行: node tests/test_pitchlogic.js
 */
const assert = require("assert");
const PL = require("../static/pitchlogic.js");

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ok:", name); pass++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- cent 変換 ---
ok("A4=440Hz → 6900cent", near(PL.hzToCents(440), 6900));
ok("A5=880Hz → 8100cent", near(PL.hzToCents(880), 8100));
ok("6900cent → A4 name", PL.centsToName(6900) === "A4");
ok("6000cent → C4 name", PL.centsToName(6000) === "C4");

// --- スナップ（F-1） ---
ok("既定 50cent スナップ", PL.snapCents(6923, {}) === 6900);
ok("50cent 上寄せ", PL.snapCents(6926, {}) === 6950);
ok("Shift=1cent 微調整", PL.snapCents(6923, { shift: true }) === 6923);
ok("Alt=100cent 粗スナップ", PL.snapCents(6949, { alt: true }) === 6900);
ok("snapStep 既定=50", PL.snapStep({}) === 50);
ok("snapStep Shift=1", PL.snapStep({ shift: true }) === 1);
ok("snapStep Alt=100", PL.snapStep({ alt: true }) === 100);

// --- 縦ドラッグ → オフセット（上方向=音高↑、50cent スナップ） ---
// centsPerPixel=10 とし、上へ 20px ドラッグ = +200cent
ok("上ドラッグで音高↑", PL.computeDragOffset(0, -20, 10, {}) === 200);
ok("下ドラッグで音高↓", PL.computeDragOffset(0, 20, 10, {}) === -200);
ok("ドラッグ結果が50centにスナップ", PL.computeDragOffset(0, -2.3, 10, {}) % 50 === 0);
ok("Shift中は1cent刻み", PL.computeDragOffset(0, -2.3, 10, { shift: true }) === 23);

// --- ヒットテスト ---
const notes = [
  { id: "n0", segments: [
    { startSec: 0.0, endSec: 0.5, baseCents: 6000, pitchOffsetCents: 0 },
    { startSec: 0.5, endSec: 1.0, baseCents: 6000, pitchOffsetCents: 50 } ] },
  { id: "n1", segments: [
    { startSec: 1.2, endSec: 1.8, baseCents: 6700, pitchOffsetCents: 0 } ] },
];
ok("segAtTime 0.25s → seg0", PL.segAtTime(notes, 0.25) === notes[0].segments[0]);
ok("segAtTime 0.7s → seg1", PL.segAtTime(notes, 0.7) === notes[0].segments[1]);
ok("segAtTime 1.1s(無音) → null", PL.segAtTime(notes, 1.1) === null);
ok("offsetAtTime 0.7s → 50", PL.offsetAtTime(notes, 0.7) === 50);
ok("offsetAtTime 無音 → 0", PL.offsetAtTime(notes, 1.1) === 0);

// --- 座標変換の往復 ---
const T = PL.makeTransforms(0, 2, 5700, 7200, 800, 600);
ok("timeToX↔xToTime 往復", near(T.xToTime(T.timeToX(1.3)), 1.3, 1e-9));
ok("centsToY↔yToCents 往復", near(T.yToCents(T.centsToY(6450)), 6450, 1e-6));
ok("上ほど音高が高い(y小)", T.centsToY(7000) < T.centsToY(6000));
ok("centsPerPixel = (7200-5700)/600", near(T.centsPerPixel, 1500 / 600));

// --- pitchRange ---
const r = PL.pitchRange(notes);
ok("pitchRange が全音高を含む", r.lo <= 6000 && r.hi >= 6750);
ok("pitchRange は100cent丸め", r.lo % 100 === 0 && r.hi % 100 === 0);

// --- AC-6: 50cent スナップが有効なとき pitchOffsetCents % 50 == 0 ---
for (let dy = -50; dy <= 50; dy += 1.3) {
  const off = PL.computeDragOffset(0, dy, 7.7, {});   // 既定=50cent スナップ
  if (off % 50 !== 0) { throw new Error("AC-6 違反: offset=" + off); }
}
ok("AC-6: 50centスナップで offset%50==0 が常に成立", true);

// --- 分割 (F-2) ---
const n0 = { id: "n", segments: [
  { id: "a", startSec: 0, endSec: 1.0, baseCents: 6000, pitchOffsetCents: 100 } ] };
const s1 = PL.splitNote(n0, 0, 0.4);
ok("分割で2セグメントになる", s1.segments.length === 2);
ok("分割: 左の終端=分割点", s1.segments[0].endSec === 0.4);
ok("分割: 右の始端=分割点", s1.segments[1].startSec === 0.4);
ok("分割: 元のオフセットを引き継ぐ", s1.segments[1].pitchOffsetCents === 100);
ok("分割: IDが別々", s1.segments[0].id !== s1.segments[1].id);
const s2 = PL.splitNote(s1, 1, 0.7);   // 再帰分割
ok("再帰分割で3セグメント", s2.segments.length === 3);
ok("範囲外の分割時刻は無視", PL.splitNote(n0, 0, 5.0).segments.length === 1);

// --- 結合 (F-2) ---
const m = PL.mergeNote(s2, 1);
ok("結合で2セグメントに戻る", m.segments.length === 2);
ok("結合: 終端が引き継がれる", m.segments[0].endSec === s2.segments[1].endSec);

// --- 分割線の移動 ---
const mv = PL.moveDivider(s1, 1, 0.6, 0.02);
ok("分割線移動: 左終端が動く", Math.abs(mv.segments[0].endSec - 0.6) < 1e-9);
ok("分割線移動: 右始端が同期", Math.abs(mv.segments[1].startSec - 0.6) < 1e-9);
const mvc = PL.moveDivider(s1, 1, 0.999, 0.02);   // 最小長でクランプ
ok("分割線移動: 最小長でクランプ", mvc.segments[1].endSec - mvc.segments[1].startSec >= 0.02 - 1e-9);

// --- ゲイン塗り高さ (6.3) ---
ok("0dB → 塗り比 1.0", near(PL.gainFillFraction(0), 1.0));
ok("-12dB → 塗り比 0.5(半分)", near(PL.gainFillFraction(-12), 0.5));
ok("+12dB → 塗り比 1.5(はみ出す)", near(PL.gainFillFraction(12), 1.5));
ok("塗り比↔gainDb 往復", near(PL.fillFractionToGainDb(PL.gainFillFraction(6)), 6));
ok("gainDb は +12 でクランプ", PL.fillFractionToGainDb(3.0) === 12);

// --- AC-18: 同時再生スケジュール（同一 t0 / offset の反映） ---
const s0 = PL.computePlaybackSchedule(100, 0, 0);
ok("AC-18 offset=0 で両者が同一 t0", s0.vocalStart === 100 && s0.backingStart === 100);
ok("AC-18 offset=0 でバッファ位置も一致", s0.vocalOffset === 0 && s0.backingOffset === 0);
const sp = PL.computePlaybackSchedule(100, 0.3, 0);
ok("正offset=伴奏を遅らせる(開始が+0.3)", Math.abs(sp.backingStart - 100.3) < 1e-9);
ok("正offset: 相対遅れ = offset", Math.abs((sp.backingStart - sp.vocalStart) - 0.3) < 1e-9);
const sn = PL.computePlaybackSchedule(100, -0.2, 0);
ok("負offset: 同時刻開始で伴奏先頭を切り詰め", sn.backingStart === 100 && Math.abs(sn.backingOffset - 0.2) < 1e-9);
const ss = PL.computePlaybackSchedule(100, 0, 1.5);
ok("seek 時も両者同一位置", ss.vocalOffset === 1.5 && ss.backingOffset === 1.5 && ss.backingStart === 100);

// --- AC-19: 再生中は編集不可（canEdit） ---
ok("canEdit: stopped=可", PL.canEdit("stopped") === true);
ok("canEdit: dirty=可", PL.canEdit("dirty") === true);
ok("canEdit: rendering=不可", PL.canEdit("rendering") === false);
ok("canEdit: playing=不可", PL.canEdit("playing") === false);

// --- 範囲選択（マーキー） ---
const rn = [
  { id: "n0", segments: [
    { id: "a", startSec: 0.0, endSec: 0.5, baseCents: 6000, pitchOffsetCents: 0 },
    { id: "b", startSec: 0.5, endSec: 1.0, baseCents: 6700, pitchOffsetCents: 0 } ] },
  { id: "n1", segments: [
    { id: "c", startSec: 1.2, endSec: 1.8, baseCents: 7200, pitchOffsetCents: 0 } ] },
];
ok("矩形が時間と音高で交差するバーを選択",
   PL.segmentsInRect(rn, 0.2, 0.8, 5900, 6100).map(s => s.id).join() === "a");
ok("広い矩形は複数選択",
   PL.segmentsInRect(rn, 0.0, 2.0, 5000, 8000).length === 3);
ok("音高が外れると選択されない",
   PL.segmentsInRect(rn, 0.0, 2.0, 5000, 5500).length === 0);
ok("時間が外れると選択されない",
   PL.segmentsInRect(rn, 2.0, 3.0, 5000, 8000).length === 0);

// --- carveSegment（ペースト用の切り出し） ---
const cnote = { id: "n", segments: [
  { id: "x", startSec: 0, endSec: 2.0, baseCents: 6000, pitchOffsetCents: 0 } ] };
const carved = PL.carveSegment(cnote, 0.5, 1.2);
ok("carve で [a,b] のセグメントが得られる",
   carved && Math.abs(carved.seg.startSec - 0.5) < 1e-6 && Math.abs(carved.seg.endSec - 1.2) < 1e-6);
ok("carve は3セグメントに分割", carved.note.segments.length === 3);
ok("carve 範囲外は null", PL.carveSegment(cnote, 3.0, 4.0) === null);
const carveEdge = PL.carveSegment(cnote, 0, 1.0);   // 先頭境界に接する
ok("先頭に接する carve", carveEdge && Math.abs(carveEdge.seg.startSec) < 1e-6);

// ==========================================================================
// キー判定とハモリガイド
// ==========================================================================
const sg = (st, en, cents) => ({ id: "k" + st + cents, startSec: st, endSec: en,
                                 baseCents: cents, pitchOffsetCents: 0 });

// --- チューニングずれの推定 ---
const inTune = [sg(0, 1, 6000), sg(1, 2, 6400), sg(2, 3, 6700)];
ok("ずれ無しなら offset≈0", Math.abs(PL.estimateTuningOffset(inTune)) < 1e-6);
const flat30 = inTune.map((s) => Object.assign({}, s, { baseCents: s.baseCents - 30 }));
ok("一律 -30cent を検出", near(PL.estimateTuningOffset(flat30), -30, 1e-6));
const sharp45 = inTune.map((s) => Object.assign({}, s, { baseCents: s.baseCents + 45 }));
ok("一律 +45cent を検出", near(PL.estimateTuningOffset(sharp45), 45, 1e-6));
// ばらついているだけの素材に偽の補正を掛けない（ここが無いと判定が壊れる）。
// ±50cent は円環上で同じ位置に回り込むので、散らばり例は角度が広がるよう選ぶ。
const scattered = [sg(0,1,6000-40), sg(1,2,6400+10), sg(2,3,6700+40),
                   sg(3,4,6900-10), sg(4,5,7200+25), sg(5,6,7400-25)];
ok("ばらつきだけなら補正しない", PL.estimateTuningOffset(scattered) === 0);
const nearlyUniform = [sg(0,1,6020), sg(1,2,6425), sg(2,3,6715), sg(3,4,6922)];
ok("ほぼ一律なら補正する", Math.abs(PL.estimateTuningOffset(nearlyUniform) - 20.5) < 1.0);

// --- 音高クラス分布は音価で重み付け ---
const pcp = PL.pitchClassProfile([sg(0, 3, 6000), sg(3, 4, 6400)], 0);
ok("長い音ほど重い", pcp[0] === 3 && pcp[4] === 1);
ok("分布は12要素", pcp.length === 12);

// --- キー判定（C メジャーの旋律）---
const cmaj = [sg(0,1,6000), sg(1,2,6400), sg(2,3,6700), sg(3,4,6900),
              sg(4,5,6700), sg(5,6,6400), sg(6,7.5,6000), sg(7.5,8,7200)];
const k1 = PL.detectKey(cmaj);
ok("C major を判定", k1.tonic === 0 && k1.mode === "major");
ok("キー名の整形", PL.keyName(k1.tonic, k1.mode) === "C major");
ok("候補は3件返る", k1.candidates.length === 3);
ok("確信度は1位と2位の差", near(k1.confidence, k1.candidates[0].r - k1.candidates[1].r, 1e-12));

// ずれがあっても同じ判定になる（今回の検証の要点）
const jitter = [-40, 25, -15, 45, -30, 10, 35, -20];
const cmajOff = cmaj.map((s, i) => Object.assign({}, s, { baseCents: s.baseCents + jitter[i] }));
ok("±45cent のばらつきがあっても C major", (() => {
  const k = PL.detectKey(cmajOff); return k.tonic === 0 && k.mode === "major";
})());
ok("ばらつき時に偽の補正が掛からない", Math.abs(PL.detectKey(cmajOff).offsetCents) < 1e-9);
const cmajDetuned = cmaj.map((s) => Object.assign({}, s, { baseCents: s.baseCents - 35 }));
ok("一律 -35cent ずれても C major", (() => {
  const k = PL.detectKey(cmajDetuned); return k.tonic === 0 && k.mode === "major";
})());
ok("一律ずれは補正値として報告される",
   near(PL.detectKey(cmajDetuned).offsetCents, -35, 1e-6));
// 半音まるごと間違えた音が1つ混ざっても判定は変わらない
const cmajWrong = cmaj.map((s, i) => i === 3
  ? Object.assign({}, s, { baseCents: s.baseCents + 100 }) : s);
ok("半音間違いが1音あっても C major", (() => {
  const k = PL.detectKey(cmajWrong); return k.tonic === 0 && k.mode === "major";
})());
ok("空入力は null", PL.detectKey([]) === null);

// --- 度数計算（キー内の段数で数える）---
ok("C major で C の3度上 = E (+400)", PL.diatonicShift(6000, 0, "major", 2) === 6400);
ok("C major で E の3度上 = G (+300)", PL.diatonicShift(6400, 0, "major", 2) === 6700);
ok("C major で B の3度上 = D (+300)", PL.diatonicShift(7100, 0, "major", 2) === 7400);
ok("C major で C の3度下 = A (-300)", PL.diatonicShift(6000, 0, "major", -2) === 5700);
ok("C major で C の5度上 = G (+700)", PL.diatonicShift(6000, 0, "major", 4) === 6700);
ok("C major で C の6度上 = A (+900)", PL.diatonicShift(6000, 0, "major", 5) === 6900);
ok("A minor で A の3度上 = C (+300)", PL.diatonicShift(6900, 9, "minor", 2) === 7200);
ok("A minor で C の3度上 = E (+400)", PL.diatonicShift(7200, 9, "minor", 2) === 7600);
// B の6度上は B-C-D-E-F-G で G（+800）。単純な平行移動なら G#(+900) になってしまう。
ok("オクターブをまたぐ (B の6度上=G)", PL.diatonicShift(7100, 0, "major", 5) === 7900);
ok("音階外の音は半音のズレを保つ", PL.diatonicShift(6100, 0, "major", 2) === 6500);
ok("微小なずれも維持される", near(PL.diatonicShift(6023, 0, "major", 2), 6423, 1e-9));

// --- ハモリガイド ---
const gsegs = [sg(0, 1, 6000), sg(1, 2, 6400)];
const guides = PL.harmonyGuides(gsegs, { tonic: 0, mode: "major" }, 3, "up");
ok("ガイドは入力と同数", guides.length === 2);
ok("ガイドは時間を引き継ぐ", guides[0].startSec === 0 && guides[0].endSec === 1);
ok("3度上ガイドの音高", guides[0].cents === 6400 && guides[1].cents === 6700);
const gdown = PL.harmonyGuides(gsegs, { tonic: 0, mode: "major" }, 3, "down");
ok("3度下ガイドの音高", gdown[0].cents === 5700 && gdown[1].cents === 6000);
const g5 = PL.harmonyGuides(gsegs, { tonic: 0, mode: "major" }, 5, "up");
ok("5度上ガイドの音高", g5[0].cents === 6700);
ok("キー未確定ならガイド無し", PL.harmonyGuides(gsegs, null, 3, "up").length === 0);
ok("編集後の音程に追従", (() => {
  const moved = [{ id: "m", startSec: 0, endSec: 1, baseCents: 6000, pitchOffsetCents: 200 }];
  return PL.harmonyGuides(moved, { tonic: 0, mode: "major" }, 3, "up")[0].cents === 6500;
})());

console.log(`\n${pass} checks passed`);
