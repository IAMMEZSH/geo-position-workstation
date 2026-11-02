#!/bin/sh
# 经纬度定位工作站 · iPhone / iPad（iSH）启动器
#
# 这是「苹果手机和平板在本机跑桥接」的那条路。三步，全部在 iSH 的终端里敲：
#   apk add python3                       # 只需一次；桥接只用标准库，不需要 pip
#   cd 到本目录                            # 或者用下面 [1/4] 打印的 git 一行命令
#   sh 启动-iSH.sh                        # 端口被占用就  sh 启动-iSH.sh 9000
#
# 想「点开就能用」，其实不必装 iSH：Safari 直接打开托管地址
#   https://iammezsh.github.io/geo-position-workstation/
# 七个内核、离线数据、地图、623 道浏览器自检（含 71 道异步门）全都在；只有 ⑧ 网络诊断面板的
# 「逐跳路由追踪 / 内网网卡」这一类需要本机桥接，没有桥接时页面会明说缺什么，
# 不会给你一个编造出来的结果。
#
# 验证边界（重要，不猜）：
#   · 本机（Linux/Alpine 内核）能验的：server.py --selftest、桥接起监听、
#     /api/health 与 /api/iface 的真实应答。这些在 iSH 里同样是真跑，脚本会当场打印数字。
#   · iOS 上「Safari 能不能连进 iSH 监听的 127.0.0.1」取决于 iSH 版本与它把不把
#     端口交给 iOS——这不是本页面能决定的，本仓库作者没有 iOS 真机可以替你保证。
#     所以这个脚本把「怎么验、连不上怎么办」打全，不让你自己猜。
#   · 另一条硬约束：桥接只绑回环。非回环绑定（比如局域网 IP）在 server.py 里是
#     启动即拒绝，这是隐私红线，不提供开关，也别改。
#
# 这张脸为什么长成这样（和另外四个平台都不同，见 MANUAL 2.10）：
#   iSH 的终端只保证标准 16 色（它不报 COLORTERM，我们也不替它猜 24-bit），iPhone 上
#   可视宽度就四十来列，而且方块字形在 iSH 自带字体里有可能落成豆腐块。所以这里的
#   HUD 一律用 ASCII 结构件：横线、竖线轨道、[*] / [x] 状态点，颜色只是加上去的强调，
#   不承担任何信息——换句话说，把颜色全关掉，画面信息量一个字节都不少：
#       NO_COLOR=1 sh 启动-iSH.sh
#   同样的道理，正文里不出现任何需要「对齐」才成立的图案：宽行让终端自己折，不撑破框。
#   这条不是审美妥协，是这台设备上唯一能被验证的写法；作者没有 iOS 真机，
#   所以宁可写成「你自己一眼能核对」的样子。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1

PORT=${1:-8765}
SELFTEST_LOG=/tmp/geo-selftest.log
BRIDGE_LOG=/tmp/geo-bridge.log
URL="http://127.0.0.1:$PORT"

# ---------------------------------------------------------------- 16 色的那张脸
esc() { printf '%b' "$1"; }

COL=1
[ -t 1 ] || COL=0
[ -n "${NO_COLOR:-}" ] && COL=0
case ${GEO_COLOR:-} in
  0) COL=0 ;;
  1) COL=1 ;;
esac

K1='' K2='' K3='' KD='' KB='' KR='' KE=''
if [ "$COL" = 1 ]; then
  KB=$(esc '\0033[1m') KR=$(esc '\0033[0m') KD=$(esc '\0033[1;30m')
  K1=$(esc '\0033[1;34m') K2=$(esc '\0033[1;32m') K3=$(esc '\0033[1;33m') KE=$(esc '\0033[1;31m')
fi

COLS=0
case ${GEO_WIDTH:-} in
  '' | *[!0-9]*) ;;
  *) COLS=$GEO_WIDTH ;;
esac
if [ "$COLS" = 0 ] && [ -t 1 ]; then
  C=$( (tput cols) 2>/dev/null || echo 0)
  case $C in
    '' | *[!0-9]*) ;;
    *) COLS=$C ;;
  esac
fi
[ "$COLS" -lt 30 ] && COLS=44
[ "$COLS" -gt 60 ] && COLS=60

