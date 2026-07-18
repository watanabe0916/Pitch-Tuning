#!/bin/bash
# ボーカル・ピッチエディタ 起動スクリプト（macOS・conda 不要）
# Finder でダブルクリック、または `./start.command` で実行できる。
# .venv が無ければ自動でセットアップ → サーバー起動 → ブラウザを開く。
#
# Ctrl+C・ウィンドウを閉じる（SIGHUP）のどちらでも uvicorn を確実に道連れにする。
# それでも残ってしまった場合は ./stop.command で強制終了できる。

set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT=8000
PIDFILE="$ROOT/.server.pid"

# 前回のプロセスが生きたまま残っていれば先に片付ける（多重起動・PID使い回し対策）
if [ -f "$PIDFILE" ]; then
  oldpid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    echo "前回のサーバー(PID $oldpid)が残っていたため終了します…"
    kill "$oldpid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PIDFILE"
fi

# 初回起動時: .venv が無ければセットアップを走らせる
if [ ! -d ".venv" ]; then
  echo "初回セットアップを実行します…"
  ./setup.sh
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "サーバーを起動します → http://localhost:${PORT}/"

# 少し待ってからブラウザを開く（サーバー起動と競合しないように）
( sleep 2 && open "http://localhost:${PORT}/" ) &

cd "$ROOT/server"
uvicorn app:app --port "${PORT}" &
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE"

# Ctrl+C(INT) / ターミナルを閉じた(HUP) / kill(TERM) いずれでも uvicorn を止めてから終了する
cleanup() {
  echo ""
  echo "サーバーを停止します…"
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$PIDFILE"
}
trap cleanup INT TERM HUP EXIT

wait "$SERVER_PID"
