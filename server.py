#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""经纬度定位工作站 · 本地桥接服务（server.py）

为什么需要这个文件
------------------
浏览器的安全模型不允许发送原始 ICMP/UDP，也没有逐跳探测的接口，因此「路由追踪 / 受限 ping」
这类功能必须由本机一个小服务代跑系统命令（tracert / traceroute / ping / nslookup），
再把文本输出解析成结构化 JSON 交给前端 `app/core-net.js` 的 `GEONET.tracerouteViaBridge`。
除此之外没有任何理由需要这个服务：所有几何/卫星/基站计算都在浏览器里离线完成。

三条不可协商的红线（既写在代码里，也写在 --selftest 的断言里）
--------------------------------------------------------------
1. **只监听回环地址**（127.0.0.1 或 ::1）。本服务会把外部输入喂给系统命令，即便有白名单，
   把它绑到 0.0.0.0 也等于给同网段任何人一个「可参数化的命令执行入口」。
   所以 `--host 0.0.0.0`（或任何非回环地址）不是警告，是直接拒绝启动。
2. **argv 列表 + shell=False**。任何把主机名拼进命令行字符串的做法都会被
   `a.com; rm -rf /`、`` a.com`id` ``、`$(...)`、换行注入突破。这里外部输入永远只作为
   argv 的独立元素传入，永远不经过 shell；校验失败在**构造 argv 之前**就返回 400。
3. **默认不接收也不转发任何位置信息**。所有 `lat/lon/lng/latitude/longitude/position/loc/accuracy`
   参数名一律 400 拒绝；GeoIP 代理只接受 IP 字面量或留空（查询自己的出口 IP），
   上游 URL 只允许来自内置来源表（避免把本服务变成 SSRF 跳板）。

设计上的取舍
------------
* 只用标准库（http.server / socket / subprocess / json / urllib / threading），
  不装任何依赖、不联网下载，双击即可跑；代价是没有连接池与并发限流，
  所以额外做了「单请求墙钟上限 + 输出字节上限」来兜住失控的子进程。
* 解析器只认「文本结构」，不认任何厂商的措辞；无法识别的行按原样保留在 raw_lines 里，
  解析不出来就返回空 hops + 中文说明，**绝不编造跳数**（前端也断言 fabricated_hops=false）。
* 上游字段名（各家 GeoIP 服务）按公开文档写的，**未逐字段核对**；所以 /api/geoip 同时返回
  `upstream`（原样透传，前端要什么字段自己取）和 `normalized`（尽力归一，取不到就是 null）。

用法
----
    python server.py                 # 默认 http://127.0.0.1:8765
    python server.py --port 9000     # 换端口（仍只绑回环）
    python server.py --selftest      # 离线自检：不监听端口、不发任何外部请求
    Ctrl+C                           # 随时停止
