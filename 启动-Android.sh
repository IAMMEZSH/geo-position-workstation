#!/bin/sh
# 经纬度定位工作站 · Android（Termux）启动器
# 用法：在 Termux 里 cd 到本目录，执行  sh 启动-Android.sh
# 需要先装 Python（只有 ⑧ 需要它）：  pkg install python
# 把整个「经纬度定位工作站」文件夹放进手机存储（termux-setup-storage 后可见）即可完全离线使用。
#
# 本文件只点名脸：GEO_FACE=android 换成 44 列窄框、单线方角、绿→琥珀阶梯，
# 因为竖屏 Termux 常见就四十来列。回退逻辑与「只绑回环 / 不接收经纬度」那几条
# 一律由 启动-macOS-Linux.sh 说一次，这里不重复。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1

GEO_FACE=android exec sh "$DIR/启动-macOS-Linux.sh"
