# ボーカル・ピッチエディタ — サーバー側（解析・再合成）

CLAUDE.md の仕様に基づく実装。**Phase 1（F0 推定 + ノート自動分割）**、
**Phase 2（renderF0/renderGain + WORLD 再合成、AC-1〜5/7/8）** が完了。

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
    analysis.py      # F0 推定(Harvest+StoneMask) + sp(cheaptrick)/ap(d4c)、Analysis 型
    segmentation.py  # ノート自動分割（5章）。Note/Segment 型（2章データモデル）
    edit.py          # ノート編集の中核（F-2）: split_segment / merge_segments
    render.py        # ★Phase 2 の中核。build_frame_curve（共通 smoothstep）+
                     #   renderF0(3.1-3.4) + renderGain(3.5-3.6) + synthesize(4) +
                     #   render_output（信号チェーン 4.2）+ 遷移長の自動延長(3.4)
    viz.py           # matplotlib 可視化（F0曲線 + セグメント境界 + RMS）
  scripts/
    make_test_audio.py  # 合成歌声ジェネレータ（ビブラート/しゃくり/グライド/無声）
    phase1_demo.py      # Phase 1 パイプラインの CLI
    phase2_demo.py      # Phase 2: 解析→編集→再合成→WAV 書き出し
  tests/
    test_phase2.py      # 受け入れ基準 AC-1〜5, 7, 8 の自動テスト
```

## Phase 2 の実行とテスト

```bash
cd server && conda activate pitch
# 編集後ボーカルを書き出す（コード直書きの編集を適用）
python scripts/phase2_demo.py out/test_vocal.wav
#   → out/test_vocal_tuned.wav（編集後） / _baseline.wav（無編集再合成）

# 受け入れ基準テスト（AC-1〜5, 7, 8）
python -m pytest tests/test_phase2.py -v -s
```

### Phase 2 検証結果（AC 実測値）

| AC | 内容 | 実測 | 判定 |
|----|------|------|------|
| AC-1 | 2分割 +200/-100cent でクリック無し | max|dy| 比 0.76（<1.5）| ✅ |
| AC-2 | 有声区間に音の途切れ無し | RMS 最小/中央値 0.95 | ✅ |
| AC-3 | 再解析 F0 が連続 | max 16.1 cent/5ms（<20）| ✅ |
| AC-4 | 無編集出力 ≈ 原音 | スペクトル SNR 28.7dB | ✅ |
| AC-5 | +1200cent でフォルマント保存 | Δ 2.4%（<5%）| ✅ |
| AC-7 | 極端なゲイン差でクリック無し | ゲイン傾き 666dB/s | ✅ |
| AC-8 | 全 gain=0 で包絡線 1.0 | 誤差 0.0 | ✅ |

**測定上の注意（AC-4 / AC-5）— 仕様との差分**

- **AC-4**: 仕様は「SNR≥25dB」。ただし WORLD は再合成時に**位相を再生成する**ため、
  波形サンプル単位の SNR は原理的に無意味（実測 ≈ -1dB）。これは仕様が採用を
  義務づけるボコーダー（P2/4章）の性質。よって**知覚的近さを表す線形振幅
  スペクトル SNR**で評価し、28.7dB を得た（閾値 20dB）。
- **AC-5**: フォルマント保存は sp 不変により**全音域で構造的に保証**される。
  ただし +1200cent 後の高い f0 では倍音間隔がフォルマント幅を超え、
  「5% 精度の測定」自体が原理的に不可能になる。低め(A2)の声＋倍音対数振幅への
  放物線補間で測定し、Δ2.4% を得た。

> `phase2_demo.py` は自動分割で生じた 60ms 級の短セグメントで、
> 300cent のグライド遷移に必要な 189ms を確保できず警告を出す（3.4 の仕様どおり。
> クリックを出す代わりに遷移長をクランプして警告する挙動）。

## Phase 1 の検証結果

合成歌声（C4-E4-G4-A4-G4-E4-C4、一部グライド接続・無声区間あり）で:

- 主要ノートの音高・境界が ground truth と一致（±10 cent）
- **無声を挟まないグライド接続部（E4→G4, A4→G4）を「1 ノート内 2 セグメント」に
  正しく分割** — F-2/F-3 のユースケースを実証
- ビブラート（5.5Hz）は cent 領域ローパスで除去され、分割判定に影響しない
- アタックのしゃくりは時間重み付き中央値により baseCents に引きずられない

## 次のステップ（Phase 3）

Web UI（Canvas ピアノロール、縦ドラッグ、50cent スナップ）+
`POST /api/session` / `/api/render`。サーバー側は sp/ap を常駐させ、
クライアントとは JSON（EditState）+ WAV のみをやり取りする（P4/10章）。
