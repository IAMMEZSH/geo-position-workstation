#!/bin/sh
# 经纬度定位工作站 · iPhone / iPad（iSH）启动器
#
# 用法（在 iSH 里）：
#   apk add python3                 # 只需一次
#   cd 到本目录（或用下面的 git 一行拉下来）
#   sh 启动-iSH.sh
#
# 想做「点开就能用」的最短路径，其实不必用 iSH：直接用 Safari 打开托管地址
#   https://iammezsh.github.io/geo-position-workstation/
# 六个内核 + 离线数据 + 地图 + 自检全都跑，只有 ⑧ 的逐跳路由追踪需要本机桥接。
#
# 诚实说明（重要）：iSH 用的是自己的用户态网络栈，Safari 能否连到 iSH 里监听的
# 127.0.0.1 取决于 iSH 版本，本仓库作者没有在 iOS 实机上验证过这一步。
# 所以这个脚本先自测、再把「怎么看结果」和「连不上怎么办」打印给你，不让你猜。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1

PORT=${1:-8765}

echo "经纬度定位工作站 · iSH（Alpine on iOS）"
echo "--------------------------------------------------------------------------"

if ! command -v python3 >/dev/null 2>&1; then
  echo "找不到 python3。先执行：  apk add python3"
  echo "（桥接只用标准库，不需要 pip install 任何东西。）"
  exit 1
fi

if [ ! -f server.py ]; then
  echo "当前目录没有 server.py，说明文件夹没拷全。两种补齐办法："
  echo "  1) 在 iSH 里直接拉一份：  apk add git && git clone https://github.com/IAMMEZSH/geo-position-workstation && cd geo-position-workstation"
  echo "  2) 用「文件」App 把整个文件夹放进 iSH 的 pub 目录（一般是 /mnt/pub），再 cd 进去。"
  exit 1
fi

echo "[1/3] 先跑离线自检（87 项，不联网、不监听端口）……"
if python3 server.py --selftest >/tmp/geo-selftest.log 2>&1; then
  echo "      自检通过。"
else
  echo "      自检没通过，先看 /tmp/geo-selftest.log（把最后几行发出来就能定位）。"
  tail -5 /tmp/geo-selftest.log 2>/dev/null
  exit 1
fi

echo "[2/3] 启动桥接：127.0.0.1:$PORT（只绑回环，不监听局域网，不收坐标参数）"
python3 server.py --port "$PORT" >/tmp/geo-bridge.log 2>&1 &
SRV=$!

i=1
while [ "$i" -le 12 ]; do
  if python3 -c "import urllib.request as u;u.urlopen('http://127.0.0.1:$PORT/api/health',timeout=2)" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "      桥接进程自己退出了，日志："
    tail -8 /tmp/geo-bridge.log 2>/dev/null
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if ! python3 -c "import urllib.request as u;u.urlopen('http://127.0.0.1:$PORT/api/health',timeout=2)" >/dev/null 2>&1; then
  echo "      12 秒内 iSH 自己都连不上这个端口，多半是被占用了：换端口再试，如  sh 启动-iSH.sh 9000"
  tail -8 /tmp/geo-bridge.log 2>/dev/null
  kill "$SRV" 2>/dev/null
  exit 1
fi
echo "      iSH 内部访问 /api/health 正常。"

MISSING=""
for tool in traceroute ping; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  echo "      提示：这台 iSH 里缺 $MISSING。桥接会如实报告「命令缺失」并降级，"
  echo "            绝不编造跳数。要补齐就：  apk add iputils traceroute"
fi

echo "[3/3] 现在切到 Safari，打开："
echo
echo "        http://127.0.0.1:$PORT/"
echo
echo "      如果 Safari 打不开（一直转圈或「无法打开页面」）：那是 iSH 的用户态网络栈"
echo "      不把端口交给 iOS，不是本页面的问题。两条出路，功能差别只有 ⑧ 的逐跳追踪："
echo "        · 直接用托管地址：https://iammezsh.github.io/geo-position-workstation/"
echo "        · 或者换 A-Shell / Pyto / Texta 这类能本机起 HTTP 的 App 跑同样的 server.py"
echo
echo "      按 Ctrl+C 关闭桥接。日志：/tmp/geo-bridge.log"
echo "      （⑧ 可以追踪内网地址，比如网关 192.168.1.1；响应里的 target_scope"
echo "        会标明这一层目标是内网还是公网。）"
echo "--------------------------------------------------------------------------"

trap 'kill "$SRV" 2>/dev/null' INT TERM
wait "$SRV"
