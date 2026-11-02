#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按平台打最小包：一台设备只需要它那一类文件，不必整仓下载。

为什么要有这个脚本
    仓库里 66 个文件里有 2.79 MB 是界面截图、64 KB 是测试闸门、还有一个 PowerShell 桥
    和一个 Python 桥——它们分别只属于某一个平台。iPhone 用户不需要 启动-Windows.bat，
    Windows 用户不需要 启动-iSH.sh。本脚本把「哪个平台需要哪些文件」写成显式清单，
    一次生成 zip，并把清单本身变成可被 tests/check-package.py 断言的数据结构。

用法
    python 工具/pack-platform.py --list              # 打印每个平台的清单
    python 工具/pack-platform.py --check             # 校验清单（文件都在、覆盖完全、无越界）
    python 工具/pack-platform.py macos               # 只打 macos 包 -> dist/geo-macos.zip
    python 工具/pack-platform.py --all               # 打全部六个 + full
    python 工具/pack-platform.py --all --json dist/包清单.json

三条纪律
    1. 只用标准库（zipfile / argparse / json），因为这台机器可能没装任何东西。
    2. zip 里每个条目的时间戳钉死成 1980-01-01，同一份源码重复打包得到同样的字节，
       「文档里写的包大小」才不会因为哪天重新压一次就漂移。
    3. 除 full 以外的包不带 images/（那 2.79 MB 截图是文档用的），
       于是包内 MANUAL.md 的图片链接会被改写成 Pages 上的同一张图——
       文档只有一份源，改一次两边都改，不在包里塞一份重复的图。
