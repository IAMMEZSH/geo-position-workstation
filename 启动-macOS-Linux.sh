#!/bin/sh
# 经纬度定位工作站 · macOS / Linux / Android 桥接引擎（一份逻辑，三张脸）
#
# macOS 用系统自带的「终端」就能跑，不需要 Homebrew、不需要 pip、不需要先 chmod：
#     cd 到这个目录，然后  sh 启动-macOS-Linux.sh
# Linux 同理，用发行版自带的那个终端：cd 到本目录，然后  sh 启动-Linux.sh。
# Android 在 Termux 里：sh 启动-Android.sh —— 它只是把 GEO_FACE=android 传进来再转交。
# 三个平台的「入口」都只做两件事：切到本目录、点名自己那张脸。三级回退逻辑只有这一份，
# 所以不存在「macOS 说的话和 Linux 不一样」这种漂移。
# 用 sh 而不是 ./ 起跑，是因为 git clone 出来的文件不带可执行位，./ 会 Permission denied。
#
# 行为（与 启动-Windows.bat 同一套三级回退思路）：
#   有 Python3 → 拉起本机桥接（只绑 127.0.0.1），用同源 http 地址打开页面，⑧ 全功能；
#   没有 Python3 → 照常打开离线页面，只有 ⑧「联网与路由追踪」提示桥接不可用，
#                  其余 10 个面板与 ⑪ 自检完全不受影响。
# 换端口：PORT=9000 sh 启动-macOS-Linux.sh   （页面用 9000 打开时 ⑧ 自动连同源端口）
#
# 关于 HUD：为什么一个引擎要分三张脸，以及它什么时候会闭嘴。
#   GEO_FACE=macos|linux|android 决定框线字形、色阶、宽度上限；说什么、按什么顺序说，
#   一行都没多——把「内容」和「摆法」分开之后，改配色不可能改坏流程。这是本文件唯一的
#   装饰层，删掉所有 hud_* 函数、把剩下的 printf 换成 echo，行为逐字不变。
#   颜色只在 stdout 真是终端时打开：管道给 grep、CI 收日志、重定向进文件都自动退回纯文本，
#   不会有人拿到一串 ESC 乱码。NO_COLOR 非空即全关（这是现成的跨项目约定 no-color.org），
#   GEO_COLOR=1/0 强制开关（远程排障要截图就 1）。
#   24-bit 渐变只在 COLORTERM=truecolor|24bit 时启用；不支持的终端不假装支持——阶梯退化成
#   单色，iTerm/Terminal.app/GNOME Terminal/Termux 都报 truecolor，屏幕好的老终端上看到的是
#   同一份信息，只是没有那条彩虹。
#   窗口标题走 OSC 2，把它当状态读数用（BOOTING / READY / DEGRADED）：cmd 只能整窗换调色板，
#   Unix 只能整窗换标题，两边各把手上那件事做到位（Windows 那张脸见 启动-Windows.bat）。
#   宽度取 tput cols，拿不到就按 72 摆，超过上限截到上限（Android 截到 44：竖屏 Termux
#   常见就 40 来列，框比内容宽是最难看的一种翻车）。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
PORT=${PORT:-8765}
LOG="$DIR/桥接服务.log"
OS=$(uname -s 2>/dev/null || echo unknown)
GEO_FACE=${GEO_FACE:-linux}

# Termux 的 uname 也是 Linux，只能看 PREFIX；认错了会给手机打印一屏 apt/dnf，那是废纸。
IS_TERMUX=0
case ${PREFIX:-} in
  *termux* | *Termux*) IS_TERMUX=1 ;;
esac

# 给用户复述「该怎么再跑一次」时，说的是他自己那一层的入口文件名，不是引擎名。
if [ "$IS_TERMUX" = 1 ]; then
  ENTRY=启动-Android.sh
else
  case $OS in
    Darwin) ENTRY=启动-macOS-Linux.sh ;;
    *) ENTRY=启动-Linux.sh ;;
  esac
fi

# 提示内容跟「脸」走，机器事实（$OS、$ENTRY）跟机器走：预览 android 这张脸的人
# 应该看到 pkg install python，而不是一屏 apt/dnf——那 5 行在 44 列的脸上也根本站不住。
FAMILY=linux
if [ "$IS_TERMUX" = 1 ] || [ "$GEO_FACE" = android ]; then
  FAMILY=termux
