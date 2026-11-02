#!/bin/sh
# 经纬度定位工作站 · macOS / Linux 通用启动器
# 有 Python3 就把本地桥接服务拉起来（只绑 127.0.0.1），再用同源 http 地址打开页面；
# 没有 Python3 也照常打开页面——只有 ⑧「联网与路由追踪」会提示不可用，其余面板全部本地计算。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
PORT=${PORT:-8765}
LOG="$DIR/桥接服务.log"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then
    PY=$c
    break
  fi
done

open_page() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  elif command -v termux-open >/dev/null 2>&1; then termux-open "$1" >/dev/null 2>&1
  else echo "请手动用浏览器打开：$1"
  fi
}

wait_ready() {
  i=0
  while [ $i -lt 10 ]; do
    if "$PY" -c "import urllib.request as u;u.urlopen('http://127.0.0.1:$PORT/api/health',timeout=1)" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

if [ -z "$PY" ]; then
  echo "[提示] 没找到可用的 Python3，直接离线打开页面。"
  echo "       只有 ⑧「联网与路由追踪」需要 Python3；其余面板不联网也能用。"
  open_page "index.html"
  exit 0
fi

echo "[启动] 用 $PY 拉起本地桥接服务（只监听 127.0.0.1，日志：$LOG）"
nohup "$PY" server.py --port "$PORT" >"$LOG" 2>&1 &
BRIDGE_PID=$!

if wait_ready; then
  echo "[就绪] 桥接服务在线：http://127.0.0.1:$PORT/ （PID $BRIDGE_PID）"
  open_page "http://127.0.0.1:$PORT/index.html"
else
  echo "[提示] 桥接服务 10 秒内没就绪（端口被占？见 $LOG），已退回离线页面。"
  echo "       ⑧ 面板会如实显示「桥接不可用」，其余面板不受影响。"
  kill $BRIDGE_PID >/dev/null 2>&1
  open_page "index.html"
fi

echo
echo "若浏览器没有自动弹出，请手动访问上面打印的地址。"
echo "停止桥接服务：kill $BRIDGE_PID 或直接关掉本终端窗口。"
echo "用法与精度说明见同目录 说明书.md。"
