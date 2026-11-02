#!/bin/sh
# 经纬度定位工作站 · Android（Termux）启动器
# 用法：在 Termux 里 cd 到本目录，执行  sh 启动-Android.sh
# 需要先装 Python：  pkg install python
# 把整个「经纬度定位工作站」文件夹放进手机存储（termux-setup-storage 后可见）即可完全离线使用。

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1

echo "Android 说明：本机桥接只绑 127.0.0.1，因此只有这台手机上的浏览器能用它；"
echo "              不会把服务暴露到局域网，也不接收任何经纬度参数（隐私红线，详见 说明书.md）。"
echo

exec sh "$DIR/启动-macOS-Linux.sh"