i_rule() { # $1 用 = 还是 -：整条正好 COLS 列（前导空格和首字符都要算进去）
  printf ' %s%s%s%s\n' "$K1" "$1" "$(i_rep "$1" "$((COLS - 2))")" "$KR"
}
i_rep() {
  i=0
  while [ "$i" -lt "$2" ]; do printf '%s' "$1"; i=$((i + 1)); done
}
i_head() {
  TITLE="G E O   P O S I T I O N   W O R K S T A T I O N"
  [ "${#TITLE}" -gt "$COLS" ] && TITLE="GEO POSITION WORKSTATION"
  i_rule =
  printf ' %s%s%s\n' "$KB$K1" "$TITLE" "$KR"
  printf ' %siSH · Alpine on iOS · iPhone / iPad%s\n' "$KD" "$KR"
  i_rule -
}
i_step() { # $1 第几步  $2 标题
  printf ' %s[%s/4] %s%s%s\n' "$KB" "$K3$1" "$KR" "$2" ""
}
i_kv() { # 标签 正文：竖线轨道把「步骤在做的事」和「结论」分开
  printf '   %s|%s %s%s%s %s\n' "$KD" "$KR" "$KB$K1" "$1" "$KR" "$2"
}
i_note() {
  printf '   %s| %s%s%s\n' "$KD" "$K1" "$1" "$KR"
}
i_dim() {
  printf '     %s%s%s\n' "$KD" "$1" "$KR"
}
i_cmd() {
  printf '       %s%s\n' "$1" ""
}
i_ok() {
  printf '   %s[%s*%s] %s%s\n' "$KB" "$K2" "$KR" "$1" "$KR"
}
i_bad() {
  printf '   %s[%sx%s] %s%s\n' "$KB" "$KE" "$KR" "$1" "$KR"
}

i_head
i_kv 'DIR' "$DIR"
i_kv 'URL' "$URL"
i_kv 'LOG' "$SELFTEST_LOG  /  $BRIDGE_LOG"
i_rule -

if ! command -v python3 >/dev/null 2>&1; then
  i_bad '找不到 python3。先执行：  apk add python3'
  i_dim '（只需一次；桥接只用标准库，不需要 pip）'
  exit 1
fi
i_kv 'PY' "python3 $(python3 -V 2>&1)"

if [ ! -f server.py ]; then
  i_bad '当前目录没有 server.py，说明文件夹没拷全。两种补齐办法：'
  i_note '1) 在 iSH 里直接拉一份（最省事，62 个文件全在里面）：'
  i_cmd 'apk add git && git clone https://github.com/IAMMEZSH/geo-position-workstation && cd geo-position-workstation'
  i_note '2) 用 iOS 的「文件」App 把整个文件夹放进 iSH 挂载目录（一般在 /mnt/ 下），再 cd 进去：'
  i_cmd 'ls /mnt          # 看这台 iSH 把「文件」里的哪个位置挂进来了'
  exit 1
fi

i_step 1 '离线自测：python3 server.py --selftest（不联网、不监听端口，只算不调）'
# 直接把自测自己的结论抄下来，不在这里数它的行数——数字由 server.py 说了算，改动不会走样。
# PYTHONIOENCODING 是给非 UTF-8 终端的：GBK 一类的控制台会把那句中文结论写坏；
# Alpine / iSH 本来就是 UTF-8，设不设都一样。
if PYTHONIOENCODING=utf-8 python3 server.py --selftest >"$SELFTEST_LOG" 2>&1; then
  # 直接把自测自己的结论抄下来，不在这里数它的行数——数字由 server.py 说了算，改动不会走样。
  i_ok "$(tail -1 "$SELFTEST_LOG")"
else
  i_bad '没通过。先把日志尾几行给你（把这段发出来就能定位，不用重跑）：'
  tail -12 "$SELFTEST_LOG" 2>/dev/null
  i_dim "完整日志： $SELFTEST_LOG"
  exit 1
fi

i_step 2 "起桥接：$URL（只绑回环，不监听局域网，永不接收坐标类参数）"
PYTHONIOENCODING=utf-8 python3 server.py --port "$PORT" >"$BRIDGE_LOG" 2>&1 &
SRV=$!

i=1
while [ "$i" -le 15 ]; do
  if python3 -c "import urllib.request as u;u.urlopen('$URL/api/health',timeout=2)" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SRV" 2>/dev/null; then
    i_bad '桥接进程自己退出了，日志尾几行：'
    tail -12 "$BRIDGE_LOG" 2>/dev/null
    i_dim '最常见两种：端口已被占用（换  sh 启动-iSH.sh 9000），或 python3 缺标准库模块。'
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

