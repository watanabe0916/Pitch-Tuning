"""Phase 2 デモ: 解析 → 編集 → 再合成 → WAV 書き出し。

パラメータはコード直書き（Phase 2 の完了条件どおり）。
分割・ピッチ移動・セグメントゲインを適用し、編集後ボーカルを出力する。

使い方:
    python scripts/phase2_demo.py out/test_vocal.wav
    → out/test_vocal_tuned.wav（編集後）と *_baseline.wav（無編集再合成）
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitch import load_audio, analyze, segment_notes, render_output  # noqa: E402
from pitch.edit import split_segment  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    args = ap.parse_args()
    stem = os.path.splitext(args.audio)[0]

    la = load_audio(args.audio)
    print(f"analyze: {la.duration_sec:.2f}s {la.sample_rate}Hz")
    a = analyze(la.samples, la.sample_rate)
    notes = segment_notes(a)
    print(f"notes={len(notes)} segs={sum(len(n.segments) for n in notes)}")

    # 無編集の再合成（AC-4 相当。プレビュー基準）
    baseline = render_output(a, notes)
    sf.write(f"{stem}_baseline.wav", baseline.astype(np.float32),
             la.sample_rate, subtype="FLOAT")
    print(f"wrote {stem}_baseline.wav")

    # --- 編集（コード直書き） ---
    # 例: 各ノートを 50cent 刻みでスケール補正しつつ、最初のノートを2分割して
    #     後半だけ +200cent、語尾ノートの後半をフェード気味に -6dB。
    edited = [n for n in notes]
    if edited:
        first = edited[0]
        mid = 0.5 * (first.start_sec + first.end_sec)
        first = split_segment(first, 0, mid)
        first.segments[1].pitch_offset_cents = +200.0   # 後半だけ上げる
        first.segments[1].correct_strength = 0.8        # しっかり補正
        edited[0] = first
    if len(edited) >= 1:
        last = edited[-1]
        last.segments[-1].gain_db = -6.0                # 語尾を少し下げる
        last.segments[-1].fade_out_ms = 120.0

    tuned = render_output(a, edited, master_gain_db=0.0)
    sf.write(f"{stem}_tuned.wav", tuned.astype(np.float32),
             la.sample_rate, subtype="FLOAT")
    print(f"wrote {stem}_tuned.wav")


if __name__ == "__main__":
    main()
