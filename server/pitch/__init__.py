"""ボーカル・ピッチエディタ — 解析・再合成パッケージ。

Phase 1 では F0 推定とノート自動分割を提供する。
CLAUDE.md の仕様に対応。
"""

from .pitchmath import hz_to_cents, cents_to_hz, A4_CENTS
from .audio_io import load_audio, LoadedAudio
from .analysis import estimate_f0, analyze, Analysis
from .segmentation import segment_notes, Note, Segment
from .render import (render_f0, render_gain, synthesize, render_output,
                     render_master, true_peak_db, true_peak_limit)

__all__ = [
    "hz_to_cents",
    "cents_to_hz",
    "A4_CENTS",
    "load_audio",
    "LoadedAudio",
    "estimate_f0",
    "analyze",
    "Analysis",
    "segment_notes",
    "Note",
    "Segment",
    "render_f0",
    "render_gain",
    "synthesize",
    "render_output",
    "render_master",
    "true_peak_db",
    "true_peak_limit",
]