elif [ "$OS" = Darwin ] || [ "$GEO_FACE" = macos ]; then
  FAMILY=macos
fi

esc() { printf '%b' "$1"; }
OSC=$(esc '\0033]0;')
BEL=$(esc '\007')

# ---------------------------------------------------------------- HUD 调色与尺寸
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
[ "$COLS" -lt 24 ] && COLS=72
FACE_MAX=72
[ "$GEO_FACE" = android ] && FACE_MAX=44
[ "$COLS" -gt "$FACE_MAX" ] && COLS=$FACE_MAX

hud_color_on=1
[ -t 1 ] || hud_color_on=0
[ -n "${NO_COLOR:-}" ] && hud_color_on=0
case ${GEO_COLOR:-} in
  0) hud_color_on=0 ;;
  1) hud_color_on=1 ;;
esac

hud_truecolor=0
if [ "$hud_color_on" = 1 ]; then
  case ${COLORTERM:-} in
    truecolor | 24bit) hud_truecolor=1 ;;
  esac
fi

ca='' ca2='' cw='' ce='' cd='' cb='' cr=''
A1='' A2='' A3='' A4='' A5='' A6=''
if [ "$hud_color_on" = 1 ]; then
  cb=$(esc '\0033[1m') cr=$(esc '\0033[0m') cd=$(esc '\0033[0;90m')
  if [ "$hud_truecolor" = 1 ]; then
    cw=$(esc '\0033[38;2;255;192;67m') ce=$(esc '\0033[38;2;255;93;115m')
    case $GEO_FACE in
      macos)
        ca=$(esc '\0033[38;2;47;224;255m') ca2=$(esc '\0033[38;2;167;139;250m')
        A1=$(esc '\0033[38;2;47;224;255m') A2=$(esc '\0033[38;2;66;190;255m')
        A3=$(esc '\0033[38;2;92;156;250m') A4=$(esc '\0033[38;2;126;122;245m')
        A5=$(esc '\0033[38;2;180;100;224m') A6=$(esc '\0033[38;2;255;90;200m') ;;
      android)
        ca=$(esc '\0033[38;2;55;255;190m') ca2=$(esc '\0033[38;2;255;192;67m')
        A1=$(esc '\0033[38;2;55;255;190m') A2=$(esc '\0033[38;2;104;235;160m')
        A3=$(esc '\0033[38;2;150;226;118m') A4=$(esc '\0033[38;2;186;222;90m')
        A5=$(esc '\0033[38;2;222;208;76m') A6=$(esc '\0033[38;2;255;192;67m') ;;
      *)
        ca=$(esc '\0033[38;2;34;211;238m') ca2=$(esc '\0033[38;2;217;70;239m')
        A1=$(esc '\0033[38;2;34;211;238m') A2=$(esc '\0033[38;2;56;189;245m')
        A3=$(esc '\0033[38;2;84;158;245m') A4=$(esc '\0033[38;2;108;122;240m')
        A5=$(esc '\0033[38;2;160;96;230m') A6=$(esc '\0033[38;2;217;70;239m') ;;
    esac
  else
    cd=$(esc '\0033[0;37m')
    case $GEO_FACE in
      macos) ca=$(esc '\0033[1;36m') ca2=$(esc '\0033[1;35m') ;;
      android) ca=$(esc '\0033[1;32m') ca2=$(esc '\0033[1;33m') ;;
      *) ca=$(esc '\0033[1;36m') ca2=$(esc '\0033[1;35m') ;;
    esac
    cw=$(esc '\0033[1;33m') ce=$(esc '\0033[1;31m')
    A1=$ca A2=$ca A3=$ca A4=$ca2 A5=$ca2 A6=$ca2
  fi
fi

# 每张脸自己的字形。macOS 细线圆角，Linux 双线方角，Android 单线窄框 + 实心圆点。
case $GEO_FACE in
  macos) G_T='╭' G_B='╰' G_R='─' G_CH='╮' G_E='╯' G_A='─' G_P='⌘' G_DOT='◉' ;;
  android) G_T='┌' G_B='└' G_R='─' G_CH='┐' G_E='┘' G_A='▮' G_P='▴' G_DOT='▸' ;;
  *) G_T='╔' G_B='╚' G_R='═' G_CH='╗' G_E='╝' G_A='═' G_P='◆' G_DOT='◆' ;;
esac

