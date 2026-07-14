"""Phase 9: フレーズ自動分割（長尺対応・10.4）のテスト。

- 無音でのみ分割・有声区間は切らない
- フレーズ連結が元の時間軸を保つ（各フレーズが正しい位置に配置）
- あるフレーズだけ編集しても他フレーズのレンダはキャッシュ再利用される（応答性）

実行: cd server && python -m pytest tests/test_phase9.py -v
"""

from __future__ import annotations

import copy
import io
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitch.phrases import detect_phrases  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import app as appmod  # noqa: E402
from app import app, SESSIONS, _render_vocal_signal  # noqa: E402

SR = 44100
client = TestClient(app)


def tone(dur, f0, amp=0.4):
    """倍音付きの母音風トーン（segment_notes が正しく働くよう純音にしない）。"""
    t = np.arange(int(dur * SR)) / SR
    ph = 2 * np.pi * f0 * t
    x = sum(a * np.sin((k + 1) * ph) for k, a in enumerate([1, .5, .33, .2]))
    x *= amp / np.max(np.abs(x))
    a, r = int(0.02 * SR), int(0.02 * SR)
    x[:a] *= np.linspace(0, 1, a); x[-r:] *= np.linspace(1, 0, r)
    return x.astype(np.float32)


# ==========================================================================
# フレーズ検出
# ==========================================================================

def test_detect_phrases_splits_only_at_silence():
    # 2つの音 + 間に 0.3s の無音
    x = np.concatenate([tone(0.5, 200), np.zeros(int(0.3 * SR), np.float32), tone(0.5, 300)])
    ph = detect_phrases(x, SR)
    print(f"\nphrases={ph}")
    assert len(ph) == 2                       # 無音で2フレーズに分割
    split = ph[0][1] / SR
    assert 0.5 < split < 0.8                  # 分割点は無音区間の中

def test_no_split_without_silence():
    x = tone(1.5, 220)                        # 連続音（無音なし）
    ph = detect_phrases(x, SR)
    assert len(ph) == 1                       # 有声区間は切らない

def test_short_silence_does_not_split():
    # 50ms の短い無音では分割しない（150ms 未満）
    x = np.concatenate([tone(0.4, 200), np.zeros(int(0.05 * SR), np.float32), tone(0.4, 200)])
    ph = detect_phrases(x, SR)
    assert len(ph) == 1


# ==========================================================================
# フレーズ連結（時間軸の保存）とキャッシュ
# ==========================================================================

def _make_session():
    x = np.concatenate([tone(0.5, 200), np.zeros(int(0.3 * SR), np.float32), tone(0.5, 300)])
    b = io.BytesIO(); sf.write(b, x, SR, format="WAV", subtype="FLOAT"); b.seek(0)
    r = client.post("/api/session", files={"audio": ("long.wav", b, "audio/wav")})
    return r.json()


def test_session_has_two_phrases_and_global_notes():
    j = _make_session()
    print(f"\nnumPhrases={j['numPhrases']} phraseBounds={j['phraseBounds']} notes={len(j['notes'])}")
    assert j["numPhrases"] == 2
    # ノートが両フレーズに存在（1つ目 ~0-0.5s, 2つ目 ~0.8-1.3s）
    starts = sorted(n["segments"][0]["startSec"] for n in j["notes"])
    assert starts[0] < 0.5 and starts[-1] > 0.7


def test_phrase_placement_preserves_timeline():
    j = _make_session()
    sid, notes = j["sessionId"], j["notes"]
    es = {"notes": notes, "masterGainDb": 0.0}
    sess = SESSIONS[sid]
    y = _render_vocal_signal(sess, es)
    # フレーズ1(~0-0.5s)とフレーズ2(~0.8-1.3s)に音、間(0.55-0.75s)は無音
    def rms(t0, t1):
        return 20 * np.log10(np.sqrt(np.mean(y[int(t0 * SR):int(t1 * SR)] ** 2)) + 1e-12)
    print(f"\nph1={rms(0.1,0.4):.1f}dB gap={rms(0.55,0.72):.1f}dB ph2={rms(0.9,1.2):.1f}dB")
    assert rms(0.1, 0.4) > -30 and rms(0.9, 1.2) > -30      # 両フレーズに音
    assert rms(0.55, 0.72) < -50                            # 間は無音


def test_editing_one_phrase_reuses_other_cache():
    j = _make_session()
    sid, notes = j["sessionId"], j["notes"]
    sess = SESSIONS[sid]
    es = {"notes": notes, "masterGainDb": 0.0}
    _render_vocal_signal(sess, es)                          # 初回: 両フレーズをレンダ
    out0_ph0 = sess.phrases[0].render_out
    out0_ph1 = sess.phrases[1].render_out
    assert out0_ph0 is not None and out0_ph1 is not None

    # フレーズ2 のノートだけ +200cent 編集
    edited = copy.deepcopy(notes)
    # 2つ目のフレーズ（startSec > 0.7）のノートを探して編集
    for n in edited:
        if n["segments"][0]["startSec"] > 0.7:
            for s in n["segments"]:
                s["pitchOffsetCents"] = 200.0
    _render_vocal_signal(sess, {"notes": edited, "masterGainDb": 0.0})

    # フレーズ1 はキャッシュ再利用（同一オブジェクト）、フレーズ2 は再レンダ（別オブジェクト）
    print(f"\nph0 reused={sess.phrases[0].render_out is out0_ph0} "
          f"ph1 rerendered={sess.phrases[1].render_out is not out0_ph1}")
    assert sess.phrases[0].render_out is out0_ph0          # 変更なし → キャッシュ命中
    assert sess.phrases[1].render_out is not out0_ph1      # 変更あり → 再合成
