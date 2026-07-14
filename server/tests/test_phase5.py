"""Phase 5 受け入れ基準の自動テスト（AC-15, AC-16, AC-21）。

書き出し（/api/export）とプレビュー（/api/render）の整合・リミッターを検証する。
FastAPI TestClient でサーバーを起動せず in-process に叩く。

実行: cd server && python -m pytest tests/test_phase5.py -v
"""

from __future__ import annotations

import io
import os
import sys

import numpy as np
import soundfile as sf
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from app import app  # noqa: E402
from pitch.render import true_peak_db  # noqa: E402

SR = 44100
client = TestClient(app)


def synth_vowel(dur=1.2, f0=180.0, sr=SR):
    t = np.arange(int(dur * sr)) / sr
    ph = 2 * np.pi * f0 * t
    x = sum(a * np.sin((k + 1) * ph) for k, a in enumerate([1, .5, .33, .25, .15]))
    x *= 0.35 / np.max(np.abs(x))
    a, r = int(0.02 * sr), int(0.03 * sr)
    env = np.ones_like(x); env[:a] = np.linspace(0, 1, a); env[-r:] = np.linspace(1, 0, r)
    return (x * env).astype(np.float32)


def make_session():
    buf = io.BytesIO()
    sf.write(buf, synth_vowel(), SR, format="WAV", subtype="FLOAT")
    buf.seek(0)
    r = client.post("/api/session", files={"audio": ("test.wav", buf, "audio/wav")})
    assert r.status_code == 200, r.text
    j = r.json()
    return j["sessionId"], j["notes"]


def decode(content: bytes):
    y, sr = sf.read(io.BytesIO(content), dtype="float64")
    return y, sr


# ==========================================================================
# AC-15: /api/export が Content-Disposition を返しファイルとして保存できる
# ==========================================================================

def test_ac15_content_disposition():
    sid, notes = make_session()
    r = client.post("/api/export", json={
        "sessionId": sid, "editState": {"notes": notes, "masterGainDb": 0.0},
        "target": "vocal", "format": "wav", "bitDepth": 24, "normalize": False,
    })
    assert r.status_code == 200
    cd = r.headers.get("content-disposition", "")
    print(f"\nAC-15 Content-Disposition: {cd}")
    assert cd.startswith("attachment;") and 'filename="' in cd and cd.rstrip('"').endswith(".wav")
    assert r.headers.get("content-type") == "audio/wav"


# ==========================================================================
# AC-16: target=vocal 既定の書き出しがプレビューとサンプル単位で一致する
# ==========================================================================

def test_ac16_export_matches_preview():
    sid, notes = make_session()
    es = {"notes": notes, "masterGainDb": 0.0}
    prev = client.post("/api/render", json={"sessionId": sid, "editState": es, "mode": "preview"})
    exp = client.post("/api/export", json={
        "sessionId": sid, "editState": es, "target": "vocal",
        "format": "wav", "bitDepth": 32, "normalize": False,
    })
    assert prev.status_code == 200 and exp.status_code == 200
    yp, _ = decode(prev.content)
    ye, _ = decode(exp.content)
    print(f"\nAC-16 preview={len(yp)} export={len(ye)} "
          f"equal={np.array_equal(yp.astype(np.float32), ye.astype(np.float32))}")
    assert len(yp) == len(ye)
    # プレビュー(32float WAV)と書き出し(vocal/wav/32float)はサンプル単位で一致する
    assert np.array_equal(yp.astype(np.float32), ye.astype(np.float32))


# ==========================================================================
# AC-21: +12dB を含む書き出しが -1 dBTP を超えない（リミッターが機能）
# ==========================================================================

def test_ac21_true_peak_ceiling():
    import copy
    sid, notes = make_session()
    boosted = copy.deepcopy(notes)
    for n in boosted:
        for s in n["segments"]:
            s["gainDb"] = 12.0
    es = {"notes": boosted, "masterGainDb": 6.0}   # さらに +6dB マスター
    r = client.post("/api/export", json={
        "sessionId": sid, "editState": es, "target": "vocal",
        "format": "wav", "bitDepth": 24, "normalize": False,
    })
    assert r.status_code == 200
    y, _ = decode(r.content)
    tp = true_peak_db(y)
    print(f"\nAC-21 true peak = {tp:.3f} dBTP (limit -1.0)")
    assert tp <= -1.0 + 0.05   # 24bit 量子化の微小誤差を許容


def test_ac21b_normalize_reaches_ceiling():
    sid, notes = make_session()
    r = client.post("/api/export", json={
        "sessionId": sid, "editState": {"notes": notes, "masterGainDb": 0.0},
        "target": "vocal", "format": "wav", "bitDepth": 24, "normalize": True,
    })
    y, _ = decode(r.content)
    tp = true_peak_db(y)
    print(f"\nAC-21b normalize true peak = {tp:.3f} dBTP (~ -1.0)")
    assert abs(tp - (-1.0)) < 0.1
