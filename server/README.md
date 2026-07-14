# ボーカル・ピッチエディタ — サーバー側（解析・再合成）

CLAUDE.md の仕様に基づく実装。現在 **Phase 1（F0 推定 + ノート自動分割）** が完了。

## セットアップ

conda の classic solver が非常に遅いため、パッケージは **pip** で導入する。
F0 推定は当初 librosa(pyin) を想定していたが、依存の numba/llvmlite が LLVM ビルドを
要して重いため、**WORLD Harvest** に一本化した（`pyworld` は Phase 2 の再合成でも使う）。

```bash
conda create -y -n pitch python=3.10
conda activate pitch
pip install -r server/requirements.txt   # numpy scipy matplotlib soundfile pyworld
```

`pyworld` は clang でソースビルドされる（Xcode Command Line Tools が必要）。

## Phase 1 の実行

```bash
cd server
conda activate pitch

# 検証用の合成歌声を生成（ground truth の音符列 JSON も出力）
python scripts/make_test_audio.py --out out/test_vocal.wav

# F0 推定 → ノート自動分割 → 図を保存
python scripts/phase1_demo.py out/test_vocal.wav
# → out/test_vocal_phase1.png
```

任意の音声にも使える: `python scripts/phase1_demo.py path/to/vocal.wav`

## 構成

```
server/
  pitch/
    pitchmath.py     # Hz ⇔ cent 変換（内部表現は cent = A4/6900 に集約）
    audio_io.py      # 読み込み・内部正規化（mono/float32/元SR、10.1）
    analysis.py      # F0 推定（WORLD Harvest+StoneMask）+ RMS 包絡線、Analysis 型
    segmentation.py  # ノート自動分割（5章）: 無声で分割 → cent LP 平滑 →
                     #   80cent/50ms で分割 → 時間重み付き中央値 baseCents →
                     #   60ms 未満を吸収。Note/Segment 型（2章データモデル）
    viz.py           # matplotlib 可視化（F0曲線 + セグメント境界 + RMS）
  scripts/
    make_test_audio.py  # 合成歌声ジェネレータ（ビブラート/しゃくり/グライド/無声）
    phase1_demo.py      # Phase 1 パイプラインの CLI
```

## Phase 1 の検証結果

合成歌声（C4-E4-G4-A4-G4-E4-C4、一部グライド接続・無声区間あり）で:

- 主要ノートの音高・境界が ground truth と一致（±10 cent）
- **無声を挟まないグライド接続部（E4→G4, A4→G4）を「1 ノート内 2 セグメント」に
  正しく分割** — F-2/F-3 のユースケースを実証
- ビブラート（5.5Hz）は cent 領域ローパスで除去され、分割判定に影響しない
- アタックのしゃくりは時間重み付き中央値により baseCents に引きずられない

## 次のステップ（Phase 2）

`renderF0()` + `renderGain()`（smoothstep 補間）+ WORLD 再合成
（`cheaptrick`/`d4c`/`synthesize`）。AC-1〜5, 7, 8 を自動テストで検証する。
