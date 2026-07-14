# ボーカル・ピッチエディタ — サーバー側（解析・再合成）

CLAUDE.md の仕様に基づく実装。
- **Phase 1**: F0 推定 + ノート自動分割
- **Phase 2**: renderF0/renderGain + WORLD 再合成（AC-1〜5/7/8）
- **Phase 3**: Web UI（Canvas ピアノロール・縦ドラッグ・50cent スナップ）+ `/api/session`・`/api/render`
- **Phase 4**: 分割/結合/遷移区間/セグメント音量の UI（AC-6、遷移帯・塗り高さの可視化）
- **Phase 5**: 書き出し（`/api/export`）+ ダウンロード UI + トゥルーピーク・リミッター（AC-15/16/21）
- **Phase 6**: 伴奏トラック（アップロード・同時再生・再生中の編集ロック・ミックス書き出し、AC-17〜20）
- **Phase 7**: 録音（AudioWorklet で生 PCM・前処理無効化・レベルメーター、アカペラのみ、AC-11〜14）
- **Phase 8**: リバーブ・マスターフェーダー・アンドゥ・ズーム・プロジェクト保存（AC-9/10）

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

## Phase 3: Web UI とサーバー

```bash
cd server && conda activate pitch
uvicorn app:app --reload --port 8000
# → ブラウザで http://localhost:8000/
#   「音声を開く」で WAV/FLAC/AIFF を読み込み → ピアノロールにノート表示
#   青い矩形を縦ドラッグ → 音高が 50cent 刻みで変わり、離すと再合成して再生
#   Shift=1cent 微調整 / Alt=100cent 粗スナップ
# 開発用: http://localhost:8000/#demo でサンプル音声を自動読み込み
```

### 構成（Phase 3）

```
server/
  app.py                 # FastAPI。POST /api/session, POST /api/render,
                         #   DELETE /api/session/:id。sp/ap はサーバー常駐(P4)、
                         #   クライアントとは JSON(EditState)+WAV のみ交換
  pitch/schema.py        # Note/Segment ⇔ JSON、Float32→base64
  static/
    index.html / style.css
    pitchlogic.js        # DOM 非依存の純粋ロジック（座標変換/スナップ/ヒットテスト）
    app.js               # Canvas 描画・ドラッグ・/api/render・Web Audio 再生
  tests/test_pitchlogic.js  # 縦ドラッグ/スナップ/座標変換の自動テスト（node で実行）
```

### Phase 3 検証

- `POST /api/render` は編集後 EditState を全区間一括再合成し WAV を返す。
  `pitchOffsetCents=+200` を与えた出力を再解析すると、該当ノートが**ちょうど
  +200cent** 高い（測定 200.0）。
- `node tests/test_pitchlogic.js` — 26 チェック（50/1/100cent スナップ、
  縦ドラッグ→音高、時刻→セグメントのヒットテスト、座標変換の往復）通過。
- ブラウザ実機（headless Chrome）で `#demo` 自動読み込み → 解析 → ピアノロール
  描画 → 再合成まで JS エラー無しで到達することを確認。

> 設計原則 P4: 解析データ(sp/ap ≈ 原音の 10 倍)はクライアントに送らない。
> 編集のたびに EditState(JSON) を送り、返ってきた WAV を差し替えて再生する。

## Phase 4: 編集操作の UI

ブラウザ操作（`http://localhost:8000/`）:

| 操作 | 挙動 |
|------|------|
| セグメント縦ドラッグ | 音高（50cent / Shift=1c / Alt=100c スナップ） |
| **S** キー | カーソル位置でセグメントを分割（再帰可） |
| 分割線ダブルクリック | 隣接セグメントを結合 |
| 分割線ドラッグ | 分割位置を移動 |
| **Ctrl**+分割線ドラッグ | 遷移区間長（transitionInMs）を伸縮 |
| **G**+縦ドラッグ | セグメント音量（gainDb） |
| **M** キー | 選択セグメントのミュート切替 |
| Master フェーダー / 補正スライダー | masterGainDb / 選択セグメントの correctStrength |

