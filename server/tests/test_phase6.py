"""Phase 6 受け入れ基準（AC-17）+ 伴奏バックエンドのテスト。

AC-18/19/20 はクライアント側（Web Audio / トランスポート）で、
純粋ロジックは tests/test_pitchlogic.js（computePlaybackSchedule / canEdit）で検証する。

実行: cd server && python -m pytest tests/test_phase6.py -v
"""

from __future__ import annotations

import io
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from app import app  # noqa: E402

SR = 44100
client = TestClient(app)


def _session():
    x = 0.3 * np.sin(2 * np.pi * 180 * np.arange(int(1.5 * SR)) / SR)
    b = io.BytesIO(); sf.write(b, x.astype(np.float32), SR, format="WAV", subtype="FLOAT"); b.seek(0)
    r = client.post("/api/session", files={"audio": ("v.wav", b, "audio/wav")})
    return r.json()["sessionId"], r.json()["notes"]


def _upload_backing(sid, pcm, sr=SR):
    b = io.BytesIO(); sf.write(b, pcm, sr, format="WAV", subtype="FLOAT"); b.seek(0)
    return client.post("/api/backing", data={"sessionId": sid},
                       files={"audio": ("b.wav", b, "audio/wav")})


def test_backing_upload_and_stream():
    sid, _ = _session()
    back = np.zeros((int(2.0 * SR), 2), np.float32); back[SR // 2, :] = 0.9
    r = _upload_backing(sid, back)
    assert r.status_code == 200, r.text
    j = r.json()
    print(f"\nbacking: {j['durationSec']:.2f}s ch={j['channels']} sr={j['sampleRate']}")
    assert j["channels"] == 2 and abs(j["durationSec"] - 2.0) < 0.01
    # 再生用ストリーム
    ra = client.get(f"/api/backing/{sid}/audio")
    assert ra.status_code == 200
    y, sr = sf.read(io.BytesIO(ra.content))
    assert y.shape[1] == 2 and sr == SR


def test_backing_resampled_to_vocal_sr():
    sid, _ = _session()   # vocal SR = 44100
    back = np.zeros((int(1.0 * 48000), 2), np.float32); back[24000, :] = 0.8
    r = _upload_backing(sid, back, sr=48000)
    assert r.status_code == 200
    assert r.json()["sampleRate"] == SR   # 伴奏側がボーカルSRへ変換される（12.1）


# ==========================================================================
# AC-17: target="mix" で伴奏の開始位置が offsetSec と一致（誤差1サンプル以内）
# ==========================================================================

def test_ac17_mix_backing_offset():
    sid, notes = _session()
    # 伴奏: 0.5s にインパルス
    impulse_sec = 0.5
    back = np.zeros((int(2.0 * SR), 2), np.float32)
    back[int(impulse_sec * SR), :] = 0.9
    _upload_backing(sid, back)

    # ボーカルは全ミュート（伴奏を分離して開始位置を測る）
    import copy
    muted = copy.deepcopy(notes)
    for n in muted:
        for s in n["segments"]:
            s["mute"] = True

    for off in (0.0, 0.3, -0.15):
        es = {"notes": muted, "masterGainDb": 0.0,
              "backing": {"offsetSec": off, "gainDb": 0.0, "mute": False}}
        r = client.post("/api/export", json={
            "sessionId": sid, "editState": es, "target": "mix",
            "format": "wav", "bitDepth": 32, "normalize": False})
        assert r.status_code == 200
        y, _ = sf.read(io.BytesIO(r.content))
        peak = int(np.argmax(np.abs(y[:, 0])))
        # 期待: 伴奏インパルス(0.5s) が offset ぶん移動して現れる
        expected = int(round((impulse_sec + off) * SR))
        err = abs(peak - expected)
        print(f"\nAC-17 offset={off:+.2f}s impulse@{peak} expect@{expected} err={err}")
        assert err <= 1


def test_ac17_mix_length():
    sid, notes = _session()   # vocal 1.5s
    back = np.zeros((int(2.0 * SR), 2), np.float32)
    _upload_backing(sid, back)
    es = {"notes": notes, "masterGainDb": 0.0,
          "backing": {"offsetSec": 0.3, "gainDb": 0.0, "mute": False}}
    r = client.post("/api/export", json={
        "sessionId": sid, "editState": es, "target": "mix",
        "format": "wav", "bitDepth": 32, "normalize": False})
    y, _ = sf.read(io.BytesIO(r.content))
    # 長さ = max(ボーカル1.5s, 伴奏2.0s + 0.3s) = 2.3s（13.2）
    print(f"\nmix length = {len(y)/SR:.3f}s (expect ~2.3s)")
    assert abs(len(y) / SR - 2.3) < 0.02
