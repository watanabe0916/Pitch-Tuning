"""ハモリ（副ボイス）合成のテスト。

コピー元と同時に鳴る、ピッチシフトした別声部が出力に混ざることを検証する。
音色(sp)は保持されるため、3度下でも同じ声質の低い声になる。

実行: cd server && python -m pytest tests/test_harmony.py -v
"""

from __future__ import annotations

import copy
import io
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from app import app, SESSIONS, _render_vocal_signal  # noqa: E402

SR = 44100


def _vowel(dur=1.2, f0=200.0):
    t = np.arange(int(dur * SR)) / SR
    ph = 2 * np.pi * f0 * t
    x = sum(a * np.sin((k + 1) * ph) for k, a in enumerate([1, .5, .33, .2]))
    x *= 0.4 / np.max(np.abs(x))
    a, r = int(0.02 * SR), int(0.03 * SR)
    x[:a] *= np.linspace(0, 1, a); x[-r:] *= np.linspace(1, 0, r)
    return x.astype(np.float32)


client = TestClient(app)


def _session(f0=200.0):
    b = io.BytesIO(); sf.write(b, _vowel(f0=f0), SR, format="WAV", subtype="FLOAT"); b.seek(0)
    j = client.post("/api/session", files={"audio": ("v.wav", b, "audio/wav")}).json()
    return j["sessionId"], j["notes"]


def _energy_at(y, freq, bw=8.0):
    n = len(y) - (len(y) % 2)
    seg = y[:n] * np.hanning(n)
    mag = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    band = (freqs >= freq - bw) & (freqs <= freq + bw)
    return float(np.max(mag[band])) if band.any() else 0.0


def test_harmony_adds_lower_voice():
    sid, notes = _session(f0=200.0)
    sess = SESSIONS[sid]

    # ハモリ = ノートの複製を -400cent（長3度下あたり）シフト
    harm = copy.deepcopy(notes)
    for n in harm:
        for s in n["segments"]:
            s["pitchOffsetCents"] = -400.0
    es = {"notes": notes, "masterGainDb": 0.0, "harmonies": [{"notes": harm}]}
    es_dry = {"notes": notes, "masterGainDb": 0.0}

    y_dry = _render_vocal_signal(sess, es_dry)
    y_harm = _render_vocal_signal(sess, es)

    f_low = 200.0 * 2 ** (-400 / 1200)   # ≒158.7Hz
    e_dry_low = _energy_at(y_dry, f_low)
    e_harm_low = _energy_at(y_harm, f_low)
    e_harm_main = _energy_at(y_harm, 200.0)
    print(f"\nlow({f_low:.0f}Hz): dry={e_dry_low:.2f} harm={e_harm_low:.2f} | main(200Hz) harm={e_harm_main:.2f}")

    # ハモリ有りで低音側にエネルギーが大幅に増える & 主音も残る
    assert e_harm_low > e_dry_low * 5
    assert e_harm_main > 0
    # 出力長は主ボーカルと同程度（同時発音＝時間は伸びない）
    assert abs(len(y_harm) - len(y_dry)) < int(0.05 * SR)


def test_harmony_gated_silent_outside_region():
    """部分ハモリ: 前半だけにハモリを置くと、後半には低音が増えない（ゲート）。"""
    sid, notes = _session(f0=200.0)
    sess = SESSIONS[sid]
    # ノート全体の前半だけをハモリ区間にする
    harm = copy.deepcopy(notes)
    for n in harm:
        segs = []
        for s in n["segments"]:
            mid = (s["startSec"] + s["endSec"]) / 2
            s = dict(s); s["endSec"] = mid; s["pitchOffsetCents"] = -400.0
            segs.append(s)
        n["segments"] = segs
    es = {"notes": notes, "masterGainDb": 0.0, "harmonies": [{"notes": harm}]}
    y = _render_vocal_signal(sess, es)
    f_low = 200.0 * 2 ** (-400 / 1200)
    # 前半(0.3s)には低音、後半(0.9s)には低音が少ない
    def elow(t):
        i = int(t * SR); n = 8192
        seg = y[i:i + n] * np.hanning(n)
        mag = np.abs(np.fft.rfft(seg)); fr = np.fft.rfftfreq(n, 1 / SR)
        band = (fr >= f_low - 12) & (fr <= f_low + 12)
        return float(np.max(mag[band]))
    print(f"\ngated: front={elow(0.25):.2f} back={elow(0.9):.2f}")
    assert elow(0.25) > elow(0.9) * 3
