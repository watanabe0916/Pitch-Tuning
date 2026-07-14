"""音声の読み込みと内部正規化。

CLAUDE.md 10.1 に対応:
- モノラル / float32 / 元のサンプルレートを維持
- リサンプリングしない（WORLD は 44.1k/48k どちらでも動く）
- MP3/M4A は高域欠落のため警告する
"""

from __future__ import annotations

import os
import warnings
from dataclasses import dataclass

import numpy as np
import soundfile as sf


# 非可逆圧縮フォーマット（読み込みは許可するが警告する）
_LOSSY_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".opus"}


@dataclass
class LoadedAudio:
    """内部正規化済みの音声。以降のパイプラインはこの形式のみを扱う。"""

    samples: np.ndarray  # float32, shape=(N,), モノラル
    sample_rate: int

    @property
    def duration_sec(self) -> float:
        return len(self.samples) / self.sample_rate


def load_audio(path: str) -> LoadedAudio:
    """音声ファイルを読み込み、モノラル / float32 / 元サンプルレートへ正規化する。

    ステレオは L+R の平均でミックスダウンする（10.1）。
    """
    ext = os.path.splitext(path)[1].lower()
    if ext in _LOSSY_EXTS:
        warnings.warn(
            f"非可逆圧縮フォーマット ({ext}) は高域が欠落しており、"
            "d4c(非周期性成分)の推定精度が落ちます。可逆フォーマット推奨。",
            stacklevel=2,
        )

    try:
        data, sr = sf.read(path, dtype="float32", always_2d=True)
    except RuntimeError as exc:  # libsndfile が対応しない形式 (mp3/m4a 等)
        raise RuntimeError(
            f"{path} を soundfile で読み込めませんでした。"
            "MP3/M4A の場合は ffmpeg 経由のデコードが必要です。"
        ) from exc

    return _to_mono(data, sr)


def load_audio_fileobj(fileobj, filename: str = "") -> LoadedAudio:
    """アップロードされたファイル様オブジェクトから読み込む（API 用）。

    soundfile はファイル様オブジェクトを直接読める。MP3/M4A は libsndfile が
    対応しないため RuntimeError になる（Phase 3 では可逆形式のみ対応）。
    """
    ext = os.path.splitext(filename)[1].lower()
    if ext in _LOSSY_EXTS:
        warnings.warn(f"非可逆圧縮フォーマット ({ext}) は品質が落ちます。", stacklevel=2)
    data, sr = sf.read(fileobj, dtype="float32", always_2d=True)
    return _to_mono(data, sr)


def _to_mono(data: np.ndarray, sr: int) -> LoadedAudio:
    # data: shape=(N, channels) — モノラルへミックスダウン（10.1）
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    return LoadedAudio(samples=np.ascontiguousarray(mono, dtype=np.float32),
                       sample_rate=int(sr))
