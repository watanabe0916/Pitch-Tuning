"""ノート自動分割（解析側）。

CLAUDE.md 5章のアルゴリズムを実装する:
  1. 無声区間 (voiced==0) で必ず分割する
  2. F0 曲線(cent領域)をカットオフ 5-8Hz のローパスで平滑化（ビブラート除去）
  3. 平滑化後の曲線が 80cent 以上変化し 50ms 以上持続したら分割点
  4. 各セグメントの baseCents は時間重み付き中央値
  5. 60ms 未満のセグメントは隣接セグメントへ吸収する

Phase 1 の成果物は Note[] / Segment[]。編集パラメータ(pitchOffsetCents 等)は
既定値で初期化する（2章のデータモデルに対応）。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

import numpy as np
from scipy.signal import butter, filtfilt

from .analysis import Analysis
from .pitchmath import hz_to_cents


@dataclass
class Segment:
    """編集単位。2章 Segment 型に対応。Phase 1 では baseCents までを埋める。"""

    id: str
    start_sec: float
    end_sec: float
    base_cents: float          # 時間重み付き中央値で得た代表音高
    pitch_offset_cents: float = 0.0
    correct_strength: float = 0.0
    transition_in_ms: float = 40.0
    vibrato_scale: float = 1.0
    gain_db: float = 0.0
    mute: bool = False
    gain_transition_ms: float = 20.0
    fade_in_ms: float = 0.0
    fade_out_ms: float = 0.0


@dataclass
class Note:
    """ノート。分割前は segments が要素1つ。"""

    id: str
    segments: list = field(default_factory=list)

    @property
    def start_sec(self) -> float:
        return self.segments[0].start_sec

    @property
    def end_sec(self) -> float:
        return self.segments[-1].end_sec


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def segment_notes(
    analysis: Analysis,
    *,
    lp_cutoff_hz: float = 6.0,
    jump_cents: float = 80.0,
    sustain_sec: float = 0.050,
    min_seg_sec: float = 0.060,
) -> list:
    """Analysis から初期ノート列を生成する。

    有声の連続区間ごとに 1 ノートを作り、その内部を音高変化で
    複数セグメントへ分割する（=1 ノートに複数セグメント）。
    無声区間はノートを跨がない（手順1）。
    """
    voiced = analysis.voiced.astype(bool)
    cents = hz_to_cents(analysis.f0_hz, unvoiced_value=np.nan)
    hop = analysis.hop_sec
    times = analysis.times

    notes: list = []

    for v_start, v_end in _voiced_runs(voiced):
        region = cents[v_start:v_end].copy()
        # 稀に有声フラグと F0=0 が食い違うフレームを補間で埋める。
        region = _fill_nan(region)
        smoothed = _lowpass_cents(region, hop, lp_cutoff_hz)

        # 手順3: 平滑化曲線の音高変化で分割点(ローカルインデックス)を得る。
        bounds = _detect_pitch_changes(
            smoothed, hop, jump_cents=jump_cents, sustain_sec=sustain_sec
        )

        # 手順5: 60ms 未満のセグメントを吸収し、境界リストを確定。
        bounds = _absorb_short(bounds, smoothed, hop, min_seg_sec)

        segments = []
        for lo, hi in zip(bounds[:-1], bounds[1:]):
            g_lo, g_hi = v_start + lo, v_start + hi
            base = _time_weighted_median(cents[g_lo:g_hi])
            start_sec = float(times[g_lo])
            # セグメント終端は次フレーム開始（=hop 1つ分先）まで含める。
            end_sec = float(times[g_hi - 1] + hop)
            segments.append(
                Segment(
                    id=_new_id(),
                    start_sec=start_sec,
                    end_sec=end_sec,
                    base_cents=float(base),
                )
            )

        if segments:
            notes.append(Note(id=_new_id(), segments=segments))

    return notes


# --------------------------------------------------------------------------
# 内部ヘルパ
# --------------------------------------------------------------------------

def _voiced_runs(voiced: np.ndarray):
    """有声フレームの連続区間 [start, end) を列挙する。"""
    if not voiced.any():
        return
    idx = np.flatnonzero(np.diff(voiced.astype(np.int8)))
    edges = np.concatenate(([0], idx + 1, [len(voiced)]))
    for lo, hi in zip(edges[:-1], edges[1:]):
        if voiced[lo]:
            yield int(lo), int(hi)


def _fill_nan(x: np.ndarray) -> np.ndarray:
    """NaN を線形補間で埋める（両端は最近傍で外挿）。"""
    x = x.copy()
    nan = np.isnan(x)
    if not nan.any():
        return x
    if nan.all():
        return np.zeros_like(x)
    good = ~nan
    xi = np.flatnonzero(good)
    x[nan] = np.interp(np.flatnonzero(nan), xi, x[good])
    return x


def _lowpass_cents(cents: np.ndarray, hop_sec: float, cutoff_hz: float) -> np.ndarray:
    """cent 曲線を Butterworth ローパスで平滑化（ビブラート 5-7Hz を除去）。

    フレーム列のサンプルレートは 1/hop_sec（≒200Hz）。区間が短く filtfilt
    が使えない場合は移動平均へフォールバックする。
    """
    fs = 1.0 / hop_sec
    nyq = fs / 2.0
    wn = min(cutoff_hz / nyq, 0.99)
    b, a = butter(2, wn, btype="low")
    padlen = 3 * max(len(a), len(b))
    if len(cents) <= padlen:
        # 短区間: 窓長を区間長に収めた移動平均。
        win = max(1, min(len(cents), int(round(fs / cutoff_hz))))
        kernel = np.ones(win) / win
        return np.convolve(cents, kernel, mode="same")
    return filtfilt(b, a, cents)


def _detect_pitch_changes(
    smoothed: np.ndarray, hop_sec: float, *, jump_cents: float, sustain_sec: float
) -> list:
    """平滑化 cent 曲線から分割境界(インデックス)を貪欲に検出する。

    現在セグメントの代表音高(=これまでの中央値)から jump_cents 以上離れ、
    その状態が sustain_sec 以上継続したら、逸脱の開始点を境界にする。
    戻り値は [0, ..., len] の昇順境界リスト。
    """
    n = len(smoothed)
    if n == 0:
        return [0, 0]
    sustain = max(1, int(round(sustain_sec / hop_sec)))

    bounds = [0]
    seg_start = 0
    i = 1
    while i < n:
        level = np.median(smoothed[seg_start:i])
        if abs(smoothed[i] - level) > jump_cents:
            end = min(n, i + sustain)
            # 逸脱が sustain フレーム継続し、かつ符号(方向)が一致すること。
            dev = smoothed[i:end] - level
            if (end - i) >= sustain and np.all(np.abs(dev) > jump_cents) \
                    and (np.all(dev > 0) or np.all(dev < 0)):
                bounds.append(i)
                seg_start = i
                i = i + 1
                continue
        i += 1
    bounds.append(n)
    return bounds


def _absorb_short(
    bounds: list, smoothed: np.ndarray, hop_sec: float, min_seg_sec: float
) -> list:
    """min_seg_sec 未満のセグメントを、音高が近い隣接セグメントへ吸収する。"""
    min_frames = max(1, int(round(min_seg_sec / hop_sec)))
    changed = True
    while changed and len(bounds) > 2:
        changed = False
        for k in range(len(bounds) - 1):
            lo, hi = bounds[k], bounds[k + 1]
            if hi - lo >= min_frames:
                continue
            # この短セグメントを消す = 境界のどちらか一方を除去する。
            has_prev = k > 0
            has_next = k + 1 < len(bounds) - 1
            if has_prev and has_next:
                # 前後セグメントの代表音高に近い側へ寄せる。
                cur = np.median(smoothed[lo:hi])
                prev = np.median(smoothed[bounds[k - 1]:lo])
                nxt = np.median(smoothed[hi:bounds[k + 2]])
                drop = k if abs(cur - prev) <= abs(cur - nxt) else k + 1
            elif has_prev:
                drop = k
            else:  # has_next のみ（先頭セグメント）
                drop = k + 1
            del bounds[drop]
            changed = True
            break
    return bounds


def _time_weighted_median(cents: np.ndarray) -> float:
    """時間重み付き中央値。フレームは等間隔なので通常の中央値に一致する。

    アタックのしゃくりに引きずられないよう平均ではなく中央値を用いる（手順4）。
    """
    valid = cents[~np.isnan(cents)]
    if len(valid) == 0:
        return 0.0
    return float(np.median(valid))
