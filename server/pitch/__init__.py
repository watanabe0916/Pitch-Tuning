"""ボーカル・ピッチエディタ — 解析・再合成パッケージ。

Phase 1 では F0 推定とノート自動分割を提供する。
CLAUDE.md の仕様に対応。
"""

from .pitchmath import hz_to_cents, cents_to_hz, A4_CENTS
from .audio_io import load_audio, LoadedAudio
from .analysis import estimate_f0, Analysis
from .segmentation import segment_notes, Note, Segment

__all__ = [
    "hz_to_cents",
    "cents_to_hz",
    "A4_CENTS",
    "load_audio",
    "LoadedAudio",
    "estimate_f0",
    "Analysis",
    "segment_notes",
    "Note",
    "Segment",
]
