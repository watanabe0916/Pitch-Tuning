"""F0 推定と解析結果の保持。

CLAUDE.md 2章 / 5章 に対応。Phase 1 では F0 曲線と有声フラグを推定する。
（WORLD の sp/ap 分析は Phase 2 で追加する。）

F0 推定は WORLD の Harvest + StoneMask を用いる（仕様 7章 / 14章参照）。
Harvest は高精度な F0 推定器で、無声フレームを 0Hz として返すため
有声フラグを直接得られる。Phase 2 の cheaptrick/d4c と同じ WORLD 基盤で
一貫させられる利点もある。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pyworld as pw

from .pitchmath import hz_to_cents


@dataclass
class Analysis:
    """解析結果（読み取り専用・不変）。編集操作はこれを書き換えない。

    sp/ap は Phase 2 の再合成で使う（声質。編集しない）。サイズが大きく
    サーバー常駐前提のため、F0 のみ必要な用途では None のままにできる。
    """

    sample_rate: int
    hop_sec: float          # F0 フレーム間隔（既定 5ms）
    f0_hz: np.ndarray       # shape=(F,), 0 = 無声
    voiced: np.ndarray      # shape=(F,), uint8, 1 = 有声
    times: np.ndarray       # shape=(F,), 各フレームの中心時刻 [sec]
    rms_db: np.ndarray      # shape=(F,), 振幅包絡線 [dBFS]（音量表示用）
    spectral_envelope: np.ndarray = None  # WORLD sp, shape=(F, fft//2+1)。声質
    aperiodicity: np.ndarray = None       # WORLD ap, shape=(F, fft//2+1)
    fft_size: int = 0

    @property
    def f0_cents(self) -> np.ndarray:
        """F0 を cent へ変換した配列（無声フレームは NaN）。"""
        return hz_to_cents(self.f0_hz, unvoiced_value=np.nan)

    @property
    def frame_period_ms(self) -> float:
        return self.hop_sec * 1000.0


def estimate_f0(
    samples: np.ndarray,
    sample_rate: int,
    hop_sec_target: float = 0.005,
    fmin_hz: float = 65.0,     # 約 C2
    fmax_hz: float = 1100.0,   # 約 C#6（歌声の上限に余裕）
) -> Analysis:
    """WORLD Harvest + StoneMask で F0 を推定し Analysis を返す。

    frame_period は hop_sec_target[ms]。Harvest の temporal_positions を
    そのままフレーム時刻として用いる。
    """
    x = np.ascontiguousarray(samples, dtype=np.float64)
    frame_period_ms = hop_sec_target * 1000.0
    hop_sec = hop_sec_target

    f0, t = pw.harvest(
        x, sample_rate,
        f0_floor=fmin_hz, f0_ceil=fmax_hz,
        frame_period=frame_period_ms,
    )
    # StoneMask で F0 を精緻化（Harvest の推定を補正）。
    f0 = pw.stonemask(x, f0, t, sample_rate)

    f0 = np.asarray(f0, dtype=np.float64)
    voiced = f0 > 0.0
    f0[~voiced] = 0.0  # 無声フレームの F0 は必ず 0（3.3 の不変条件）

    rms = _windowed_rms(x, sample_rate, t, win_sec=0.030)
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-8))

    return Analysis(
        sample_rate=int(sample_rate),
        hop_sec=hop_sec,
        f0_hz=f0,
        voiced=voiced.astype(np.uint8),
        times=np.asarray(t, dtype=np.float64),
        rms_db=rms_db,
    )


def analyze(
    samples: np.ndarray,
    sample_rate: int,
    hop_sec_target: float = 0.005,
    fmin_hz: float = 65.0,
    fmax_hz: float = 1100.0,
) -> Analysis:
    """完全な WORLD 解析: F0 + sp(cheaptrick) + ap(d4c)。

    再合成 (Phase 2) はこの sp/ap を保持したまま f0 のみ差し替える（4.1）。
    sp は cheaptrick が推定した f0 に依存するため、必ず**元の f0** で計算する。
    """
    a = estimate_f0(samples, sample_rate, hop_sec_target, fmin_hz, fmax_hz)
    x = np.ascontiguousarray(samples, dtype=np.float64)
    t = a.times

    sp = pw.cheaptrick(x, a.f0_hz, t, sample_rate)   # スペクトル包絡 = 声質
    ap = pw.d4c(x, a.f0_hz, t, sample_rate)           # 非周期性成分
    fft_size = (sp.shape[1] - 1) * 2

    a.spectral_envelope = np.ascontiguousarray(sp, dtype=np.float64)
    a.aperiodicity = np.ascontiguousarray(ap, dtype=np.float64)
    a.fft_size = int(fft_size)
    return a


def _windowed_rms(x: np.ndarray, sr: int, times: np.ndarray,
                  win_sec: float = 0.030) -> np.ndarray:
    """各フレーム時刻を中心とする窓の RMS を求める（累積和で高速化）。"""
    win = max(1, int(round(win_sec * sr)))
    half = win // 2
    # 二乗の累積和。前後に half サンプルのゼロパディングを効かせる。
    sq = np.concatenate(([0.0], np.cumsum(x.astype(np.float64) ** 2)))
    n = len(x)
    centers = np.clip(np.round(times * sr).astype(np.int64), 0, n)
    a = np.clip(centers - half, 0, n)
    b = np.clip(centers + half, 0, n)
    counts = np.maximum(b - a, 1)
    energy = sq[b] - sq[a]
    return np.sqrt(energy / counts)
