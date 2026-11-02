#!/bin/sh
# 双击此文件即可（macOS）。逻辑都在 启动-macOS-Linux.sh，这里只负责切到正确目录再转交，
# 免得两份脚本各说各话。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
sh "$DIR/启动-macOS-Linux.sh"