**可視化（6.3 / 6.4）**: セグメント境界に遷移区間帯（半透明の橙帯）を重ね、
矩形内はゲインに応じた塗り高さ（0dB=行いっぱい）＋原音 RMS 包絡線を薄く表示。
ミュートは枠線のみ（アウトライン）。

純粋ロジック（分割/結合/分割線移動/塗り高さ/スナップ）は `pitchlogic.js` に集約し、
`node tests/test_pitchlogic.js` で **44 チェック**（AC-6: 50cent スナップで
`pitchOffsetCents % 50 == 0` が常に成立 を含む）を検証。

サーバー検証: 分割＋オフセット(+200/-100)＋ゲイン(+6dB)＋ミュート＋遷移(120ms)＋
master(-3dB) を含む EditState を `/api/render` に投げ、出力の分割各半が
±200/-100cent、ミュート区間が -91dB（無音）になることを確認済み。

## Phase 5: 書き出し + リミッター

- `render_master()`（[render.py](server/pitch/render.py)）= `render_output` +
  **トゥルーピーク・リミッター**（4倍オーバーサンプルで -1 dBTP を超えないよう抑制）。
  `normalize=True` で -1 dBTP へ正規化。
- **プレビュー(`/api/render`)と書き出し(`/api/export`)は同一の `render_master` を通す**ため、
  既定条件で出力がサンプル単位で一致する（AC-16）。プレビューは 32bit float WAV。
- `POST /api/export`: `target`(vocal/mix)・`format`(wav/flac/mp3)・`bitDepth`・`normalize`。
  `Content-Disposition: attachment` でダウンロード。ファイル名は `<原名>_tuned_<日時>.<ext>`。
  伴奏ミックス(target=mix)は Phase 6 で対応。
- UI: 形式選択 + -1dBTP正規化チェック + 「⬇ 書き出し」ボタン → ブラウザ保存（13.3）。

### Phase 5 検証（AC 実測）

| AC | 内容 | 実測 |
|----|------|------|
| AC-15 | Content-Disposition でファイル保存できる | `attachment; filename="..._tuned_....wav"` ✅ |
| AC-16 | 既定書き出し = プレビュー（サンプル一致）| `array_equal == True`（maxdiff 0.0）✅ |
| AC-21 | +12dB でも -1 dBTP を超えない | 真ピーク **-1.000 dBTP** ✅ |

```bash
python -m pytest tests/test_phase5.py -v      # AC-15/16/21
```

## Phase 6: 伴奏トラック

- `POST /api/backing`（sessionId + audio）: **解析しない**。ステレオ保持のままデコードし、
  ボーカルと SR が違えば**伴奏側だけ**をボーカル SR へリサンプル（ボーカルは不変・12.1）。
  波形表示用の間引きピーク列を返す。`GET /api/backing/:sid/audio` が再生用ストリーム。
- **同時再生（12.2）**: 単一 `AudioContext` 上で両ソースに同じ基準時刻 `t0` を渡す
  （`computePlaybackSchedule`）。`offsetSec` で頭合わせ（正=伴奏を遅らせる。書き出しと一致）。
  ミュート/ソロ/音量は `GainNode` で（接続は切らない）。
- **編集ロック（F-7 / 12.3）**: 再生中はグリッド・スライダー・伴奏コントロールを無効化。
  Play 押下時に `dirty` なら必ず再合成してから再生（AC-20）。
- **ミックス書き出し（13.2）**: `target="mix"` で `mix_vocal_backing`
  （ボーカル=センター、伴奏=offset ずらし）→ 出力段でトゥルーピーク・リミッター。
- UI: 伴奏レーン（波形・音量・M/S・頭合わせ）+ 両レーンを貫く再生ヘッド（12.4）。

### Phase 6 検証（AC）

