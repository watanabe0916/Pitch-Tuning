/*
 * 録音まわりの DOM 非依存な純粋ロジック（テスト可能）。
 * ブラウザでは window.RecLogic、Node ではテスト用に module.exports で公開する。
 * CLAUDE.md 11章に対応。
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  else root.RecLogic = lib;
})(typeof self !== "undefined" ? self : this, function () {

  // getUserMedia の音声制約（11.1）。通話向け前処理はすべて無効化する。
  // これらが有効だとピッチ補正の前段として有害（AGC=音量均し / NS=スペクトル削り /
  // AEC=波形歪み）。
  const AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };

  // 取得したトラックの MediaTrackSettings を検査し、前処理が残っていれば警告を返す（AC-11）。
  function checkAudioConstraints(settings) {
    const warns = [];
    const s = settings || {};
    if (s.autoGainControl === true) warns.push("autoGainControl (AGC) が有効です");
    if (s.noiseSuppression === true) warns.push("noiseSuppression (NS) が有効です");
    if (s.echoCancellation === true) warns.push("echoCancellation (AEC) が有効です");
    return warns;
  }

  // ピークレベル(線形 0..1) → メーター状態（11.4）。目標 -12dBFS、0dBFS でクリップ警告（AC-14）。
  function meterFromPeak(peak) {
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    return {
      db,
      clip: peak >= 1.0,           // 0dBFS 到達（AC-14）→ 赤警告
      hot: db > -6 && peak < 1.0,  // 大きすぎ（黄）
      good: db >= -18 && db <= -6, // 適正付近（-12 目標）
    };
  }

  // 複数の Float32Array チャンクを1本に結合する。
  function concatFloat32(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // モノラル Float32 PCM を 32bit float WAV（非圧縮）へエンコードする（11.2）。
  // MediaRecorder(WebM/Opus 非可逆) を使わず、これで可逆な PCM を送る。
  function encodeWavFloat32(samples, sampleRate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 4);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); ws(8, "WAVE");
    ws(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 3, true);            // 3 = IEEE float
    dv.setUint16(22, 1, true);            // モノラル
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 4, true); // byte rate
    dv.setUint16(32, 4, true);            // block align
    dv.setUint16(34, 32, true);           // bits per sample
    ws(36, "data"); dv.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, samples[i], true);
    return buf;
  }

  return { AUDIO_CONSTRAINTS, checkAudioConstraints, meterFromPeak,
           concatFloat32, encodeWavFloat32 };
});
