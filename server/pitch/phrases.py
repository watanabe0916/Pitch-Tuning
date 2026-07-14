"""フレーズ自動分割（長尺対応・10.4）。

**振幅が完全に無音に落ちる箇所でのみ**音声をフレーズに分割する。
各フレーズを独立に解析・再合成することで、sp/ap のメモリ肥大と
1操作あたりの待ち時間を抑える。**有声区間の途中では絶対に切らない。**

    無音判定: RMS < -50dB が 150ms 以上継続 → その区間の中央を分割点とする
"""

from __future__ import annotations

import numpy as np


def _frame_rms_db(samples: np.ndarray, sr: int, hop: int, win: int) -> np.ndarray:
    """hop 間隔・win 窓の短時間 RMS を dBFS で返す（累積和で高速化）。"""
    x = np.asarray(samples, dtype=np.float64)
    sq = np.concatenate(([0.0], np.cumsum(x ** 2)))
    n = len(x)
    starts = np.arange(0, n, hop)
    a = np.clip(starts - win // 2, 0, n)
    b = np.clip(starts + win // 2, 0, n)
    counts = np.maximum(b - a, 1)
    rms = np.sqrt((sq[b] - sq[a]) / counts)
    return 20.0 * np.log10(rms + 1e-12)


def detect_phrases(samples: np.ndarray, sr: int, *,
                   thresh_db: float = -50.0,
                   min_silence_sec: float = 0.15) -> list:
    """無音区間の中央でのみ分割したフレーズ範囲 [(start_sample, end_sample), ...] を返す。

    条件を満たす無音がなければ全体を1フレーズとして返す（[(0, N)]）。
    先頭・末尾の無音では分割しない（内部の無音のみ分割点にする）。
    """
    n = len(samples)
    if n == 0:
        return [(0, 0)]
    hop = max(1, int(0.010 * sr))       # 10ms
    win = max(hop, int(0.025 * sr))     # 25ms
    rms_db = _frame_rms_db(samples, sr, hop, win)
    silent = rms_db < thresh_db
    min_frames = max(1, int(round(min_silence_sec / (hop / sr))))

    # 無音の連続区間を列挙し、min_frames 以上続くものの中央を分割点にする。
    splits = []
    i = 0
    F = len(silent)
    while i < F:
        if silent[i]:
            j = i
            while j < F and silent[j]:
                j += 1
            if (j - i) >= min_frames:
                center_frame = (i + j) // 2
                center_sample = int(center_frame * hop)
                # 先頭/末尾に張り付く無音は分割点にしない（内部のみ）
                if 0 < center_sample < n:
                    splits.append(center_sample)
            i = j
        else:
            i += 1

    bounds = [0] + splits + [n]
    phrases = []
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        if hi > lo:
            phrases.append((lo, hi))
    return phrases or [(0, n)]