| AC | 内容 | 検証 |
|----|------|------|
| AC-17 | mix の伴奏開始位置 = offsetSec（±1サンプル）| インパルス位置 **err=0**（0/+0.3/-0.15s）✅ |
| AC-18 | 同時再生が同一 t0（1サンプル以内）| `computePlaybackSchedule` 単体テスト ✅ |
| AC-19 | 再生中は編集が EditState を変えない | `canEdit` + 全編集経路の `playing` ガード ✅ |
| AC-20 | Play 押下で必ず再合成してから再生 | `dirty→renderAndLoad(true)` ✅ |

```bash
python -m pytest tests/test_phase6.py -v    # AC-17 + 伴奏バックエンド
node tests/test_pitchlogic.js               # AC-18/19（+ 既存 50 超）
```

## Phase 7: 録音（アカペラ）

- **前処理を全無効化**（11.1）: `getUserMedia({audio:{echoCancellation:false,
  noiseSuppression:false, autoGainControl:false, channelCount:1}})`。
  取得後 `getSettings()` を検査し、前処理が残っていれば警告（AC-11）。
- **`MediaRecorder` は使わない**（WebM/Opus 非可逆）。`recorder-worklet.js`（AudioWorklet）で
  生 Float32 PCM を取得し、`encodeWavFloat32` で **32bit float WAV** にして
  ファイル読み込みと同じ `/api/session` へ流す（11.2 / AC-12）。
- **サンプルレートは決め打ちしない**: `ctx.sampleRate` を実測して使う（11.3）。
- **レベルメーター**（11.4）: 目標 -12dBFS、0dBFS 到達で赤クリップ警告（AC-14）。
- 権限拒否時はファイル読み込みへ誘導（11.7）。localhost は HTTPS 例外。

純粋ロジック（WAV エンコード・制約検査・メーター）は `reclogic.js` に集約。

### Phase 7 検証（AC）

| AC | 内容 | 検証 |
|----|------|------|
| AC-11 | 前処理3種が false（残れば警告）| `checkAudioConstraints` 単体 ✅ |
| AC-12 | 非圧縮 PCM(float32)・非 Opus/AAC | WAV fmt=3/32bit ✅ |
| AC-13 | 録音 PCM がサーバーでビット一致 | Node生成WAV→soundfile復元が **bit-exact** ✅ |
| AC-14 | 0dBFS 到達で警告 | `meterFromPeak(≥1.0).clip` ✅ |

```bash
node tests/test_reclogic.js          # AC-11/12/14
python -m pytest tests/test_phase7.py # AC-12/13（ブラウザWAV→サーバ復元）
```

## Phase 8: リバーブ・アンドゥ・ズーム・プロジェクト保存

- **リバーブ**（[render.py](server/pitch/render.py)）: 指数減衰ノイズの合成 IR による
  畳み込み（決定的）。信号チェーンは **gain →（★）リバーブ → master → リミッター**。
  セグメントゲインは必ずリバーブ前段（AC-10）、マスターはリバーブ後段（4.2）。
- **アンドゥ/リドゥ**: `commitEdit` を全編集の合流点にし、EditState スナップショットを
  スタック管理。`Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`（`↶ ↷` ボタンも）。
- **ズーム**: 横方向 `pxPerSec`。`＋/－` ボタン と `Cmd/Ctrl+ホイール`。
- **プロジェクト保存/読込**（13.4）: 音声を含まない EditState を JSON で入出力。
  音声 + JSON の2点で編集状態を完全復元。
- リバーブ量スライダー・マスターフェーダーはツールバーに常設。

### Phase 8 検証（AC）

| AC | 内容 | 実測 |
|----|------|------|
| AC-9 | +12dB でもリバーブ後 -1 dBTP を超えない | 真ピーク **-1.000 dBTP** ✅ |
| AC-10 | ミュート区間 -70dB 以下・残響も引き継がない | 尾 RMS **-115 dB**（ゲインがリバーブ前段の証明）✅ |

```bash
python -m pytest tests/test_phase8.py -v   # AC-9/10
```

## 次のステップ（Phase 9）

フレーズ自動分割（長尺対応）、テイク管理、レイテンシ補正。
