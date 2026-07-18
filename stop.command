#!/bin/bash
# ボーカル・ピッチエディタ 停止スクリプト（macOS）
# Finder でダブルクリック、または `./stop.command` で実行できる。
# start.command の Ctrl+C が効かなかった場合や、閉じ忘れたサーバーを
# 確実に終了させるための保険。PID記録 → ダメならポート占有プロセスを直接kill。

cd "$(dirname "$0")"
PORT=8000
PIDFILE=".server.pid"
found=0

if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "サーバー(PID $pid)を停止します…"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    found=1
  fi
  rm -f "$PIDFILE"
fi

# pidfile が無い/古い場合のフォールバック: ポート8000を掴んでいるプロセスを直接止める
port_pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$port_pids" ]; then
  echo "ポート ${PORT} を使用中のプロセスを停止します: $port_pids"
  kill $port_pids 2>/dev/null || true
  sleep 1
  for p in $port_pids; do
    kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
  done
  found=1
fi

if [ "$found" = "1" ]; then
  echo "✅ サーバーを停止しました。"
else
  echo "起動中のサーバーは見つかりませんでした。"
fi
