#!/bin/bash
# ボーカル・ピッチエディタ セットアップ（conda 不要・venv ベース）
# 初回に1回だけ実行する。プロジェクト直下に .venv を作り、依存を pip で入れる。
#   使い方:  ./setup.sh
# フォークした人はこれを実行するだけで動く環境が整う（要: Python 3.9+）。

set -e
cd "$(dirname "$0")"

# --- 適切な Python を探す（3.9 以上。新しいものを優先） ---
PY=""
for cand in python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver=$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "0.0")
    major=${ver%%.*}; minor=${ver##*.}
    if [ "$major" = "3" ] && [ "$minor" -ge 9 ] 2>/dev/null; then
      PY="$cand"; break
    fi
  fi
done

if [ -z "$PY" ]; then
  echo "エラー: Python 3.9 以上が見つかりません。"
  echo "  https://www.python.org/downloads/ からインストールしてください。"
  exit 1
fi
echo "使用する Python: $PY ($($PY --version 2>&1))"

# --- venv 作成 & 依存インストール ---
if [ ! -d ".venv" ]; then
  echo ".venv を作成します…"
  "$PY" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
echo "依存パッケージをインストールします（pyworld のビルドに数分かかることがあります）…"
pip install -r server/requirements.txt

echo ""
echo "✅ セットアップ完了。start.command をダブルクリック（または ./start.command）で起動できます。"
