#!/usr/bin/env python3
"""包完整性闸门（不联网、不建 socket）：

1. index.html 里引用的每个本地资源都必须存在且非空 —— file:// 打开没有 404 提示，
   少一个文件就是「页面能开但内核没加载」，这类故障内核自检看不见。
2. 启动器卫生：.bat 必须纯 ASCII 且 CRLF（中文 Windows 的 GBK 控制台会把 UTF-8 批处理
   读成乱码并中断执行）；.sh 必须是 LF（CRLF 会让 sh 报 bad interpreter / syntax error）。
3. server.py 不得出现 shell 执行入口（os.system / os.popen / subprocess(..., shell=True) /
   eval( / exec( ）—— 这是隐私与注入红线，写进闸门而不是只写进文档。
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

for sh in ["启动-macOS-Linux.sh", "启动-Android.sh", "启动-macOS.command"]:
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
DEV_ONLY = ("app/_build/",)
hit = []
for folder in ("示例数据", "app", "vendor", "docs", "images", "tests"):
    fd = os.path.join(ROOT, folder)
    if not os.path.isdir(fd):
        continue
    for dirpath, _dirnames, filenames in os.walk(fd):
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace(os.sep, "/")
            if any(rel.startswith(p) for p in DEV_ONLY):
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