"""

import argparse
import ast
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ================================================================ 0. 常量

VERSION = "1.0.0"
SERVER_NAME = "geonet-bridge"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

# 只有这几个地址允许绑定。'localhost' 在多数系统上解析到 127.0.0.1/::1，
# 仍然接受，但启动时会打印它实际解析到的地址，避免「以为在回环其实不是」。
LOOPBACK_ALLOWED = ("127.0.0.1", "::1", "localhost", "127.0.0.53")

MAX_HOST_LEN = 253            # DNS 全名的 RFC 长度上限（经验值，写死避免超长参数灌进 argv）
MAX_LABEL_LEN = 63
# 白名单字符集：与 app/core-net.js 的 HOST_CHARSET_RE 保持一致（两侧互不信任，各自校验）。
HOST_CHARSET_RE = re.compile(r"^[A-Za-z0-9._:-]+$")
# 显式黑名单：即使白名单已经排除了它们，第二道检查仍保留——
# 万一以后有人放宽了白名单正则，这里还能挡住 shell 元字符。
FORBIDDEN_CHARS = frozenset(" \t\r\n\v\f<>`|;&$()'\"\\")
MAX_HOPS_LIMIT = 30           # tracert 的 -h 上限；超过只会让一次请求占用几分钟
MAX_PING_COUNT = 10
OUTPUT_CAP_BYTES = 1 << 20    # 子进程输出最多读 1 MiB：防止异常刷屏把内存吃掉
WALL_CLOCK_CAP_S = 180.0      # 单请求墙钟上限（比子进程 timeout 更外层的一道保险）
STATIC_MAX_BYTES = 64 << 20   # 静态文件最大 64 MiB

# 隐私红线：这些参数名一旦出现在 /api/* 的查询串里，直接 400。
POSITION_PARAMS = frozenset({
    "lat", "lon", "lng", "latitude", "longitude", "position", "loc", "accuracy",
    "alt", "altitude", "bearing", "speed", "heading",
})

IPV4_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")
IPV4_FIND_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")
IPV6_FIND_RE = re.compile(r"\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b")
MS_RE = re.compile(r"(<)?(\d+(?:[.,]\d+)?)\s*(?:ms|毫秒)", re.IGNORECASE)
HOP_LEAD_RE = re.compile(r"^\s*(\d{1,3})\s+(.*)$")
# 「请求超时」在不同系统/语言下的写法；只用于判定「这一跳没回应」，不用于推断任何 RTT。
TIMEOUT_HINTS = ("超时", "timed out", "request timed out", "无响应", "* * *")

IS_WINDOWS = os.name == "nt"

# 全局锁只保护「写日志」这一件事：ThreadingHTTPServer 会并发处理请求，
# 而 print 交错会让每请求一行日志变成不可读的碎条。
_LOG_LOCK = threading.Lock()
# 在跑的子进程数：用于 /api/health 的负载提示，也用于软限流（超过阈值直接 503）。
_ACTIVE = {"children": 0, "max_children": 4}
_ACTIVE_LOCK = threading.Lock()


def log_line(message):
    """每请求一行日志：时间 + 方法 + 路径 + 状态 + 耗时（由调用方拼好）。"""
    with _LOG_LOCK:
        sys.stdout.write(message + "\n")
        sys.stdout.flush()


# ================================================================ 1. 输入校验（纯函数）

def validate_host(raw, max_len=MAX_HOST_LEN):
    """白名单式主机名校验。返回 dict：{ok, host, kind, reason}。

    为什么是「白名单 + 结构校验」而不是「黑名单去掉了危险字符」：
    黑名单永远列不全（反引号、`$()`、换行、NUL、各种全角同形字……），
    而合法主机名的字符集是闭集 `[A-Za-z0-9._:-]`，收紧它不会误伤任何正常用法。

    注意：这个函数**不做 DNS**。它的职责只是「不让任意字符串进入命令」，
    不是「确认这个域名存在」。解析单独由 /api/dns 负责。
    """
    if not isinstance(raw, str):
        return {"ok": False, "host": None, "kind": None, "reason": "主机名必须是字符串"}
    s = raw.strip()
    if not s:
        return {"ok": False, "host": None, "kind": None, "reason": "主机名为空"}
    if len(s) > max_len:
        return {"ok": False, "host": None, "kind": None,
                "reason": "主机名过长（%d > %d）" % (len(s), max_len)}
    if not HOST_CHARSET_RE.match(s):
        return {"ok": False, "host": None, "kind": None,
                "reason": "含白名单 [A-Za-z0-9._:-] 之外的字符（空格/引号/分号/反引号/$()/换行等一律拒绝）"}
    hit = sorted({c for c in s if c in FORBIDDEN_CHARS})
    if hit:
        return {"ok": False, "host": None, "kind": None,
                "reason": "含 shell 元字符：" + " ".join(repr(c) for c in hit)}
    if "\x00" in s:
        return {"ok": False, "host": None, "kind": None, "reason": "含 NUL 字符"}
    if ".." in s:
        return {"ok": False, "host": None, "kind": None, "reason": "含连续点（非法域名）"}
    # 首字符是 '-' 会被命令当成选项（例如 `-h` 覆盖跳数、`-6` 改协议族），必须拒绝；
    # 尾部的 '-'/'.'/':' 是非法标签或截断写法，同样拒绝。
    if s.startswith("-"):
        return {"ok": False, "host": None, "kind": None, "reason": "以 - 开头（会被当作命令选项注入）"}
    if s.endswith("-"):
        return {"ok": False, "host": None, "kind": None, "reason": "以 - 结尾（非法域名标签）"}
    if s.startswith(".") or s.endswith("."):
        return {"ok": False, "host": None, "kind": None, "reason": "以点开头/结尾（非法域名）"}
    if s.startswith(":") and not s.startswith("::"):
        return {"ok": False, "host": None, "kind": None, "reason": "单个前导冒号不是合法 IPv6"}
    if s.endswith(":"):
        return {"ok": False, "host": None, "kind": None, "reason": "以冒号结尾（截断的 IPv6）"}

    m = IPV4_RE.match(s)
    if m:
        for i in range(1, 5):
            part = m.group(i)
            if len(part) > 1 and part[0] == "0":
                # 前导零在部分 libc 里按八进制解释（010 == 8），会产生「看着不一样」的地址，直接拒。
                return {"ok": False, "host": None, "kind": "ipv4",
                        "reason": "IPv4 段含前导零（%s），按八进制歧义拒绝" % part}
            n = int(part)
            if not (0 <= n <= 255):
                return {"ok": False, "host": None, "kind": "ipv4", "reason": "IPv4 段越界（%s）" % part}
        return {"ok": True, "host": s, "kind": "ipv4", "reason": None}

    if ":" in s:
        # IPv6 字面量：只允许十六进制、点与冒号；压缩符 '::' 最多一次。
        # 用 indexOf/lastIndexOf 的等价写法能抓住 '2001:db8:::1' 这种重叠写法。
        if not re.match(r"^[0-9A-Fa-f:.]+$", s):
            return {"ok": False, "host": None, "kind": "ipv6", "reason": "IPv6 含非十六进制字符"}
        first, last = s.find("::"), s.rfind("::")
        if first >= 0 and first != last:
            return {"ok": False, "host": None, "kind": "ipv6", "reason": "IPv6 压缩符 :: 出现多次"}
        if ":::" in s:
            return {"ok": False, "host": None, "kind": "ipv6", "reason": "IPv6 出现连续三个及以上冒号"}
        groups = [g for g in s.replace("::", ":").split(":") if g != ""]
        for g in groups:
            head = g.split(".")[0]
            if not re.match(r"^[0-9A-Fa-f]+$", head) and not IPV4_RE.match(g):
                return {"ok": False, "host": None, "kind": "ipv6", "reason": "IPv6 分组含非法字符（%s）" % g}
            if len(head) > 4 and not IPV4_RE.match(g):
                return {"ok": False, "host": None, "kind": "ipv6", "reason": "IPv6 分组超长（%s）" % g}
        if len(groups) > 8:
            return {"ok": False, "host": None, "kind": "ipv6", "reason": "IPv6 分组超过 8 段"}
        if "." in s and not IPV4_RE.match(s.split(":")[-1]):
            return {"ok": False, "host": None, "kind": "ipv6", "reason": "IPv6 内嵌 IPv4 部分非法"}
        return {"ok": True, "host": s, "kind": "ipv6", "reason": None}

    # 域名：标签只允许字母数字连字符，且不以连字符开头/结尾。
    labels = s.split(".")
    for lab in labels:
        if not re.match(r"^[A-Za-z0-9-]+$", lab):
            return {"ok": False, "host": None, "kind": "domain", "reason": "域名标签含非法字符（%s）" % lab}
        if len(lab) > MAX_LABEL_LEN:
            return {"ok": False, "host": None, "kind": "domain", "reason": "域名标签超过 %d 字符" % MAX_LABEL_LEN}
        if lab.startswith("-") or lab.endswith("-"):
            return {"ok": False, "host": None, "kind": "domain", "reason": "标签以连字符开头/结尾（%s）" % lab}
    if not re.search(r"[A-Za-z0-9]", s):
        return {"ok": False, "host": None, "kind": "domain", "reason": "域名无字母数字"}
    if re.match(r"^\d+$", labels[-1]):
        # 末段全数字多半是想写 IPv4 却多写了一段（如 1.2.3.4.5）；拒绝而不是猜测。
        return {"ok": False, "host": None, "kind": "domain", "reason": "末段为纯数字（疑似写错的 IPv4 字面量），拒绝"}
    return {"ok": True, "host": s, "kind": "domain", "reason": None}


def find_position_params(query_dict):
    """挑出查询串里的「位置类」参数名（返回小写、排序后的列表）。

    为什么要单独一步：隐私红线要靠结构保证，不能靠「前端没传」。
    万一以后有人给 UI 加了个「把当前坐标发给桥接服务复用缓存」的便利功能，
    这一层会直接把请求打回 400，让错误在开发期就暴露，而不是静默泄漏。
    统一转小写：HTTP 参数名大小写敏感，但 `LON=121` 显然也该拦 —— 按语义拦而不是按字面拦。
    """
    bad = set()
    for key in (query_dict or {}):
        name = str(key).strip().lower()
        if name in POSITION_PARAMS:
            bad.add(name)
    return sorted(bad)


def clamp_int(raw, default, low, high):
    """把查询参数安全地夹到 [low, high]。非数字一律回到默认值，绝不抛异常。"""
    try:
        v = int(str(raw).strip())
    except (TypeError, ValueError):
        v = default
    return max(low, min(high, v))


def is_bind_address_loopback(host):
    """判断要绑定的地址是否是回环。返回 (ok, reason)。

    这里刻意用「白名单 + 实际解析结果」双重判定：
    `localhost` 名字上安全，但如果用户在 hosts 文件里把它指向了网卡地址，
    绑定它其实就不是回环了 —— 所以还要看 getaddrinfo 回来的地址是否在 127/8 或 ::1。
    """
    if not isinstance(host, str) or not host.strip():
        return False, "绑定地址为空"
    h = host.strip()
    if h in ("0.0.0.0", "::", "*", ""):
        return False, "禁止绑定 %s：本服务会把参数喂给系统命令，暴露到任何网卡都是危险的" % h
    if h in LOOPBACK_ALLOWED:
        # 名字在白名单里，但仍要确认它真的解析回环（hosts 文件可能被改）。
        try:
            infos = socket.getaddrinfo(h, None, 0, socket.SOCK_STREAM)
            addrs = {i[4][0] for i in infos}
            if addrs and all(a.startswith("127.") or a == "::1" for a in addrs):
                return True, None
            return False, "「%s」实际解析到 %s，不是回环地址；请显式使用 127.0.0.1" % (h, ",".join(sorted(addrs)))
        except socket.gaierror as exc:
            return False, "无法解析绑定地址「%s」：%s" % (h, exc)
    if h.startswith("127."):
        return True, None
    if h == "::1":
        return True, None
    # IPv6 回环的少见写法 ::ffff:127.0.0.1
    if h.lower().startswith("::ffff:127."):
        return True, None
    return False, "只允许绑定回环地址（127.0.0.1 / ::1 / localhost），当前是 %s" % h


def safe_join(root, raw_path):
    """把 URL 路径安全地拼到静态根目录下。返回 (ok, 绝对路径或原因)。

    防线（三层，缺一层的常见事故都能在历史 CVE 里找到）：
      1) 先解百分号编码再判 `..`：`%2e%2e%2f` 不解码就检查看起来是干净的。
      2) 逐段拒绝 `..`/绝对路径/NUL/控制字符：不做「把 .. 删掉」这种规范化，
         因为删掉之后的路径已经不是用户要的那个了，静默改写更容易出错。
      3) 最后用 realpath + commonpath 复核：符号链接、`C:` 与 `C:/` 的盘根差异、
         大小写差异都会在实文件系统层面暴露，这一步兜住前两步的遗漏。
    另外拒绝点开头文件（.env/.git/.ssh）和常见私钥/数据库扩展名 —— 静态目录里
    一旦有人误放了凭据，不该被一个「只是想看 index.html」的服务顺手带出来。
    """
    if not isinstance(raw_path, str):
        return False, "路径必须是字符串"
    try:
        decoded = urllib.parse.unquote(raw_path)
    except (UnicodeDecodeError, ValueError):
        decoded = raw_path
    if any(ord(c) < 32 or ord(c) == 127 for c in decoded):
        return False, "路径含控制字符"
    if "\x00" in decoded:
        return False, "路径含 NUL"
    if re.match(r"^[a-zA-Z]:[\\/]", decoded):
        return False, "路径含 Windows 绝对盘符，拒绝"
    if decoded.startswith("\\") or decoded.startswith("//"):
        return False, "路径是 UNC/双斜杠的绝对写法，拒绝"
    if "\\" in decoded:
        return False, "路径含反斜杠（Windows 分隔符），拒绝"
    # URL 路径天生就是「以 / 开头」的，这里剥掉的只是这个根锚点，不是绝对路径判断的一部分：
    # 剥完之后剩下的段一律相对 root 解释。真正的绝对写法（盘符、UNC、双斜杠）在上面已经拒了。
    if decoded.startswith("/"):
        decoded = decoded[1:]
    segs = decoded.split("/")
    clean = []
    for seg in segs:
        if seg in ("", "."):
            continue
        if seg == "..":
            return False, "路径含 ..（目录穿越），拒绝"
        if seg.startswith("."):
            return False, "路径含点文件/点目录（%s），拒绝" % seg
        clean.append(seg)
    root_real = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(root_real, *clean)) if clean else root_real
    try:
        common = os.path.commonpath([root_real, candidate])
    except ValueError as exc:
        # commonpath 在「不同盘符」或「一个是相对一个绝对」时抛 ValueError：直接判非法。
        return False, "路径与静态根目录不可比（%s），拒绝" % exc
    if os.path.normcase(common) != os.path.normcase(root_real):
        return False, "路径解析后逃出静态根目录，拒绝"
    base = os.path.basename(candidate)
    if base.startswith("."):
        return False, "拒绝提供点文件（%s）" % base
    ext = os.path.splitext(base)[1].lower()
    if ext in SECRET_EXTS:
        return False, "拒绝提供敏感类型文件（%s）" % ext
    return True, candidate


SECRET_EXTS = frozenset({
    ".key", ".pem", ".p12", ".pfx", ".jks", ".id_rsa", ".sqlite", ".db", ".env", ".kdbx",
    # .log 是本服务自己写的那份访问日志（bridge-*.log）：里面是用户查过哪些主机/URL 的
    # 原样请求行。桥接既然能写它，就必须不能把它当静态资源发出去。
    ".log",
})

# ================================================================ 2. 子进程调用（shell=False）

TOOL_CANDIDATES = {
    # 顺序 = 优先级。Windows 只有 tracert，类 Unix 一般是 traceroute（BSD 与 IPutils 参数不同，
    # 由 build_traceroute_argv 按平台区分，不给它「猜参数」的机会）。
    "traceroute": ["tracert"] if IS_WINDOWS else ["traceroute", "tracepath"],
    "ping": ["ping"],
}


def which_tool(kind):
    """返回可执行文件的绝对路径，找不到返回 None（调用方降级，不抛异常）。

    用 shutil.which 而不是裸命令名：解析出来的绝对路径进 argv，可避免
    PATH 被污染时执行到同名的恶意程序（当前目录优先在 Windows 上是历史老问题）。
    """
    for name in TOOL_CANDIDATES.get(kind, []):
        path = shutil.which(name)
        if path:
            return path
    return None


def build_traceroute_argv(host, max_hops, timeout_s, exe=None):
    """构造 tracert/traceroute 的 argv 列表（**永远是列表，永远没有 shell**）。

    host 必须作为独立元素出现在最后一位；本函数不接受任何含空格的字符串，
    validate_host 已保证它不含 shell 元字符。
    `exe` 参数是给离线自检注入假路径用的（自检绝不依赖本机装了什么命令）。
    """
    if exe is None:
        exe = which_tool("traceroute")
    if not exe:
        return None, "本机找不到 traceroute/tracert 命令（未安装或不在 PATH）"
    hops = str(max(1, min(MAX_HOPS_LIMIT, int(max_hops))))
    secs = max(1, min(30, int(timeout_s)))
    if IS_WINDOWS:
        # -d 禁止把 IP 反解成主机名：反解会把「查询 DNS」混进本服务，慢且隐私上多一步。
        # -w 单位是毫秒。
        return [exe, "-d", "-h", hops, "-w", str(secs * 1000), host], exe
    if sys.platform == "darwin":
        # macOS 的 -w 是秒；-q 每跳探测次数
        return [exe, "-n", "-m", hops, "-w", str(secs), "-q", "1", host], exe
    # Linux（iputils）：-w 整体等待秒，-z 等待秒，-q 每跳次数
    return [exe, "-n", "-m", hops, "-w", str(secs), "-z", str(secs), "-q", "1", host], exe


def build_ping_argv(host, count, timeout_s, exe=None):
    if exe is None:
        exe = which_tool("ping")
    if not exe:
        return None, "本机找不到 ping 命令"
    n = str(max(1, min(MAX_PING_COUNT, int(count))))
    secs = max(1, min(30, int(timeout_s)))
    if IS_WINDOWS:
        return [exe, "-n", n, "-w", str(secs * 1000), "-l", "32", host], exe
    return [exe, "-c", n, "-W", str(secs), "-i", "1", host], exe


def _decode_out(data):
    """子进程输出解码。

    Windows 的控制台默认是本地代码页（中文系统上常见 cp936/gbk），不是 UTF-8；
    直接 utf-8 解码会把中文提示变成乱码或抛异常，而 traceroute 的「请求超时。」
    恰好是中文 —— 那是判定「这一跳没回应」的关键字，不能丢。
    """
    if not data:
        return ""
    for enc in ("utf-8", "gb18030", "cp936", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def run_command(argv, timeout_s, env=None):
    """执行 argv（shell=False），返回 dict。任何失败都变成结构化字段，不抛异常。

    为什么强调 shell=False：subprocess.run(str, shell=True) 等价于
    `/bin/sh -c "<整串>"`，此时白名单再严也白搭——分号、反引号、`$()`、换行
    都会在 shell 层重新获得语法含义。用 argv 列表时这些字符只是「某个参数里的字面量」。
    """
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) for x in argv):
        return {"ok": False, "error_kind": "bad_input", "error": "argv 必须是非空字符串列表", "stdout": "", "stderr": "", "code": None}
    # argv[0] 是可执行文件路径，Windows 上必然含反斜杠，所以只检**参数部分**：
    # 正常参数只有标志位、数字与已过滤的主机名，出现这些字符就说明上游校验被绕过。
    for tok in argv[1:]:
        if any(c in tok for c in ("\x00", "\n", "\r", ";", "|", "&", "`", "$", "<", ">", "\\")):
            return {"ok": False, "error_kind": "bad_input", "error": "参数含可疑字符，拒绝执行：%r" % tok,
                    "stdout": "", "stderr": "", "code": None}
    budget = max(1.0, min(float(timeout_s), WALL_CLOCK_CAP_S))
    with _ACTIVE_LOCK:
        if _ACTIVE["children"] >= _ACTIVE["max_children"]:
            return {"ok": False, "error_kind": "busy", "error": "并发子进程已达上限（%d），请稍后重试"
                    % _ACTIVE["max_children"], "stdout": "", "stderr": "", "code": None}
        _ACTIVE["children"] += 1
    started = time.monotonic()
    try:
        kwargs = {
            "shell": False,               # ← 硬要求：永远不经过 shell
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "timeout": budget,
            "stdin": subprocess.DEVNULL,  # 防止命令读 stdin 卡住整个请求
            "env": env or os.environ,
            "close_fds": True,
        }
        if IS_WINDOWS:
            # 不弹控制台窗口（双击 .py 运行时那个黑框闪一下就没了，很烦）
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        proc = subprocess.run(argv, **kwargs)
        out = _decode_out(proc.stdout or b"")[:OUTPUT_CAP_BYTES]
        err = _decode_out(proc.stderr or b"")[:OUTPUT_CAP_BYTES]
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": out,
            "stderr": err,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
            "argv_shape": [os.path.basename(argv[0]), "<%d args>" % (len(argv) - 1)],
            "timed_out": False,
            "error_kind": None if proc.returncode == 0 else "command_failed",
            "error": None if proc.returncode == 0 else "命令返回非零状态码 %s（可能是目标不可达或权限不足）" % proc.returncode,
        }
    except subprocess.TimeoutExpired as exc:
        # 超时时的部分输出：subprocess 已经 kill 了子进程，但前面拿到的跳仍然是真实测得值，
        # 保住它们比丢掉更有用（也符合「有就说有、没有就说没有」的口径）。
        partial = _decode_out(exc.stdout or b"")[:OUTPUT_CAP_BYTES] if isinstance(exc.stdout, (bytes, str)) else ""
        return {"ok": False, "error_kind": "timeout",
                "error": "命令超过 %ss 未完成，已终止子进程（下面是有 timeout 事件前拿到的部分输出）" % round(budget, 1),
                "stdout": partial, "stderr": "",
                "code": None, "elapsed_ms": round((time.monotonic() - started) * 1000, 1), "timed_out": True}
    except FileNotFoundError:
        return {"ok": False, "error_kind": "command_missing", "error": "找不到可执行文件：%s" % os.path.basename(argv[0]),
                "stdout": "", "stderr": "", "code": None, "elapsed_ms": 0, "timed_out": False}
    except OSError as exc:
        return {"ok": False, "error_kind": "os_error", "error": "启动子进程失败：%s" % exc,
                "stdout": "", "stderr": "", "code": None, "elapsed_ms": 0, "timed_out": False}
    finally:
        with _ACTIVE_LOCK:
            _ACTIVE["children"] -= 1

# ================================================================ 3. 文本解析（纯函数，可离线自测）

def parse_traceroute_text(text):
    """把 tracert / traceroute 的文本输出解析成 hops 列表。返回 dict{hops, target_ip, unparsed}。

    为什么只认「结构」不认「措辞」：各系统/语言的提示语不同（中文「请求超时。」、
    英文 "Request timed out."、BSD 的 `* * *`），但**行首是跳号 + 行内含 IP 与 N 个 ms**
    这个结构是共通的。任何解析不出来的行原样进 unparsed 供人核对，不做二次加工。

    重要：本函数是「解析器测试」的目标，不保证覆盖所有厂商输出；解析不出时返回空 hops，
    调用方必须如实报告「0 跳」，**不得**用推测填补（前端也断言 fabricated_hops=false）。
    """
    hops = []
    unparsed = []
    target_ip = None
    body = text if isinstance(text, str) else ""
    lines = body.splitlines()
    for idx, line in enumerate(lines):
        raw = line.rstrip("\r")
        if not raw.strip():
            continue
        # 头部行：`Tracing route to example.com [93.184.216.34]` / `traceroute to x (1.2.3.4), 5 hops max`
        if target_ip is None:
            m = re.search(r"[\[(]\s*(\d{1,3}(?:\.\d{1,3}){3}|(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4})\s*[\])]", raw)
            if m and not HOP_LEAD_RE.match(raw):
                target_ip = m.group(1)
                continue
        m = HOP_LEAD_RE.match(raw)
        if not m:
            # 非跳行（标题、"Trace complete."、错误提示）：只在含明显错误字样时保留
            if any(k in raw for k in ("无法访问", "找不到", "Request could not find", "cannot resolve", "Unknown host", "没有与这些网络")):
                unparsed.append(raw.strip()[:200])
            continue
        hop_no = int(m.group(1))
        rest = m.group(2)
        v4 = IPV4_FIND_RE.findall(rest)
        v6 = [a for a in IPV6_FIND_RE.findall(rest) if a not in v4]
        ips = v4 + v6
        # Windows tracert 把亚毫秒的样本印成「<1 毫秒」（单位还本地化了，正常样本仍是 ms）。
        # 这类带 < 的是上界而不是测量值，取中点或写 0 都是编数，所以原样留在 rtt_bounds 里。
        times, bounds = [], []
        for gt, gv in MS_RE.findall(rest):
            val = float(gv.replace(",", "."))
            if gt:
                bounds.append("<" + ("%g" % val))
            else:
                times.append(val)
        star_count = rest.count("*")
        low = rest.lower()
        timed_out = (not times and not bounds and not ips) or any(h in low for h in TIMEOUT_HINTS) \
            or ("超时" in rest and not times and not bounds)
        # 主机名：把 IP 与 "N ms" 从行里抠掉，剩下的字母串就是（tracert 不带 -d 时会有）。
        residue = rest
        for a in ips:
            residue = residue.replace(a, " ", 1)
        residue = MS_RE.sub(" ", residue)
        residue = residue.replace("*", " ")
        words = [w for w in re.split(r"[\s,]+", residue) if w and re.match(r"^[A-Za-z0-9._-]+$", w) and not re.match(r"^\d+$", w)]
        hostname = words[0][:128] if words else None
        hops.append({
            "hop": hop_no,
            "ip": ips[0] if ips else None,
            "hostname": hostname,
            "rtts_ms": [round(t, 3) for t in times],
            "rtt_bounds": bounds,
            "star_count": star_count,
            "timed_out": bool(timed_out),
            "status": "timeout" if timed_out else ("ok" if (times or bounds or ips) else "unknown"),
            "alt_ips": ips[1:],
            "raw": raw.strip()[:240],
        })
    hops.sort(key=lambda h: h["hop"])
    return {"hops": hops, "target_ip": target_ip, "unparsed": unparsed[:12]}


def parse_ping_text(text):
    """解析 ping 的统计段。中英文标签都试；取不到就是 None（不猜 0）。"""
    out = {
        "target_ip": None, "sent": None, "received": None, "lost": None, "loss_percent": None,
        "min_ms": None, "avg_ms": None, "max_ms": None, "mdev_ms": None, "samples_ms": [],
    }
    body = text if isinstance(text, str) else ""
    m = re.search(r"[\[(]\s*(\d{1,3}(?:\.\d{1,3}){3})\s*[\])]", body)
    if m:
        out["target_ip"] = m.group(1)
    # 单条回复的时间样本：中文「时间=1ms」/英文 "time=1ms"
    out["samples_ms"] = [float(x.replace(",", ".")) for x in
                         re.findall(r"(?:时间|time)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms", body, re.IGNORECASE)]
    # Linux(iputils) 写 `2 packets transmitted, 0 received`，macOS/BSD 写 `0 packets received`：
    # 量词 packets 在一行里可能出现也可能不出现，所以两侧都做成可选，否则 macOS 的 ping
    # 会被解析成「收到了 null」，前端把一次真实的全丢包误报成命令失败。
    sent = re.search(r"(?:已发送|发送|Sent)\s*[=:]\s*(\d+)|(\d+)\s+packets?\s+transmitted", body, re.IGNORECASE)
    recv = re.search(r"(?:已接收|接收|Received)\s*[=:]\s*(\d+)|(\d+)\s+(?:packets\s+)?received", body, re.IGNORECASE)
    lost = re.search(r"(?:丢失|Lost)\s*[=:]\s*(\d+)|(\d+)\s+(?:packets\s+)?lost", body, re.IGNORECASE)
    # 丢包率的写法差别最大：`50% 丢失` / `0% loss` / `0% packet loss` —— 所以 % 与关键词之间允许几个词。
    loss = re.search(r"(\d+(?:[.,]\d+)?)\s*%[^\n]{0,14}?(?:丢失|loss)", body, re.IGNORECASE)
    for key, match in (("sent", sent), ("received", recv), ("lost", lost)):
        if match:
            out[key] = int(next(g for g in match.groups() if g is not None))
    if loss:
        out["loss_percent"] = float(loss.group(1).replace(",", "."))
    trip = re.search(r"(?:最短|Minimum)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms.*?"
                     r"(?:最长|Maximum)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms.*?"
                     r"(?:平均|Average)\s*[=:]\s*(\d+(?:[.,]\d+)?)\s*ms", body, re.IGNORECASE | re.DOTALL)
    if trip:
        out["min_ms"] = float(trip.group(1).replace(",", "."))
        out["max_ms"] = float(trip.group(2).replace(",", "."))
        out["avg_ms"] = float(trip.group(3).replace(",", "."))
    rtt = re.search(r"(?:rtt|round-trip)[^=]*=\s*([\d.]+)/([\d.]+)/([\d.]+)(?:/([\d.]+))?", body, re.IGNORECASE)
    if rtt:
        out["min_ms"] = float(rtt.group(1))
        out["avg_ms"] = float(rtt.group(2))
        out["max_ms"] = float(rtt.group(3))
        if rtt.group(4):
            out["mdev_ms"] = float(rtt.group(4))
    # 样本兜底：统计段缺失时用单条回复算（这是真实测得值，不是推测值）
    if out["avg_ms"] is None and out["samples_ms"]:
        vals = out["samples_ms"]
        out["min_ms"], out["max_ms"] = min(vals), max(vals)
        out["avg_ms"] = round(sum(vals) / len(vals), 3)
    return out


# ================================================================ 4. GeoIP 上游（透传 + 归一）

GEOIP_SOURCES = {
    "ipapi_com": {
        "name": "ip-api.com",
        "url_self": "http://ip-api.com/json/?fields=status,message,query,lat,lon,city,country,countryCode",
        "url_query": "http://ip-api.com/json/{ip}?fields=status,message,query,lat,lon,city,country,countryCode",
        "requires_key": False,
        # 免费版只有明文 HTTP：查询内容（你的出口 IP）对链路上任何人可见。如实标注，用不用由调用方决定。
        "note": "免费版走明文 HTTP；字段名按公开文档，未逐字段核对",
        "status_key": "status", "status_ok": "success",
        "ip_keys": ["query", "ip"], "lat_keys": ["lat", "latitude"], "lon_keys": ["lon", "longitude"],
        "acc_keys": [], "city_keys": ["city"], "country_keys": ["country", "countryName"],
    },
    "ipinfo_io": {
        "name": "ipinfo.io",
        "url_self": "https://ipinfo.io/json",
        "url_query": "https://ipinfo.io/{ip}/json",
        "requires_key": False,
        "note": "loc 是「纬度,经度」的单个逗号字符串（顺序容易写反）；按公开文档，未逐字段核对",
        "ip_keys": ["ip"], "lat_keys": ["loc"], "lon_keys": ["loc"], "split_loc": True,
        "acc_keys": [], "city_keys": ["city"], "country_keys": ["country"],
    },
    "ipapi_co": {
        "name": "ipapi.co",
        "url_self": "https://ipapi.co/json/",
        "url_query": "https://ipapi.co/{ip}/json/",
        "requires_key": False,
        "note": "精度字段叫 accuracy_radius（单位公里）；按公开文档，未逐字段核对",
        "ip_keys": ["ip"], "lat_keys": ["latitude"], "lon_keys": ["longitude"],
        "acc_keys": ["accuracy_radius"], "city_keys": ["city"], "country_keys": ["country_name", "country_code"],
    },
    "ipwho_is": {
        "name": "ipwho.is",
        "url_self": "https://ipwho.is/",
        "url_query": "https://ipwho.is/{ip}",
        "requires_key": False,
        "note": "成功标志字段叫 success；按公开文档，未逐字段核对",
        "status_key": "success", "status_ok": True,
        "ip_keys": ["ip"], "lat_keys": ["latitude"], "lon_keys": ["longitude"],
        "acc_keys": [], "city_keys": ["city"], "country_keys": ["country", "country_code"],
    },
    "freeipapi": {
        "name": "freeipapi.com",
        "url_self": "https://freeipapi.com/api/json",
        "url_query": "https://freeipapi.com/api/json/{ip}",
        "requires_key": False,
        "note": "字段是驼峰（ipAddress/cityName/countryName）；无精度字段；按公开文档，未逐字段核对",
        "ip_keys": ["ipAddress"], "lat_keys": ["latitude"], "lon_keys": ["longitude"],
        "acc_keys": [], "city_keys": ["cityName"], "country_keys": ["countryName", "countryCode"],
    },
}

# 元数据/私有网段：如果允许调用方任意指定上游 URL，这些地址就成了内网探测的入口。
PRIVATE_NETS = ("127.", "10.", "192.168.", "169.254.", "172.16.", "172.17.", "172.18.",
                "172.19.", "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
                "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.", "::1", "fe80:")

# ipaddress 的 is_private 在不同 Python 版本覆盖范围不一样（3.13 起 100.64.0.0/10 不算私有）。
# 内网测绘用得上的段在这里钉死，不依赖标准库版本的口径。
EXTRA_PRIVATE_NETS = (ipaddress.ip_network("100.64.0.0/10"),     # 运营商级 NAT（RFC 6598）
                      ipaddress.ip_network("0.0.0.0/8"),         # 「本网络」，Windows 上等于本机
                      ipaddress.ip_network("198.18.0.0/15"))     # 基准测试段，内网设备偶尔占用


def is_safe_upstream_url(url, require_placeholder=True):
    """上游 URL 白名单检查。返回 (ok, reason)。

    默认 /api/geoip 只允许来源表里的模板，`upstream_url` 覆盖是给自托管场景的；
    既然要开放就必须挡住 SSRF：只允许 http(s)、host 不得是回环/私有/链路本地
    （169.254.169.254 是云厂商元数据服务，经典靶子）或 localhost。

    `require_placeholder` 分两种用法：
      * 校验**来源表模板**时要 True —— 必须含 {ip}，这样调用方只能给 IP 字面量，
        不能直接塞一条完整 URL（否则本服务就退化成任意 URL 代理）。
      * 校验**拼好的最终 URL**时传 False —— 留空 ip（查自己的出口 IP）时模板本来就没有 {ip}。
    """
    if not isinstance(url, str) or not url:
        return False, "URL 为空"
    if any(c in url for c in (" ", "\n", "\r", "\x00")):
        # 空格/换行会让 URL 变成两个请求（HTTP 请求走私）；这里宁可误拒。
        return False, "URL 含空白或控制字符"
    parts = urllib.parse.urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        return False, "只允许 http/https 协议（当前是 %r）" % parts.scheme
    if require_placeholder and "{ip}" not in (parts.path or ""):
        return False, "URL 模板必须包含 {ip} 占位符（只允许替换 IP，不接受任意完整 URL）"
    host = (parts.hostname or "").lower()
    if not host:
        return False, "URL 缺少主机名"
    if host in ("localhost", "0.0.0.0") or host.endswith(".local") or host.endswith(".internal"):
        return False, "上游主机名指向本机/内网名（%s），拒绝" % host
    if any(host.startswith(p) for p in PRIVATE_NETS):
        return False, "上游主机名在私有/链路本地网段（%s），拒绝" % host
    return True, None


def is_private_target(host):
    """判断目标是不是「本机 / 内网 / 链路本地 / 云元数据」地址。返回 (是否内网, 原因)。

    这个函数**只用于标注**，不用于拦截：⑧ 的 traceroute/ping 允许打内网，
    因为这台桥接跑在你自己的机器上、只监听回环，追踪自家路由器 192.168.1.1
    正是它的主要用途之一。响应里带上 `target_scope`，是为了让页面上「这跳是内网」
    这件事看得见，也方便你自己判断某次追踪有没有跑出局域网。
    """
    s = (host if isinstance(host, str) else "").strip().lower()
    if not s:
        return False, None          # 空值由 validate_host 负责拒绝，这里不重复判
    if s in ("localhost", "localhost.") or s.endswith((".local", ".internal", ".lan", ".home.arpa")):
        return True, "本机/内网名（%s）" % s
    literal = s[1:-1] if s.startswith("[") and s.endswith("]") else s
    try:
        ip = ipaddress.ip_address(literal)
    except ValueError:
        return False, None          # 是域名：由解析结果再判一次（见 target_scope）
    if ip.is_loopback:
        return True, "回环地址 %s" % ip
    if ip.is_link_local:
        return True, "链路本地 %s（云厂商元数据 169.254.169.254 属于这一类）" % ip
    if ip.is_private:
        return True, "私有网段 %s" % ip
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True, "组播/保留/未指定地址 %s" % ip
    # 运营商级 NAT（RFC 6598）与「本网络」（0.0.0.0/8）：Python 3.13 起 is_private 不再覆盖，
    # 但它们照样是内网测绘常用的段，宁可多拒一层。
    for net in EXTRA_PRIVATE_NETS:
        if ip in net:
            return True, "在 %s 段（内网测绘常用）" % net
    return False, None


def target_scope(host, resolved=None):
    """标注目标归属。返回 ("lan", 原因) 或 ("public", None)——**只标注，不拦截**。

    字面量是内网 → lan；字面量是域名但**解析到**内网 → 也标 lan（内网 DNS、rebinding 走这条）。
    域名解析失败、或解析到公网，都算 public：宁可标错一次归属，也不给你的正常追踪添堵。
    """
    bad, why = is_private_target(host)
    if bad:
        return "lan", why
    for addr in (resolved or []):
        bad2, why2 = is_private_target(addr)
        if bad2:
            return "lan", "域名 %s 解析到内网地址：%s" % (host, why2)
    return "public", None


def geoip_source_ids():
    return sorted(GEOIP_SOURCES.keys())


def pick_field(data, keys):
    """按候选键名取第一个存在的字段；都不存在返回 None（缺失就是缺失，不编默认值）。"""
    if not isinstance(data, dict):
        return None
    for k in keys or []:
        if k in data and data[k] is not None:
            return data[k]
    return None


def _reject_constant(name):
    """json.loads 的 parse_constant 回调：见 NaN/Infinity/-Infinity 就抛（→ json_error）。"""
    raise ValueError("上游 JSON 含非法字面量 %s" % name)


def _finite(value):
    """把任意上游值转成有限浮点；非数/inf 一律 None（不返回 NaN，绝不让它进 JSON 输出）。

    布尔值单独拒收：Python 的 float(True) 是 1.0，上游把 lat 写成 true 时会凭空得到一个
    「北纬 1 度」。PowerShell 那份桥本来就不认布尔，这里跟着拒，两份实现才对得齐。
    """
    if isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def parse_geoip_json(data, source_id):
    """把上游 JSON 归一成 {ip, lat, lon, accuracy_km, city, country, source, ok, error}。

    与 app/core-net.js 的 parseIpSource 输出同形（两侧各写一份，字段名对齐但不互相依赖）。
    各家字段名未逐字段核对，所以：取不到的字段一律 null，精度取不到时**不填数**，
    由前端按兜底量级处理并标注 accuracy_fallback。
    """
    src = GEOIP_SOURCES.get(source_id) or {}
    res = {"ip": None, "lat": None, "lon": None, "accuracy_km": None, "city": None,
           "country": None, "source": source_id, "ok": False, "error": None,
           "error_kind": None, "accuracy_fallback": True}
    if not isinstance(data, dict):
        res["error"] = "上游返回不是 JSON 对象"
        res["error_kind"] = "json_error"
        return res
    if "status_key" in src:
        got = pick_field(data, [src["status_key"]])
        if got != src["status_ok"]:
            res["error"] = "上游按自身 status 字段判定失败：%s" % (pick_field(data, ["message", "error", "reason"]) or got)
            res["error_kind"] = "field_missing"
            return res
    res["ip"] = pick_field(data, src.get("ip_keys", []))
    if src.get("split_loc"):
        loc = pick_field(data, src.get("lat_keys", []))
        if isinstance(loc, str) and "," in loc:
            a, b = loc.split(",", 1)
            la, lo = _finite(a), _finite(b)
            if la is None or lo is None:
                res["error"] = "loc 字段无法拆成两个有限实数（%r）" % loc
                res["error_kind"] = "field_invalid"
                return res
            res["lat"], res["lon"] = la, lo
    else:
        lat = _finite(pick_field(data, src.get("lat_keys", [])))
        lon = _finite(pick_field(data, src.get("lon_keys", [])))
        if (lat is None) != (lon is None):
            # 只拿到一个轴 = 另一个轴字段名不对或值是 NaN，报出来而不是当成「没有坐标」
            res["error"] = "经纬度只解析出一个（lat=%r lon=%r），字段名按公开文档，未逐字段核对" % (lat, lon)
            res["error_kind"] = "field_invalid"
            return res
        res["lat"], res["lon"] = lat, lon
    res["accuracy_km"] = _finite(pick_field(data, src.get("acc_keys", [])))
    res["accuracy_fallback"] = res["accuracy_km"] is None
    res["city"] = pick_field(data, src.get("city_keys", []))
    res["country"] = pick_field(data, src.get("country_keys", []))
    if res["lat"] is None or res["lon"] is None:
        res["error"] = "缺少经纬度字段（按公开文档找过 %s，未逐字段核对）" % (src.get("lat_keys") or [])
        res["error_kind"] = "field_missing"
        return res
    if abs(res["lat"]) > 90 or abs(res["lon"]) > 180:
        res["error"] = "经纬度越界（lat=%s lon=%s）" % (res["lat"], res["lon"])
        res["error_kind"] = "field_invalid"
        return res
    res["ok"] = True
    return res


def build_geoip_url(source_id, ip, key=None, custom_url=None):
    """按来源模板拼 URL。ip 必须是合法 IP 字面量或空（查自己的出口 IP）。

    custom_url（自托管覆盖）只在**同时给了 ip** 时接受，且必须是含 {ip} 的模板：
    这样「覆盖 URL」覆盖的是端点，不是「让调用方决定请求什么」。
    """
    src = GEOIP_SOURCES.get(source_id)
    if not src:
        return None, "未知的 GeoIP 来源 %r（可用：%s）" % (source_id, ", ".join(geoip_source_ids()))
    if ip in (None, ""):
        if custom_url:
            return None, "使用 custom_url 时必须给出 ip 参数（模板需含 {ip}，本服务不接受任意完整 URL）"
        url = src["url_self"]
    else:
        vh = validate_host(ip)
        if not vh["ok"] or vh["kind"] not in ("ipv4", "ipv6"):
            return None, "ip 参数需是合法 IPv4/IPv6 字面量：%s" % (vh["reason"] or "类型不对")
        template = custom_url or src["url_query"]
        ok, reason = is_safe_upstream_url(template, require_placeholder=True)
        if not ok:
            return None, "URL 模板不合法：%s" % reason
        url = template.replace("{ip}", urllib.parse.quote(vh["host"], safe=":."))
    if src.get("requires_key"):
        if not key:
            return None, "来源 %s 需要 api key（本服务不内置任何 key）" % source_id
        sep = "&" if "?" in url else "?"
        url = url + sep + "apikey=" + urllib.parse.quote(str(key), safe="")
    return url, None


def http_fetch_json(url, timeout_s=8.0):
    """GET 一个 JSON（只给 /api/geoip 用）。错误分类要互不相同，便于前端按类提示。

    返回 {ok, status, data, error_kind, error, elapsed_ms}；任何异常都在这里吞掉并转成字段。
    """
    started = time.monotonic()
    ok, reason = is_safe_upstream_url(url, require_placeholder=False)
    if not ok:
        return {"ok": False, "status": None, "data": None, "error_kind": "bad_input", "error": reason}
    req = urllib.request.Request(url, headers={"accept": "application/json",
                                               "user-agent": "%s/%s (local bridge)" % (SERVER_NAME, VERSION)})
    try:
        with urllib.request.urlopen(req, timeout=max(1.0, min(float(timeout_s), 60.0))) as resp:
            status = getattr(resp, "status", 200)
            payload = resp.read(OUTPUT_CAP_BYTES)
    except urllib.error.HTTPError as exc:
        # HTTP 4xx/5xx：上游明确告诉我们失败了，状态码要带回去
        return {"ok": False, "status": exc.code, "data": None, "error_kind": "http_error",
                "error": "上游返回 HTTP %s %s" % (exc.code, getattr(exc, "reason", "") or "")}
    except urllib.error.URLError as exc:
        inner = getattr(exc, "reason", exc)
        kind = "timeout" if isinstance(inner, (TimeoutError, socket.timeout)) else "network"
        return {"ok": False, "status": None, "data": None, "error_kind": kind,
                "error": ("上游响应超时（%ss）" % timeout_s) if kind == "timeout" else ("网络/证书/DNS 失败：%s" % inner)}
    except (TimeoutError, socket.timeout):
        return {"ok": False, "status": None, "data": None, "error_kind": "timeout",
                "error": "上游响应超时（%ss）" % timeout_s}
    except Exception as exc:                      # 最后一道：绝不让异常冒到 HTTP 线程外面
        return {"ok": False, "status": None, "data": None, "error_kind": "network",
                "error": "访问上游时出现未预期错误：%s" % exc}
    try:
        # parse_constant 拦 NaN/Infinity：JSON 规范里没有这两个字面量，但 Python 的 json 默认接受，
        # 而它们一旦流到前端就是 `null` 之外的第三种「看起来像数」的东西（且 JSON.stringify 会把它变成 null，
        # 让偏差计算静默出错）。宁可报 json_error 也不放行。
        data = json.loads(payload.decode("utf-8", errors="replace"), parse_constant=_reject_constant)
    except ValueError as exc:
        return {"ok": False, "status": status, "data": None, "error_kind": "json_error",
                "error": "上游返回不是合法 JSON：%s" % exc}
    return {"ok": True, "status": status, "data": data, "error_kind": None, "error": None,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 1)}


# ================================================================ 5. DNS（线程 + 超时）

def run_with_timeout(fn, seconds, args=()):
    """在守护线程里跑 fn，超时返回 ('timeout', None)。

    为什么需要它：`socket.getaddrinfo` 是 C 库阻塞调用，Python 层没有真正的超时参数，
    DNS 挂了它就会一直卡着，把整个请求（甚至 UI 的一次点击）拖死。
    超时后线程仍在后台跑（无法强杀），但它是 daemon，不会阻止进程退出 —— 这是标准库下
    唯一干净的做法，值得在注释里写明白，别让人以为是「忘记 cancel 了」。
    """
    box = {"value": None, "error": None, "done": threading.Event()}

    def worker():
        try:
            box["value"] = fn(*args)
        except Exception as exc:
            box["error"] = exc
        finally:
            box["done"].set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    if not box["done"].wait(max(0.1, float(seconds))):
        return False, None, "操作超过 %ss 未完成（后台线程已放弃，daemon 不阻止退出）" % seconds
    if box["error"] is not None:
        return False, None, "%s: %s" % (type(box["error"]).__name__, box["error"])
    return True, box["value"], None


def resolve_dns(host, timeout_s=5.0):
    """解析主机名。返回 {ok, host, addresses, family, error, error_kind}。"""
    vh = validate_host(host)
    if not vh["ok"]:
        return {"ok": False, "host": None, "addresses": [], "error": vh["reason"], "error_kind": "bad_input"}
    if vh["kind"] in ("ipv4", "ipv6"):
        return {"ok": True, "host": vh["host"], "addresses": [vh["host"]], "family": vh["kind"],
                "error": None, "error_kind": None, "note": "输入已是 IP 字面量，未发起查询"}
    done, value, err = run_with_timeout(socket.getaddrinfo, timeout_s, args=(vh["host"], None))
    if not done:
        return {"ok": False, "host": vh["host"], "addresses": [], "error": err, "error_kind": "timeout"}
    if err is not None:
        return {"ok": False, "host": vh["host"], "addresses": [], "error": "DNS 解析失败：%s" % err,
                "error_kind": "dns_error"}
    addrs = []
    for item in value or []:
        addr = item[4][0]
        if addr not in addrs:
            addrs.append(addr)
    return {"ok": bool(addrs), "host": vh["host"], "addresses": addrs[:16],
            "family": "ipv6" if any(":" in a for a in addrs) else "ipv4",
            "error": None if addrs else "没有解析到任何地址",
            "error_kind": None if addrs else "dns_empty"}


def has_ipv4_loopback_address():
    """本机是否存在 127 段单播地址。

    之前这里写死 True，等于把没验证过的事实报给用户（PowerShell 那份桥是真的枚举网卡）。
    用 UDP connect 让内核替我们挑「发往 127.0.0.1 时用哪个源地址」：UDP 的 connect 只登记
    默认目的地址，一个包都不发，所以既不联网也不影响端口；拿不到就如实 False。
    """
    probe = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.settimeout(0.5)
        probe.connect(("127.0.0.1", 53))
        return probe.getsockname()[0].startswith("127.")
    except OSError:
        return False
    finally:
        if probe is not None:
            try:
                probe.close()
            except OSError:
                pass


def iface_summary(bind_host, port):
    """本机网络接口摘要 —— 刻意只给「数量」和「是否回环」，不给任何可识别的值。

    为什么不返回主机名/MAC/局域网 IP：这个端点会被本地页面（用户从 file:// 打开的那份 HTML、
    以及官方托管页）经来源白名单访问到，那些信息足够做设备指纹与内网测绘。
    前端真正需要的是「桥接是否只在回环上」这个安全事实，所以只报事实。
    枚举失败时说「取不到」（ok=false + error），而不是给一个 0 假装这台机器没有网卡。
    """
    out = {
        "ok": True,
        "bind_address": bind_host,
        "port": port,
        "bind_is_loopback": False,
        "bind_check_reason": None,
        "interface_count": 0,
        "ipv4_loopback_present": has_ipv4_loopback_address(),
        "redacted_fields": ["hostname", "mac", "interface_names", "lan_addresses"],
        "note": "本端点刻意不返回主机名/MAC/内网地址：/api/* 对来源白名单（file://、回环、官方托管页）开放，"
                "这些信息足以做设备指纹。需要排查本机网络请用系统命令。",
    }
    loop_ok, why = is_bind_address_loopback(bind_host)
    out["bind_is_loopback"] = loop_ok
    out["bind_check_reason"] = why
    try:
        out["interface_count"] = len(socket.if_nameindex())
    except (OSError, AttributeError, ValueError) as exc:
        out["ok"] = False
        out["error"] = "枚举网卡失败：%s" % exc
        out["error_kind"] = "os_error"
    return out

# ================================================================ 6. HTTP 处理器

def is_api_path(path):
    """只有 /api/* 才可能被授予跨站读权限（名单见 origin_allowed）。

    单独抽成函数是因为这条规则必须能**离线断言**：静态目录如果也带上 CORS，
    任意本地页面（包括用户从网上下载的 HTML）就能把项目源码与数据文件全部读走。
    """
    return isinstance(path, str) and path.startswith("/api/")


# ---------------------------------------------------------------- 跨站来源白名单
# 这条边以前是 `Access-Control-Allow-Origin: *`，等于「你浏览器里开着的任何网页都能借这台
# 机器的桥接发包、并把响应读走」。桥接里从来没有你的坐标（位置类参数一律 400），但它能替你
# 跑 tracert/ping，也能被拿来探测本机服务，所以这条边现在收成一张写死的名单：
#   null                        → file:// 双击打开的页面（浏览器给的是不透明来源）
#   https://iammezsh.github.io  → 官方托管页（跨协议打本机回环，见 MANUAL §2.5）
#   回环 origin                 → 本机自己提供的同源页面（端口跟着页面走，换端口不必改名单）
#   压根没有 Origin 头           → 非浏览器客户端（启动器探测 /api/health、curl），照常放行
# 其余任何来源一律 403 origin_not_allowed。自建域名或内网镜像用 --allow-origin 追加
# （PowerShell 那份桥是 -AllowOrigin）：名单只能变长，默认值不会变短。
CORS_ALLOWED_ORIGINS = ("null", "https://iammezsh.github.io")
EXTRA_ALLOWED_ORIGINS = []          # main() 按 --allow-origin 追加；两份桥同一个概念
# 回环 origin 的判定不用正则猜形状，交给 urllib.parse 拆开 + ipaddress 判性质：
# 主机名必须正好是 localhost，或者是一个「真的是回环」的 IP 字面量。于是
#   [2001:db8::1]、10.0.0.5      → 是 IP，但不回环 → 拒
#   [::ffff:8.8.8.8]             → IPv4 映射写法：拆开看内层，8.8.8.8 不回环 → 拒
#   127.1                        → 不是合法的点分四段，ipaddress 直接报错 → 拒
#   127.0.0.1.evil.com           → 不是 IP，也不叫 localhost → 拒
# 拒绝只是让本机同源页面换个写法，放过则等于给伪装留门，所以宁可严一点。
def _is_loopback_origin(parsed):
    host = parsed.hostname
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(addr, "ipv4_mapped", None)   # ::ffff:a.b.c.d 的真身在括号里，得看内层；IPv4 没这个属性
    return (mapped or addr).is_loopback


def origin_allowed(origin, extra=None):
    """浏览器带进来的 Origin 能不能放行（放行就是把原值回显成 Access-Control-Allow-Origin）。"""
    o = "" if origin is None else str(origin).strip()
    if o == "":
        return True                  # 非浏览器客户端：CORS 对它没有意义，请求照做
    low = o.lower()
    if low in tuple(x.lower() for x in CORS_ALLOWED_ORIGINS):
        return True
    p = urllib.parse.urlsplit(low)
    # origin 只有「协议 + 主机 + 端口」这一段。带路径、带查询、带账号密码的都不是 origin，
    # 而是伪造出来想把名单骗过去的字符串，一律不给过。端口不解析（urlsplit 对
    # `host:443.evil.cn` 取端口会抛异常），因为名单判定根本不需要它。
    if p.scheme not in ("http", "https") or not p.netloc or p.path or p.query or p.fragment:
        return False
    if p.username or p.password:
        return False
    if _is_loopback_origin(p):
        return True
    for x in tuple(extra or ()) + tuple(EXTRA_ALLOWED_ORIGINS):
        if low == str(x).strip().lower():
            return True
    return False


def add_allowed_origin(origin):
    """--allow-origin 的落点：只接受完整 origin（协议+主机[:端口]），别的写法直接拒。"""
    o = str(origin or "").strip().lower().rstrip("/")
    if re.match(r"^https?://[a-z0-9.\-\[\]:]+$", o) is None or "://" not in o:
        return {"ok": False, "error": "来源写法不对（要 https://域名 或 http://127.0.0.1:端口）：%s" % one_line(origin, 60)}
    EXTRA_ALLOWED_ORIGINS.append(o)
    return {"ok": True, "added": o}


def q_first(query, key, default=None):
    """从 parse_qs 的字典里取第一个值；缺失/空串返回 default。"""
    vals = (query or {}).get(key)
    if not vals:
        return default
    v = vals[0]
    if isinstance(v, str) and v.strip() == "" and default is not None:
        return default
    return v


def one_line(text, cap=200):
    """日志消毒：把任何可能被写进日志的外部文本压成一行。

    为什么必须做：`path` 是攻击者可控的，里面塞一个 `%0a%0d[伪造日志]` 就能在
    每请求一行的日志里凭空多出一条看起来像服务端记录的行（log injection / CRLF 注入）。
    """
    s = str(text if text is not None else "")
    s = re.sub(r"[\x00-\x1f\x7f]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:cap]


# 静态资源的 Content-Type 表：值写全（该带 charset 的带上，图片与 svg 不带），发送时不再临时拼。
# 不用 mimetypes.guess_type：那台机器的 /etc/mime.types 有什么，它就说什么——同一份 server.py
# 在 Windows、macOS、iSH 上可能给同一个 .py 报出三种类型，而 PowerShell 那份桥又没有这个库。
# 这份表与 ps1 的 $script:TextTypes 必须逐键逐值相同，由 tests/check-package.py 比字面量。
TEXT_TYPES = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".geojson": "application/geo+json; charset=utf-8",
    ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".wkt": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".gpx": "application/gpx+xml", ".kml": "application/vnd.google-earth.kml+xml",
    ".xml": "application/xml", ".ico": "image/x-icon", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
}


# ---------------------------------------------------------------- 响应契约
# 两份实现（本文件与 bridge-powershell.ps1）逐字段对齐，页面才能「不知道自己连上的是哪一个」。
# 这份清单就是那句话的可执行版本：ps1 里有一份同名同值的副本，
# tests/check-package.py 把两份字面量按端点做集合比较，多一个字段或少一个字段都会红。
# 列的是**成功响应**的键（失败分支少几个字段是刻意的，见各端点的 fail 路径）。
BRIDGE_CONTRACT = {
    "/api/health": ["active_children", "bind", "capabilities", "cors_policy", "endpoints",
                    "geoip_sources", "limits", "note", "ok", "platform", "privacy", "python",
                    "runtime", "server", "status", "tools", "version"],
    "/api/iface": ["bind_address", "bind_check_reason", "bind_is_loopback", "error", "error_kind",
                   "interface_count", "ipv4_loopback_present", "note", "ok", "port", "redacted_fields"],
    "/api/dns": ["Answer", "Status", "addresses", "error", "error_kind", "family", "host",
                 "kind", "note", "ok"],
    "/api/ping": ["argv", "command", "count", "elapsed_ms", "error", "error_kind", "exit_code",
                  "fabricated_stats", "host", "note", "ok", "shell", "stats", "stderr",
                  "target_ip", "target_scope", "target_scope_note", "timed_out"],
    "/api/traceroute": ["argv", "command", "elapsed_ms", "error", "error_kind", "exit_code",
                        "fabricated_hops", "hop_count", "hops", "host", "host_kind", "max_hops",
                        "note", "ok", "per_hop_timeout_s", "reached", "shell", "stderr",
                        "target_ip", "target_scope", "target_scope_note", "timed_out",
                        "unparsed_lines", "wall_clock_s"],
    "/api/geoip": ["elapsed_ms", "error", "error_kind", "fields_note", "http_status",
                   "normalized", "note", "ok", "source", "upstream", "url"],
}


def health_payload(bind_host, port):
    """/api/health 的内容。抽成纯函数便于离线断言（前端 GEONET.bridgeStatus 依赖这些字段名）。"""
    tools = {k: which_tool(k) for k in TOOL_CANDIDATES}
    return {
        "ok": True, "status": "ok",
        "server": SERVER_NAME, "version": VERSION,
        "python": sys.version.split()[0], "platform": sys.platform,
        # runtime 与 PowerShell 那份桥同名字段：界面在 python 为 null 时靠它说明自己连的是谁，
        # 所以两边都得填，不能只有一边有。（值就是本进程的运行环境，不做二次加工。）
        "runtime": "Python " + sys.version.split()[0],
        "capabilities": [k for k, v in tools.items() if v] + ["dns", "iface", "geoip", "static"],
        "tools": {k: (v or "未找到（该功能会降级）") for k, v in tools.items()},
        "endpoints": ["/api/health", "/api/traceroute?host=&max_hops=", "/api/ping?host=&count=",
                      "/api/dns?host=", "/api/iface", "/api/geoip?ip=&source="],
        "bind": {"address": bind_host, "port": port,
                 "loopback_only": is_bind_address_loopback(bind_host)[0],
                 "note": "非回环绑定在启动阶段就被拒绝，运行期不可能改成 0.0.0.0"},
        "limits": {"max_hops": MAX_HOPS_LIMIT, "max_ping_count": MAX_PING_COUNT,
                   "wall_clock_cap_s": WALL_CLOCK_CAP_S, "shell": False,
                   "max_concurrent_children": _ACTIVE["max_children"]},
        "privacy": {"position_params_accepted": False, "banned_params": sorted(POSITION_PARAMS),
                    "lan_targets_allowed": True,
                    "note": "所有坐标类参数一律 400；GeoIP 代理只接受 IP 字面量或留空（查出口 IP）。"
                             "traceroute/ping 可以打内网（追踪自家路由器是它的本职），"
                             "响应里的 target_scope 会标明目标是内网还是公网"},
        # 跨站来源白名单也当成一条对外事实报出来，页面 ⑧ 的桥接自检才能直接显示
        # 「现在谁能借这条边」，而不是让用户去猜配置。两份桥同名同形状。
        "cors_policy": {"wildcard": False, "built_in": list(CORS_ALLOWED_ORIGINS),
                        "extra": list(EXTRA_ALLOWED_ORIGINS),
                        "loopback_origins_allowed": True,
                        "no_origin_clients_allowed": True,
                        "note": "名单外的浏览器来源一律 403 origin_not_allowed；"
                                "回显具体来源而不是 *，所以任意网页读不到本机响应"},
        "geoip_sources": geoip_source_ids(),
        "active_children": _ACTIVE["children"],
        "note": "所有系统命令均以 argv 列表 + shell=False 执行；只监听回环地址",
    }


class BridgeHandler(BaseHTTPRequestHandler):
    """一个极简的 GET 服务：/api/* 是 JSON 桥接，其余是项目静态文件。

    为什么不用 SimpleHTTPRequestHandler：它的目录穿越处理与日志格式都不受控，
    而本服务的安全要求（白名单校验 + 自己的一行日志 + /api/* 才给 CORS）需要
    完全掌握发送路径的每一步。代价是要自己处理 Content-Length 与编码。
    """

    server_version = "%s/%s" % (SERVER_NAME, VERSION)
    protocol_version = "HTTP/1.1"          # keep-alive：必须每条响应都给 Content-Length（下面都给了）
    root_dir = os.getcwd()
    quiet = False
    bind_host = DEFAULT_HOST
    bind_port = DEFAULT_PORT

    # ---------- 底层输出 ----------
    def _emit(self, code, body, content_type, api, extra_headers=None, head_only=False):
        data = body if isinstance(body, (bytes, bytearray)) else str(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if api:
            # 跨站读权限只给名单里的来源（见 origin_allowed），且**原样回显**而不是 `*`：
            # `*` 会让「你浏览器里开着的任意网页」都能读走响应，回显加名单才把这条边收紧到
            # 本项目自己的页面。没有 Origin 头（本机程序、启动器探测）时不回显任何 CORS 头，
            # 请求照做——CORS 只对浏览器有意义，非浏览器客户端本来也没有跨站这个概念。
            req_origin = (self.headers.get("Origin") or "").strip()
            if req_origin and origin_allowed(req_origin):
                self.send_header("Access-Control-Allow-Origin", req_origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            self.send_header("Access-Control-Max-Age", "600")
        else:
            # 静态资源不给 CORS：跨站页面不该能把本项目文件当免费 CDN/素材读取。
            self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not head_only:
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                # 浏览器提前断开（页面刷新、用户取消）是常态：只影响这一次响应，不算故障。
                pass

    def send_json(self, code, obj, api=True, head_only=False):
        # ensure_ascii=False：中文直接可读；前端只吃 JSON，不关心传输编码。
        self._emit(code, json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                   "application/json; charset=utf-8", api, head_only=head_only)

    def fail(self, code, error, kind, api=True, extra=None, head_only=False):
        obj = {"ok": False, "error": error, "error_kind": kind}
        if extra:
            obj.update(extra)
        self.send_json(code, obj, api=api, head_only=head_only)

    # 抑制 BaseHTTPRequestHandler 自带的日志（它会和我们的一行日志重复两次）
    def log_message(self, fmt, *args):
        return

    def log_error(self, fmt, *args):
        if not self.quiet:
            log_line("[%s] 错误 %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), one_line(fmt % args)))

    # ---------- 方法分发 ----------
    def do_GET(self):
        self._dispatch(body=True)

    def do_HEAD(self):
        self._dispatch(body=False)

    def do_OPTIONS(self):
        """CORS 预检。只有来源白名单里的页面能预检通过；其余一律 403（含 file:// 之外的任意站点）。"""
        parsed = urllib.parse.urlsplit(self.path)
        api = is_api_path(parsed.path)
        if not api:
            self.fail(405, "静态资源不接受预检（本服务只支持 GET/HEAD/OPTIONS-on-/api）", "method_not_allowed", api=False)
            return
        req_origin = (self.headers.get("Origin") or "").strip()
        if req_origin and not origin_allowed(req_origin):
            # 不在名单里的站点连预检都不给它过：状态码 403 + 中文原因，界面会原样显示。
            self.fail(403, "跨站来源 %s 不在白名单里，本桥只服务本机自己的页面"
                      "（file://、回环地址与官方托管页；要加别的域名请用 --allow-origin）"
                      % one_line(req_origin, 80), "origin_not_allowed")
            return
        self.send_response(204)
        if req_origin:
            self.send_header("Access-Control-Allow-Origin", req_origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        # 托管页（https）访问本机回环属于「私有网络访问」，Chrome 等会先发带
        # Access-Control-Request-Private-Network 的预检并要求该回显。按调用方是否提出来决定回显，
        # 不给静态资源回、也不给名单外的来源回：桥接本来就只监听回环，且 /api/* 全是只读。
        if (self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()
        self._log_result(204, time.monotonic())

    def do_POST(self):
        self.fail(405, "本服务只读：所有端点都是 GET（POST 没有可写状态，避免被当作内网探针）",
                  "method_not_allowed")

    def do_PUT(self):
        self.do_POST()

    def do_DELETE(self):
        self.do_POST()

    def _log_result(self, code, started):
        if self.quiet:
            return
        ms = (time.monotonic() - started) * 1000.0
        log_line("[%s] %s %s -> %d %.1fms" % (
            time.strftime("%Y-%m-%d %H:%M:%S"), self.command,
            one_line(self.path, 200), code, ms))

    def _dispatch(self, body=True):
        started = time.monotonic()
        code = 500
        try:
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            path = parsed.path
            api = is_api_path(path)
            # 隐私红线的第一道闸：任何位置类参数直接拒，不进入任何业务逻辑。
            bad = find_position_params(query)
            if bad:
                code = 400
                self.fail(400, "拒绝接收位置类参数 %s：本服务默认不接收、不转发任何用户坐标（隐私红线）"
                          % ", ".join(bad), "privacy_rejected", api=api, head_only=not body)
                return
            if api:
                # 第二道闸：跨站来源。名单外的网页既读不到响应，也借不到这台机器发包。
                req_origin = (self.headers.get("Origin") or "").strip()
                if req_origin and not origin_allowed(req_origin):
                    code = 403
                    self.fail(403, "跨站来源 %s 不在白名单里，本桥只服务本机自己的页面"
                              "（file://、回环地址与官方托管页；要加别的域名请用 --allow-origin）"
                              % one_line(req_origin, 80), "origin_not_allowed", api=True,
                              head_only=not body)
                    return
                code = self._route_api(path, query, body)
                return
            code = self._serve_static(path, body)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            # 「进程不得因异常崩溃」：任何未预期错误都变成一条 500 JSON + 一行日志，
            # 并把类型与消息带出去（本地调试需要），但不回栈，避免泄漏路径。
            try:
                code = 500
                self.fail(500, "服务内部异常（已捕获，进程继续运行）：%s: %s" % (type(exc).__name__, exc),
                          "internal_error", api=is_api_path(self.path), head_only=not body)
            except Exception:
                pass
        finally:
            self._log_result(code, started)

    # ---------- /api/* ----------
    def _route_api(self, path, query, body):
        head = not body
        routes = {
            "/api/health": lambda: self.api_health(),
            "/api/traceroute": lambda: self.api_traceroute(query, head),
            "/api/ping": lambda: self.api_ping(query, head),
            "/api/dns": lambda: self.api_dns(query, head),
            "/api/iface": lambda: self.api_iface(head),
            "/api/geoip": lambda: self.api_geoip(query, head),
        }
        fn = routes.get(path.rstrip("/") if path != "/api/" else path)
        if fn is None:
            self.fail(404, "未知端点 %s（可用：%s）" % (path, ", ".join(sorted(routes))), "not_found", head_only=head)
            return 404
        return fn()

    def api_health(self):
        self.send_json(200, health_payload(self.bind_host, self.bind_port))
        return 200

    def _budget(self, query, default_s, low, high):
        raw = q_first(query, "timeout", None)
        if raw is None:
            return default_s
        try:
            v = float(str(raw).strip())
        except (TypeError, ValueError):
            return default_s
        if not (v > 0):
            return default_s
        return max(low, min(high, v))

    def api_traceroute(self, query, head=False):
        host_raw = q_first(query, "host", "")
        vh = validate_host(host_raw)
        if not vh["ok"]:
            self.fail(400, "host 参数非法：%s" % vh["reason"], "bad_input",
                      extra={"host": None}, head_only=head)
            return 400
        max_hops = clamp_int(q_first(query, "max_hops", ""), 20, 1, MAX_HOPS_LIMIT)
        wall_s = self._budget(query, 30.0, 5.0, 120.0)
        # 每跳等待按总预算摊： hops 多时单跳等待自动变短，保证整条命令不会突破墙钟。
        per_hop_s = max(1, min(5, int(wall_s / max(1, max_hops))))
        argv, exe = build_traceroute_argv(vh["host"], max_hops, per_hop_s)
        if argv is None:
            self.send_json(200, {"ok": False, "error": exe, "error_kind": "command_missing",
                                 "host": vh["host"], "hops": [], "hop_count": 0,
                                 "fabricated_hops": False,
                                 "note": "命令缺失属于降级，不是失败：前端会改用浏览器 DoH 兜底解析"})
            return 200
        dns = resolve_dns(vh["host"], min(5.0, wall_s))
        # 内网/公网只做标注，不做拦截：追踪自家路由器 192.168.1.1 是 ⑧ 的本职，
        # 但页面应当知道这次包有没有跑出局域网（所以域名还要看解析结果）。
        scope, scope_why = target_scope(vh["host"], dns.get("addresses") or [])
        run = run_command(argv, wall_s)
        if not run["ok"] and not run.get("stdout"):
            self.send_json(200, {"ok": False, "error": run["error"] or "命令执行失败",
                                 "error_kind": run["error_kind"], "host": vh["host"],
                                 "hops": [], "hop_count": 0, "fabricated_hops": False,
                                 "exit_code": run.get("code"), "timed_out": run.get("timed_out", False),
                                 "elapsed_ms": run.get("elapsed_ms"),
                                 "note": "未取得任何输出，绝不编造跳数"})
            return 200
        parsed = parse_traceroute_text(run["stdout"])
        hops = parsed["hops"]
        target = parsed["target_ip"] or (dns["addresses"][0] if dns.get("addresses") else None)
        last = hops[-1] if hops else None
        reached = bool(last and last.get("ip") and target and last["ip"] == target)
        self.send_json(200, {
            "ok": bool(hops),
            "host": vh["host"], "host_kind": vh["kind"], "target_ip": target,
            "target_scope": scope, "target_scope_note": scope_why,
            "max_hops": max_hops, "per_hop_timeout_s": per_hop_s, "wall_clock_s": wall_s,
            "hops": hops, "hop_count": len(hops), "reached": reached,
            "fabricated_hops": False,
            "command": exe, "argv": argv, "shell": False,
            "exit_code": run.get("code"), "timed_out": run.get("timed_out", False),
            "elapsed_ms": run.get("elapsed_ms"),
            "stderr": one_line(run.get("stderr") or "", 240),
            "unparsed_lines": parsed["unparsed"],
            "error": None if hops else "命令执行完成但没有解析出任何跳（目标不可达/被防火墙静默丢弃），未伪造跳数",
            "error_kind": None if hops else "no_hops",
            "note": "跳数完全来自系统 traceroute/tracert 的文本输出解析；解析不出来的行保留在 unparsed_lines",
        })
        return 200

    def api_ping(self, query, head=False):
        vh = validate_host(q_first(query, "host", ""))
        if not vh["ok"]:
            self.fail(400, "host 参数非法：%s" % vh["reason"], "bad_input", head_only=head)
            return 400
        count = clamp_int(q_first(query, "count", ""), 4, 1, MAX_PING_COUNT)
        wall_s = self._budget(query, 15.0, 3.0, 60.0)
        argv, exe = build_ping_argv(vh["host"], count, max(1, int(wall_s / max(1, count))))
        if argv is None:
            self.send_json(200, {"ok": False, "error": exe, "error_kind": "command_missing", "host": vh["host"]})
            return 200
        dns = resolve_dns(vh["host"], min(2.0, wall_s))
        scope, scope_why = target_scope(vh["host"], dns.get("addresses") or [])
        run = run_command(argv, wall_s)
        stats = parse_ping_text(run["stdout"])
        # 注意：ping 的退出码在非零丢包时也是非零（Windows 全丢包返回 1），
        # 所以这里用「解析到统计段」判成功，而不是用 returncode —— 用 returncode 会把
        # 「100% 丢包」这个真实结果误报成命令失败。
        got_stats = stats["received"] is not None or bool(stats["samples_ms"])
        self.send_json(200, {
            "ok": bool(run["ok"] or got_stats),
            "host": vh["host"], "command": exe, "argv": argv, "shell": False,
            "target_ip": (dns.get("addresses") or [None])[0],
            "target_scope": scope, "target_scope_note": scope_why,
            "count": count, "stats": stats,
            "exit_code": run.get("code"), "timed_out": run.get("timed_out", False),
            "elapsed_ms": run.get("elapsed_ms"),
            # stderr 与 fabricated_stats 和 PowerShell 那份桥同名字段：统计段有没有被补过，
            # 是这一行说了算，而不是靠注释保证。
            "stderr": one_line(run.get("stderr") or "", 240),
            "fabricated_stats": False,
            "error": None if got_stats else (run["error"] or "未能从 ping 输出中解析统计段"),
            "error_kind": None if got_stats else (run.get("error_kind") or "parse_empty"),
            "note": "统计值只来自 ping 自己的输出；解析不到就是 null，不填默认值",
        })
        return 200

    def api_dns(self, query, head=False):
        vh = validate_host(q_first(query, "host", ""))
        if not vh["ok"]:
            self.fail(400, "host 参数非法：%s" % vh["reason"], "bad_input", head_only=head)
            return 400
        wall_s = self._budget(query, 5.0, 1.0, 20.0)
        res = resolve_dns(vh["host"], wall_s)
        # 额外给一份 **DoH 形状**的字段（Status/Answer[].data）：
        # 前端 GEONET.dohResolve 的 URL 模板是可覆盖的，把 {host}/{type} 指到这里，
        # 在内网/无外部 DNS 的环境里也能复用同一套调用代码。Status 用 RFC1035 的 RCODE
        # （0 = NOERROR），Answer 的 type 用 DNS 记录号（A=1 / AAAA=28）。
        answers = [{"name": res["host"],
                    "type": 28 if (":" in addr) else 1,
                    "data": addr,
                    "TTL": None}          # 系统解析器不返回 TTL，这里如实留 null，不编一个数
                   for addr in res["addresses"]]
        self.send_json(200, {
            "ok": res["ok"], "host": res["host"], "kind": vh["kind"],
            "addresses": res["addresses"], "family": res.get("family"),
            "Status": 0 if res["ok"] else 2, "Answer": answers,
            "error": res["error"], "error_kind": res["error_kind"],
            "note": "只做名字解析（socket.getaddrinfo），不经过 shell；带超时是因为该调用不可中断。"
                    "Status/Answer 是为前端 DoH 模板兼容而提供的形状，字段号按 RFC1035/DNS 记录类型，未逐字段核对",
        })
        return 200

    def api_iface(self, head=False):
        obj = iface_summary(self.bind_host, self.bind_port)
        self.send_json(200, obj)
        return 200

    def api_geoip(self, query, head=False):
        source = str(q_first(query, "source", "ipapi_com")).strip()
        ip = q_first(query, "ip", "") or ""
        key = q_first(query, "key", "") or None
        custom = q_first(query, "upstream_url", "") or None
        url, why = build_geoip_url(source, ip, key, custom)
        if url is None:
            self.fail(400, why, "bad_input", head_only=head)
            return 400
        wall_s = self._budget(query, 8.0, 2.0, 30.0)
        got = http_fetch_json(url, wall_s)
        if not got["ok"]:
            self.send_json(200, {
                "ok": False, "source": source, "url": url, "upstream": None, "normalized": None,
                "error": got["error"], "error_kind": got["error_kind"],
                "http_status": got.get("status"), "elapsed_ms": got.get("elapsed_ms"),
                "note": "上游失败的分类彼此不同（超时/HTTP错误/非JSON/输入非法），便于分别提示",
            })
            return 200
        normalized = parse_geoip_json(got["data"], source)
        self.send_json(200, {
            "ok": True, "source": source, "url": url,
            "http_status": got["status"], "elapsed_ms": got["elapsed_ms"],
            "upstream": got["data"],                    # 原样透传：字段各家不同，让前端自己取
            "normalized": normalized,                  # 尽力归一：取不到就是 null
            "fields_note": (GEOIP_SOURCES.get(source) or {}).get("note", "字段名未逐字段核对"),
            "error": normalized.get("error"), "error_kind": normalized.get("error_kind"),
            "note": "本端点只按 IP 查询，请求里不含任何坐标；留空 ip 表示查本服务出口 IP",
        })
        return 200

    # ---------- 静态文件 ----------
    def _serve_static(self, raw_path, body=True):
        path = urllib.parse.unquote(raw_path or "/")
        ok, result = safe_join(self.root_dir, path)
        if not ok:
            # api=False：静态路径不给 CORS 头（跨站脚本不该读到本项目文件）
            self.fail(403, "路径被拒绝：%s" % result, "path_rejected", api=False, head_only=not body)
            return 403
        target = result
        if os.path.isdir(target):
            index = os.path.join(target, "index.html")
            if os.path.isfile(index):
                target = index
            else:
                return self._send_listing(target, raw_path, body)
        if not os.path.exists(target):
            self.fail(404, "文件不存在：%s" % one_line(path, 120), "not_found", api=False, head_only=not body)
            return 404
        if not os.path.isfile(target):
            self.fail(400, "目标不是普通文件（可能是设备节点/管道）", "not_a_file", api=False, head_only=not body)
            return 400
        size = os.path.getsize(target)
        if size > STATIC_MAX_BYTES:
            self.fail(413, "文件过大（%d 字节 > %d），本服务不做流式传输" % (size, STATIC_MAX_BYTES),
                      "too_large", api=False, head_only=not body)
            return 413
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            self.fail(500, "读取文件失败：%s" % exc, "io_error", api=False, head_only=not body)
            return 500
        ext = os.path.splitext(target)[1].lower()
        # 表里的值就是最终响应头，不再按前缀临时补 charset，也不再问平台的 mime 库：
        # 同一份文件在两份桥、三种平台上必须给出同一个头（PowerShell 那份桥用的是同一张表）。
        ctype = TEXT_TYPES.get(ext) or "application/octet-stream"
        self._emit(200, data, ctype, api=False, head_only=not body)
        return 200

    def _send_listing(self, dirpath, raw_path, body=True):
        """目录列表：只列名字与大小，且已经过 safe_join 的点文件过滤。"""
        try:
            entries = sorted(os.listdir(dirpath))
        except OSError as exc:
            self.fail(500, "列目录失败：%s" % exc, "io_error", api=False, head_only=not body)
            return 500
        rows = []
        for name in entries:
            if name.startswith("."):
                continue
            full = os.path.join(dirpath, name)
            kind = "目录" if os.path.isdir(full) else "文件"
            size = "" if os.path.isdir(full) else " %d B" % os.path.getsize(full)
            href = urllib.parse.quote(one_line((raw_path if raw_path.endswith("/") else raw_path + "/"), 200)) + urllib.parse.quote(name)
            rows.append('<li><a href="%s">%s</a> <small>%s%s</small></li>' % (href, name, kind, size))
        html = ("<!doctype html><meta charset=\"utf-8\"><title>目录 %s</title>"
                "<h1>经纬度定位工作站 · 静态目录</h1><p>%s</p><ul>%s</ul>"
                "<p><small>提示：本服务只监听 127.0.0.1；点文件与私钥类扩展名一律不提供。</small></p>"
                % (one_line(raw_path, 120), one_line(dirpath, 160), "".join(rows))).encode("utf-8")
        self._emit(200, html, "text/html; charset=utf-8", api=False, head_only=not body)
        return 200

# ================================================================ 7. 离线自检

def _strip_docstrings(tree):
    """原地去掉模块/类/函数的文档字符串（返回同一个 tree，便于链式调用）。"""
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", None) or []
            if len(body) >= 1 and isinstance(body[0], ast.Expr) \
                    and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                node.body = body[1:] or [ast.Pass()]
    return tree


def _collected_imports(tree):
    """AST 里所有 import 的顶层模块名（比正则可靠：`from x import y`、缩进里的 import 都能抓到）。"""
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:      # level>0 是本地相对导入，本项目没有
                names.add(node.module.split(".")[0])
    return names


# 下面所有 SAMPLE_* 字符串都是**手写样例文本，用来测试解析函数，不代表任何真实网络当前的输出**。
# 之所以用真实格式而不是理想化格式：解析器的 bug 几乎都出在「多余的空格 / 本地语言提示 / 括号里的重复 IP」。
SAMPLE_TRACERT_WIN = r"""样例文本，不是真实网络
C:\>tracert -d -h 6 -w 1000 example.com

Tracing route to example.com [93.184.215.14]
over a maximum of 6 hops:

  1     1 ms     1 ms     1 ms  192.168.1.1
  2    12 ms    11 ms    12 ms  10.0.0.138
  3     *        *        *     请求超时。
  4    30 ms    29 ms    31 ms  72.14.216.100
  5    44 ms    45 ms    44 ms  93.184.215.14

Trace complete.
"""

SAMPLE_TRACEROUTE_UNIX = """样例文本，不是真实网络
traceroute to example.com (93.184.215.14), 6 hops max, 60 byte packets
 1  192.168.1.1  0.842 ms  0.731 ms  0.700 ms
 2  10.0.0.138 (10.0.0.138)  11.204 ms  11.033 ms  12.005 ms
 3  * * *
 4  72.14.216.100  30.112 ms  30.050 ms  30.090 ms
 5  93.184.215.14  44.502 ms  45.001 ms  44.900 ms
"""

SAMPLE_TRACEROUTE_JUNK = """样例文本，不是真实网络
这台机器上的追踪程序输出了我们无法识别的第三种格式
nothing parseable here at all
"""

SAMPLE_PING_WIN_CN = """样例文本，不是真实网络
正在 Ping example.com [93.184.215.14] 具有 32 字节的数据:
来自 93.184.215.14 的回复: 字节=32 时间=1ms TTL=128
来自 93.184.215.14 的回复: 字节=32 时间=2ms TTL=128
请求超时。

93.184.215.14 的 Ping 统计信息:
    数据包: 已发送 = 4，已接收 = 2，丢失 = 2 (50% 丢失)，
往返行程的估计时间(以毫秒为单位):
    最短 = 1ms，最长 = 2ms，平均 = 1ms
"""

SAMPLE_PING_WIN_EN = """样例文本，不是真实网络
Pinging 8.8.8.8 with 32 bytes of data:
Reply from 8.8.8.8: bytes=32 time=11ms TTL=112
Reply from 8.8.8.8: bytes=32 time=10ms TTL=112

Ping statistics for 8.8.8.8:
    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 10ms, Maximum = 11ms, Average = 10ms
"""

SAMPLE_PING_UNIX = """样例文本，不是真实网络
PING example.com (93.184.215.14) 56(84) bytes of data.
64 bytes from 93.184.215.14: icmp_seq=1 ttl=128 time=0.842 ms
64 bytes from 93.184.215.14: icmp_seq=2 ttl=128 time=0.731 ms

--- example.com ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 1003ms
rtt min/avg/max/mdev = 0.731/0.786/0.842/0.057 ms
"""

SAMPLE_PING_TOTAL_LOSS = """样例文本，不是真实网络
Ping statistics for 10.255.255.1:
    Packets: Sent = 4, Received = 0, Lost = 4 (100% loss),
"""

# GeoIP 样例响应体：字段名按各家公开文档写的，**未逐字段核对**；这里只验证「解析器对这些形状的容错」。
SAMPLE_GEOIP = {
    "ipapi_com": {"status": "success", "query": "203.0.113.10", "lat": 37.751, "lon": -97.822,
                  "city": "Dover", "country": "United States", "countryCode": "US"},
    "ipinfo_io": {"ip": "203.0.113.10", "city": "Mountain View", "region": "California",
                  "country": "US", "loc": "37.4056,-122.0775", "org": "AS15169"},
    "ipapi_co": {"ip": "203.0.113.10", "city": "Mountain View", "country_code": "US",
                 "latitude": 37.4056, "longitude": -122.0775, "accuracy_radius": 100},
    "ipwho_is": {"success": True, "ip": "203.0.113.10", "city": "Mountain View",
                 "country": "United States", "country_code": "US", "latitude": 37.4056, "longitude": -122.0775},
    "freeipapi": {"ipAddress": "203.0.113.10", "countryName": "United States", "countryCode": "US",
                  "cityName": "Mountain View", "latitude": 37.4056, "longitude": -122.0775},
}


def run_selftest(root_dir=None):
    """离线自检：不监听端口、不起服务、不发任何外部请求、不执行任何系统命令。

    唯一碰 socket 的地方是「端口预探测」那条门：对 127.0.0.1:1 发一次 connect 试图，
    验证探测函数在没人监听时返回 False 而不是抛错——纯回环、不出本机、不建监听套接字。

    纪律与前端模块一致：**判定值必须严格是 True** 才算通过。
    `1`/非空字符串这种「truthy」不算 —— 那样写反的比较运算符能蒙过自检。
    返回 (通过数, 失败说明列表, 跳过说明列表)。
    """
    import tempfile
    root = os.path.abspath(root_dir or os.path.dirname(os.path.abspath(__file__)))
    passed = [0]
    failures = []
    skips = []

    def check(name, cond, detail=""):
        if cond is True:
            passed[0] += 1
        else:
            failures.append("%s —— 判定值=%r（必须是 True）；%s" % (name, cond, detail))

    def skip(name, why):
        skips.append("%s —— %s" % (name, why))

    HAS_CN = re.compile(r"[\u4e00-\u9fff]")

    # ---------- A. 主机白名单 ----------
    good_hosts = ["example.com", "a.b.c.example.org", "8.8.8.8", "192.168.1.1", "10.0.0.138",
                  "2001:db8::1", "fe80::1", "::1", "sub-1.example.co.uk", "a" * 50 + ".com"]
    rejected_good = [h for h in good_hosts if validate_host(h)["ok"] is not True]
    check("主机白名单：合法域名/IPv4/IPv6 全部放行（%d 例）" % len(good_hosts),
          not rejected_good, "误拒 " + repr(rejected_good))

    bad_hosts = ["", "   ", "a b.com", "host;rm -rf /", "host`id`", "host$(id)", "host|ls",
                 "host\n127.0.0.1", "host\r\nGET /api/iface HTTP/1.1", 'host"x', "host'x",
                 "2001:db8:::1", "1.2.3.4.5", "01.2.3.4", "999.1.1.1", "300.1.1.1", "..com",
                 ".leading.com", "trailing.com.", "host:", "-h", "--help", "-file", "a\x00b",
                 "café.com", "host..com", "host\\path", "$HOME", "$(whoami)", "a" * 300]
    accepted_bad = [h for h in bad_hosts if validate_host(h)["ok"] is True]
    check("主机白名单：注入与畸形输入全部拒绝（%d 例）" % len(bad_hosts),
          not accepted_bad, "误放 " + repr([one_line(h, 40) for h in accepted_bad]))

    no_reason = [h for h in bad_hosts if not HAS_CN.search(validate_host(h)["reason"] or "")]
    check("每条拒绝都给中文原因（便于直接给用户看）", not no_reason,
          "缺中文原因：" + repr([one_line(h, 30) for h in no_reason]))

    h253 = ".".join(["a" * 63, "b" * 63, "c" * 63, "d" * 61])
    check("长度上限 253 生效：253 放行 / 254 拒绝",
          len(h253) == 253 and validate_host(h253)["ok"] is True and validate_host(h253 + "x")["ok"] is False,
          "len=%d，%r / %r" % (len(h253), validate_host(h253)["ok"], validate_host(h253 + "x")["reason"]))

    metachars = [" ", "\t", "\n", "\r", "<", ">", "`", "|", ";", "&", "$", "(", ")", "'", '"', "\\", "\x00"]
    missed = [c for c in metachars if validate_host("a" + c + "b")["ok"] is not False]
    check("单个 shell 元字符逐个命中（%d 个）" % len(metachars), not missed,
          "漏网 " + repr(missed))

    junk_inputs = [None, 0, 1, [], {}, 3.14, True, b"bytes", object()]
    junk_ok = True
    for j in junk_inputs:
        try:
            if validate_host(j)["ok"] is not False:
                junk_ok = False
        except Exception as exc:
            junk_ok = False
            failures.append("validate_host(%r) 抛异常：%s" % (j, exc))
    check("非字符串输入一律判非法且不抛异常（%d 例）" % len(junk_inputs), junk_ok is True, "见上一条")

    # ---------- B. 位置参数（隐私红线） ----------
    check("位置类参数名被识别（含大小写混写）",
          find_position_params({"lat": "31.2", "LON": "121.4", "accuracy": "10", "host": "example.com"}) == ["accuracy", "lat", "lon"],
          repr(find_position_params({"lat": "1", "LON": "2", "accuracy": "3", "host": "x"})))
    check("正常参数不误伤（host/count/max_hops/source/ip）",
          find_position_params({"host": "example.com", "count": "4", "max_hops": "20", "source": "ipapi_co", "ip": "8.8.8.8"}) == [],
          "把合法参数当成了位置参数，会 400 掉所有请求")

    # ---------- C. 静态路径与目录穿越 ----------
    pos_paths = ["server.py", "app/core-net.js", "", "app/./core-net.js", "app//core-net.js",
                 "./app/core-net.js", "/server.py", "/app/core-net.js", "/"]
    pos_bad = []
    for p in pos_paths:
        ok, res = safe_join(root, p)
        if ok is not True:
            pos_bad.append((p, res))
        elif os.path.commonpath([root, res]) != root:
            pos_bad.append((p, "解析到了根外：" + res))
    check("合法路径（含 URL 的根锚点写法 /x）全部解析到根目录内（%d 例）" % len(pos_paths),
          not pos_bad, repr(pos_bad))
    check("/server.py 这种写法确实指向真实文件（静态服务可用性）",
          safe_join(root, "/server.py")[0] is True and os.path.isfile(safe_join(root, "/server.py")[1]),
          repr(safe_join(root, "/server.py")))

    traversal = ["../server.py", "app/../server.py", "..", "../", "%2e%2e/server.py",
                 "..%2fserver.py", "app/%2E%2E/server.py", "\\\\nas\\share\\x", "app/%00.txt",
                 ".env", ".git/config", "keys/server.key", "db/app.sqlite", "a\x00b",
                 "app/../../Windows/win.ini", "%252e%252e%252fserver.py", "//etc/passwd",
                 "/C:/Windows/win.ini", "C:/Windows/win.ini", "/etc/passwd\\"]
    leaked = []
    for p in traversal:
        ok, res = safe_join(root, p)
        if ok is True and os.path.commonpath([root, res]) != root:
            leaked.append((one_line(p, 40), res))
    check("目录穿越/UNC/点文件/私钥扩展名全部被拦（%d 例）" % len(traversal), not leaked,
          "逃出根目录 " + repr(leaked))

    strict_reject = [p for p in ["../server.py", ".env", "keys/server.key", "app/../../x",
                                 "//etc/passwd", "C:/Windows/win.ini", "\\\\nas\\share", "/etc/passwd\\"]
                     if safe_join(root, p)[0] is not False]
    check("这些写法是直接 403 拒绝（而不是静默改写路径）", not strict_reject, repr(strict_reject))
    check("像 /etc/passwd 这种「看起来绝对」的 URL 只会落到根内不存在的文件（永不服务系统文件）",
          safe_join(root, "/etc/passwd")[0] is True
          and not os.path.exists(safe_join(root, "/etc/passwd")[1]),
          repr(safe_join(root, "/etc/passwd")))

    tmp = tempfile.mkdtemp(prefix="geonet-selftest-")
    try:
        link_name = os.path.join(tmp, "escape.txt")
        with open(link_name, "w", encoding="utf-8") as fh:
            fh.write("outside")
        inside = os.path.join(root, "_selftest_link.txt")
        os.symlink(link_name, inside)
        try:
            ok, res = safe_join(root, "_selftest_link.txt")
            inside_ok = (ok is not True) or (os.path.commonpath([root, res]) != root) or (not os.path.realpath(inside).startswith(root))
            check("符号链接指向根外时 realpath+commonpath 这一层拦住", ok is not True,
                  "safe_join 放行了链接：%s" % res)
        finally:
            os.remove(inside)
    except (OSError, NotImplementedError) as exc:
        skip("符号链接逃逸防护", "本机不允许创建符号链接（Windows 需要开发者模式/管理员权限）：%s" % type(exc).__name__)
    finally:
        try:
            shutil.rmtree(tmp, ignore_errors=True)
        except OSError:
            pass

    # ---------- D. argv 构造与 shell=False ----------
    src_text = ""
    try:
        with open(os.path.abspath(__file__), "r", encoding="utf-8") as fh:
            src_text = fh.read()
    except OSError as exc:
        src_text = ""
        skip("源码静态审计（禁止 shell 解释器 / 只用标准库）", "读不到自身源码：%s" % exc)
    if src_text:
        # 静态审计必须看**去掉文档字符串之后的代码**，而不是原文：
        # 本文件的注释里大量出现「shell=True 是错的」这种句子，直接扫原文会把说明文字当成违规代码，
        # 反过来「原文里没出现 shell=True」才是有意义的结论。用 ast.unparse 把 docstring 摘掉再扫。
        try:
            tree = _strip_docstrings(ast.parse(src_text))
            code_text = ast.unparse(tree)
            imported = _collected_imports(tree)
            audit_ready = True
        except (SyntaxError, ValueError) as exc:
            code_text, imported, audit_ready = "", set(), False
            failures.append("解析自身源码失败，静态审计无法进行：%s" % exc)
        # 注意「拼接写法」：如果直接写 "shell=True" 这个字面量，它自己就会出现在
        # ast.unparse 的产物里，于是这条审计永远失败（自指）。拆开拼接是为了让**被检的文本
        # 与检它的代码互不重合**，结论才有意义。同理正向断言也不能整字写出来。
        forbidden = ["shell" + "=True", "shell = " + "True", "shell" + ": True",
                     "os" + ".system", "os" + ".popen", "ev" + "al(", "exe" + "c("]
        hits = [t for t in forbidden if t in code_text]
        check("源码（去 docstring 与注释）里没有『把整条命令交给 shell 解释器』的写法", hits == [], repr(hits))
        required = "'shell'" + ": False"
        check("subprocess 参数字典里确实写了 shell=False（正向断言）",
              (required in code_text) or ("shell=" + "False" in code_text), "找不到显式声明")
        stdlib = set(getattr(sys, "stdlib_module_names", ()))
        non_std = sorted(m for m in imported if stdlib and m not in stdlib)
        if stdlib and audit_ready:
            check("只 import 标准库（无第三方依赖）：%s" % ", ".join(sorted(imported)),
                  not non_std, "非标准库模块：" + repr(non_std))
        else:
            skip("只 import 标准库", "sys.stdlib_module_names 需要 Python 3.10+，当前 %s" % sys.version.split()[0])
        check("默认绑定地址写死为 127.0.0.1", DEFAULT_HOST == "127.0.0.1", "当前 %r" % DEFAULT_HOST)
        templates = []
        for sid in sorted(GEOIP_SOURCES):
            templates.append(GEOIP_SOURCES[sid]["url_self"])
            templates.append(GEOIP_SOURCES[sid]["url_query"])
        coord_ph = [t for t in templates if re.search(r"\{(lat|lon|lng|latitude|longitude|position|accuracy)\}", t)]
        no_ip_ph = [GEOIP_SOURCES[sid]["url_query"] for sid in sorted(GEOIP_SOURCES)
                    if "{ip}" not in GEOIP_SOURCES[sid]["url_query"]]
        check("URL 模板里唯一被替换的占位符是 {ip}（不存在坐标占位符）",
              not coord_ph and not no_ip_ph, repr(coord_ph + no_ip_ph))

    argv, exe = build_traceroute_argv("example.com", 20, 3, exe="/fake/traceroute")
    check("traceroute argv 是列表、主机名独立成元素、跳数按参数传入",
          isinstance(argv, list) and argv[-1] == "example.com" and str(MAX_HOPS_LIMIT) not in argv[:1]
          and any(t == "20" for t in argv) and not any(c in t for t in argv for c in (";", "|", "`", "$")),
          repr(argv))
    clamped_hi = build_traceroute_argv("example.com", 999, 3, exe="/fake/traceroute")[0]
    clamped_lo = build_traceroute_argv("example.com", 0, 3, exe="/fake/traceroute")[0]
    check("max_hops 越界被夹到 [1,%d]" % MAX_HOPS_LIMIT,
          str(MAX_HOPS_LIMIT) in clamped_hi and "1" in clamped_lo, repr((clamped_hi, clamped_lo)))
    ping_argv = build_ping_argv("8.8.8.8", 4, 2, exe="/fake/ping")[0]
    ping_over = build_ping_argv("8.8.8.8", 999, 2, exe="/fake/ping")[0]
    check("ping argv 同样受控，count 夹到 [1,%d]" % MAX_PING_COUNT,
          ping_argv[-1] == "8.8.8.8" and str(MAX_PING_COUNT) in ping_over, repr((ping_argv, ping_over)))

    str_run = run_command("ping -c 1 example.com", 5)
    check("把整条命令拼成字符串交给执行层会被拒（这正是注入的入口）",
          str_run["ok"] is False and str_run["error_kind"] == "bad_input", repr(str_run["error"]))
    semi_run = run_command(["/fake/traceroute", "example.com; rm -rf /"], 5)
    check("参数元素含分号/管道等仍被二次拦下（纵深防御）",
          semi_run["ok"] is False and semi_run["error_kind"] == "bad_input", repr(semi_run["error"]))
    missing_run = run_command(["/definitely/not/a/real/program-xyz"], 5)
    check("可执行文件不存在时降级为 command_missing 且不抛异常",
          missing_run["ok"] is False and missing_run["error_kind"] == "command_missing", repr(missing_run["error"]))
    check("注入串在构造 argv 之前就被 validate_host 拦掉（不进入执行层）",
          validate_host("example.com; rm -rf /")["ok"] is False and
          validate_host("example.com`id`")["ok"] is False and
          validate_host("example.com\nGET /api/iface")["ok"] is False, "白名单漏了换行或反引号")

    # ---------- E. 文本解析 ----------
    tw = parse_traceroute_text(SAMPLE_TRACERT_WIN)
    check("Windows tracert 样例解析出 5 跳（含目标 IP 头行）",
          len(tw["hops"]) == 5 and tw["target_ip"] == "93.184.215.14"
          and [h["hop"] for h in tw["hops"]] == [1, 2, 3, 4, 5],
          repr([h["hop"] for h in tw["hops"]]) + " target=" + repr(tw["target_ip"]))
    check("每跳的 RTT 样本逐个保留（3 个），单位毫秒",
          tw["hops"][0]["rtts_ms"] == [1.0, 1.0, 1.0] and len(tw["hops"][1]["rtts_ms"]) == 3,
          repr(tw["hops"][:2]))
    check("「请求超时。」这一跳判为 timed_out 且 ip 为 null（不猜地址）",
          tw["hops"][2]["timed_out"] is True and tw["hops"][2]["ip"] is None
          and tw["hops"][2]["rtts_ms"] == [] and tw["hops"][2]["star_count"] == 3,
          repr(tw["hops"][2]))
    check("末跳地址等于头行目标地址，reached 判据可用",
          tw["hops"][-1]["ip"] == tw["target_ip"], repr((tw["hops"][-1]["ip"], tw["target_ip"])))

    tsub = parse_traceroute_text(
        "Tracing route to localhost [127.0.0.1] over a maximum of 30 hops:\n"
        "  1    <1 毫秒   <1 毫秒   <1 毫秒  127.0.0.1\n"
        "  2     6 ms   <1 毫秒     5 ms  10.0.0.1\n"
        "\nTrace complete.\n")
    check("中文 tracert 的「<1 毫秒」不丢样本，且记为上界而不是测量值",
          tsub["hops"][0]["rtts_ms"] == [] and tsub["hops"][0]["rtt_bounds"] == ["<1", "<1", "<1"]
          and tsub["hops"][0]["timed_out"] is False and tsub["hops"][0]["status"] == "ok",
          repr(tsub["hops"][0]))
    check("同一行混有实测值与上界时各归各列（6/5 进 rtts，<1 进 bounds）",
          tsub["hops"][1]["rtts_ms"] == [6.0, 5.0] and tsub["hops"][1]["rtt_bounds"] == ["<1"],
          repr(tsub["hops"][1]))

    tu = parse_traceroute_text(SAMPLE_TRACEROUTE_UNIX)
    check("类 Unix traceroute 样例解析出 5 跳",
          len(tu["hops"]) == 5 and tu["target_ip"] == "93.184.215.14",
          repr(len(tu["hops"])) + " " + repr(tu["target_ip"]))
    check("括号里的重复 IP 不重复计入跳数，第二个进 alt_ips",
          tu["hops"][1]["ip"] == "10.0.0.138" and tu["hops"][1]["alt_ips"] == ["10.0.0.138"],
          repr(tu["hops"][1]))
    check("浮点 RTT 保留三位小数且顺序不变",
          tu["hops"][0]["rtts_ms"] == [0.842, 0.731, 0.700], repr(tu["hops"][0]["rtts_ms"]))
    check("`* * *` 行判超时（与中文提示走同一结论）",
          tu["hops"][2]["timed_out"] is True and tu["hops"][2]["ip"] is None, repr(tu["hops"][2]))
    tj = parse_traceroute_text(SAMPLE_TRACEROUTE_JUNK)
    check("完全无法识别的输出返回空 hops（绝不编造跳数）",
          tj["hops"] == [] and tj["target_ip"] is None, repr(tj["hops"])[:160])
    check("空输入/非字符串输入解析不抛异常",
          parse_traceroute_text("")["hops"] == [] and parse_traceroute_text(None)["hops"] == [])

    pw = parse_ping_text(SAMPLE_PING_WIN_CN)
    check("中文 Windows ping 统计段解析正确",
          (pw["sent"], pw["received"], pw["lost"], pw["loss_percent"]) == (4, 2, 2, 50.0)
          and (pw["min_ms"], pw["avg_ms"], pw["max_ms"]) == (1.0, 1.0, 2.0)
          and pw["samples_ms"] == [1.0, 2.0] and pw["target_ip"] == "93.184.215.14",
          repr(pw))
    pe = parse_ping_text(SAMPLE_PING_WIN_EN)
    check("英文 Windows ping 统计段解析正确",
          (pe["sent"], pe["received"], pe["lost"], pe["loss_percent"]) == (4, 4, 0, 0.0)
          and (pe["min_ms"], pe["avg_ms"], pe["max_ms"]) == (10.0, 10.0, 11.0), repr(pe))
    pu = parse_ping_text(SAMPLE_PING_UNIX)
    check("Linux ping 的 rtt min/avg/max/mdev 行解析正确",
          (pu["sent"], pu["received"], pu["loss_percent"]) == (2, 2, 0.0)
          and (pu["min_ms"], pu["avg_ms"], pu["max_ms"], pu["mdev_ms"]) == (0.731, 0.786, 0.842, 0.057), repr(pu))
    check("Linux 不单独打印 lost 数时保持 null（不把它当 0）",
          pu["lost"] is None, repr(pu["lost"]))
    pl = parse_ping_text(SAMPLE_PING_TOTAL_LOSS)
    check("100% 丢包被解析成「收到 0」而不是「命令失败」",
          pl["received"] == 0 and pl["lost"] == 4 and pl["loss_percent"] == 100.0, repr(pl))
    check("统计段缺失时用逐条回复样本兜底平均（真实测得值，不是推测值）",
          parse_ping_text("Reply from 1.2.3.4: time=3ms\nReply from 1.2.3.4: time=5ms")["avg_ms"] == 4.0,
          repr(parse_ping_text("Reply from 1.2.3.4: time=3ms\nReply from 1.2.3.4: time=5ms")))
    pm = parse_ping_text("PING 192.0.2.2 (192.0.2.2): 56 data bytes\n"
                         "--- 192.0.2.2 ping statistics ---\n"
                         "2 packets transmitted, 0 packets received, 100.0% packet loss")
    check("macOS/BSD 的 `0 packets received` 写法也能解析（量词不写就漏解析）",
          (pm["sent"], pm["received"], pm["loss_percent"]) == (2, 0, 100.0) and pm["target_ip"] == "192.0.2.2",
          repr(pm))

    # ---------- F. GeoIP 归一（纯 mock，不发请求） ----------
    all_src_ok = True
    detail_src = []
    for sid, body in sorted(SAMPLE_GEOIP.items()):
        r = parse_geoip_json(body, sid)
        if r["ok"] is not True or r["lat"] is None or r["lon"] is None:
            all_src_ok = False
            detail_src.append((sid, r["error"]))
    check("五个来源的样例响应都能归一成 {ip,lat,lon,accuracy_km,city,country}（%d 家）" % len(SAMPLE_GEOIP),
          all_src_ok, repr(detail_src))
    ipinfo = parse_geoip_json(SAMPLE_GEOIP["ipinfo_io"], "ipinfo_io")
    check("ipinfo 的 loc 按「纬度在前、经度在后」拆分（顺序写反是本类代码的头号 bug）",
          ipinfo["lat"] == 37.4056 and ipinfo["lon"] == -122.0775, repr((ipinfo["lat"], ipinfo["lon"])))
    check("没有精度字段的来源返回 accuracy_km=null + accuracy_fallback=True（不编数）",
          parse_geoip_json(SAMPLE_GEOIP["ipapi_com"], "ipapi_com")["accuracy_km"] is None
          and parse_geoip_json(SAMPLE_GEOIP["ipapi_com"], "ipapi_com")["accuracy_fallback"] is True,
          repr(parse_geoip_json(SAMPLE_GEOIP["ipapi_com"], "ipapi_com")))
    check("ipapi.co 的 accuracy_radius 被识别为公里级精度",
          parse_geoip_json(SAMPLE_GEOIP["ipapi_co"], "ipapi_co")["accuracy_km"] == 100.0
          and parse_geoip_json(SAMPLE_GEOIP["ipapi_co"], "ipapi_co")["accuracy_fallback"] is False,
          repr(parse_geoip_json(SAMPLE_GEOIP["ipapi_co"], "ipapi_co")))
    missing_lat = parse_geoip_json({"ip": "1.1.1.1", "city": "X"}, "ipapi_co")
    check("缺经纬度 → error_kind=field_missing 且 lat/lon 仍为 null",
          missing_lat["ok"] is False and missing_lat["error_kind"] == "field_missing"
          and missing_lat["lat"] is None and missing_lat["lon"] is None, repr(missing_lat["error"]))
    upstream_fail = parse_geoip_json({"status": "fail", "message": "Invalid query"}, "ipapi_com")
    check("上游自报 status=fail 时把它的 message 带出来",
          upstream_fail["ok"] is False and "Invalid query" in (upstream_fail["error"] or ""),
          repr(upstream_fail["error"]))
    oob = parse_geoip_json({"latitude": 120.0, "longitude": 200.0}, "ipapi_co")
    check("经纬度越界判 field_invalid（不返回一个看起来正常的伪解）",
          oob["ok"] is False and oob["error_kind"] == "field_invalid", repr(oob["error"]))
    # 下面四条与 bridge-powershell.ps1 的 F2 段一一对应：两份桥对同一份上游 JSON 必须给同一个结果。
    bool_lat = parse_geoip_json({"latitude": True, "longitude": 1.0}, "freeipapi")
    check("布尔值不当坐标（float(True)=1.0 会在两份桥各造一个「北纬 1 度」）",
          bool_lat["ok"] is False and bool_lat["error_kind"] == "field_invalid", repr(bool_lat["error"]))
    case_status = parse_geoip_json({"status": "Success", "lat": 1.0, "lon": 2.0}, "ipapi_com")
    check("status 比较区分大小写：Success 判失败（PowerShell 的 -eq 本来会放过它，已改成 Ordinal）",
          case_status["ok"] is False and case_status["error_kind"] == "field_missing", repr(case_status["error"]))
    check("上游给数组不是对象 → json_error（isinstance 那一判）",
          parse_geoip_json([1, 2, 3], "ipapi_com")["error_kind"] == "json_error"
          and parse_geoip_json("text", "ipapi_com")["error_kind"] == "json_error",
          repr(parse_geoip_json([1, 2, 3], "ipapi_com")))
    empty_city = parse_geoip_json({"status": "success", "lat": 1.0, "lon": 2.0, "city": ""}, "ipapi_com")
    check("上游真给了空串就返回空串，不退到下一个候选（两份桥给同一个值）",
          empty_city["ok"] is True and empty_city["city"] == "", repr(empty_city["city"]))
    one_axis = parse_geoip_json({"status": "success", "lat": 10.5}, "ipapi_com")
    check("只解析出一个坐标轴报 field_invalid，而不是当成「没有坐标」",
          one_axis["ok"] is False and one_axis["error_kind"] == "field_invalid", repr(one_axis["error_kind"]))
    check("归一结果固定 11 个键（ps1 的 Get-NormalizedGeoIp 同集）",
          sorted(parse_geoip_json({"status": "success", "lat": 1.0, "lon": 2.0}, "ipapi_com")) ==
          ["accuracy_fallback", "accuracy_km", "city", "country", "error", "error_kind",
           "ip", "lat", "lon", "ok", "source"],
          repr(sorted(parse_geoip_json({}, "ipapi_com"))))
    check("未知来源返回结构化错误而不是异常",
          parse_geoip_json({"lat": 1}, "no_such_source")["error_kind"] == "json_error"
          or parse_geoip_json({"lat": 1}, "no_such_source")["ok"] is False,
          repr(parse_geoip_json({"lat": 1}, "no_such_source")))
    check("_finite 把 NaN/inf/字符串都换成 None（绝不让 NaN 进 JSON）",
          _finite(float("nan")) is None and _finite(float("inf")) is None
          and _finite("abc") is None and _finite("1e3") == 1000.0 and _finite(None) is None, repr(_finite("x")))
    nan_rejected = True
    try:
        json.loads('{"lat": NaN}', parse_constant=_reject_constant)
        nan_rejected = False
    except ValueError:
        pass
    check("上游 JSON 里的 NaN/Infinity 字面量被拒（→ json_error）", nan_rejected is True, "NaN 被静默接受了")

    tpl_bad = []
    for sid, src in sorted(GEOIP_SOURCES.items()):
        ok, why = is_safe_upstream_url(src["url_query"], require_placeholder=True)
        if ok is not True:
            tpl_bad.append((sid, why))
    check("来源表里每个 {ip} 模板都通过安全校验（%d 个）" % len(GEOIP_SOURCES), not tpl_bad, repr(tpl_bad))
    url, why = build_geoip_url("ipapi_co", "203.0.113.10")
    check("build_geoip_url 把 IP 拼进路径而不是查询串", url == "https://ipapi.co/203.0.113.10/json/", repr((url, why)))
    self_url, _ = build_geoip_url("ipinfo_io", "")
    check("留空 ip 时查自己的出口 IP（URL 里不含任何 IP）", self_url == "https://ipinfo.io/json", repr(self_url))
    check("ip 参数必须是 IP 字面量：给域名也拒绝",
          build_geoip_url("ipapi_co", "example.com")[0] is None
          and build_geoip_url("ipapi_co", "8.8.8.8; rm -rf /")[0] is None, "让非 IP 进了 URL")
    check("custom_url 必须同时给 ip（否则等于开放任意 URL 代理）",
          build_geoip_url("ipapi_co", "", None, "http://my.geo/{ip}")[0] is None, "接受了无 ip 的 custom_url")
    ssrf_bad = [u for u in ["file:///etc/passwd", "http://127.0.0.1/{ip}", "http://localhost/{ip}",
                            "http://169.254.169.254/latest/meta-data/{ip}", "http://10.0.0.9/{ip}",
                            "gopher://x.example/{ip}", "http:///nohost/{ip}", "ftp://a/{ip}"]
                if is_safe_upstream_url(u, True)[0] is not False]
    check("SSRF/非 http 协议的上游 URL 全部被拒（%d 例）" % 8, not ssrf_bad, repr(ssrf_bad))

    # ---------- G. 隐私与 CORS ----------
    coord_in_url = []
    for sid, src in sorted(GEOIP_SOURCES.items()):
        for u in (src["url_self"], src["url_query"].replace("{ip}", "203.0.0.1")):
            if re.search(r"[?&](lat|lon|lng|latitude|longitude|accuracy|loc|position|altitude|heading)=", u):
                coord_in_url.append((sid, u))
            keys = {k.lower() for k in urllib.parse.parse_qs(urllib.parse.urlsplit(u).query)}
            if keys & set(POSITION_PARAMS):
                coord_in_url.append((sid, "参数名命中位置类：" + u))
    check("所有对外 URL 的参数名里没有任何位置信息（隐私红线）", not coord_in_url, repr(coord_in_url))
    check("上游 URL 里唯一可被替换的占位符只有 IP（没有坐标占位符）",
          not [u for sid in GEOIP_SOURCES for u in (GEOIP_SOURCES[sid]["url_self"], GEOIP_SOURCES[sid]["url_query"])
               if re.search(r"\{(lat|lon|lng|latitude|longitude|position|accuracy)\}", u)],
          "模板里出现了坐标占位符")

    check("CORS 只给 /api/*（静态文件不带跨域读权限）",
          is_api_path("/api/health") is True and is_api_path("/api/x") is True
          and is_api_path("/app/core-net.js") is False and is_api_path("/api") is False
          and is_api_path("/evil/api/health") is False and is_api_path(None) is False, "CORS 判定范围不对")

    # 跨站来源白名单：这条边以前是 `*`，现在是一张写死的名单，判定必须逐条钉住，
    # 否则「收紧」会变成一句注释。
    check("白名单：file:// 的 null 与官方托管页放行（大小写不敏感）",
          origin_allowed("null") is True and origin_allowed("https://iammezsh.github.io") is True
          and origin_allowed("HTTPS://IAMMEZSH.GitHub.IO") is True, "本项目自己的两种打开方式被拒了")
    loopback_ok = ["http://127.0.0.1:8765", "http://127.0.0.1", "https://127.0.0.1:8443",
                   "http://localhost:9000", "http://LOCALHOST:1", "http://[::1]:8765",
                   "http://[::ffff:127.0.0.1]:8765"]
    check("白名单：回环来源（含任意端口与 IPv6 方括号写法）全部放行（%d 例）" % len(loopback_ok),
          all(origin_allowed(o) for o in loopback_ok) is True,
          repr([o for o in loopback_ok if origin_allowed(o) is not True]))
    hostile = ["https://evil.example", "http://127.0.0.1.evil.com", "https://iammezsh.github.io.evil.com",
               "https://not-iammezsh.github.io", "http://10.0.0.5:8765", "http://192.168.2.1:8765",
               "http://[::ffff:8.8.8.8]:8765", "http://[2001:db8::1]", "http://127.1:8765",
               "null.com", "//iammezsh.github.io", "https://iammezsh.github.io:443.evil.cn",
               "http://localhost.evil.cn", "http://evil@127.0.0.1:8765", "http://127.0.0.1:8765/api/health",
               "http://127.0.0.1:8765?u=https://evil.example"]
    check("白名单：任意网页与内网非回环来源一律拒绝（%d 例，含前缀伪装）" % len(hostile),
          not [o for o in hostile if origin_allowed(o) is True],
          "误放：" + repr([o for o in hostile if origin_allowed(o) is True]))
    check("没有 Origin 头时照常服务（启动器探测与 curl 不受 CORS 影响）",
          origin_allowed(None) is True and origin_allowed("") is True and origin_allowed("   ") is True,
          "非浏览器客户端被当成跨站来源拒掉了")
    check("--allow-origin 只收完整 origin，写法不对就拒绝启动",
          add_allowed_origin("https://maps.example.com")["ok"] is True
          and origin_allowed("https://maps.example.com") is True
          and add_allowed_origin("maps.example.com")["ok"] is False
          and add_allowed_origin("https://example.com/a?b=1")["ok"] is False
          and add_allowed_origin("")["ok"] is False, "追加名单的校验没挡住畸形写法")
    EXTRA_ALLOWED_ORIGINS.remove("https://maps.example.com")   # 别把这条临时项留给后面的判定
    check("追加名单清空后不再放行（--allow-origin 只在启动时生效，运行期不会被网页自己加宽）",
          origin_allowed("https://maps.example.com") is False and EXTRA_ALLOWED_ORIGINS == [],
          repr(EXTRA_ALLOWED_ORIGINS))
    # 字面量用拼接写：把要禁的那行原样写进检查里，src_text 就会命中自己的检查文本（老坑）。
    check("响应里不再出现通配 `Access-Control-Allow-Origin: *`（改成回显名单内的来源）",
          ('"Access-Control-Allow-' + 'Origin", "*"') not in src_text, "源码里还在发通配头")
    check("预检与实请求走同一张名单（两处都有 403 分支）",
          src_text.count('"origin_not_allowed"') >= 2, "只有一处拒绝，另一处会放过")
    hp = health_payload("127.0.0.1", DEFAULT_PORT)
    check("health 载荷字段与前端 bridgeStatus 对齐（ok/server/version/python/platform/capabilities）",
          hp["ok"] is True and hp["server"] == SERVER_NAME and isinstance(hp["capabilities"], list)
          and hp["privacy"]["position_params_accepted"] is False and hp["bind"]["loopback_only"] is True,
          repr(sorted(hp.keys())))
    hp_text = json.dumps(hp, ensure_ascii=False, allow_nan=False)
    check("health 载荷可被严格 JSON 序列化（说明没有 NaN/Infinity 混进去）", isinstance(hp_text, str), "见上一条")
    check("health 载荷里没有任何坐标字段",
          re.search(r'"(lat|lon|latitude|longitude)"\s*:\s*[-0-9]', hp_text) is None, hp_text[:160])
    # 契约对齐：本文件的载荷必须**恰好**是 BRIDGE_CONTRACT 声明的那些键。
    # 少了页面就少一项事实，多了就是两份实现各说各话（ps1 第一版多了 engine/dotnet，
    # ping 的 argv 在 ps1 里叫 arguments —— 都是这条门当场能抓住的东西）。
    check("契约覆盖 6 个端点，且每份清单已排序、无重复",
          sorted(BRIDGE_CONTRACT) == sorted(["/api/health", "/api/iface", "/api/dns", "/api/ping",
                                             "/api/traceroute", "/api/geoip"])
          and all(v == sorted(v) and len(set(v)) == len(v) for v in BRIDGE_CONTRACT.values()),
          repr({k: len(v) for k, v in BRIDGE_CONTRACT.items()}))
    hp_diff = sorted(set(hp.keys()) ^ set(BRIDGE_CONTRACT["/api/health"]))
    check("health 的键集合与契约完全相同（与 ps1 同一份清单）", not hp_diff, "差异键：" + (", ".join(hp_diff) or "无"))
    if1 = iface_summary("127.0.0.1", DEFAULT_PORT)
    # error/error_kind 只在枚举网卡失败时出现，所以成功响应对的是「契约去掉这两个」。
    if_want = [k for k in BRIDGE_CONTRACT["/api/iface"] if k not in ("error", "error_kind")]
    if_diff = sorted(set(if1.keys()) ^ set(if_want))
    check("iface 成功响应的键与契约（去掉只在失败时出现的 error/error_kind）一字不差", not if_diff,
          "差异键：" + (", ".join(if_diff) or "无"))
    ep_paths = sorted({e.split("?")[0] for e in hp["endpoints"]})
    check("契约端点集合与 health.endpoints 同集（6 条，一份桥多写一个端点就会被抓到）",
          ep_paths == sorted(BRIDGE_CONTRACT.keys()), repr(ep_paths))
    # 字面量用拼接写：把要禁的那行原样写进检查里，src_text 就会命中自己的检查文本（老坑）。
    check("iface 的 ipv4_loopback_present 是真测出来的，不是写死的事实",
          ('"ipv4_loopback' + '_present": True') not in src_text
          and 'probe.connect(("127.0.0.1", 53))' in src_text, "源码里还残留写死的 True")
    check("iface 枚举网卡失败时说「取不到」，不给 0 假装这台机器没有网卡",
          ("except (OSError, AttributeError, ValueError) as exc" in src_text
           and 'out["ok"] = False' in src_text), "见 iface_summary")
    host_now = socket.gethostname()
    check("iface 序列化后不含本机主机名（白名单内的页面照样是别人的浏览器，脱敏红线不变）",
          len(host_now) < 2 or host_now not in json.dumps(if1, ensure_ascii=False), "响应里出现了主机名")
    check("health 如实报出自己的跨站政策（wildcard=False、内建名单非空、含 null）",
          hp["cors_policy"]["wildcard"] is False
          and hp["cors_policy"]["built_in"] == list(CORS_ALLOWED_ORIGINS)
          and "null" in hp["cors_policy"]["built_in"]
          and hp["cors_policy"]["extra"] == []
          and bool(re.search(r"[\u4e00-\u9fff]", hp["cors_policy"]["note"])), repr(hp["cors_policy"]))

    # ---------- G2. 内网目标：允许，但如实标注归属（⑧ 的本职包含追踪自家路由器） ----------
    lan_hits = ["192.168.1.1", "10.0.0.138", "172.16.5.4", "127.0.0.1", "::1", "0.0.0.0",
                "169.254.169.254", "100.64.0.1", "224.0.0.5", "localhost", "router.local",
                "nas.internal", "[::1]"]
    missed = [h for h in lan_hits if target_scope(h)[0] != "lan"]
    check("内网/回环/链路本地/元数据/CGNAT/组播 与本机名全部标为 lan（%d 个样本）" % len(lan_hits),
          not missed, "漏标：" + (", ".join(missed) or "无"))
    public_ok = ["8.8.8.8", "1.1.1.1", "github.com", "example.com", "2606:4700:4700::1111", ""]
    mis_public = [(h, target_scope(h)[0]) for h in public_ok if target_scope(h)[0] != "public"]
    check("公网目标与空值标为 public（把内网说成公网才是真事故）",
          not mis_public, repr(mis_public))
    scope_dom, why_dom = target_scope("box.example", ["8.8.8.8", "192.168.1.1"])
    check("域名解析到内网时也标注出来（内网 DNS / rebinding 看得见）",
          scope_dom == "lan" and "解析到内网" in (why_dom or ""), repr(why_dom))
    # 拼接 needle：把字面量拆开，被检的文本和检它的代码就不重合（同 D 段 shell=True 的处理）。
    scope_needle = '"target_' + 'scope": scope'
    check("traceroute 与 ping 的成功响应里都带 target_scope（前端才有东西可显示）",
          src_text.count(scope_needle) >= 2, "命中 %d 处" % src_text.count(scope_needle))
    check("拦截路径已彻底移除：没有拒绝用的闸函数，也没有它的提示函数",
          "target_guard" not in globals() and "lan_refusal_message" not in globals()
          and ("lan_target" + "_refused") not in src_text,
          repr([n for n in ("target_guard", "lan_refusal_message") if n in globals()]))
    check("启动参数里没有内网开关（没有开关=默认允许，不给「忘了加参数」留坑）",
          ("--allow-lan" + "-targets") not in src_text, "源码里还残留该开关")
    hp_policy = health_payload("127.0.0.1", DEFAULT_PORT)
    check("health 如实声明：内网目标允许，且说明 target_scope 是标注字段",
          hp_policy["privacy"]["lan_targets_allowed"] is True
          and "target_scope" in hp_policy["privacy"]["note"], repr(hp_policy["privacy"])[:120])

    # ---------- H. 绑定地址（绝不监听 0.0.0.0） ----------
    non_loopback = ["0.0.0.0", "::", "192.168.1.5", "10.0.0.1", "172.16.0.1", "", None, "0.0.0.1"]
    wrongly_ok = [h for h in non_loopback if is_bind_address_loopback(h)[0] is True]
    check("非回环绑定地址一律拒绝（%d 例）" % len(non_loopback), not wrongly_ok, repr(wrongly_ok))
    loop_ok = [h for h in ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]
               if is_bind_address_loopback(h)[0] is not True]
    check("回环地址全部放行（%d 例）" % 4, not loop_ok, repr([(h, is_bind_address_loopback(h)[1]) for h in loop_ok]))
    srv, srv_err = create_server("0.0.0.0", DEFAULT_PORT, BridgeHandler)
    check("create_server 对 0.0.0.0 直接拒绝且没有创建监听套接字",
          srv is None and isinstance(srv_err, str) and HAS_CN.search(srv_err) is not None, repr(srv_err))
    reason_cn = is_bind_address_loopback("0.0.0.0")[1] or ""
    check("拒绝理由解释了「为什么」而不只是「不行」",
          "命令" in reason_cn or "危险" in reason_cn, repr(reason_cn))

    # 重复启动防护：Windows 的 SO_REUSEADDR 允许第二个进程绑到正在监听的端口，
    # 两个桥接同时 LISTENING 时请求被随机分走，页面正常但用的可能是旧代码起的那个。
    _orig_probe = port_listener_present
    try:
        globals()["port_listener_present"] = lambda h, p, timeout_s=0.35: True
        dup_srv, dup_err = create_server("127.0.0.1", DEFAULT_PORT, BridgeHandler)
        check("端口已有监听者时不再起第二个（不创建监听套接字）",
              dup_srv is None and isinstance(dup_err, str) and ("换端口" in dup_err or "--port" in dup_err),
              repr(dup_err)[:90])
    finally:
        globals()["port_listener_present"] = _orig_probe
    check("预探测函数本身不吞非 OSError（返回值只有真假）",
          port_listener_present("127.0.0.1", 1) is False,
          "端口 1 上没有监听者 → False（这里只发一次回环 connect，不外联）")

    # ---------- I. 超时与降级 ----------
    done, value, err = run_with_timeout(lambda: 42, 2.0)
    check("run_with_timeout 正常返回结果", (done, value, err) == (True, 42, None), repr((done, value, err)))
    slow_done, _, slow_err = run_with_timeout(lambda: time.sleep(1.5), 0.05)
    check("阻塞调用超时后立刻返回降级说明（getaddrinfo 不可中断，必须这样兜）",
          slow_done is False and "未完成" in (slow_err or ""), repr(slow_err))
    def _boom():
        raise RuntimeError("模拟内部错误")

    boom_done, _, boom_err = run_with_timeout(_boom, 1.0)
    check("线程里的异常被转成错误文本而不是冒出来",
          boom_done is False and "RuntimeError" in (boom_err or ""), repr(boom_err))
    check("IP 字面量的 DNS 走本地判定，不发起任何查询",
          resolve_dns("8.8.8.8")["ok"] is True and resolve_dns("8.8.8.8")["addresses"] == ["8.8.8.8"]
          and "未发起查询" in (resolve_dns("8.8.8.8").get("note") or ""), repr(resolve_dns("8.8.8.8")))
    check("非法主机名的 DNS 端点返回 bad_input 而不是异常",
          resolve_dns("bad host;rm -rf /")["error_kind"] == "bad_input", repr(resolve_dns("bad host;x")))
    check("clamp_int 对非数字/越界一律回默认或夹紧（不抛）",
          clamp_int("abc", 4, 1, 10) == 4 and clamp_int("999", 4, 1, 10) == 10
          and clamp_int("-5", 4, 1, 10) == 1 and clamp_int("", 20, 1, 30) == 20, "夹紧逻辑不对")
    dirty = one_line("a\r\n[伪造] GET /api/iface -> 200 0.0ms", 200)
    check("日志字段压成一行（防 CRLF 日志注入）",
          "\r" not in dirty and "\n" not in dirty and "[伪造]" in dirty, repr(dirty))
    iface = iface_summary("127.0.0.1", DEFAULT_PORT)
    iface_text = json.dumps(iface, ensure_ascii=False, allow_nan=False)
    check("iface 端点只报数量与回环事实，不回主机名/MAC/内网地址",
          iface["bind_is_loopback"] is True and "hostname" in iface["redacted_fields"]
          and "mac" in iface["redacted_fields"] and socket.gethostname() not in iface_text,
          repr(sorted(iface.keys())))

    # ---------- J. 非法输入不崩 ----------
    garbage = [None, "", " ", ";", "a" * 5000, "\x00\x01", "1", "-1", "99999999999999999999", "[]", "{}"]
    survived = True
    for g in garbage:
        try:
            validate_host(g)
            safe_join(root, g)
            clamp_int(g, 4, 1, 10)
            find_position_params(g if isinstance(g, dict) else {"host": g})
            parse_traceroute_text(g)
            parse_ping_text(g)
            parse_geoip_json({"lat": g}, "ipapi_co")
            build_geoip_url(g, g)
            is_safe_upstream_url(g)
            is_api_path(g)
        except Exception as exc:
            survived = False
            failures.append("垃圾输入 %r 触发异常：%s: %s" % (one_line(g, 20), type(exc).__name__, exc))
    check("全公共函数 × 垃圾参数扫描：无异常逃逸（%d 种垃圾输入）" % len(garbage), survived is True,
          "见上一条")

    if os.path.isdir(tmp):
        shutil.rmtree(tmp, ignore_errors=True)
    return passed[0], failures, skips


def print_safe(text):
    """打印中文而不因控制台代码页崩掉。

    Windows 的 cmd 默认 cp936，UTF-8 管道（Git Bash / VSCode 终端）默认 utf-8；
    两边都可能碰上「这个字符我编码不了」。本工具的**全部输出都是中文说明**，
    如果因为一个字符编码失败就抛 UnicodeEncodeError 并退出，等于工具直接不可用。
    所以这里退让一步：用 errors='replace' 重打一遍，宁可少一个字也不崩。
    """
    try:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
    except (UnicodeEncodeError, ValueError):
        enc = getattr(sys.stdout, "encoding", None) or "utf-8"
        sys.stdout.write(text.encode(enc, errors="replace").decode(enc, errors="replace") + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        # 输出被 `| head` 之类截断：正常退出，不写 traceback
        pass


# ================================================================ 8. 服务启动

def port_listener_present(host, port, timeout_s=0.35):
    """绑定之前探一次端口上是否已有人在听。只发起一次回环 TCP 连接、不发任何数据。

    为什么需要这一步：HTTPServer 开着 SO_REUSEADDR，而 **Windows 的 SO_REUSEADDR 允许第二个
    进程绑到正在监听的端口**（POSIX 会直接 EADDRINUSE）。于是重复启动启动器会得到两个同时 LISTENING
    的桥接，连接被随机分走——页面看着一切正常，实际可能在跟上一版代码起的服务说话。
    """
    try:
        with socket.create_connection((host, int(port)), timeout=timeout_s):
            return True
    except OSError:
        return False


def port_conflict_message(host, port):
    return ("%s:%s 已经有一个桥接服务在监听，本次启动已取消（没有创建监听套接字）。"
            "Windows 允许重复绑定，再起一个只会让请求被两个服务随机分走，你可能连到的是上一次那个旧版本。"
            "直接用已有的那个就行；确实要新起一个请换端口：python server.py --port %d"
            % (host, port, int(port) + 1))


def create_server(host, port, handler_cls):
    """先验回环、再查端口有没有人、再绑定、绑定后**再复核一次实际地址**。返回 (server 或 None, 错误说明)。

    三层检查不是强迫症：`('0.0.0.0', port)` 这种写法只要漏过第一层就会直接监听所有网卡，
    而绑定成功后 socket 已经在听了 —— 所以绑定结果本身也要复核，不对就立刻关掉。
    """
    ok, reason = is_bind_address_loopback(host)
    if ok is not True:
        return None, reason
    if port_listener_present(host, port):
        return None, port_conflict_message(host, port)
    try:
        srv = ThreadingHTTPServer((host, int(port)), handler_cls)
    except OSError as exc:
        return None, "绑定 %s:%s 失败：%s（端口被占用？换个 --port 再试）" % (host, port, exc)
    actual = srv.server_address[0]
    ok2, reason2 = is_bind_address_loopback(actual)
    if ok2 is not True:
        srv.server_close()
        return None, "绑定结果不是回环地址（%s），已关闭：%s" % (actual, reason2)
    srv.daemon_threads = True          # 请求线程不阻止 Ctrl+C 退出
    srv.request_queue_size = 16        # 本地工具不需要大 backlog
    return srv, None


USAGE = """
经纬度定位工作站 · 本地桥接服务已启动
--------------------------------------------------------------------------
  监听：  http://{host}:{port}/      （只绑回环；本服务不会监听 0.0.0.0）
  根目录：{root}
  停止：  按 Ctrl+C

端点（全部只读 GET，返回 JSON）：
  /api/health                              服务与工具可用性、隐私与限制声明
  /api/traceroute?host=example.com&max_hops=20   代跑系统 traceroute/tracert，返回逐跳结构化数据
  /api/ping?host=example.com&count=4        代跑系统 ping，返回统计段
  /api/dns?host=example.com                仅做名字解析（socket，不经 shell）
  /api/iface                               只报「是否只在回环上」和接口数量，不含主机名/MAC
  /api/geoip?source=ipapi_co               透传上游 GeoIP JSON（留空 ip = 查本机出口 IP）
  其余路径 = 项目静态文件（拒绝 .. 与点文件/私钥）

配套前端：在浏览器打开项目里的页面后，`GEONET.tracerouteViaBridge(host)` 会自动走这里。
  /api/* 的跨站读权限只给来源白名单：null（file:// 打开的页面）、回环 origin、官方托管页
  https://iammezsh.github.io；命中时**原样回显那个 Origin**（不是 `*`），名单外一律 403
  origin_not_allowed。要加自己的域名或内网镜像用 --allow-origin（可重复）。
  没有 Origin 头的客户端（启动器探测、curl）不受影响；静态资源一律不带 CORS 头。

安全说明：所有外部输入先过白名单（字符集 [A-Za-z0-9._:-] + 结构校验），
  再以 argv 列表 + shell=False 交给 subprocess；非法输入直接 400 并给中文原因。
  本服务不接收任何坐标类参数（lat/lon/accuracy 等一律拒绝）。
  traceroute/ping **允许内网目标**：追踪自家路由器/局域网设备本来就是它的用途之一。
  响应里的 target_scope 会标明这次的目标算内网（回环/私有/链路本地/云元数据/CGNAT）还是公网，
  域名还会按解析结果判定，所以你看得见包到底有没有跑出局域网。
--------------------------------------------------------------------------
"""


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="server.py", description="经纬度定位工作站的本地桥接服务（只监听回环，仅标准库）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口（默认 %d）" % DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help="绑定地址，只允许回环（127.0.0.1 / ::1 / localhost）")
    parser.add_argument("--root", default=None, help="静态根目录（默认为本文件所在目录）")
    parser.add_argument("--quiet", action="store_true", help="不打印每请求一行日志")
    parser.add_argument("--allow-origin", action="append", default=[], dest="allow_origin",
                        help="追加一个允许跨站调用 /api/* 的来源（可重复，如 https://example.com）；"
                             "默认名单已含 file://、回环与官方托管页")
    parser.add_argument("--selftest", action="store_true", help="离线自检后退出（不监听端口、不外联）")
    args = parser.parse_args(argv)

    for o in args.allow_origin:
        r = add_allowed_origin(o)
        if r.get("ok") is not True:
            print_safe("启动被拒绝：%s" % r.get("error"))
            return 2

    root = os.path.abspath(args.root or os.path.dirname(os.path.abspath(__file__)))

    if args.selftest:
        n, failures, skips = run_selftest(root)
        for line in failures:
            sys.stderr.write("  [失败] %s\n" % line)
        for line in skips:
            sys.stderr.write("  [跳过] %s\n" % line)
        if failures:
            print_safe("自检失败 %d 项，通过 %d 项（共 %d 项判定，未达标项见上方 [失败]）"
                       % (len(failures), n, n + len(failures)))
            return 1
        if skips:
            print_safe("自检通过 %d 项（另有 %d 项因本机条件不支持而跳过，见上方 [跳过]）" % (n, len(skips)))
        else:
            print_safe("自检通过 %d 项" % n)
        return 0

    if not os.path.isdir(root):
        print_safe("静态根目录不存在：%s" % root)
        return 2

    BridgeHandler.root_dir = root
    BridgeHandler.quiet = bool(args.quiet)
    BridgeHandler.bind_host = args.host
    BridgeHandler.bind_port = args.port

    srv, err = create_server(args.host, args.port, BridgeHandler)
    if srv is None:
        # 「绝不监听 0.0.0.0」：这里不是警告，是拒绝启动。
        print_safe("启动被拒绝：%s" % err)
        return 2
    actual_host, actual_port = srv.server_address[0], srv.server_address[1]
    if not args.quiet:
        print_safe(USAGE.format(host=actual_host, port=actual_port, root=root))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        # serve_forever 在主线程里跑，Ctrl+C 直接抛出；这里不需要 shutdown()（它要求从另一线程调用）。
        if not args.quiet:
            print_safe("\n已按 Ctrl+C 停止，正在释放端口……")
    except OSError as exc:
        print_safe("服务因操作系统错误退出：%s" % exc)
        return 1
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
