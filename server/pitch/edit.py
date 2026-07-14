"""ノート編集の中核操作（F-2）。

重要（P1）: ここで「分割」するのは **F0 曲線への編集パラメータの適用区間**であり、
音声波形ではない。波形は最後まで一本のまま扱う。
"""

from __future__ import annotations

import copy
import uuid

from .segmentation import Note, Segment


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def split_segment(note: Note, seg_index: int, t_sec: float) -> Note:
    """note.segments[seg_index] を時刻 t_sec で 2 つに分割した新しい Note を返す。

    分割後の 2 セグメントはそれぞれ独立した pitchOffsetCents / correctStrength /
    gainDb を持てる（分割前の値をコピーして初期化）。非破壊: 元 note は変更しない。
    分割は再帰的に適用できる。
    """
    note = copy.deepcopy(note)
    seg = note.segments[seg_index]
    if not (seg.start_sec < t_sec < seg.end_sec):
        raise ValueError(
            f"分割時刻 {t_sec} はセグメント [{seg.start_sec}, {seg.end_sec}) の外です。")

    left = copy.deepcopy(seg)
    right = copy.deepcopy(seg)
    left.id, right.id = _new_id(), _new_id()
    left.end_sec = t_sec
    right.start_sec = t_sec
    # right 側は左からの遷移を持つ（境界での接続点）。既定遷移長を付与。
    note.segments[seg_index:seg_index + 1] = [left, right]
    return note


def merge_segments(note: Note, seg_index: int) -> Note:
    """seg_index と seg_index+1 を結合した新しい Note を返す（F-2 の merge）。"""
    note = copy.deepcopy(note)
    a = note.segments[seg_index]
    b = note.segments[seg_index + 1]
    merged = copy.deepcopy(a)
    merged.id = _new_id()
    merged.end_sec = b.end_sec
    note.segments[seg_index:seg_index + 2] = [merged]
    return note
