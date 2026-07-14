"""Phase 1 デモ: 音声を読み込み → F0 推定 → ノート自動分割 → 図を保存。

使い方:
    python scripts/phase1_demo.py <audio.wav> [--out plot.png]

ground truth JSON（make_test_audio.py 生成の <audio>.json）があれば重畳する。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitch import load_audio, estimate_f0, segment_notes  # noqa: E402
from pitch.viz import plot_analysis  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out = args.out or os.path.splitext(args.audio)[0] + "_phase1.png"

    print(f"[1/3] loading {args.audio}")
    la = load_audio(args.audio)
    print(f"      {la.duration_sec:.2f}s, {la.sample_rate}Hz, mono")

    print("[2/3] estimating F0 (pyin) ...")
    analysis = estimate_f0(la.samples, la.sample_rate)
    n_voiced = int(analysis.voiced.sum())
    print(f"      {len(analysis.f0_hz)} frames @ {analysis.hop_sec*1000:.2f}ms hop, "
          f"{n_voiced} voiced")

    print("[3/3] segmenting notes ...")
    notes = segment_notes(analysis)
    n_seg = sum(len(n.segments) for n in notes)
    print(f"      {len(notes)} notes, {n_seg} segments")
    for i, note in enumerate(notes):
        segs = ", ".join(
            f"{s.start_sec:.2f}-{s.end_sec:.2f}s@{s.base_cents:.0f}c"
            for s in note.segments
        )
        print(f"        note {i}: {segs}")

    gt_path = os.path.splitext(args.audio)[0] + ".json"
    ground_truth = None
    if os.path.exists(gt_path):
        with open(gt_path) as f:
            ground_truth = json.load(f).get("notes")

    plot_analysis(analysis, notes, out, ground_truth=ground_truth)
    print(f"saved figure: {out}")


if __name__ == "__main__":
    main()