hud_top() { hud_frame "$G_T" "$G_R" "$G_CH" "$ca"; }
hud_bottom() { hud_frame "$G_B" "$G_R" "$G_E" "$ca"; }
hud_sep() { hud_aurora "$G_A" "$A1" "$A2" "$A3" "$A4" "$A5" "$A6"; }

hud_frame() { # 左角 填充 右角 颜色
  printf '%s%s' "$4" "$1"
  j=0
  while [ "$j" -lt "$((COLS - 2))" ]; do printf '%s' "$2"; j=$((j + 1)); done
  printf '%s%s\n' "$3" "$cr"
}

hud_aurora() { # $1 字形，其余六个色标；颜色关着时退化成纯字符线
  ch=$1
  shift
  seg=$((COLS / 6))
  [ "$seg" -lt 1 ] && seg=1
  last=$((COLS - seg * 5))
  [ "$last" -lt 1 ] && last=$seg
  i=0
  for col in "$@"; do
    i=$((i + 1))
    n=$seg
    [ "$i" = 6 ] && n=$last
    printf '%s' "$col"
    j=0
    while [ "$j" -lt "$n" ]; do printf '%s' "$ch"; j=$((j + 1)); done
  done
  printf '%s\n' "$cr"
}

hud_kv() { # 标签 正文
  printf '  %s%s%s %s%s\n' "$cb$ca" "$1" "$cr" "$2" "$cr"
}
hud_row() { # 正文，跟标签同宽缩进
  printf '  %s\n' "$1"
}
hud_dim() {
  printf '  %s%s%s\n' "$cd" "$1" "$cr"
}
hud_cmd() { # 给人整行复制的命令：不上颜色，颜色会把光标插进串里
  printf '    %s\n' "$1"
}
hud_state() { # $1=boot|ok|bad  $2=正文
  case $1 in
    ok) c=$ca2 ;;
    bad) c=$ce ;;
    *) c=$cw ;;
  esac
  printf '  %s%s %s%s\n' "$c" "$G_DOT" "$2" "$cr"
}

win_title() { # OSC 2 当状态灯用；非终端不发
  [ -t 1 ] || return 0
  printf '%s%s%s' "$OSC" "Geo Position Workstation · $1" "$BEL"
}

# ---------------------------------------------------------------- 平台无关的流程
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
  else hud_dim "请手动用浏览器打开：$1"
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

win_title BOOTING
hud_top
TITLE="G E O   P O S I T I O N   W O R K S T A T I O N"
if [ "${#TITLE}" -gt "$((COLS - 6))" ]; then
  TITLE="GEO POSITION WORKSTATION"
fi
printf '  %s%s%s\n' "$cb$ca" "$TITLE" "$cr"
case $GEO_FACE in
  macos) hud_dim "$G_P macOS · 系统自带「终端」· 不需要 Homebrew" ;;
  android) hud_dim "$G_P Android · Termux · 全程在本机跑" ;;
  *) hud_dim "$G_P Linux · 发行版自带终端${GEO_TERM_LABEL:+ · $GEO_TERM_LABEL}" ;;
esac
hud_sep
hud_kv '[SYS]' "平台 ${OS%%-*} · 端口 $PORT"
hud_kv '[BRG]' "有 Python 用 server.py，否则离线页"
hud_kv '[BND]' "只绑 127.0.0.1，非回环直接拒绝"
hud_kv '[PRV]' "不收经纬度参数；日志只在本机"
hud_kv '[RUN]' "入口 $ENTRY"
if [ "$COLS" -ge 56 ]; then
  # 宽窗口才打印这两行：它们说的是「这台终端被识别成什么」，是排障线索，不是装饰。
  if [ "$hud_color_on" = 1 ]; then
    TC_TXT="16 色阶梯"; [ "$hud_truecolor" = 1 ] && TC_TXT="24-bit 阶梯"
    hud_dim "$G_DOT $TC_TXT · $COLS 列 · COLORTERM=$COLORTERM"
  else
    hud_dim "$G_DOT 纯文本输出（管道或 GEO_COLOR=0）· $COLS 列"
  fi
  hud_dim "$G_DOT 窗口标题当状态灯：BOOTING → READY / DEGRADED"
fi
hud_sep
hud_dim "再跑一次，这行可以直接复制："
hud_cmd "cd \"$DIR\" && sh $ENTRY"
echo

