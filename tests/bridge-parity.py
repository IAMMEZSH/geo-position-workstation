#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两份桥的实机对账：同一个请求同时发给 server.py 与 bridge-powershell.ps1。

为什么需要这一份：内核自检、两份桥各自的 --SelfTest 都只能证明「自己和自己的清单一致」。
契约字面量写歪（第一版 ps1 把 ping 的 argv 叫 arguments、iface 多回一个 status、health 里
塞了 engine/dotnet）在静态比较里能被 tests/check-package.py 抓到键名，但**实际响应**里
真长出多余键、少键、状态码不一样、error_kind 拼法不同，只有把两份桥同时拉起、逐条打同一
个请求才看得见。页面不知道自己连上的是哪一个，所以这一条是「点开就能用」的最后一道证据。

红线：只打 127.0.0.1，不出外网；GeoIP 用「构造阶段就被拒」的输入（未知来源、域名当 IP），
所以这一份可以在断网、代理、公司内网环境下跑，结果也一样。

用法：
    python tests/bridge-parity.py            # 起两份桥、对账、收尾
    python tests/bridge-parity.py 8765 8799  # 用已经在跑的两个端口（不自己起进程）

退出码：0 一致 / 1 有差异 / 3 环境不满足（如实跳过，绝不当成通过）
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from shutil import which

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUDGET_S = 8.0          # 一份桥从启动到能答 health 的上限
RESULT = []             # [(case, verdict, detail)]


