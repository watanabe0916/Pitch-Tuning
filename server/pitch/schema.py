"""EditState / Note / Segment の JSON シリアライズ（P4 / 10.3）。

クライアントとは音声実体ではなく **パラメータ（JSON）だけ** をやり取りする。
サーバーは Analysis(sp/ap) を常駐させ、この EditState を受けて再合成する。
"""

from __future__ import annotations

import base64

import numpy as np

from .segmentation import Note, Segment


# --- Segment ---------------------------------------------------------------

# キャメルケース(JS 側) ↔ スネークケース(Python) の対応。
_SEG_FIELDS = {
    "id": "id",
    "startSec": "start_sec",
    "endSec": "end_sec",
    "baseCents": "base_cents",
    "pitchOffsetCents": "pitch_offset_cents",
    "correctStrength": "correct_strength",
    "transitionInMs": "transition_in_ms",
    "vibratoScale": "vibrato_scale",
    "gainDb": "gain_db",
    "mute": "mute",
    "gainTransitionMs": "gain_transition_ms",
    "fadeInMs": "fade_in_ms",
    "fadeOutMs": "fade_out_ms",
}


def segment_to_dict(seg: Segment) -> dict:
    return {js: getattr(seg, py) for js, py in _SEG_FIELDS.items()}


def segment_from_dict(d: dict) -> Segment:
    kwargs = {}
    for js, py in _SEG_FIELDS.items():
        if js in d and d[js] is not None:
            kwargs[py] = d[js]
    return Segment(**kwargs)


def note_to_dict(note: Note) -> dict:
    return {"id": note.id, "segments": [segment_to_dict(s) for s in note.segments]}


def note_from_dict(d: dict) -> Note:
    return Note(id=d["id"], segments=[segment_from_dict(s) for s in d["segments"]])


def notes_to_json(notes) -> list:
    return [note_to_dict(n) for n in notes]


def notes_from_json(arr) -> list:
    return [note_from_dict(n) for n in arr]


# --- Float32 配列の base64（描画用データ） ---------------------------------

def f32_to_b64(arr: np.ndarray) -> str:
    """Float32 little-endian を base64 文字列へ（クライアントで Float32Array に復元）。"""
    a = np.ascontiguousarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")
