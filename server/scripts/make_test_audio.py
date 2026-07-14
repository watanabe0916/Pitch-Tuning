"""Phase 1 検証用の合成歌声を生成する。

既知の音符列（ground truth）に、ビブラート・アタックのしゃくり・
音符間のグライド・無声(息)区間を付与する。これによりノート自動分割の
境界が正しいかを目視で照合できる（Phase 1 完了条件）。

出力: <out> WAV(mono float32) と、同名 .json に ground-truth の音符列。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pitch.pitchmath import cents_to_hz  # noqa: E402


def note_to_hz(name: str) -> float:
    """"C4" のような音名を Hz へ（A4=440）。"""
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
             "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    pitch = name[:-1]
    octave = int(name[-1])
    midi = 12 * (octave + 1) + names[pitch]
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def synth_note(f0_hz: float, dur: float, sr: int,
               vibrato_hz: float = 5.5, vibrato_cents: float = 30.0,
               attack_scoop_cents: float = 120.0, scoop_sec: float = 0.06,
               glide_from_hz: float | None = None, glide_sec: float = 0.04):
    """1 音符ぶんの倍音付き波形と、その瞬時 F0 曲線を返す。"""
    n = int(dur * sr)
    t = np.arange(n) / sr

    # 目標 cent（ビブラート付き）
    base_cents = 1200 * np.log2(f0_hz / 440.0) + 6900
    vib = vibrato_cents * np.sin(2 * np.pi * vibrato_hz * t)
    # ビブラートは立ち上がってから効かせる。
    vib *= np.clip(t / 0.15, 0, 1)
    cents = base_cents + vib

    # アタックのしゃくり（下から目標へ）。分割が引きずられないことの確認用。
    scoop_env = np.clip(1 - t / scoop_sec, 0, 1)
    cents = cents - attack_scoop_cents * scoop_env

    # 直前音符からのグライド（ポルタメント）。
    if glide_from_hz is not None:
        from_cents = 1200 * np.log2(glide_from_hz / 440.0) + 6900
        g = np.clip(1 - t / glide_sec, 0, 1)
        cents = cents * (1 - g) + from_cents * g

    f0 = 440.0 * 2.0 ** ((cents - 6900) / 1200.0)

    # 位相を積分して倍音合成（母音風のスペクトル）。
    phase = 2 * np.pi * np.cumsum(f0) / sr
    harmonics = [1.0, 0.5, 0.33, 0.22, 0.15, 0.1]
    wave = sum(a * np.sin((k + 1) * phase) for k, a in enumerate(harmonics))

    # 音符エンベロープ（軽いアタック/リリース）。
    env = np.ones(n)
    a = int(0.01 * sr)
    r = int(0.03 * sr)
    env[:a] = np.linspace(0, 1, a)
    env[-r:] = np.linspace(1, 0, r)
    wave *= env

    return wave.astype(np.float32), f0.astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="test_vocal.wav")
    ap.add_argument("--sr", type=int, default=44100)
    args = ap.parse_args()

    sr = args.sr
    # (音名, 長さ秒, 直後の無声=息 秒, 前音からグライドするか)
    melody = [
        ("C4", 0.55, 0.20, False),
        ("E4", 0.50, 0.00, True),   # グライドで繋ぐ（無声を挟まない → 1ノート内2セグメント）
        ("G4", 0.60, 0.25, False),
        ("A4", 0.45, 0.00, True),
        ("G4", 0.70, 0.30, False),
        ("E4", 0.80, 0.20, False),
        ("C4", 0.90, 0.00, False),
    ]

    pieces = []
    f0_pieces = []
    ground_truth = []
    t_cursor = 0.0
    prev_hz = None
    for name, dur, gap, glide in melody:
        f0 = note_to_hz(name)
        wave, f0curve = synth_note(
            f0, dur, sr,
            glide_from_hz=prev_hz if glide else None,
        )
        pieces.append(wave)
        f0_pieces.append(f0curve)
        ground_truth.append({"note": name, "start": round(t_cursor, 4),
                             "end": round(t_cursor + dur, 4), "hz": round(f0, 2)})
        t_cursor += dur
        prev_hz = f0

        if gap > 0:
            silence = np.zeros(int(gap * sr), dtype=np.float32)
            pieces.append(silence)
            f0_pieces.append(np.zeros_like(silence))
            t_cursor += gap
            prev_hz = None  # 無声を挟んだらグライド元をリセット

    audio = np.concatenate(pieces)
    # 軽くノイズを足してリアルにする。
    audio += 0.002 * np.random.randn(len(audio)).astype(np.float32)
    audio *= 0.5 / np.max(np.abs(audio))  # -6dB 程度に正規化

    sf.write(args.out, audio, sr, subtype="FLOAT")
    with open(os.path.splitext(args.out)[0] + ".json", "w") as f:
        json.dump({"sample_rate": sr, "notes": ground_truth}, f,
                  indent=2, ensure_ascii=False)

    print(f"wrote {args.out} ({len(audio)/sr:.2f}s, {sr}Hz)")
    print(f"wrote {os.path.splitext(args.out)[0]}.json ({len(ground_truth)} notes)")


if __name__ == "__main__":
    main()
