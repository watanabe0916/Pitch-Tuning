"""選択的再合成のテスト。

編集フレーズ内でも、合成音（WORLD）を使うのはピッチ編集した区間＋遷移だけで、
それ以外は原音のまま保たれることを検証する。ブレンド境界にクリックが
出ないこと（AC-1 相当）も確認する。

実行: cd server && python -m pytest tests/test_selective.py -v
"""

from __future__ import annotations

import copy
import io
import os
import sys

import numpy as np
import pyworld as pw
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from app import app, SESSIONS, _render_vocal_signal  # noqa: E402

SR = 44100


def _vowel(dur=2.0, f0=200.0):
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


def _split_and_shift(notes, shift_cents):
    """全ノートを中点で2分割し、後半だけ shift_cents 動かした編集を作る。"""
    edited = copy.deepcopy(notes)
    for n in edited:
        segs = []
        for s in n["segments"]:
            mid = (s["startSec"] + s["endSec"]) / 2
            left = dict(s); left["endSec"] = mid; left["id"] = s["id"] + "L"
            right = dict(s); right["startSec"] = mid; right["id"] = s["id"] + "R"
            right["pitchOffsetCents"] = shift_cents
            segs += [left, right]
        n["segments"] = segs
    return edited


def test_unedited_region_stays_original():
    """分割して後半だけ +200cent。前半（遷移より前）は原音とサンプル一致する。"""
    sid, notes = _session()
    sess = SESSIONS[sid]
    edited = _split_and_shift(notes, +200.0)
    y = _render_vocal_signal(sess, {"notes": edited, "masterGainDb": 0.0})

    ph = sess.phrases[0]
    orig = ph.samples.astype(np.float64)
    seg = edited[0]["segments"][0]
    # 前半のうち、境界の遷移＋ゲート端から十分離れた区間を比較
    a = int((seg["startSec"] + 0.05) * SR)
    b = int((seg["endSec"] - 0.10) * SR)
    d = np.max(np.abs(y[a:b] - orig[a:b]))
    print(f"\nunedited region maxdiff = {d:.2e}")
    assert d < 1e-6            # ボコーダーを通っていない＝原音そのまま

    # 後半は実際にピッチが上がっている（+200cent ≒ ×1.122）
    c = int((seg["endSec"] + 0.15) * SR)
    tail = np.ascontiguousarray(y[c:c + int(0.5 * SR)])
    f0, t = pw.harvest(tail, SR)
    f0m = np.median(f0[f0 > 0])
    cents = 1200 * np.log2(f0m / 200.0)
    print(f"shifted region pitch = +{cents:.0f} cent")
    assert abs(cents - 200) < 20


def test_no_click_at_blend_boundary():
    """原音↔合成音のブレンド境界で隣接サンプル差分が跳ねない（AC-1 相当）。"""
    sid, notes = _session()
    sess = SESSIONS[sid]
    edited = _split_and_shift(notes, +200.0)
    y = _render_vocal_signal(sess, {"notes": edited, "masterGainDb": 0.0})
    orig = sess.phrases[0].samples.astype(np.float64)

    ref = np.max(np.abs(np.diff(orig)))
    out = np.max(np.abs(np.diff(y[:len(orig)])))
    print(f"\nmax|dy| orig={ref:.4f} out={out:.4f} ratio={out / ref:.2f}")
    assert out < ref * 1.5


def test_gain_only_edit_never_uses_vocoder():
    """音量編集のみのフレーズは原音×ゲイン包絡（ボコーダー不使用）。"""
    sid, notes = _session()
    sess = SESSIONS[sid]
    edited = copy.deepcopy(notes)
    for n in edited:
        for s in n["segments"]:
            s["gainDb"] = -6.0
    y = _render_vocal_signal(sess, {"notes": edited, "masterGainDb": 0.0})
    orig = sess.phrases[0].samples.astype(np.float64)

    seg = edited[0]["segments"][0]
    a = int((seg["startSec"] + 0.1) * SR)
    b = int((seg["endSec"] - 0.1) * SR)
    expect = orig[a:b] * (10 ** (-6.0 / 20.0))
    d = np.max(np.abs(y[a:b] - expect))
    print(f"\ngain-only maxdiff vs orig*-6dB = {d:.2e}")
    assert d < 1e-6
