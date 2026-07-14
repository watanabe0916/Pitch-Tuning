#!/bin/bash
# ボーカル・ピッチエディタ 起動スクリプト（macOS・conda 不要）
# Finder でダブルクリック、または `./start.command` で実行できる。
# .venv が無ければ自動でセットアップ → サーバー起動 → ブラウザを開く。

set -e
cd "$(dirname "$0")"

# 初回起動時: .venv が無ければセットアップを走らせる
if [ ! -d ".venv" ]; then
  echo "初回セットアップを実行します…"
  ./setup.sh
fi

# shellcheck disable=SC1091
source .venv/bin/activate

PORT=8000
echo "サーバーを起動します → http://localhost:${PORT}/"

# 少し待ってからブラウザを開く（サーバー起動と競合しないように）
( sleep 2 && open "http://localhost:${PORT}/" ) &

# サーバー起動（Ctrl+C で停止）。この端末ウィンドウは開いたままにしておくこと。
cd server
exec uvicorn app:app --port "${PORT}"
