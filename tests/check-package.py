#!/usr/bin/env python3
"""包完整性闸门（不联网、不建 socket）：

1. index.html 里引用的每个本地资源都必须存在且非空 —— file:// 打开没有 404 提示，
   少一个文件就是「页面能开但内核没加载」，这类故障内核自检看不见。
2. 启动器卫生：.bat 必须纯 ASCII 且 CRLF（中文 Windows 的 GBK 控制台会把 UTF-8 批处理
   读成乱码并中断执行）；.sh 必须是 LF（CRLF 会让 sh 报 bad interpreter / syntax error）。
3. server.py 不得出现 shell 执行入口（os.system / os.popen / subprocess(..., shell=True) /
   eval( / exec( ）—— 这是隐私与注入红线，写进闸门而不是只写进文档。
3b. PowerShell 那份桥（bridge-powershell.ps1，不装 Python 时的等价实现）同样不许经过命令
   解释器或字符串求值；它没有 AST 可解析，所以按行扫，但先剔掉注释——「这里不许用
   Invoke-Expression」这类讲解文字不算违规。两份桥的 /api 端点与拒收参数必须逐条一致，
   页面才不需要知道自己连的是哪一个；`.ps1` 的 BOM/CRLF 也必须钉住，
   否则别人 clone 出来的那份在 PowerShell 5.1 上直接读成乱码。
3c. 前端外泄通道扫描：app/*.js 与 index.html 抹掉注释之后，不许出现 beacon / XHR /
   图片探针 / cookie / 常驻通道 / postMessage / 动态求值 / 动态 import / 未加密持久存储；
   localStorage 只许 core-vault.js（写密文信封）与 core-net.js（默认策略下根本不读）引用；
   index.html 与 app/style.css 都不许引用任何远程资源——样式表用 @import 或 url(//字体站)
   拉一次字体，用户每次打开页面就交一次出口 IP 与 Referer，而 JS 侧的扫描对此毫无知觉。
   扫描器本身带一条有效性对照，
   否则「扫不到」可能只是「扫描器把整段吞了」的同一种失败。
4. README/MANUAL/docs 里的每一条本地链接（配图与文件）都必须指得到磁盘上的实体，
   否则 GitHub 首页只会显示裂开的占位符，而内核自检对此毫无知觉。
5. .gitignore 不许命中任何要分发的文件（`*.log` 会顺手吞掉示例数据里的 NMEA 样例），
   且 package.json 保持零依赖。
6. 换行符由 `.gitattributes` 钉死（`.sh`/`.command`=LF、`.bat`=CRLF、图片=binary），
   而不是取决于每个克隆者本机的 `core.autocrlf`。
7. 对外文档是英文的：README.md 与 MANUAL.md 里，中日韩文字只许出现在被引用的界面字面量
   （反引号 / `<code>` / **加粗**）里；仓库根只有这两份 .md；`§x.y` 交叉引用必须指得到
   真实小节；文档里声明的包闸门数必须等于本次实跑总数（这一条把自己也算进去）；
   §1.1 的分包表必须在临时目录里真打一次七个包对回去——清单一改，手机要下载多少字节就变了，
   而这件事内核自检完全看不见。
"""
import fnmatch
import json
import os
import re
import sys

# 输出编码兜底：stdout 被重定向或接到管道里时（CI、`| tee`、被别的程序调用），
# Windows 上的 Python 会退回 locale 编码（常见 cp1252），中文一打印就 UnicodeEncodeError，
# 整个闸门直接崩在第一条 print 上。真控制台不受影响，所以只在「当前编码打不出中文」时才换。
try:
    "中文".encode(sys.stdout.encoding or "ascii")
except (LookupError, UnicodeEncodeError):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = sys.platform == "win32"

results = []


def check(name, ok, detail):
    results.append((name, bool(ok), detail))