"""

import argparse
import io
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PAGES_BASE = "https://iammezsh.github.io/geo-position-workstation/"

# 平台无关的那一份：界面 + 六个内核 + 离线数据 + 第三方库 + 样例输入。
# 少任何一个都不叫「能用的最小集」，所以逐条写死，不用通配符——
# 通配符会在有人往 app/ 里丢临时文件时悄悄把它打包发出去。
CORE = [
    "index.html",
    "favicon.svg",
    "LICENSE",
    "README.md",
    "MANUAL.md",
    "app/core-astro.js",
    "app/core-cell.js",
    "app/core-datums.js",
    "app/core-geodetic.js",
    "app/core-gnss.js",
    "app/core-net.js",
    "app/core-vault.js",
    "app/data/data-cities.js",
    "app/data/data-countries.js",
    "app/data/data-land.js",
    "app/style.css",
    "app/ui-app.js",
    "app/ui-map.js",
    "vendor/leaflet.css",
    "vendor/leaflet.js",
    "vendor/qrcode.js",
    "示例数据/L6-PPP-B2b电文示例.txt",
    "示例数据/NMEA语句示例.log",
    "示例数据/TDOA时差示例.txt",
    "示例数据/三角交会示例.txt",
    "示例数据/坐标批处理示例.csv",
    "示例数据/基站观测示例.csv",
    "示例数据/基站观测示例.json",
    "示例数据/指纹库示例.json",
    "示例数据/现场扫描示例.json",
    "示例数据/航迹示例.gpx",
]

# 三张机制图 + 一张 Apple 路径图 + 一张分包图：只有 43 KB，每个平台都带上，
# 因为「桥接为什么只绑回环」这类问题在任何平台都得看着图回答。
FIGURES = [
    "docs/img/architecture.svg",
    "docs/img/decision-flow.svg",
    "docs/img/privacy-boundary.svg",
    "docs/img/apple-launch-paths.svg",
    "docs/img/platform-packs.svg",
]

# 平台专有文件。这里的差别就是「分类」的全部内容：
#   Windows 有 PowerShell 5.1，所以零安装也有全功能桥；
#   其余平台的桥是 server.py，需要一个 python3；
#   macOS 与 Linux 各有一个「平台入口」（.command / 启动-Linux.sh），
#   负责本平台特有的事，桥接逻辑共用 启动-macOS-Linux.sh 那一份，不写两遍；
#   iSH 的 python3 要 apk add，Android 的走 Termux。
PLATFORMS = [
    ("browser", "Any device · UI only (no bridge)",
     CORE + FIGURES),
    ("windows", "Windows 10/11",
     CORE + FIGURES + ["启动-Windows.bat", "bridge-powershell.ps1", "server.py"]),
    ("macos", "macOS 12+",
     CORE + FIGURES + ["启动-macOS.command", "启动-macOS-Linux.sh", "server.py"]),
    ("linux", "Linux (any distro)",
     CORE + FIGURES + ["启动-Linux.sh", "启动-macOS-Linux.sh", "server.py"]),
    ("android", "Android · Termux",
     CORE + FIGURES + ["启动-Android.sh", "server.py"]),
    ("ios-ish", "iPhone / iPad · iSH or a-Shell",
     CORE + FIGURES + ["启动-iSH.sh", "server.py"]),
]

# 只属于开发/文档的文件：测试闸门、数据重建脚本、CI 配置、截图、包管理元数据。
# 它们必须出现在 full 包里，也必须被上面六个平台包排除。
DEV = [
    ".gitattributes",
    ".github/workflows/ci.yml",
    ".gitignore",
    "package.json",
    "tests/bridge-parity.py",
    "tests/check-package.py",
    "tests/run-all.mjs",
    "工具/build-data.mjs",
    "工具/pack-platform.py",
]

# 截图只进文档包：2.79 MB 的 PNG 对「今天就要用一个坐标」的人没有意义。
IMAGES = [
    "images/01-map-crosshair.png",
    "images/02-crosshair-readout.png",
    "images/03-coords-parse.png",
    "images/04-cell-trilateration.png",
    "images/05-gnss-pvt.png",
    "images/06-astro.png",
    "images/07-net-geoip.png",
    "images/08-net-traceroute.png",
    "images/09-selftest.png",
    "images/10-tri-bearing.png",
    "images/11-signal-rssi.png",
    "images/12-overview-session.png",
    "images/13-theme-light.png",
    "images/14-batch-export.png",
    "images/15-bridge-health.png",
]

# full 包 = 仓库里的一切：平台无关核心 + 每张机制图 + 各平台入口 + 开发文件 + 截图。
_PLATFORM_EXTRA = {rel for _n, _l, fs in PLATFORMS for rel in fs} - set(CORE) - set(FIGURES)
FULL = sorted(set(CORE) | set(FIGURES) | set(DEV) | set(IMAGES) | _PLATFORM_EXTRA)

FIXED_ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def toposix(rel):
    return rel.replace(os.sep, "/")


def show_path(p):
    """相对仓库根的展示路径。relpath 在 Windows 上跨盘符直接抛 ValueError——
    CI 的 windows runner 工作区在 D:、TEMP 在 C:，打包到临时目录就崩在这里。"""
    try:
        return toposix(os.path.relpath(p, ROOT))
    except ValueError:
        return toposix(os.path.abspath(p))


def abs_of(rel):
    return os.path.join(ROOT, *rel.split("/"))


def size_of(rel):
    p = abs_of(rel)
    return os.path.getsize(p) if os.path.isfile(p) else None


def manifest_for(platform):
    for name, _label, files in PLATFORMS:
        if name == platform:
            return list(files)
    if platform == "full":
        return list(FULL)
    return None


def platforms():
    return [name for name, _label, _files in PLATFORMS]


def labels():
    return {name: label for name, label, _files in PLATFORMS}


def missing_files(platform):
    m = manifest_for(platform)
    return [rel for rel in (m or []) if size_of(rel) is None]


def stats_for(platform):
    """(文件数, 未压缩字节)；不存在的文件不计入，由 --check 单独报错。"""
    m = manifest_for(platform) or []
    present = [rel for rel in m if size_of(rel) is not None]
    return len(present), sum(size_of(rel) for rel in present)


def rewrite_manual(text):
    """把包内 MANUAL.md 的图片相对链接改成 Pages 上同一张图。

    只在「这个包不带 images/」时调用。full 包保留相对路径，因为它自己就有图。
    """
    return text.replace("](images/", "](" + PAGES_BASE + "images/")


def build(platform, outdir, verbose=True):
    files = manifest_for(platform)
    if files is None:
        raise SystemExit("未知平台 %r（可选：%s）"
                         % (platform, ", ".join(platforms() + ["full"])))
    absent = [rel for rel in files if size_of(rel) is None]
    if absent:
        raise SystemExit("清单里的文件不在仓库里：%s\n"
                         "先补齐再打包（--check 会逐条告诉你缺哪个）。"
                         % ", ".join(absent))
    if not os.path.isdir(outdir):
        os.makedirs(outdir)
    zpath = os.path.join(outdir, "geo-%s.zip" % platform)
    folder = "geo-%s" % platform
    total = 0
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            data = open(abs_of(rel), "rb").read()
            arc = folder + "/" + rel
            if platform != "full" and rel == "MANUAL.md":
                data = rewrite_manual(data.decode("utf-8")).encode("utf-8")
            info = zipfile.ZipInfo(arc, date_time=FIXED_ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            # 外部属性按目标平台该有的权限位写：启动器必须可执行，否则 macOS/Linux
            # 上双击和 ./启动-xxx.sh 都不成立（Windows 忽略这几位，不影响 .bat）。
            base = 0o644 << 16
            if rel.endswith((".sh", ".command")):
                base = 0o755 << 16
            elif rel.endswith(".py") and rel == "server.py":
                base = 0o755 << 16
            info.external_attr = base
            z.writestr(info, data)
            total += len(data)
        n = len(files)
    zsize = os.path.getsize(zpath)
    if verbose:
        print("%-9s %2d files  raw %9d B  zip %9d B  -> %s"
              % (platform, n, total, zsize, show_path(zpath)))
    return {"platform": platform, "files": n, "raw_bytes": total,
            "zip_bytes": zsize, "zip": show_path(zpath),
            "list": files}


def check():
    """清单自检：文件在不在、有没有互相夹带、六个包 + DEV + IMAGES 是不是正好覆盖交付面。"""
    problems = []
    deliverable = set(FULL)
    covered = set()
    for name, _label, files in PLATFORMS:
        for rel in files:
            if size_of(rel) is None:
                problems.append("%s: 清单里的文件不存在 -> %s" % (name, rel))
            covered.add(rel)
        # 别的平台的启动器不许混进来
        foreign = [rel for rel in files
                   if rel in ("启动-Windows.bat", "启动-macOS.command", "启动-macOS-Linux.sh",
                              "启动-Linux.sh", "启动-Android.sh", "启动-iSH.sh",
                              "bridge-powershell.ps1")
                   and rel not in _own_launchers(name)]
        if foreign:
            problems.append("%s: 夹带了别的平台的入口 -> %s" % (name, ", ".join(foreign)))
    for rel in FULL:
        if size_of(rel) is None:
            problems.append("full: 清单里的文件不存在 -> %s" % rel)
    uncovered = sorted(deliverable - covered - set(DEV) - set(IMAGES))
    if uncovered:
        problems.append("没有任何平台包覆盖到的交付文件 -> %s" % ", ".join(uncovered))
    # 磁盘上有、清单里没有的仓库文件，必须出现在 DEV/IMAGES/CORE/FIGURES 之外，
    # 否则说明有人新加了文件却忘了归类（gate 的价值就在这条）。
    on_disk = set()
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames
                       if d not in (".git", "node_modules", "__pycache__", "dist", "_build")]
        for fn in filenames:
            rel = toposix(os.path.relpath(os.path.join(dirpath, fn), ROOT))
            if rel.startswith(".qoder") or rel in ("桥接服务.log", "bridge-powershell.log"):
                continue
            on_disk.add(rel)
    known = deliverable | set(DEV) | set(IMAGES)
    surprise = sorted(on_disk - known)
    if surprise:
        problems.append("磁盘上有但未归类（请归入 CORE/FIGURES/平台/DEV/IMAGES）-> %s"
                        % ", ".join(surprise))
    return problems


def _own_launchers(platform):
    own = {
        "windows": {"启动-Windows.bat", "bridge-powershell.ps1"},
        "macos": {"启动-macOS.command", "启动-macOS-Linux.sh"},
        # Linux 有自己的入口（钻进自带终端），但桥接逻辑和 macOS 共用那一份引擎。
        "linux": {"启动-Linux.sh", "启动-macOS-Linux.sh"},
        "android": {"启动-Android.sh"},
        "ios-ish": {"启动-iSH.sh"},
        "browser": set(),
    }
    return own.get(platform, set())


def main(argv=None):
    ap = argparse.ArgumentParser(description="按平台生成最小 zip 包")
    ap.add_argument("platform", nargs="?", help="browser|windows|macos|linux|android|ios-ish|full")
    ap.add_argument("--all", action="store_true", help="打全部六个平台包 + full")
    ap.add_argument("--list", action="store_true", help="打印每个平台的文件清单")
    ap.add_argument("--check", action="store_true", help="只校验清单，不打包")
    ap.add_argument("--json", help="把结果写成 JSON（供文档与闸门核对）")
    ap.add_argument("--outdir", default=os.path.join(ROOT, "dist"), help="输出目录，默认 dist/")
    args = ap.parse_args(argv)

    if args.list:
        for name, label, files in PLATFORMS:
            n, raw = stats_for(name)
            print("%-9s %-34s %2d files  raw %d B" % (name, label, n, raw))
            for rel in files:
                mark = " " if size_of(rel) is not None else "缺"
                print("    %s %s" % (mark, rel))
        n, raw = stats_for("full")
        print("%-9s %-34s %2d files  raw %d B" % ("full", "everything in the repo", n, raw))
        return 0

    if args.check:
        problems = check()
        for p in problems:
            print("[清单] %s" % p)
        if problems:
            return 1
        print("[清单] 六个平台包 + full 校验通过（文件齐全、无夹带、交付面无遗漏）")
        return 0

    targets = platforms() + ["full"] if args.all else [args.platform]
    if targets == [None]:
        ap.error("给一个平台名，或用 --all / --list / --check")
    results = [build(t, args.outdir) for t in targets]
    if args.json:
        buf = io.BytesIO()
        buf.write(json.dumps({"generated_by": "工具/pack-platform.py",
                              "pages_base": PAGES_BASE,
                              "packs": results},
                             ensure_ascii=False, indent=2,
                             sort_keys=True).encode("utf-8"))
        if not os.path.isdir(args.outdir):
            os.makedirs(args.outdir)
        with open(args.json, "wb") as fh:
            fh.write(buf.getvalue())
        print("清单 JSON -> %s" % show_path(args.json))
    return 0


if __name__ == "__main__":
    sys.exit(main())
