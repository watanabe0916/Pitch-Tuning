"""ルックアヘッド・リミッターのテスト。

「マスターを上げても全体スケーリングで打ち消されて音量が変わらない」
という旧実装の問題が再発しないことを検証する。

実行: cd server && python -m pytest tests/test_limiter.py -v
"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitch.render import true_peak_limit, true_peak_db  # noqa: E402

SR = 44100


def _vocal_like(dur=3.0):
    """声に似た信号: 中程度の持続音 + 時々の大きなピーク（子音・アタック相当）。"""
    t = np.arange(int(dur * SR)) / SR
    x = 0.08 * np.sin(2 * np.pi * 220 * t) * (1 + 0.3 * np.sin(2 * np.pi * 3 * t))
    for k in range(1, int(dur * 2)):          # 0.5 秒ごとに 20ms のバースト
        i = int(k * 0.5 * SR)
        b = int(0.02 * SR)
        if i + b < len(x):
            x[i:i + b] += 0.35 * np.sin(2 * np.pi * 800 * t[:b]) * np.hanning(b)
    return x


def _rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-12)


def test_master_boost_actually_increases_loudness():
    """+18dB ブースト後の出力が、ちゃんと大幅に大きくなる（旧実装では +7dB 程度で頭打ち）。"""
    x = _vocal_like()
    y0 = true_peak_limit(x)
    y1 = true_peak_limit(x * 10 ** (18 / 20))
    gain = _rms_db(y1) - _rms_db(y0)
    print(f"\nrms gain with +18dB master: {gain:.1f} dB")
    assert gain > 12.0            # ブーストの大半がラウドネスに反映される
    assert true_peak_db(y1) <= -1.0 + 0.1   # かつ天井は守る（AC-21）


def test_ceiling_always_respected():
    """極端なブーストでも -1 dBTP を超えない。"""
    x = _vocal_like()
    for boost in (6, 12, 24):
        y = true_peak_limit(x * 10 ** (boost / 20))
        tp = true_peak_db(y)
        print(f"boost +{boost}dB -> true peak {tp:.2f} dBTP")
        assert tp <= -1.0 + 0.1


def test_below_ceiling_passthrough():
    """天井より十分小さい信号はそのまま（サンプル一致・AC-16 の前提）。"""
    x = _vocal_like() * 0.5
    y = true_peak_limit(x)
    assert np.array_equal(x, y)


def test_no_clicks_from_gain_envelope():
    """ゲイン包絡が急峻な段差を作らない（隣接サンプル差分が入力の 1.5 倍以内・AC-1 相当）。"""
    x = _vocal_like() * 10 ** (18 / 20)
    y = true_peak_limit(x)
    r = np.max(np.abs(np.diff(y))) / (np.max(np.abs(np.diff(x))) * (np.max(np.abs(y)) / np.max(np.abs(x))))
    print(f"\nnormalized max|dy| ratio: {r:.2f}")
    assert r < 1.5
