"""ピッチ変換ユーティリティ。

内部表現はすべて cent（A4 = 6900 cent = MIDI 69 × 100）で保持する。
CLAUDE.md F-1 / 3.3 に対応。ここに変換を集約し、他モジュールで直接 log2 を書かない。
"""

from __future__ import annotations

import numpy as np

# A4 (440 Hz) を基準とする cent 値。MIDI ノート 69 × 100 に一致する。
A4_HZ = 440.0
A4_CENTS = 6900.0


def hz_to_cents(f0_hz, unvoiced_value: float = np.nan):
    """周波数 [Hz] を cent へ変換する。

    f0_hz <= 0（無声フレーム）は ``unvoiced_value`` に置き換える。
    スカラー・配列どちらも受け付ける。
    """
    f0 = np.asarray(f0_hz, dtype=np.float64)
    scalar = f0.ndim == 0
    f0 = np.atleast_1d(f0)

    cents = np.full(f0.shape, unvoiced_value, dtype=np.float64)
    voiced = f0 > 0
    cents[voiced] = 1200.0 * np.log2(f0[voiced] / A4_HZ) + A4_CENTS

    return float(cents[0]) if scalar else cents


def cents_to_hz(cents):
    """cent を周波数 [Hz] へ変換する。NaN はそのまま NaN を返す。"""
    c = np.asarray(cents, dtype=np.float64)
    scalar = c.ndim == 0
    c = np.atleast_1d(c)

    hz = A4_HZ * np.power(2.0, (c - A4_CENTS) / 1200.0)
    hz[np.isnan(c)] = np.nan

    return float(hz[0]) if scalar else hz
