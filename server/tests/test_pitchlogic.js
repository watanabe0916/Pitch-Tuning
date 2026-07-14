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

console.log(`\n${pass} checks passed`);