if ! python3 -c "import urllib.request as u;u.urlopen('$URL/api/health',timeout=2)" >/dev/null 2>&1; then
  i_bad '15 秒内 iSH 自己都连不上这个端口。多半是被占用了：换端口再试，如  sh 启动-iSH.sh 9000'
  tail -12 "$BRIDGE_LOG" 2>/dev/null
  kill "$SRV" 2>/dev/null
  exit 1
fi
i_ok "/api/health 应答正常（第 ${i} 秒）。"

i_step 3 '拿一次真实数据，数字当场打给你看（不是「自检全绿」就算完）'
PYTHONIOENCODING=utf-8 python3 - "$URL" <<'PYEOF'
import json
import sys
import urllib.request

base = sys.argv[1]


def get(path):
    with urllib.request.urlopen(base + path, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


h = get("/api/health")
b = h.get("bind") or {}
print("   | 桥 %s %s · %s · 监听 %s:%s（回环独占=%s）"
      % (h.get("server"), h.get("version"), h.get("runtime"),
         b.get("address"), b.get("port"), b.get("loopback_only")))
print("   | 能力 %s" % ", ".join(h.get("capabilities") or []))
try:
    i = get("/api/iface")
    print("   | 网卡 %s 个 · 主机名/MAC/内网地址一律不返回（脱敏字段：%s）"
          % (i.get("interface_count"), ", ".join(i.get("redacted_fields") or [])))
except Exception as exc:
    print("   | /api/iface 这次没答上（%s）——桥接会如实报失败，不编内容。" % type(exc).__name__)
try:
    d = get("/api/dns?host=127.0.0.1")
    print("   | 本机解析回环字面量：%s" % (", ".join(d.get("addresses") or []) or "无应答"))
except Exception as exc:
    print("   | 这次 DNS 没答上（%s）。" % type(exc).__name__)
PYEOF

MISSING=""
for tool in traceroute ping; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  i_note "提示：这台 iSH 里缺 $MISSING。⑧ 会如实报告「命令缺失」并降级，绝不编造跳数。"
  i_note '           要补齐就：  apk add iputils traceroute'
fi

i_step 4 '切到 Safari，打开：'
echo
i_kv 'URL' "$URL/"
echo
i_note 'iPad：把 iSH 和 Safari 分屏（Split View）或叠加（Slide Over）再打开——'
i_dim  '      iOS 会把切到后台的 iSH 挂起，桥接一挂起，页面里的 ⑧ 就发不出请求。'
i_note 'iPhone：没有分屏，就把 Safari 页面加到主屏幕后回到 iSH，或者接受'
i_dim  '      「iSH 前台时才能用 ⑧」这个限制；七个内核和离线数据不受影响。'
echo
i_note 'Safari 打不开（一直转圈 / 「无法打开页面」）时，按这个顺序排除，别急着怀疑页面：'
i_note '  1) iSH 里自己试一次，能答上说明桥接没问题，是 iOS 那一层没交端口：'
i_cmd  "apk add curl && curl -s $URL/api/health"
i_note '  2) 换端口再起一次：  sh 启动-iSH.sh 9000'
i_note '  3) 确认 iSH 没被挂起（回到 iSH 敲个 echo hi 看还响不响）。'
i_note '  4) 上面都正常但 Safari 仍连不上：那是这台设备的 iSH 不把监听端口交给 iOS，'
i_dim  '     不是本页面的问题，也不是配置能改出来的。两条出路，功能差别只有 ⑧ 的逐跳追踪：'
i_cmd  'https://iammezsh.github.io/geo-position-workstation/'
i_dim  '     或把 server.py 放进能在 iOS 本机起 HTTP 的 Python 环境'
i_dim  '     （A-Shell / Pyto / Texta 一类），页面里手填桥接地址，同样只打 127.0.0.1'
i_note "  5) 只想在终端里用 ⑧ 的接口，不开界面也完全可以："
i_cmd  "curl -s '$URL/api/dns?host=example.com'"
i_cmd  "curl -s '$URL/api/ping?host=127.0.0.1&count=2'"
echo
i_ok "按 Ctrl+C 关闭桥接。日志：$BRIDGE_LOG"
i_note '  （⑧ 可以追踪内网地址，比如网关 192.168.1.1；响应里的 target_scope'
i_dim  '     会标明这一层目标是内网还是公网。）'
i_dim  '完整说明见同目录 MANUAL.md（英文，含各平台的最小文件清单——不必整包下载）。'
i_rule =

trap 'kill "$SRV" 2>/dev/null' INT TERM
wait "$SRV"
