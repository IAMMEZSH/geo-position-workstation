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
4. README/说明书/docs 里的每一条本地链接（配图与文件）都必须指得到磁盘上的实体，
   否则 GitHub 首页只会显示裂开的占位符，而内核自检对此毫无知觉。
5. .gitignore 不许命中任何要分发的文件（`*.log` 会顺手吞掉示例数据里的 NMEA 样例），
   且 package.json 保持零依赖。
6. 换行符由 `.gitattributes` 钉死（`.sh`/`.command`=LF、`.bat`=CRLF、图片=binary），
   而不是取决于每个克隆者本机的 `core.autocrlf`。
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
check("启动-Windows.bat 纯 ASCII", not non_ascii,
      "非 ASCII 字节 %d 个%s" % (len(non_ascii), ("，首个偏移 " + str(non_ascii[0])) if non_ascii else ""))
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
check("启动-Windows.bat 不用 timeout 做延时",
      not [l for l in _exec_lines if re.match(r"@?timeout\b", l)],
      "Git Bash 等工具链会把 coreutils 的 timeout 排到 PATH 前面，批处理里的 timeout 不一定是 Windows 那个；"
      "延时用 ping -n")

for sh in ["启动-macOS-Linux.sh", "启动-Android.sh", "启动-macOS.command", "启动-iSH.sh"]:
    data = read_bytes(sh)
    check(sh + " 用 LF（不含 CR）", b"\r" not in data, "CR 出现 %d 次" % data.count(b"\r"))
    check(sh + " 有 shebang", data.startswith(b"#!"), data.split(b"\n", 1)[0].decode("utf-8", "replace"))

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
for doc in ["说明书.md"]:
    check(doc + " 存在且非空", os.path.getsize(os.path.join(ROOT, doc)) > 1000, "")

# ---------------------------------------------------------------- 5. 文档链接与忽略规则
# GitHub 首页坏图是「图文极详尽」最容易烂的地方：图片改名或删掉，网页上只会显示裂开的占位符，
# 而内核自检、界面都不会有任何动静。这里把 README/说明书/docs 里的本地链接逐个对着磁盘核一遍。
doc_files = ["README.md", "说明书.md"]
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
check("文档里的本地链接（图/文件）全部指得到实体", not broken,
      "%d 条本地链接，断链 %s" % (link_total, ("；".join(broken[:6])) if broken else "无"))

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
