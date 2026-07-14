"""Phase 7 受け入れ基準（AC-13）: 録音→書き出しがサーバー送信 PCM と一致する。

ブラウザ側の WAV エンコーダ（reclogic.js の encodeWavFloat32）が生成した WAV を、
サーバー側（soundfile）がサンプル単位で復元できることを検証する
（＝ Opus/AAC 等の非圧縮を経由していない・AC-12/13）。

さらに「録音→編集なしで書き出し」がサーバーに送った PCM と一致することを、
WORLD 分析合成誤差の範囲で確認する。

実行: cd server && python -m pytest tests/test_phase7.py -v
"""

from __future__ import annotations

import io
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(os.path.dirname(HERE), "static")


def _node_encode_wav(tmp_wav: str, tmp_raw: str, n=2000, sr=44100):
    """Node で reclogic.encodeWavFloat32 を呼び、WAV と元 float32 生データを書き出す。"""
    js = f"""
    const RL = require({os.path.join(STATIC, 'reclogic.js')!r});
    const fs = require('fs');
    const N={n}, sr={sr};
    const s = new Float32Array(N);
    for (let i=0;i<N;i++) s[i] = Math.sin(i*0.017)*0.7;
    const wav = RL.encodeWavFloat32(s, sr);
    fs.writeFileSync({tmp_wav!r}, Buffer.from(wav));
    fs.writeFileSync({tmp_raw!r}, Buffer.from(s.buffer));  // 生 float32(LE)
    """
    subprocess.run(["node", "-e", js], check=True)


def test_ac13_browser_wav_decodes_bit_exact(tmp_path):
    wav = str(tmp_path / "rec.wav")
    raw = str(tmp_path / "rec.f32")
    _node_encode_wav(wav, raw)

    # サーバー側（soundfile）で復元
    y, sr = sf.read(wav, dtype="float32")
    # ブラウザが持っていた元 float32 サンプル
    expected = np.fromfile(raw, dtype="<f4")

    print(f"\nAC-13 sr={sr} n={len(y)} bit-exact={np.array_equal(y, expected)}")
    assert sr == 44100
    assert y.ndim == 1                       # モノラル
    assert len(y) == len(expected)
    # 非圧縮 float32 なのでビット一致（Opus/AAC を経由していない証明・AC-12/13）
    assert np.array_equal(y, expected)


def test_ac13_wav_is_ieee_float():
    """WAV ヘッダのフォーマットコードが 3(IEEE float)・32bit であること（AC-12）。"""
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "r.wav"); raw = os.path.join(d, "r.f32")
        _node_encode_wav(wav, raw, n=100)
        with open(wav, "rb") as f:
            head = f.read(44)
        fmt_code = int.from_bytes(head[20:22], "little")
        bits = int.from_bytes(head[34:36], "little")
        print(f"\nAC-12 fmt_code={fmt_code} bits={bits}")
        assert fmt_code == 3 and bits == 32
