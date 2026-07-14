"""Phase 8 受け入れ基準（AC-9, AC-10）: リバーブと信号チェーンの順序。

AC-9 : +12dB を含む出力がリバーブ後も -1 dBTP を超えない（リミッター機能）。
AC-10: セグメントをミュートするとその区間が -70dB 以下で、
       リバーブ残響もそのセグメントから発生しない（＝ゲインがリバーブ前段にある証明）。

実行: cd server && python -m pytest tests/test_phase8.py -v
"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitch import analyze, segment_notes  # noqa: E402
from pitch.render import render_output, render_master, true_peak_db  # noqa: E402

SR = 44100
REVERB = {"mix": 0.4, "decaySec": 0.8}


def _vowel(dur=1.0, f0=180.0):
    t = np.arange(int(dur * SR)) / SR
    ph = 2 * np.pi * f0 * t
    x = sum(a * np.sin((k + 1) * ph) for k, a in enumerate([1, .5, .33, .2]))
    x *= 0.4 / np.max(np.abs(x))
    a, r = int(0.02 * SR), int(0.03 * SR)
    env = np.ones_like(x); env[:a] = np.linspace(0, 1, a); env[-r:] = np.linspace(1, 0, r)
    return x.astype(np.float32) * env


def _analyze():
    a = analyze(_vowel(), SR)
    return a, segment_notes(a)


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


# ==========================================================================
# AC-9: +12dB を含む出力が（リバーブ後も）-1 dBTP を超えない
# ==========================================================================

def test_ac9_limiter_after_reverb():
    a, notes = _analyze()
    for n in notes:
        for s in n.segments:
            s.gain_db = 12.0
    y = render_master(a, notes, master_gain_db=6.0, reverb=REVERB, normalize=False)
    tp = true_peak_db(y)
    print(f"\nAC-9 (+12dB seg, +6dB master, reverb) true peak = {tp:.3f} dBTP")
    assert tp <= -1.0 + 0.05


# ==========================================================================
# AC-10: ミュートするとその区間 -70dB 以下 & リバーブ残響も引き継がない
# ==========================================================================

def test_ac10_mute_before_reverb_no_tail():
    a, notes = _analyze()
    assert len(notes) >= 1

    # ボーカル(0..~1s)に対しリバーブ ON。尾は 1s 以降に伸びる。
    y_on = render_output(a, notes, reverb=REVERB)
    note_end = notes[-1].segments[-1].end_sec
    tail0 = int(note_end * SR)
    tail = y_on[tail0: tail0 + int(0.5 * SR)]      # ノート終端後の残響区間
    print(f"\nAC-10 unmuted tail RMS = {rms_db(tail):.1f} dB (残響あり)")
    assert rms_db(tail) > -70.0                    # 通常はリバーブ残響が存在する

    # 全セグメントをミュート → リバーブ前段でゼロ入力 → 残響も発生しない
    for n in notes:
        for s in n.segments:
            s.mute = True
    y_mute = render_output(a, notes, reverb=REVERB)
    print(f"AC-10 muted whole RMS = {rms_db(y_mute):.1f} dB, "
          f"muted tail RMS = {rms_db(y_mute[tail0: tail0 + int(0.5 * SR)]):.1f} dB")
    # ミュート区間（＝全体）が -70dB 以下、かつ残響の尾も無い（ゲインがリバーブ前段の証明）
    assert rms_db(y_mute) <= -70.0
    assert rms_db(y_mute[tail0: tail0 + int(0.5 * SR)]) <= -70.0


def test_ac10_gain_before_reverb_distinguishes_order():
    """後段ゲインなら残る尾が、前段ゲイン（本実装）では消えることを対比で確認。"""
    a, notes = _analyze()
    note_end = notes[-1].segments[-1].end_sec
    tail0 = int(note_end * SR)

    # 本実装（前段ゲイン）でミュート → 尾なし
    for n in notes:
        for s in n.segments:
            s.mute = True
    y_pre = render_output(a, notes, reverb=REVERB)
    tail_pre = rms_db(y_pre[tail0: tail0 + int(0.5 * SR)])

    # 参照: もし後段でゲイン（＝先にリバーブ、後でミュート相当のゼロ）だったら
    # ノート区間はゼロでも尾は残るはず。ここでは前段実装の尾が十分小さいことを確認。
    print(f"\nAC-10(order) 前段ゲインの尾 RMS = {tail_pre:.1f} dB（後段なら残るはず）")
    assert tail_pre <= -70.0
