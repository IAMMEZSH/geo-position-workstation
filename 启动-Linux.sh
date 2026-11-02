#!/bin/sh
# 经纬度定位工作站 · Linux 启动器（不分发行版，一律用系统自带终端）
#
# 与 macOS 完全同一条路：不装任何东西，用你桌面本来就有那个终端。
#   1) 打开自带终端：GNOME 系（Ubuntu/Fedora）右键桌面「Open Terminal」或 Ctrl+Alt+T；
#      KDE 叫 Konsole；XFCE 叫 Terminal Emulator；Cinnamon 叫 Terminal；
#      LXQt 叫 QTerminal；纯 Wayland 上常见的是 foot 或 Konsole。
#   2) cd 到本目录，然后  sh 启动-Linux.sh
#
# 从文件管理器双击进来也算数：那种情况下脚本没有终端窗口，直接退出就像「闪退」，
# 所以它会探测你机器上装着的那个自带终端，在里面把自己重新拉起一次——不写 .desktop、
# 不改系统设置、不装依赖。桥接逻辑一律在 启动-macOS-Linux.sh 里，本文件只做
# 「进终端 + 转交」，和 macOS 的 启动-macOS.command 是同一个做法，两份不会各说各话。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
ENGINE="$DIR/启动-macOS-Linux.sh"
SELF="$DIR/启动-Linux.sh"
OS=$(uname -s 2>/dev/null || echo unknown)

# 已经在交互式终端里（或已经是重拉起的那一次）→ 直接转交。
# GEO_LAUNCHER_IN_TERMINAL 是重拉起时打的标记：万一那个终端起不来、又把脚本交回
# 一个没有 TTY 的环境，没有这个标记就会无限递归拉起自己。
# GEO_FACE 在这里点名一次：引擎按它选框线字形与色阶，流程逻辑不分叉。
if [ -n "$GEO_LAUNCHER_IN_TERMINAL" ] || { [ -t 0 ] && [ -t 1 ]; }; then
  GEO_FACE=linux sh "$ENGINE"
  exit $?
fi

# 没有 TTY。先看是不是无显示环境（SSH、WSL、容器、纯 tty 控制台）：
# 那种情况下拉不起图形终端，也根本不需要——命令就在当前 shell 里跑。
# 「这里没有图形会话」这句话交给引擎的横幅去说（GEO_TERM_LABEL），本文件不重复播报。
if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
  GEO_LAUNCHER_IN_TERMINAL=1 GEO_FACE=linux GEO_TERM_LABEL="无图形会话 SSH/WSL/容器" sh "$ENGINE"
  exit $?
fi

# 按「这个桌面自带的那个」顺序探测。$TERMINAL 优先：它是 freedesktop 的约定，
# 各 DE 都允许用户指定自己的终端。剩下的逐个点名，因为参数形状分两种
# （`-- CMD` 与 `-e CMD`），不存在通用写法，猜不得。
FOUND=""
if [ -n "$TERMINAL" ] && command -v "$TERMINAL" >/dev/null 2>&1; then
  FOUND=$TERMINAL
else
  for t in gnome-terminal mate-terminal konsole yakuake xfce4-terminal lxterminal \
           qterminal terminator tilix deepin-terminal kitty alacritty foot xterm; do
    if command -v "$t" >/dev/null 2>&1; then FOUND=$t; break; fi
  done
fi

if [ -z "$FOUND" ]; then
  GEO_LAUNCHER_IN_TERMINAL=1 GEO_FACE=linux GEO_TERM_LABEL="未探到可拉起的图形终端" sh "$ENGINE"
  exit $?
fi

# 只有 GNOME/MATE 系用 `--`；其余（含 KDE、XFCE、LXQt、iTerm 系的现代终端）用 `-e`。
case $FOUND in
  gnome-terminal | mate-terminal) ARGS=-- ;;
  *) ARGS=-e ;;
esac

echo "[终端] 用你系统自带的 $FOUND 开一个窗口，在里面继续启动。"
# 标签跟着进新窗口：横幅上写的是「真正跑了这次的那个终端」，不是探测列表里的第一个名字。
GEO_LAUNCHER_IN_TERMINAL=1 GEO_FACE=linux GEO_TERM_LABEL="$FOUND" "$FOUND" "$ARGS" sh "$SELF" >/dev/null 2>&1 && exit 0

# 拉起了但没成功（参数形状不同、权限、sandbox）→ 退回当前 shell，绝不让用户什么都不看到。
echo "[提示] $FOUND 没能拉起窗口，退回在当前 shell 里直接跑。"
GEO_LAUNCHER_IN_TERMINAL=1 GEO_FACE=linux GEO_TERM_LABEL="$FOUND" sh "$ENGINE"
exit $?
