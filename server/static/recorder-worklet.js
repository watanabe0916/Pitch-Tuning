/*
 * 録音用 AudioWorkletProcessor（11.2）。
 * MediaRecorder（WebM/Opus 非可逆）ではなく、生の Float32 PCM を取り出す。
 * 各処理ブロックの入力チャンネル 0 を複製してメインスレッドへ送る。
 */
class RecProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      // ブロックはリングバッファ由来で使い回されるため、必ずコピーして送る。
      this.port.postMessage(new Float32Array(ch));
    }
    return true;   // ノードを生かし続ける
  }
}
registerProcessor("rec-processor", RecProcessor);