if [ -z "$PY" ]; then
  win_title DEGRADED
  hud_state boot "没有可用的 Python3 —— 直接离线打开页面"
  hud_dim "这不是失败：只有 ⑧ 需要它。"
  hud_dim "其余十个面板与 ⑪ 自检，不联网也能全跑。"
  echo
  # 三份「怎么装解释器」只写各自那一行，共用的一句话只写一遍——
  # 同一条说明在三个分支里各抄一份，早晚会长得不一样。
  hud_dim "要 ⑧ 全功能，只差一个解释器："
  if [ "$FAMILY" = termux ]; then
    hud_cmd "pkg install python"
  elif [ "$FAMILY" = macos ]; then
    hud_cmd "xcode-select --install     # Command Line Tools"
    hud_dim "  2) 直接跑一次  python3 --version   （系统会弹窗问你要不要装）"
    hud_dim "  3) 已有 Homebrew：  brew install python"
  else
    hud_cmd "sudo apt install python3    # Debian / Ubuntu / Mint"
    hud_cmd "sudo dnf install python3    # Fedora / RHEL / Alma"
    hud_cmd "sudo pacman -S python       # Arch / Manjaro"
    hud_cmd "sudo zypper install python3 # openSUSE"
    hud_cmd "sudo apk add python3        # Alpine"
    hud_dim "用发行版自带的包管理器就行：不需要 pip、不需要编译、不需要第三方仓库。"
  fi
  echo
  hud_dim "装完重跑上面那行即可。"
  hud_dim "不装也照常用，只是 ⑧ 显示「桥接不可用」。"
  echo
  if [ "$FAMILY" = termux ]; then
    hud_dim "Termux 特有的两个坑："
    hud_cmd "termux-setup-storage"
    hud_dim "  想读手机存储里那一份，先跑一次授权。"
    hud_cmd "acquire wakelock"
    hud_dim "  否则安卓会挂起进程，⑧ 发到一半就断。"
  elif [ "$FAMILY" = macos ]; then
    hud_dim "macOS 特有的两个坑："
    hud_dim "  · 想双击 启动-macOS.command 而不是用终端，先给它可执行位："
    hud_cmd "chmod +x 启动-macOS.command"
    hud_dim "    从浏览器/ZIP 拿到的还可能被 Gatekeeper 拦，去掉隔离标记："
    hud_cmd "xattr -dr com.apple.quarantine ."
    hud_dim "  · 页面也可以完全不落盘：直接开在线地址"
    hud_cmd "https://iammezsh.github.io/geo-position-workstation/"
  else
    hud_dim "Linux 特有的两个坑："
    hud_dim "  · 双击 .sh 在不少文件管理器里是「用编辑器打开」，"
    hud_dim "    或问你一句却没终端窗口，看着像闪退。"
    hud_dim "    首选还是在自带终端里跑；真要双击就双击 启动-Linux.sh——"
    hud_dim "    它会钻进你自带的那个终端里继续跑。"
    hud_dim "  · 没有可执行位也照样能跑：用  sh  起，不要用  ./"
  fi
  echo
  open_page "index.html"
  echo
  hud_dim "完整说明见同目录 MANUAL.md（英文）。"
  hud_dim "含各平台最小文件清单——不必整包下载。"
  hud_bottom
  exit 0
fi

hud_state boot "用 $PY 拉起桥接（只绑回环）"
hud_dim "日志：$LOG"
nohup "$PY" server.py --port "$PORT" >"$LOG" 2>&1 &
BRIDGE_PID=$!

if wait_ready; then
  win_title READY
  hud_state ok "桥接在线 http://127.0.0.1:$PORT/"
  hud_dim "PID $BRIDGE_PID · 关掉本窗口即停止"
  hud_dim "⑧ 已解锁：DNS / ping / 逐跳追踪 / 网卡"
  hud_dim "网卡只报数量，MAC 与内网地址不返回。"
  open_page "http://127.0.0.1:$PORT/index.html"
else
  win_title DEGRADED
  hud_state bad "10 秒内没就绪（端口被占？）退回离线页"
  hud_cmd "PORT=9000 sh $ENTRY"
  hud_dim "⑧ 会显示「桥接不可用」，其余面板不受影响"
  kill $BRIDGE_PID >/dev/null 2>&1
  open_page "index.html"
fi

echo
hud_sep
hud_dim "完整说明见同目录 MANUAL.md（英文）。"
hud_dim "含各平台最小文件清单——不必整包下载。"
hud_bottom
