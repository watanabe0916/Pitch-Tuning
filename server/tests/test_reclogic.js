/*
 * reclogic.js の自動テスト（Phase 7 の録音まわり純粋ロジック）。
 * AC-11(前処理検査) / AC-12(非圧縮float32) / AC-14(クリップ警告) を検証。
 * 実行: node tests/test_reclogic.js
 */
const assert = require("assert");
const RL = require("../static/reclogic.js");

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ok:", name); pass++; };
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// WAV を読み戻すヘルパ
function parseWav(buf) {
  const dv = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  const fmt = dv.getUint16(20, true), ch = dv.getUint16(22, true);
  const sr = dv.getUint32(24, true), bits = dv.getUint16(34, true);
  const dataSize = dv.getUint32(40, true), n = dataSize / 4;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = dv.getFloat32(44 + i * 4, true);
  return { riff: str(0, 4), wave: str(8, 4), fmt, ch, sr, bits, samples: s };
}

// --- AC-11: 前処理制約の検査 ---
ok("既定制約はすべて前処理OFF",
   RL.AUDIO_CONSTRAINTS.echoCancellation === false &&
   RL.AUDIO_CONSTRAINTS.noiseSuppression === false &&
   RL.AUDIO_CONSTRAINTS.autoGainControl === false &&
   RL.AUDIO_CONSTRAINTS.channelCount === 1);
ok("全OFFなら警告なし",
   RL.checkAudioConstraints({ autoGainControl: false, noiseSuppression: false, echoCancellation: false }).length === 0);
ok("AGC ON を検出", RL.checkAudioConstraints({ autoGainControl: true }).length === 1);
ok("3つとも ON を検出",
   RL.checkAudioConstraints({ autoGainControl: true, noiseSuppression: true, echoCancellation: true }).length === 3);

// --- AC-12: 非圧縮 float32 WAV エンコード（可逆） ---
const N = 1000, sr = 48000;
const samples = new Float32Array(N);
for (let i = 0; i < N; i++) samples[i] = Math.sin(i * 0.03) * 0.5;
const wav = RL.encodeWavFloat32(samples, sr);
const p = parseWav(wav);
ok("RIFF/WAVE ヘッダ", p.riff === "RIFF" && p.wave === "WAVE");
ok("フォーマット=3 (IEEE float)", p.fmt === 3);
ok("32bit", p.bits === 32);
ok("モノラル", p.ch === 1);
ok("サンプルレートを保持", p.sr === sr);
let exact = p.samples.length === N;
for (let i = 0; i < N; i++) if (p.samples[i] !== samples[i]) exact = false;
ok("サンプルがビット一致（可逆・非圧縮）", exact);

// --- concat ---
const c = RL.concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])]);
ok("concatFloat32", c.length === 5 && c[0] === 1 && c[4] === 5);

// --- AC-14: メーター（クリップ検出） ---
ok("peak=1.0 → クリップ", RL.meterFromPeak(1.0).clip === true);
ok("peak=1.2 → クリップ", RL.meterFromPeak(1.2).clip === true);
ok("peak=0.5 → クリップなし", RL.meterFromPeak(0.5).clip === false);
ok("peak=0.25 ≒ -12dBFS", near(RL.meterFromPeak(0.25).db, -12.04, 0.1));
ok("-12dBFS 付近は適正(good)", RL.meterFromPeak(0.25).good === true);
ok("peak=0 → -∞ / クリップなし", RL.meterFromPeak(0).db === -Infinity && RL.meterFromPeak(0).clip === false);

console.log(`\n${pass} checks passed`);