def read_bytes(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return f.read()


# ---------------------------------------------------------------- 1. 入口资源
html = read_bytes("index.html").decode("utf-8", "replace")
refs = re.findall(r'(?:src|href)\s*=\s*"([^"]+)"', html)
local = [r for r in refs if not re.match(r'^(https?:|data:|mailto:|#)', r)]
missing = [r for r in local if not os.path.isfile(os.path.join(ROOT, r.replace("/", os.sep)))]
empty = [r for r in local if os.path.isfile(os.path.join(ROOT, r.replace("/", os.sep)))
         and os.path.getsize(os.path.join(ROOT, r.replace("/", os.sep))) == 0]
check("index.html 引用的本地资源齐备", not missing and not empty,
      "%d 个引用，缺失 %s，空文件 %s" % (len(local), missing or "无", empty or "无"))

# ---------------------------------------------------------------- 2. 启动器卫生
bat = read_bytes("启动-Windows.bat")
non_ascii = [i for i, b in enumerate(bat) if b > 0x7F]


def bat_print_width(raw):
    """这张脸上「最宽的一行输出」有多宽（保守上界）。

    cmd 的窗口默认 80 列；超过就会折行，而折行是把框线劈成两半的最常见方式。
    %VAR% 按 8 个字符算（比任何真实展开都宽），%%f 按 12 个算（文件名比它长），
    所以这里得到的是上界而不是精确值——上界 <= 80 就意味着真实输出一定 <= 80。
    """
    worst = 0
    for line in raw.decode("ascii", "replace").splitlines():
        s = line.strip()
        if not s.lower().startswith("echo"):
            continue
        body = re.sub(r"%[A-Za-z0-9_]+%", "x" * 8, s[4:])
        body = body.replace("%%f", "x" * 12).replace("%%i", "1")
        worst = max(worst, len(body.rstrip()))
    return worst


_bat_w = bat_print_width(bat)
check("启动-Windows.bat 纯 ASCII、零转义字节、最宽一行不越过 80 列",
      not non_ascii and b"\x1b" not in bat and _bat_w <= 80,
      "非 ASCII 字节 %d 个%s · ESC %d 个 · 最宽输出 %d 列（cmd 默认 80 列，超了就折行，"
      "折行会把框线劈成两半）" % (len(non_ascii), ("，首个偏移 " + str(non_ascii[0])) if non_ascii else "",
                                  bat.count(b"\x1b"), _bat_w))
check("启动-Windows.bat 用 CRLF", b"\r\n" in bat and b"\n" not in bat.replace(b"\r\n", b""),
      "CRLF 行数 %d" % bat.count(b"\r\n"))
def bat_command_lines(raw):
    """批处理里真正会被执行的行（注释与空行剔除），用于按命令而不是按单词检查。"""
    out = []
    for line in raw.decode("utf-8", "replace").splitlines():
        s = line.strip()
        if not s or s.lower().startswith("rem ") or s.startswith("::"):
            continue
        out.append(s.lower())
    return out


_exec_lines = bat_command_lines(bat)
_bat_text = bat.decode("ascii", "replace")
check("启动-Windows.bat 延时用 ping、状态用 color（不用 timeout，也不赌转义序列）",
      not [l for l in _exec_lines if re.match(r"@?timeout\b", l)]
      and all(("color %s " % c) in _bat_text.lower() for c in ("0e", "0a", "0c")),
      "Git Bash 等工具链会把 coreutils 的 timeout 排到 PATH 前面，批处理里的 timeout 不一定是 Windows 那个，"
      "延时用 ping -n；这张脸的状态灯用 cmd 一定认的 color（0E 探测中 / 0A 桥在线 / 0C 退回离线），"
      "因为转义序列在这个终端上是否生效取决于 conhost，不取决于本文件")

# 五张脸各有一套转义纪律，钉在这里而不是只在注释里说一遍。闸门数不新增：
# 「入口能不能被 sh 认」和「它打算怎么给自己上色」本来就是同一件事的两半。
FACE_RULES = {
    "启动-macOS-Linux.sh": lambda s: [
        ("三张 Unix 脸的框线字形互不相同", all(g in s for g in "╭╮╰╯╔╗╚╝┌┐└┘")),
        ("24-bit 只在终端自己报 truecolor 时才发",
         "38;2;" in s and "COLORTERM" in s),
        ("颜色能整条关掉（NO_COLOR 与 GEO_COLOR 都认）",
         "NO_COLOR" in s and "GEO_COLOR" in s),
        ("装解释器的提示跟着「脸」走，不跟着 uname 走",
         "FAMILY=termux" in s and "FAMILY=macos" in s),
    ],
    "启动-iSH.sh": lambda s: [
        ("iSH 只用 16 色，一个 24-bit 序列都不发", "38;2;" not in s),
        ("iSH 的框线是纯 ASCII，不赌方块字形",
         not [c for c in s if 0x2500 <= ord(c) <= 0x25FF]),
        ("颜色能整条关掉（NO_COLOR 与 GEO_COLOR 都认）",
         "NO_COLOR" in s and "GEO_COLOR" in s),
        ("横线把前导空格和首字符算进宽度，整条正好 $COLS 列",
         '$((COLS - 2))' in s),
    ],
    "启动-macOS.command": lambda s: [("macOS 入口点名 macos 这张脸", "GEO_FACE=macos" in s)],
    "启动-Android.sh": lambda s: [("Termux 入口点名 android 这张脸", "GEO_FACE=android" in s)],
    "启动-Linux.sh": lambda s: [("Linux 入口点名 linux 这张脸，并带上真正跑了它的那个终端名",
                                 "GEO_FACE=linux" in s and "GEO_TERM_LABEL" in s)],
}

for sh in ["启动-macOS-Linux.sh", "启动-Linux.sh", "启动-Android.sh", "启动-macOS.command", "启动-iSH.sh"]:
    data = read_bytes(sh)
    check(sh + " 用 LF（不含 CR）", b"\r" not in data, "CR 出现 %d 次" % data.count(b"\r"))
    face_fail = [name for name, ok in FACE_RULES[sh](data.decode("utf-8", "replace")) if not ok]
    check(sh + " 有 shebang，且这张脸的上色纪律没有走样",
          data.startswith(b"#!") and not face_fail,
          "首行 %s；未通过：%s" % (data.split(b"\n", 1)[0].decode("utf-8", "replace"),
                                   "、".join(face_fail) if face_fail else "无"))

# ---------------------------------------------------------------- 3. 桥接红线
# 必须走 AST：server.py 的注释与 docstring 里大量出现「shell=True 是错的」这类说明文字，
# 直接扫原文会把讲解当成违规代码（server.py 自己的自检也是用 ast.unparse 摘掉 docstring 再扫的）。
import ast

py = read_bytes("server.py").decode("utf-8", "replace")
violations = []
for node in ast.walk(ast.parse(py)):
    if not isinstance(node, ast.Call):
        continue
    f = node.func
    if isinstance(f, ast.Attribute):
        base = f.value.id if isinstance(f.value, ast.Name) else ""
        fname = (base + "." + f.attr) if base else f.attr
    elif isinstance(f, ast.Name):
        fname = f.id
    else:
        continue
    if fname in ("os.system", "os.popen", "eval", "exec", "compile"):
        violations.append("%s @ line %d" % (fname, node.lineno))
    if fname.startswith("subprocess.") or fname in ("Popen", "run", "call", "check_output", "check_call"):
        for k in node.keywords:
            if k.arg == "shell" and isinstance(k.value, ast.Constant) and k.value.value is True:
                violations.append("%s(shell=True) @ line %d" % (fname, node.lineno))

check("server.py 无 shell/动态执行入口", not violations,
      "AST 扫描命中 " + (", ".join(violations) if violations else "无") + "（注释里的讲解不计）")
check("server.py 拒绝非回环绑定", "非回环" in py or "loopback" in py.lower(),
      "启动阶段校验绑定地址（不是运行期警告）")
check("server.py 坐标类参数在禁用名单里",
      re.search(r'"lat"|\'lat\'', py) is not None and "accuracy" in py,
      "lat/lon/accuracy 等一律拒收")

# ------------------------------------------------------ 3b. PowerShell 桥（不装 Python 的那条路）
# 这份桥是 server.py 的等价实现：Windows 自带 PowerShell 5.1，所以 ⑧ 面板在「什么都没装」的
# 机器上也能全开。它没有 Python 的 AST 可解析，只能按行扫——于是注释行必须先剔掉，
# 否则「这里不许用 Invoke-Expression」这类讲解文字会被当成违规（server.py 也踩过同一个坑）。
PS1 = "bridge-powershell.ps1"
ps1_raw = read_bytes(PS1)
check(PS1 + " 带 UTF-8 BOM（5.1 没 BOM 会把中文注释按 GBK 读断）",
      ps1_raw.startswith(b"\xef\xbb\xbf"), "首 3 字节 " + ps1_raw[:3].hex())
check(PS1 + " 用 CRLF（.gitattributes 钉死，clone 后仍是 CRLF）",
      b"\r\n" in ps1_raw and b"\n" not in ps1_raw.replace(b"\r\n", b"").replace(b"\r", b""),
      "CRLF 行数 %d，裸 LF %d" % (ps1_raw.count(b"\r\n"), ps1_raw.replace(b"\r\n", b"").count(b"\n")))

ps1_all = ps1_raw.decode("utf-8-sig", "replace")
_in_block = re.split(r"<#", ps1_all)
ps1_code = _in_block[0]
for _seg in _in_block[1:]:
    ps1_code += _seg.split("#>", 1)[1] if "#>" in _seg else ""
ps1_lines = [l.strip() for l in ps1_code.splitlines()
             if l.strip() and not l.strip().startswith("#")]
ps1_src = "\n".join(ps1_lines)

FORBIDDEN_PS = [
    ("字符串求值（Invoke-Expression / iex）", r"Invoke-Expression|\biex\b"),
    ("启动命令解释器（cmd.exe）", r"\bcmd(?:\.exe)?\s+/[cv]"),
    ("以 shell 方式起进程（Start-Process）", r"Start-Process"),
    ("再起一个 PowerShell 当子进程", r"powershell(?:\.exe)?\s+-"),
]
for label, pat in FORBIDDEN_PS:
    hits = [l for l in ps1_lines if re.search(pat, l, re.I)]
    check("bridge-powershell.ps1 " + label, not hits, "命中行：" + ("；".join(h[:70] for h in hits[:3]) if hits else "无"))
check("bridge-powershell.ps1 子进程显式关掉 ShellExecute",
      "UseShellExecute = $false" in ps1_src.replace("UseShellExecute = $False", "UseShellExecute = $false"),
      "UseShellExecute=$true 会让参数串再过一次命令解释器")

# 两份实现必须「看起来是同一个服务」：字段名和红线一致，页面才不需要知道自己连的是哪一个。
_py_pp = re.search(r"POSITION_PARAMS\s*=\s*frozenset\(\{(.*?)\}\)", py, re.S)
_ps_pp = re.search(r"\$script:PositionParams\s*=\s*@\((.*?)\)", ps1_src, re.S)
py_banned = set(re.findall(r'"([a-z_]+)"', _py_pp.group(1))) if _py_pp else set()
ps_banned = set(re.findall(r"'([a-z_]+)'", _ps_pp.group(1))) if _ps_pp else set()
check("两份桥拒收的坐标类参数是同一 13 项",
      len(py_banned) == 13 and py_banned == ps_banned,
      "差异：" + (",".join(sorted(py_banned ^ ps_banned)) or "无") + "（server.py %d / ps1 %d）" % (len(py_banned), len(ps_banned)))
_py_ep = re.search(r'"endpoints":\s*\[(.*?)\]', py, re.S)
_ps_ep = re.search(r"endpoints\s*=\s*@\((.*?)\)", ps1_src, re.S)
py_ep = set(re.findall(r'"([^"]+)"', _py_ep.group(1))) if _py_ep else set()
ps_ep = set(re.findall(r"'([^']+)'", _ps_ep.group(1))) if _ps_ep else set()
check("两份桥的 /api 端点清单逐条一致",
      len(py_ep) == 6 and py_ep == ps_ep,
      "差异：" + (",".join(sorted(py_ep ^ ps_ep)) or "无") + "（%d / %d 条）" % (len(py_ep), len(ps_ep)))
check("两份桥的静态目录同样拒发 .log（自家访问日志不能被当资源下载）",
      '".log"' in py and "'.log'" in ps1_src, "SECRET_EXTS / $script:SecretExts 都含 .log")

# 静态 Content-Type 表也要逐键逐值一致。上一版这里两份桥给同一张 svg 报了两个头
# （ps1 的正则把 image/svg+xml 也算成「该补 charset」），而页面看不出来；
# server.py 那侧还曾经回落到 mimetypes，等于让每台机器的 /etc/mime.types 决定响应头。
_mm_py = re.search(r"TEXT_TYPES\s*=\s*\{(.*?)\n\}", py, re.S)
py_types = {}
if _mm_py:
    try:
        py_types = ast.literal_eval("{" + _mm_py.group(1) + "}")
    except (ValueError, SyntaxError):
        py_types = {}
_mm_ps = re.search(r"\$script:TextTypes\s*=\s*@\{(.*?)\n\}", ps1_src, re.S)
ps_types = {}
if _mm_ps:
    ps_types = dict(re.findall(r"'([^']+)'\s*=\s*'([^']+)'", _mm_ps.group(1)))
type_diff = sorted({("%s=%r/%r" % (k, py_types.get(k), ps_types.get(k)))
                    for k in set(py_types) | set(ps_types)
                    if py_types.get(k) != ps_types.get(k)})
check("两份桥的静态 Content-Type 表逐键逐值一致（%d 个扩展名）" % len(py_types),
      len(py_types) >= 18 and len(py_types) == len(ps_types) and not type_diff,
      "；".join(type_diff[:6]) if type_diff else "python %d / powershell %d" % (len(py_types), len(ps_types)))
check("server.py 不再回落到平台的 mime 库（iSH/Termux/macOS 的 mime.types 各不相同）",
      "mimetypes" not in py.replace("不用 mimetypes.guess_type", "").replace(
          "而 PowerShell 那份桥又没有这个库", ""),
      "import 或 guess_type 调用还在")
index_html = read_bytes("index.html").decode("utf-8", "replace")
local_ext = sorted({os.path.splitext(m)[1].lower() for m in re.findall(
    r'(?:src|href)="((?:app|vendor|images|docs|示例数据)/[^"]+)"', index_html)})
unmapped = [e for e in local_ext if e and e not in py_types]
check("index.html 用到的每种本地扩展名都在表里（%s）" % (" ".join(local_ext) or "无"),
      bool(local_ext) and not unmapped, "表里没有：" + (", ".join(unmapped) or "无"))

# 响应契约字面量对账：server.py 的 BRIDGE_CONTRACT 与 ps1 的 $script:BridgeContract 必须逐端点逐键相同。
# 两份桥各自的自检只能保证「自己和自己的清单一致」，而清单本身写歪了（ping 的 argv 在 ps1 第一版
# 叫 arguments、iface 在 ps1 多了 status）只有把两份字面量摆在一起比才看得见。
_bc_py = re.search(r"BRIDGE_CONTRACT\s*=\s*(\{.*?\n\})", py, re.S)
py_contract = {}
if _bc_py:
    try:
        py_contract = ast.literal_eval(_bc_py.group(1))
    except (ValueError, SyntaxError):
        py_contract = {}
_bc_ps = re.search(r"\$script:BridgeContract\s*=\s*@\{(.*?)\n\}", ps1_src, re.S)
ps_contract = {}
if _bc_ps:
    for _m in re.finditer(r"'(/api/[a-z_]+)'\s*=\s*@\(([^)]*)\)", _bc_ps.group(1), re.S):
        ps_contract[_m.group(1)] = sorted(re.findall(r"'([^']+)'", _m.group(2)))
contract_diff = []
for _ep in sorted(set(py_contract) | set(ps_contract)):
    _a, _b = sorted(py_contract.get(_ep, [])), sorted(ps_contract.get(_ep, []))
    if _a != _b:
        contract_diff.append("%s 差 %s" % (_ep, ",".join(sorted(set(_a) ^ set(_b))) or
                                           "条数 %d/%d" % (len(_a), len(_b))))
check("两份桥的契约字面量互相解析得到（正则没落空，各 %d 个端点）" % len(py_contract),
      len(py_contract) == 6 and len(ps_contract) == 6 and
      all(isinstance(v, list) and v for v in py_contract.values()),
      "python %d / powershell %d" % (len(py_contract), len(ps_contract)))
check("两份桥的响应契约逐端点逐键一致（%d 端点 / %d 个键）" % (
    len(py_contract), sum(len(v) for v in py_contract.values())),
      len(py_contract) == 6 and not contract_diff,
      "；".join(contract_diff) if contract_diff else "6 个端点的键集合两两相同")

# 跨站来源白名单：两份桥必须写着同一张名单。这条比对放在这里而不是只靠实机对账，
# 是因为「名单少一条」在实机上表现为「某个页面打不开桥」，用户会以为是代码坏了；
# 而字面量一比就能在提交时说出是谁擅自改了默认名单。
_ap_py = re.search(r"CORS_ALLOWED_ORIGINS\s*=\s*\((.*?)\)", py, re.S)
_ap_ps = re.search(r"\$script:CorsBuiltInOrigins\s*=\s*@\((.*?)\)", ps1_src, re.S)
py_allow = sorted({g for pair in re.findall(r"\"([^\"]+)\"|'([^']+)'", _ap_py.group(1)) for g in pair if g}) if _ap_py else []
ps_allow = sorted({g for pair in re.findall(r"\"([^\"]+)\"|'([^']+)'", _ap_ps.group(1)) for g in pair if g}) if _ap_ps else []
check("两份桥的内置来源白名单字面量一致（%s）" % " ".join(py_allow),
      bool(_ap_py) and bool(_ap_ps) and py_allow == ps_allow and "null" in py_allow
      and "https://iammezsh.github.io" in py_allow,
      "python %s / powershell %s" % (py_allow, ps_allow))
check("两份桥都不再发通配 `Access-Control-Allow-Origin: *`",
      '"Access-Control-Allow-Origin", "*"' not in py and
      "AddHeader('Access-Control-Allow-Origin', '*')" not in ps1_src,
      "回显名单内来源才是这条边的新形状")
check("两份桥各有预检与实请求两处 403 拒绝分支（origin_not_allowed）",
      py.count('"origin_not_allowed"') >= 2 and ps1_src.count("'origin_not_allowed'") >= 2,
      "python %d / powershell %d" % (py.count('"origin_not_allowed"'), ps1_src.count("'origin_not_allowed'")))
check("追加来源的开关两份都有且写法不同名（--allow-origin / -AllowOrigin）",
      '"--allow-origin"' in py and "$AllowOrigin" in ps1_src and "-AllowOrigin" in ps1_src,
      "名单只能由启动参数变长，运行期没有加宽入口")

# ------------------------------------------------------ 3c. 前端外泄通道（源码级扫描，不跑浏览器）
# 「每个人只能知道自己定位的」必须可被机器证伪。浏览器里能把坐标悄悄带出去的口子是有限的：
# beacon、XHR、1×1 图片探针、cookie、常驻通道（WebSocket/EventSource）、动态求值、
# 未加密的持久存储、以及引用远程资源（CDN/字体/统计脚本 = 把出口 IP 和 Referer 交出去）。
# 文档写「我们不上传」不算数，扫源码才算。
# 扫描前先抹注释：本项目的注释大量在写「这里不许用 X」，按原文扫会把讲解当违规
# （server.py 的 AST 与 ps1 的行扫早就为同一件事踩过坑）。
def js_code_only(src):
    r"""抹掉 /* */ 与 // 注释，保留字符串与正则字面量原样、行数不变。
    两处刻意的取舍：
    1) 不做引号状态机——core-datums.js 与 core-net.js 的正则字符类里同时有反引号和单引号
       （类成员直接列着 ` ' " 这些字符），跟着引号走会把真代码当字符串吞掉；
       字符串里的敏感词本来就是违规候选，宁可扫出来让人解释。
    2) 行注释要求 // 前面不是 : 也不是反斜杠，否则 URL 正则里的 \/\/ 会被当注释腰斩。
    """
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n - 2 if j < 0 else j
            out.append("\n" * src.count("\n", i, j + 2))
            i = j + 2
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/" and (i == 0 or src[i - 1] not in ":\\"):
            j = src.find("\n", i)
            j = n if j < 0 else j
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


JS_SCANNED = ["index.html"] + sorted(
    "app/" + f for f in os.listdir(os.path.join(ROOT, "app")) if f.endswith(".js"))
js_code = {}
for rel in JS_SCANNED:
    js_code[rel] = js_code_only(read_bytes(rel).decode("utf-8", "replace"))

# 工具自检：注释里出现的禁用词必须不算违规，代码里出现的一次都不许漏。
# 没有这一条，下面所有「扫不到」的闸门都可能只是「扫描器把整段吞了」的同一种失败。
_probe = ("// 讲解：这里不许用 navigator.sendBeacon(a, b) 把坐标寄走\n"
          "var u = 'http://127.0.0.1:8765';\n"
          "/* 多行说明里写 sendBeacon(x, y) 也不算 */\n"
          "navigator.sendBeacon('https://example.com', payload);\n")
_probe_code = js_code_only(_probe)
check("泄露扫描器自身有效（注释里的禁用词不算、代码里的一处不漏、URL 不被腰斩）",
      len(re.findall(r"sendBeacon\s*\(", _probe_code)) == 1 and
      "http://127.0.0.1:8765" in _probe_code,
      "4 行样例 → 命中 1 处（期望 1），注入的存储地址仍在代码里")
_WITNESS = {"app/core-net.js": "allow_ambient_storage", "app/core-vault.js": "AES-GCM",
            "app/ui-app.js": "function boot", "index.html": "<script"}
_lost = [f for f, tok in _WITNESS.items() if tok not in js_code.get(f, "")]
check("抹注释没有吞掉真代码（每个被扫文件留一个只有代码里才有的见证串）",
      not _lost and len(_WITNESS) == 4, "见证串丢失：" + ("、".join(_lost) if _lost else "无"))

LEAK_BANS = [
    ("sendBeacon（关掉页面也能把数据寄出去的最后一条通道）", r"\bsendBeacon\s*\("),
    ("XMLHttpRequest（绕开内核 fetch 策略的第二条出网口）", r"\bXMLHttpRequest\b"),
    ("new Image() 探针（把坐标编进 URL 的 1×1 打点）", r"\bnew\s+Image\s*\("),
    ("document.cookie（位置进了 cookie 就会被之后每次请求自动带上）", r"\bdocument\s*\.\s*cookie\b"),
    ("WebSocket / EventSource / BroadcastChannel（常驻或跨标签通道）",
     r"\bnew\s+(?:WebSocket|EventSource|BroadcastChannel)\s*\("),
    ("postMessage（把解交给别的标签页或iframe，等于交给别人）", r"\.postMessage\s*\("),
    ("动态求值 eval / new Function（把数据变成代码的路径一条都不留）", r"\beval\s*\(|\bnew\s+Function\s*\("),
    ("动态 import( 与远程脚本", r"\bimport\s*\("),
    ("未加密的持久存储 sessionStorage / indexedDB / openDatabase",
     r"\bsessionStorage\b|\bindexedDB\b|\bopenDatabase\s*\("),
]
for label, pat in LEAK_BANS:
    hits = [rel for rel in JS_SCANNED for _ in re.findall(pat, js_code[rel])]
    check("前端无 " + label, not hits, "命中文件：" + ("、".join(hits[:4]) if hits else "无") +
          "（%d 个文件逐行扫，注释不计）" % len(JS_SCANNED))

# 宿主持久存储：全项目只许两个持有者，且各自都有明确理由。
# core-vault.js 是唯一能把字节写进 localStorage 的地方，写进去的是 AES-256-GCM 信封；
# core-net.js 留着 rawStore() 这条读取分支，但默认策略（allow_ambient_storage=false）
# 在碰到 global.localStorage 之前就 return，所以经纬度缓存永远不落盘。
STORAGE_KEEPERS = {"app/core-vault.js", "app/core-net.js"}
bad_keepers = []
for rel in JS_SCANNED:
    touched = bool(re.search(r"\blocalStorage\b", js_code[rel]))
    if rel not in STORAGE_KEEPERS and touched:
        bad_keepers.append(rel)
check("localStorage 只被两个持有者引用：%s" % " ".join(sorted(STORAGE_KEEPERS)),
      not bad_keepers and all(re.search(r"\blocalStorage\b", js_code[k]) for k in STORAGE_KEEPERS),
      "越界引用：" + ("、".join(bad_keepers) if bad_keepers else "无") +
      "（界面层 ui-app.js 一律经 GEOVAULT，注释里的讲解不计）")
check("GEONET 的宿主存储读取受策略位把关且出厂为关",
      bool(re.search(r"allow_ambient_storage:\s*false", js_code["app/core-net.js"])) and
      bool(re.search(r"if \(!POLICY\.allow_ambient_storage\) return \{ store: null, kind: 'disabled' \}",
                     js_code["app/core-net.js"])),
      "early return 在 global.localStorage 之前，明文位置没有落盘路径")

# 样式表也在这条红线里：皮肤是 app/style.css，一旦哪天为「好看」加了一行
# @import 或 url(https://fonts...)，用户每次打开页面都会把出口 IP 与 Referer 交给第三方，
# 而 JS 侧的扫描对此毫无知觉。CSS 只用 /* */ 注释，所以另用一个只抹块注释的剥离器——
# js_code_only() 的 // 规则会把协议相对地址 url(//host/x) 当注释吞掉，那正是这里要抓的东西。
def css_code_only(src):
    out = []
    i, n = 0, len(src)
    while i < n:
        if src[i] == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n - 2 if j < 0 else j
            out.append("\n" * src.count("\n", i, j + 2))
            i = j + 2
            continue
        out.append(src[i])
        i += 1
    return "".join(out)


css = css_code_only(read_bytes("app/style.css").decode("utf-8", "replace"))
check("入口页与样式表都不引用任何远程资源（无 CDN、无字体、无统计脚本、无 url()）",
      "http://" not in html and "https://" not in html and
      "http://" not in css and "https://" not in css and
      "@import" not in css and "url(" not in css,
      "远程引用会把出口 IP 与 Referer 交给第三方；style.css 里 url()/@import 与协议相对地址同样算外泄通道")

# 系统定位是「用户点了才给」的功能，不是外泄通道，但它必须只出现在界面层的一个面板里：
# 内核文件要是能自己摸 navigator.geolocation，「只有我知道我定位了什么」就无从谈起。
_geo_users = [rel for rel in JS_SCANNED if re.search(r"\bnavigator\s*\.\s*geolocation\b", js_code[rel])]
check("系统定位只在界面层出现（内核摸不到 navigator.geolocation）",
      _geo_users == ["app/ui-app.js"],
      "引用文件：" + ("、".join(_geo_users) if _geo_users else "无") + "，且必须跟着一个用户点击入口")

# 启动器：没有 Python 也要把桥拉起来，所以 PowerShell 回退必须是真的会被执行的那一行，
# 而不是只在注释里提一句。
check("启动-Windows.bat 有 PowerShell 回退（不装 Python 也起桥）",
      bool([l for l in _exec_lines if "bridge-powershell.ps1" in l]),
      "执行行里出现 bridge-powershell.ps1")
check("启动-Windows.bat 的可达性探测不依赖 Python",
      bool([l for l in _exec_lines if "invoke-webrequest" in l]) and
      not bool([l for l in _exec_lines if re.search(r"%py% -c", l)]),
      "探测用 PowerShell Invoke-WebRequest，两份桥共用同一条判定")

# ---------------------------------------------------------------- 4. 文档齐备
for doc in ["MANUAL.md"]:
    check(doc + " 存在且非空", os.path.getsize(os.path.join(ROOT, doc)) > 1000, "")

# ---------------------------------------------------------------- 5. 文档链接与忽略规则
# GitHub 首页坏图是「图文极详尽」最容易烂的地方：图片改名或删掉，网页上只会显示裂开的占位符，
# 而内核自检、界面都不会有任何动静。这里把 README/MANUAL/docs 里的本地链接逐个对着磁盘核一遍。
doc_files = ["README.md", "MANUAL.md"]
for d in ("docs",):
    dd = os.path.join(ROOT, d)
    if os.path.isdir(dd):
        doc_files += [os.path.join(d, f) for f in sorted(os.listdir(dd)) if f.endswith(".md")]

broken, link_total = [], 0
for rel in doc_files:
    p = os.path.join(ROOT, rel)
    if not os.path.isfile(p):
        broken.append(rel + "（文件本身不存在）")
        continue
    text = open(p, encoding="utf-8").read()
    base = os.path.dirname(p)
    for m in re.finditer(r'!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)', text):
        t = m.group(1)
        if re.match(r'^(https?:|mailto:|data:|#)', t):
            continue
        link_total += 1
        target = os.path.normpath(os.path.join(base, t.split("#", 1)[0]))
        if not os.path.exists(target):
            broken.append("%s → %s" % (rel, t))
# 五张机制图和链接属于同一件事：说明书说「看图就能明白」，图就得真的在、且是同一套皮。
# 皮是钉死的：深色画布 + 霓虹描边 + 发光标题。改色可以，改回浅色不行——那会让下面这条
# 「不许残留浅色底」的断言变红，而这是唯一能发现「有人手动重存了一遍图」的信号。
LIGHT_CANVAS = ("#f7f8fa", "#eef3fb", "#f2f8f2", "#fdf3ef", "#f6f2fa", "#fff8e8")
fig_dir = os.path.join(ROOT, "docs", "img")
figs = sorted(f for f in os.listdir(fig_dir)) if os.path.isdir(fig_dir) else []
fig_bad = []
if len(figs) != 5 or not all(f.endswith(".svg") for f in figs):
    fig_bad.append("docs/img 应有 5 张 .svg，实为 %s" % figs)
for f in figs:
    if not f.endswith(".svg"):
        continue
    s = read_bytes(os.path.join("docs", "img", f)).decode("utf-8", "replace")
    for why in ("hudgrid" not in s and "缺深色 HUD 画布（hudgrid）",
                'fill="url(#hudbg)"' not in s and "画布没接 hudbg 渐变",
                'filter="#' in s and '出现 filter="#id"（合法 XML、所有渲染器都当没有）',
                [c for c in LIGHT_CANVAS if c in s] and "残留浅色底 %s" % [c for c in LIGHT_CANVAS if c in s]):
        if why:
            fig_bad.append("%s：%s" % (f, why))

check("文档里的本地链接（图/文件）全部指得到实体，且五张机制图都是同一套深色霓虹 HUD 皮",
      not broken and not fig_bad,
      "%d 条本地链接，断链 %s；图 %s" % (
          link_total, ("；".join(broken[:6])) if broken else "无",
          ("；".join(fig_bad)) if fig_bad else "%d 张齐全" % len(figs)))

# .gitignore 写成 *.log 会把「示例数据/NMEA语句示例.log」这份要分发的样例静默吞掉，
# 页面上看不出任何异常，clone 下来才发现少文件。所以：任何忽略规则都不许命中交付文件。
ignore_rules = [l.strip() for l in read_bytes(".gitignore").decode("utf-8", "replace").splitlines()
                if l.strip() and not l.strip().startswith("#")]


def rule_hits(rule, rel_path):
    """够用的 gitignore 子集：目录规则匹配其下全部路径，含 / 的规则锚到仓库根，裸文件名匹配任意层级。"""
    r = rule.rstrip("/")
    if not r:
        return False
    anchored = r.startswith("/") or "/" in r.strip("/")
    pat = r.lstrip("/")
    if anchored:
        return fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(rel_path, pat + "/*")
    return any(fnmatch.fnmatch(part, pat) for part in rel_path.split("/"))


# app/_build/ 与 工具/__pycache__/ 本就该被忽略，不参与「交付文件」检查。
# __pycache__ 不写死前缀：闸门脚本一旦被当模块 import，tests/ 下也会长出一份，
# 那是本机字节码缓存，不是交付物。
DEV_ONLY = ("app/_build/",)
hit = []
for folder in ("示例数据", "app", "vendor", "docs", "images", "tests"):
    fd = os.path.join(ROOT, folder)
    if not os.path.isdir(fd):
        continue
    for dirpath, _dirnames, filenames in os.walk(fd):
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace(os.sep, "/")
            if "__pycache__/" in rel or any(rel.startswith(p) for p in DEV_ONLY):
                continue
            if any(rule_hits(rule, rel) for rule in ignore_rules):
                hit.append(rel)
check("忽略规则没有误吞交付文件", not hit, "被命中的交付文件：" + ("、".join(hit[:6]) if hit else "无"))

# 零依赖是「拷走就能用」的前提；一旦有人顺手 npm install，交付包就不再自包含了。
pkg = json.loads(read_bytes("package.json").decode("utf-8", "replace"))
check("package.json 保持零依赖",
      not pkg.get("dependencies") and not pkg.get("devDependencies"),
      "dependencies=%s devDependencies=%s" % (pkg.get("dependencies") or "{}", pkg.get("devDependencies") or "{}"))

# 启动器的换行符必须由仓库钉死，不能靠每个克隆者自己的 core.autocrlf：
# Windows 默认 autocrlf=true 会把 .sh 签出成 CRLF（macOS/Linux 直接 bad interpreter），
# 反过来 .bat 用 LF 又会被 cmd.exe 读断。上面两条只查工作区现状，管不了别人 clone 出来的那份。
ga_path = os.path.join(ROOT, ".gitattributes")
ga = read_bytes(".gitattributes").decode("utf-8", "replace") if os.path.isfile(ga_path) else ""
check(".gitattributes 钉死启动器换行（.sh/.command=lf，.bat=crlf）",
      bool(re.search(r"^\*\.sh\s+text\s+eol=lf\s*$", ga, re.M)) and
      bool(re.search(r"^启动-macOS\.command\s+text\s+eol=lf\s*$", ga, re.M)) and
      bool(re.search(r"^\*\.bat\s+text\s+eol=crlf\s*$", ga, re.M)),
      ".gitattributes 存在" if ga else "仓库缺 .gitattributes")
check("图片声明为 binary（防止换行转换毁掉 PNG）",
      bool(re.search(r"^\*\.png\s+binary\s*$", ga, re.M)), "含 *.png binary")
check(".gitattributes 钉住 *.ps1 为 CRLF（PS 5.1 + BOM 的读法要求，clone 后不许变 LF）",
      bool(re.search(r"^\*\.ps1\s+text\s+eol=crlf\s*$", ga, re.M)), "含 *.ps1 text eol=crlf")
check(".gitignore 忽略 PowerShell 桥的访问日志",
      "/bridge-powershell.log" in ignore_rules,
      "运行日志不入库；仍然逐条列而不写 *.log——示例数据里那份 NMEA 样例后缀就是 .log")

# ---------------------------------------------------------------- 7. 文档语言、结构与自述数字
# GitHub 首页与说明书对外必须是英文：界面是中文的，所以「中文只能作为被引用的界面字面量」
# 出现（反引号、<code>、**加粗**），并且引用片段不许跨空行——一个漏掉的右反引号
# 能把后面整段中文藏起来，那样的检查等于没检查。
CJK_RE = re.compile(r'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')


def cjk_prose(text):
    """返回 [(行号, 片段)]：没被当界面字面量引用的中日韩文字。"""
    offenders, para, start, fence = [], [], None, False

    def flush():
        if not para:
            return
        body = "\n".join(para)
        for pat in (r'`[^`]+`', r'<code>.*?</code>', r'\*\*[^*]+\*\*'):
            body = re.sub(pat, lambda m: " " * len(m.group(0)), body, flags=re.S)
        for off, one in enumerate(body.split("\n")):
            if CJK_RE.search(one):
                offenders.append((start + off, "".join(sorted(set(CJK_RE.findall(one))))[:24]))

    for i, raw in enumerate(text.split("\n"), 1):
        if raw.strip().startswith("```"):
            fence = not fence
            flush()
            para, start = [], None
            continue
        if fence:
            continue
        if not raw.strip():
            flush()
            para, start = [], None
            continue
        if start is None:
            start = i
        para.append(raw)
    flush()
    return offenders


readme = read_bytes("README.md").decode("utf-8", "replace")
manual = read_bytes("MANUAL.md").decode("utf-8", "replace")
for name, text in (("README.md", readme), ("MANUAL.md", manual)):
    bad = cjk_prose(text)
    check("%s 用英文写（中文只出现在被引用的界面字面量里）" % name, not bad,
          "%d 行越界：%s" % (len(bad), bad[:4]) if bad else "字面量之外无中日韩")

# 说明书只留一份：多出来的一份不会有人读，只会让链接、数字、术语在两个地方各说各话。
root_md = sorted(f for f in os.listdir(ROOT) if f.endswith(".md"))
check("仓库根只有 README.md 与 MANUAL.md 两份文档", root_md == ["MANUAL.md", "README.md"],
      "实际 %s" % root_md)

# 重编号之后，正文里指到不存在小节的「§8.6」是查不出来的坏链：读者只会以为自己翻错了页。
heads = set(re.findall(r'^##\s+(\d+)\.', manual, re.M))
heads |= {"%s.%s" % m for m in re.findall(r'^###\s+(\d+)\.(\d+)\b', manual, re.M)}
refs = re.findall(r'§+\s*(\d+(?:\.\d+)?)', readme + "\n" + manual)
dangling = sorted({r for r in refs if r not in heads and r.split(".")[0] not in heads})
check("README/MANUAL 的 § 交叉引用都指得到真实小节", not dangling,
      "%d 处引用、%d 个真实小节，悬空 %s" % (len(refs), len(heads), dangling or "无"))

# §1.1 那张分包表写的是「实测」而不是「估算」，那就得每次真的打一遍包对回去：
# 清单加一个文件、启动器换一行注释，表里的字节数都会变，而页面上一切看起来仍然正常。
# 打包打进临时目录，不碰 dist/（那是本机产物，已被 .gitignore 忽略）。
# 只把「文件数 + 未压缩字节」按字节钉死：这两个改一位还是同长度的数字，所以自指成立。
# ZIP 那一列对到 0.01 MB 即可——MANUAL.md 就在包里，把精确字节写进表会改变 DEFLATE
# 输出，精确值无法自我引用地成立，这一点在 §1.1 里是明写的，不是蒙过去的。
import importlib.util as _ilu
import tempfile as _tempfile

_pp_spec = _ilu.spec_from_file_location("packplatform", os.path.join(ROOT, "工具", "pack-platform.py"))
_pp = _ilu.module_from_spec(_pp_spec)
_pp_spec.loader.exec_module(_pp)

_pp_rows = {}
for _line in manual.split("\n"):
    _c = [x.strip() for x in _line.split("|")]
    if len(_c) == 7 and _c[2].startswith("`geo-") and _c[2].endswith(".zip`"):
        _pp_rows[_c[2][5:-5]] = _c
_mismatch = []
_tmpdir = _tempfile.mkdtemp(prefix="geo-pack-")
try:
    for _p in _pp.platforms() + ["full"]:
        _s = _pp.build(_p, _tmpdir, verbose=False)
        _c = _pp_rows.get(_p)
        if _c is None:
            _mismatch.append("%s: 表里没有这一行" % _p)
            continue
        _want = [" %d " % _s["files"],
                 " %s B " % "{:,}".format(_s["raw_bytes"]).replace(",", " "),
                 " %.2f MB " % (_s["zip_bytes"] / 1e6)]
        for _i, _w in enumerate(_want):
            if _c[3 + _i] != _w.strip():
                _mismatch.append("%s 第 %d 列 文档=%s 实跑=%s"
                                 % (_p, 3 + _i, _c[3 + _i], _w.strip()))
finally:
    for _f in os.listdir(_tmpdir):
        os.remove(os.path.join(_tmpdir, _f))
    os.rmdir(_tmpdir)
check("MANUAL §1.1 的分包尺寸就是本次实打出来的",
      not _mismatch and len(_pp_rows) == len(_pp.platforms()) + 1,
      "%d 个包逐项对回；差异 %s" % (len(_pp_rows), _mismatch[:4] or "无"))

# 这一条把自己也算进去：文档里写的包闸门数必须等于本次实跑的总数，
# 否则「加一道门、说明书继续写旧数」就会静默发生（§11 记过一次同类事故）。
declared = len(results) + 1
check("文档写的包闸门数就是本次实跑数",
      ("**%d items / 0 failures**" % declared) in manual and
      ("### 8.6 Package inspection: %d items" % declared) in manual and
      ("package inspection, %d items" % declared) in readme,
      "文档声明 %d 项 == 实跑 %d 项（MANUAL §8 表 + §8.6 标题 + README 命令行注释）" % (declared, declared))

# ---------------------------------------------------------------- 汇总
width = max(len(n) for n, _, _ in results)
fails = 0
print("包完整性闸门\n")
for name, ok, detail in results:
    print("  %s  %s%s" % ("OK  " if ok else "FAIL", name.ljust(width),
                          ("  · " + detail) if detail else ""))
    if not ok:
        fails += 1
print("\n  合计 %d 项 / %d 失败" % (len(results), fails))
sys.exit(1 if fails else 0)