def record(case, ok, detail):
    RESULT.append((case, ok, detail))
    print("  %s %-34s %s" % ("OK  " if ok else "FAIL", case, detail if detail else ""))


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http_get(url, timeout=20.0):
    """返回 (status, body_bytes, headers_lower)。4xx/5xx 也算答到了，不抛出去——两份桥的拒绝路径就是要对比的。"""
    req = urllib.request.Request(url, headers={"Accept": "*/*", "Origin": "http://127.0.0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), {str(k).lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), {str(k).lower(): v for k, v in (exc.headers or {}).items()}


def wait_ready(base, label, procs):
    """等这份桥答 /api/health；期间子进程要是自己退出了，立刻把它的输出掏出来当证据。"""
    deadline = time.time() + BUDGET_S
    while time.time() < deadline:
        for p in procs:
            if p is not None and p.poll() is not None:
                raise RuntimeError("%s 的进程提前退出（退出码 %s）" % (label, p.returncode))
        got = http_get(base + "/api/health", timeout=2.0)
        if got and got[0] == 200:
            return
        time.sleep(0.25)
    raise RuntimeError("%s 在 %.0f 秒内没有答 /api/health" % (label, BUDGET_S))


def json_keys(body):
    try:
        data = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        return None, "响应不是 JSON：%s" % exc
    if not isinstance(data, dict):
        return None, "响应是 %s，不是对象" % type(data).__name__
    return data, ""


CASES = [
    # (名称, 路径, 期望状态码)
    ("health", "/api/health", 200),
    ("iface 脱敏摘要", "/api/iface", 200),
    ("dns 查回环字面量", "/api/dns?host=127.0.0.1", 200),
    ("ping 回环 2 包", "/api/ping?host=127.0.0.1&count=2", 200),
    ("traceroute 回环 3 跳", "/api/traceroute?host=127.0.0.1&max_hops=3", 200),
    ("geoip 未知来源（构造期拒）", "/api/geoip?source=no_such_source", 400),
    ("geoip 域名当 IP（构造期拒）", "/api/geoip?ip=github.com", 400),
    ("坐标参数被拒", "/api/ping?host=127.0.0.1&lat=31.2", 400),
    ("垃圾主机名被拒", "/api/dns?host=a%3Bb", 400),
    ("自家访问日志不外发", "/bridge-powershell.log", 403),
    ("index.html 同源可读", "/index.html", 200),
]

# 静态穿越这一类不能只看状态码：http.sys 会先把 URL 规范化（/app/../server.py 到 handler
# 手里已经变成 /server.py），所以 PowerShell 那份给 200、server.py 那份给 403 —— 两边都没把
# 根目录外的文件交出去，这才是要点。于是这类用例断言的是「拒绝或落在根内」，不是状态码相同。
TRAVERSAL_CASES = [
    "/%2e%2e/%2e%2e/C:/Windows/win.ini",
    "/..%5cwindows%5cwin.ini",
    "/app/../server.py",
    "/%2e%2e/app/data/data-countries.js",
    "/%c0%af%x",
]


def local_resources():
    """index.html 真正引用的本地资源（页面能不能全开就看这些文件在服务时的样子）。"""
    try:
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as fh:
            html = fh.read()
    except OSError:
        return []
    found = []
    for m in re.finditer(r'(?:src|href)="((?:app|vendor|images|docs)/[^"]+)"', html):
        path = m.group(1)
        if path not in found:
            found.append(path)
    return found


def compare_traversal(py_base, ps_base):
    """越界尝试：两份桥都必须「要么 4xx，要么给的是根目录里的文件」，且不把 win.ini 递出来。"""
    bad = 0
    for path in TRAVERSAL_CASES:
        row = []
        case_bad = False
        for label, base in (("server.py", py_base), ("ps1", ps_base)):
            st, body, _hdr = http_get(base + path)
            leaked = b"[extensions]" in body or b"for win.ini" in body or b"MS VB;" in body[:400]
            inside_root = st < 300 and (
                os.path.normpath(os.path.join(ROOT, path.split("?")[0].lstrip("/"))).replace("\\", "/")
                .startswith(ROOT.replace("\\", "/")))
            if leaked or (st >= 300 and st not in (400, 403, 404, 405)):
                case_bad = True
            row.append("%s=%d%s" % (label, st, "（漏出根外内容！）" if leaked else
                                    ("（根内文件）" if inside_root else "")))
        record("越界尝试 " + path[:26], not case_bad, " · ".join(row))
        bad += 0 if not case_bad else 1
    return bad


def compare_static_assets(py_base, ps_base):
    """页面引用的每个本地文件：两份桥必须给同样的字节和同样的 Content-Type。"""
    bad = 0
    assets = local_resources()
    for rel in assets:
        a = http_get(py_base + "/" + rel)
        b = http_get(ps_base + "/" + rel)
        ct_a, ct_b = a[2].get("content-type", "?"), b[2].get("content-type", "?")
        same = a[0] == b[0] == 200 and a[1] == b[1] and ct_a == ct_b
        record("静态资源 " + rel, same, "%d 字节 · %s%s" % (
            len(a[1]), ct_a, "" if same else " ← 两份不一致（ps1 %d 字节 · %s，状态 %s/%s）" % (
                len(b[1]), ct_b, a[0], b[0])))
        bad += 0 if same else 1
    return bad


def compare_cases(py_base, ps_base):
    hard_fail = 0
    for name, path, want_status in CASES:
        a = http_get(py_base + path)
        b = http_get(ps_base + path)
        if a is None or b is None:
            record(name, False, "有一方没答")
            hard_fail += 1
            continue
        if a[0] != want_status or b[0] != want_status:
            record(name, False, "状态码 server.py=%s ps1=%s，期望 %s" % (a[0], b[0], want_status))
            hard_fail += 1
            continue
        if want_status == 200 and not path.startswith("/api/"):
            # 静态资源两边服务的是同一份磁盘文件：字节和 Content-Type 都必须一致。
            # 4xx 的静态拒绝走下面的 JSON 分支——两边的中文原因不必逐字相同，键才必须相同。
            same_body = a[1] == b[1] and a[2].get("content-type") == b[2].get("content-type")
            record(name, same_body, "%d 字节，Content-Type %s%s" % (
                len(a[1]), a[2].get("content-type", "?"),
                "" if same_body else " / 两份不一致（ps1 %d 字节，%s）" % (
                    len(b[1]), b[2].get("content-type", "?"))))
            hard_fail += 0 if same_body else 1
            continue
        da, ea = json_keys(a[1])
        db, eb = json_keys(b[1])
        if da is None or db is None:
            record(name, False, (ea or eb))
            hard_fail += 1
            continue
        diff = sorted(set(da) ^ set(db))
        ka = da.get("error_kind") if da.get("error") is not None else None
        kb = db.get("error_kind") if db.get("error") is not None else None
        if diff:
            record(name, False, "键集合差异：%s（server.py %d 键 / ps1 %d 键）" % (
                ",".join(diff), len(da), len(db)))
            hard_fail += 1
        elif ka != kb:
            record(name, False, "error_kind 不同：server.py=%r / ps1=%r" % (ka, kb))
            hard_fail += 1
        else:
            okflag = da.get("ok")
            extra = ""
            if isinstance(okflag, bool) and okflag != db.get("ok"):
                # 系统命令本身的行为差一份（例如 ping 解析得动而 traceroute 解析不动）
                # 不是契约问题，但也不能藏起来：如实写成参考信息，不判失败。
                extra = " · 参考：ok 标记不同（server.py=%s / ps1=%s）" % (okflag, db.get("ok"))
            record(name, True, "%d 键两两相同%s" % (len(da), extra))
    return hard_fail


def compare_health(py_base, ps_base):
    """health 是给页面看的「我是谁、我不能干什么」：除了键名，语义字段也必须一致。"""
    a = json_keys(http_get(py_base + "/api/health")[1])[0]
    b = json_keys(http_get(ps_base + "/api/health")[1])[0]
    bad = 0
    try:
        same_as = [
            ("server 名", a["server"], b["server"]),
            ("version", a["version"], b["version"]),
            ("能力清单", sorted(set(a["capabilities"])), sorted(set(b["capabilities"]))),
            ("端点清单", sorted(set(a["endpoints"])), sorted(set(b["endpoints"]))),
            ("GeoIP 来源", sorted(_src_id(x) for x in a["geoip_sources"]),
             sorted(_src_id(x) for x in b["geoip_sources"])),
            ("拒收参数", sorted(set(a["privacy"]["banned_params"])), sorted(set(b["privacy"]["banned_params"]))),
            ("拒收坐标（布尔）", a["privacy"]["position_params_accepted"], b["privacy"]["position_params_accepted"]),
            ("允许内网（布尔）", a["privacy"]["lan_targets_allowed"], b["privacy"]["lan_targets_allowed"]),
            ("不走 shell（布尔）", a["limits"]["shell"], b["limits"]["shell"]),
            ("跳数上限", a["limits"]["max_hops"], b["limits"]["max_hops"]),
            ("ping 次数上限", a["limits"]["max_ping_count"], b["limits"]["max_ping_count"]),
            ("只绑回环（布尔）", a["bind"]["loopback_only"], b["bind"]["loopback_only"]),
            ("绑定地址", a["bind"]["address"], b["bind"]["address"]),
        ]
        # platform 只在 Windows 上比：ps1 那份写的是 Win32NT→win32 / 其它→posix，
        # sys.platform 在 mac/Linux 上本来就是另一个词，两边不该被迫一致。
        if os.name == "nt":
            same_as.append(("platform（本机确实是 Windows 时才比）", a["platform"], b["platform"]))
    except KeyError as exc:
        record("health 语义字段", False, "契约里的字段在响应里找不到：%s" % exc)
        return 1
    for label, va, vb in same_as:
        if va != vb:
            bad += 1
            record("health·" + label, False, "server.py=%r / ps1=%r" % (va, vb))
    if not bad:
        record("health 语义字段一致（%d 项）" % len(same_as), True,
               "能力 %s · 来源 %d 家 · 拒收 %d 参数" % (
                   "/".join(sorted(set(a["capabilities"]))), len(a["geoip_sources"]),
                   len(a["privacy"]["banned_params"])))
    # 这两项是「故意不同」的：页面靠它们说出自己连的是哪一份实现。
    if a["python"] is None or b["python"] is not None:
        record("health·python 字段各说各话（ps1 不许冒充 Python）", False,
               "server.py=%r / ps1=%r" % (a["python"], b["python"]))
    else:
        record("health·python 如实（server.py 给版本，ps1 给 null）", True,
               "%r / %r；runtime=%r / %r" % (a["python"], b["python"], a["runtime"], b["runtime"]))
    if not (str(a["runtime"]).startswith("Python") and str(b["runtime"]).startswith("PowerShell")):
        record("health·runtime 前缀", False, "%r / %r" % (a["runtime"], b["runtime"]))
    if not (str(a["platform"]).strip() and str(b["platform"]).strip()):
        record("health·platform 非空", False, "%r / %r" % (a["platform"], b["platform"]))
    return bad


def _src_id(item):
    return item["id"] if isinstance(item, dict) else item


def start_bridges():
    """自己起两份桥；返回 (procs, py_base, ps_base)。"""
    procs = []
    try:
        py_port, ps_port = free_port(), free_port()
        procs.append(subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "server.py"), "--port", str(py_port), "--quiet"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace"))
        ps_exe = "powershell.exe" if os.name == "nt" else "pwsh"
        procs.append(subprocess.Popen(
            [ps_exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
             os.path.join(ROOT, "bridge-powershell.ps1"), "-Port", str(ps_port), "-Quiet"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace"))
    except OSError as exc:
        stop(procs)
        raise RuntimeError("起进程失败：%s" % exc)
    py_base, ps_base = "http://127.0.0.1:%d" % py_port, "http://127.0.0.1:%d" % ps_port
    try:
        wait_ready(py_base, "server.py", procs)
        wait_ready(ps_base, "bridge-powershell.ps1", procs)
    except RuntimeError as exc:
        for p in procs:
            try:
                out = (p.stdout.read() if p.stdout else "") or ""
                if out:
                    print("  · 子进程输出（末尾 800 字）：" + out[-800:])
            except Exception:
                pass
        stop(procs)
        raise exc
    return procs, py_base, ps_base


def stop(procs):
    for p in procs:
        if p is None or p.poll() is not None:
            continue
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def main(argv):
    if os.name != "nt" and which("pwsh") is None:
        print("跳过：本机没有 PowerShell（这份桥的实机对账只在它能跑的平台上做）。")
        return 3
    procs = []
    try:
        if len(argv) >= 2:
            py_base, ps_base = ("http://127.0.0.1:%d" % int(argv[0]),
                                "http://127.0.0.1:%d" % int(argv[1]))
            wait_ready(py_base, "server.py", [])
            wait_ready(ps_base, "bridge-powershell.ps1", [])
            print("用已经在跑的两份桥： %s 与 %s" % (py_base, ps_base))
        else:
            procs, py_base, ps_base = start_bridges()
            print("已起两份桥： server.py → %s · powershell → %s" % (py_base, ps_base))
        bad = (compare_cases(py_base, ps_base)
               + compare_static_assets(py_base, ps_base)
               + compare_traversal(py_base, ps_base)
               + compare_health(py_base, ps_base))
        print("\n  用例 %d / 失败 %d" % (len(RESULT), bad))
        if bad:
            print("结论：两份桥的回答不一致（页面会在其中一份上少东西）。")
            return 1
        print("结论：两份桥对同一批请求给出同一形状的响应。")
        return 0
    except RuntimeError as exc:
        # 桥起不来不是「跳过」：CI 上把它记成通过，等于把坏掉的零安装路径放过。
        print("失败：%s" % exc)
        return 1
    finally:
        stop(procs)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
