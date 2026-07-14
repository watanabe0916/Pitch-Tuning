"""Phase 1 の可視化。matplotlib で F0 曲線とノート分割を描画する。

CLAUDE.md 9章 Phase 1 完了条件（目視でノート境界が妥当）を確認するための図。
"""

from __future__ import annotations

import numpy as np
import matplotlib

matplotlib.use("Agg")  # ヘッドレス環境でも保存できるように
import matplotlib.pyplot as plt

# 日本語ラベルの豆腐化を防ぐ。CJK 対応フォントを優先し、無ければ DejaVu へ。
matplotlib.rcParams["font.family"] = [
    "Hiragino Sans", "Hiragino Maru Gothic Pro", "YuGothic",
    "Noto Sans CJK JP", "DejaVu Sans",
]
matplotlib.rcParams["axes.unicode_minus"] = False

from .analysis import Analysis
from .pitchmath import hz_to_cents, cents_to_hz


def _cents_to_note_name(cents: float) -> str:
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    midi = int(round(cents / 100.0))
    return f"{names[midi % 12]}{midi // 12 - 1}"


def plot_analysis(
    analysis: Analysis,
    notes: list,
    out_path: str,
    ground_truth: list | None = None,
    title: str = "Phase 1: F0 estimation + note segmentation",
):
    """F0 曲線とセグメント境界・代表音高を重ねて保存する。

    ground_truth: [{"start","end","hz"|"cents"}] があれば点線で重畳する。
    """
    times = analysis.times
    cents = hz_to_cents(analysis.f0_hz, unvoiced_value=np.nan)
    voiced = analysis.voiced.astype(bool)

    fig, (ax_p, ax_a) = plt.subplots(
        2, 1, figsize=(14, 8), sharex=True,
        gridspec_kw={"height_ratios": [3, 1]},
    )

    # --- 上段: ピッチ ---
    # 無声区間を薄いグレーで塗る
    _shade_unvoiced(ax_p, times, voiced, analysis.hop_sec)

    ax_p.plot(times, cents, color="0.35", lw=1.0, label="F0 (推定)")

    # ground truth（あれば）
    if ground_truth:
        for i, g in enumerate(ground_truth):
            c = g.get("cents")
            if c is None and "hz" in g:
                c = hz_to_cents(g["hz"])
            ax_p.hlines(c, g["start"], g["end"], color="tab:green",
                        lw=2.5, alpha=0.4,
                        label="ground truth" if i == 0 else None)

    # セグメント: 代表音高 + 境界
    seg_idx = 0
    for note in notes:
        for seg in note.segments:
            ax_p.hlines(seg.base_cents, seg.start_sec, seg.end_sec,
                        color="tab:blue", lw=3,
                        label="segment baseCents" if seg_idx == 0 else None)
            ax_p.axvline(seg.start_sec, color="tab:red", lw=0.8,
                         ls="--", alpha=0.7)
            ax_p.text(seg.start_sec, seg.base_cents + 25,
                      _cents_to_note_name(seg.base_cents),
                      fontsize=8, color="tab:blue")
            seg_idx += 1
        # ノート終端も引く
        ax_p.axvline(note.end_sec, color="tab:red", lw=0.8, ls="--", alpha=0.7)

    ax_p.set_ylabel("pitch [cents] (A4=6900)")
    ax_p.set_title(f"{title}\nnotes={len(notes)}, "
                   f"segments={sum(len(n.segments) for n in notes)}")
    ax_p.legend(loc="upper right", fontsize=9)
    ax_p.grid(True, alpha=0.2)

    # 右軸に音名
    _add_note_axis(ax_p, cents)

    # --- 下段: 振幅包絡線 ---
    ax_a.plot(times, analysis.rms_db, color="0.4", lw=1.0)
    _shade_unvoiced(ax_a, times, voiced, analysis.hop_sec)
    ax_a.set_ylabel("RMS [dBFS]")
    ax_a.set_xlabel("time [sec]")
    ax_a.grid(True, alpha=0.2)

    fig.tight_layout()
    fig.savefig(out_path, dpi=110)
    plt.close(fig)
    return out_path


def _shade_unvoiced(ax, times, voiced, hop_sec):
    """無声フレーム区間を薄グレーで塗る。"""
    for lo, hi in _false_runs(voiced):
        ax.axvspan(times[lo], times[min(hi, len(times) - 1)] + hop_sec,
                   color="0.85", alpha=0.5, lw=0)


def _false_runs(mask: np.ndarray):
    inv = ~mask.astype(bool)
    if not inv.any():
        return
    idx = np.flatnonzero(np.diff(inv.astype(np.int8)))
    edges = np.concatenate(([0], idx + 1, [len(inv)]))
    for lo, hi in zip(edges[:-1], edges[1:]):
        if inv[lo]:
            yield int(lo), int(hi - 1)


def _add_note_axis(ax, cents):
    valid = cents[~np.isnan(cents)]
    if len(valid) == 0:
        return
    lo = int(np.floor(valid.min() / 100)) - 1
    hi = int(np.ceil(valid.max() / 100)) + 1
    ticks = list(range(lo * 100, hi * 100 + 1, 100))
    ax2 = ax.twinx()
    ax2.set_ylim(ax.get_ylim())
    ax2.set_yticks(ticks)
    ax2.set_yticklabels([_cents_to_note_name(c) for c in ticks], fontsize=7)
    ax2.set_ylabel("note")
