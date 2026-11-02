#!/bin/sh
# 双击此文件即可（macOS）。横幅、色阶、三级回退（Python → 离线页面）都在
# 启动-macOS-Linux.sh 里，本文件只做本平台特有的两件事：切到正确目录、
# 把脸点名成 macos（细线圆框 + 青→紫→粉阶梯）。两份文件不会各说各话。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
GEO_FACE=macos exec sh "$DIR/启动-macOS-Linux.sh"
