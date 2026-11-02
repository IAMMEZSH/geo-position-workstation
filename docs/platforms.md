# 平台支持矩阵（哪些是真测过的，哪些是设计上就不给）

先说结论：**六个内核 + 离线数据 + 地图 + 自检，在任何能执行 JavaScript 的浏览器里都完整可用**；
差异只在两处——① 浏览器定位需要「安全上下文」，② ⑧ 面板的路由追踪需要本机 Python 桥接。

**已经有一个公开在线地址，所有平台点开就能用**：<https://iammezsh.github.io/geo-position-workstation/>
（GitHub Pages 直接发布仓库根目录，所以它和下载版是同一份文件；下面表里凡是写「任意 HTTPS 静态托管」的地方，
现在都可以换成这一行。）

## 一览表

| 平台 | 怎么打开 | 六个内核 / 离线数据 | ⑪ 自检 | 浏览器定位 | ⑧ 路由追踪（桥接） |
|---|---|---|---|---|---|
| 任意平台 · 不下载不安装 | 浏览器开在线地址 | ✅ | ✅ https 下 515 门实测通过 | ✅ https 是安全上下文 | ⚠️ 需要你本机另起 `python server.py`；跨源已实测打通（见下面「托管页 → 本机桥接」） |
| Windows | 双击 `启动-Windows.bat` | ✅ | ✅ | ✅ Chrome/Edge 会弹授权 | ✅ 启动器拉起 `server.py`，页面自动连同源端口 |
| Windows（不跑 bat） | 双击 `index.html` | ✅ | ✅ | ✅ `file://` 在 Chrome/Edge/Firefox 里算安全上下文 | ⚠️ 桥接没起 → ⑧ 显示「桥接不在线」，直连源仍可用 |
| macOS | 双击 `启动-macOS.command`（首次需 `chmod +x`） | ✅ | ✅ | ✅ | ✅ |
| macOS / Linux | `sh 启动-macOS-Linux.sh` | ✅ | ✅ | ✅ | ✅ |
| Linux | 直接开 `index.html` | ✅ | ✅ | ✅ | ⚠️ 需手动 `python3 server.py` |
| Android 手机/平板 | Termux：`pkg install python` → `sh 启动-Android.sh` | ✅ | ✅ | ✅ Chrome 开 `http://127.0.0.1:8765/` 是安全上下文，会弹授权 | ✅ 桥接就跑在手机上（只绑回环，别的设备连不到） |
| Android（无 Termux） | 开在线地址 | ✅ | ✅ | ✅ | ❌ 手机上没有 Python → 只有直连 GeoIP 源与 DoH |
| iPhone / iPad | ① 开在线地址（推荐，零安装）；② iOS 本地 Web Server App 后 Safari 开 `http://127.0.0.1:…` | ✅ | ✅ | ✅ https/回环都是安全上下文 | ⚠️ 要装 iSH 跑 `启动-iSH.sh`（下表），否则只有 GeoIP/DoH |
| iPhone / iPad（文件 App 直接开 .html） | ❌ 不要用 | Quick Look 不执行脚本，页面根本跑不起来 | — | — | — |

### iPhone / iPad 上跑桥接（iSH 路径）

`启动-iSH.sh` 会依次：查 `python3`（缺就提示 `apk add python3`）→ 查 `server.py` 在不在（不在就给
`git clone` 与「文件」App 放进 `/mnt/pub` 两条补齐办法）→ 跑 `python3 server.py --selftest`（87 项，不联网）
→ 起桥接并最多轮询 12 秒 `/api/health` → 检查 `traceroute` / `ping` 齐不齐（缺就提示
`apk add iputils traceroute`）→ 打印该在 Safari 打开的地址。**作者没有在 iOS 实机上验证过
Safari 能不能连上 iSH 里监听的 127.0.0.1**（iSH 用自己的用户态网络栈，这一步取决于它的版本），
所以脚本把每一步的成功/失败都打出来，并在连不上时打印日志尾部 + 两条出路（在线地址，
或 A-Shell / Pyto / Texta 这类能起本机 HTTP 的 App 跑同一份 `server.py`）。

## 三条「不给」是设计，不是没做完

1. **桥接不监听局域网。** `server.py` 在非回环绑定上是**启动阶段直接拒绝**，不是警告后继续跑。
   所以「电脑起服务、手机连 `http://192.168.x.x:8765`」这条路走不通，也不该走通——
   一个能代跑 `tracert`/`ping` 的 HTTP 服务暴露到局域网，等于给同网段任何人开了个命令口子。
   手机要用，就在手机上跑（Termux / iSH），或者接受没有路由追踪。
2. **桥接不接收坐标。** `lat / lon / lng / latitude / longitude / position / loc / accuracy`
   以及 `alt / altitude / bearing / heading / speed` 全在拒收名单里，参数校验在构造 argv 之前。
3. **非安全上下文不给定位。** 用 `http://` 局域网地址打开页面时，浏览器会直接拒掉 Geolocation
   （不是本工具能绕的）。六个离线内核不受影响，因为它们只是 JS 计算。

**与之相对，一条「给」需要说清楚：⑧ 允许追踪内网地址。** `192.168.1.1`、`127.0.0.1`、NAS 都能打，
没有开关要记；响应里的 `target_scope`（`lan` / `public`，域名按解析结果判）会写进界面的「目标归属」一行。
取舍与边界写在 `docs/privacy.md`。

## 已实测的部分（2026-11-02，本机 Windows）

| 场景 | 结果 |
|---|---|
| `http://127.0.0.1:8765/index.html` | 7 个命名空间全部加载，Leaflet 就绪，陆域 1374 块挂图，⑪ 515 门 / 0 失败（0.70 s） |
| `file://…/index.html`（不跑桥接，直接双击） | `isSecureContext = true`，7 个命名空间齐，地图就绪，陆域 1374 块；桥接自检从 `Origin: null` 调 `/api/health` **11 ms 返回在线** |
| ⑧ IP 定位（6 源并行） | 3 源成功 → 融合 `30.008663, 121.256478`，报告精度 100 km（BLUE σ 42.86 km 与保守分位取大者），χ²=0.193/dof=4/p=0.996；超时与 403 的源被剔除并逐条写明原因 |
| ⑧ 路由追踪 `github.com` | 6 跳（其中 2 跳 `*` 无响应，如实标注 timeout），耗时 8016 ms，数据全部来自系统 `tracert` 解析 |
| ⑥ GNSS 最小二乘 | 解 `31.3099935, 121.3900514, 12.18 m`，与场景真值差 **4.94 m**（独立检核，不依赖内核自报 σ），RAIM 剔除 PRN 16，HDOP 1.753 |
| ③ 基站多边定位 | 3 站 LTE → `31.233164, 121.479721`，残差 RMS 7.7 m，不确定半径 75.4 m，GDOP 1.17 |
| ④ 方位交会 | `31.239985, 121.479983`，角残差等效 0.5 m，不确定半径 52.3 m |
| ② WGS84→GCJ-02 | 偏移量级 433.2 m；迭代反算回 WGS84 与原值差 **0.0000 m** |
| 准星 | 中心 `28.000000, 122.000000` → 一次给出 DD / DMS / UTM 51R / MGRS 51R WL / Plus Code / Geohash / 最近城市 温岭 73.4 km / 缩放 |
| 浏览器定位 | 本机的受控测试浏览器被自动化策略直接拒绝授权（`code=1`，1 ms 返回）→ 界面如实显示「你拒绝了定位授权」，**没有**拿 IP 结果或城市中心冒充。这一条只能由你在自己的浏览器里点「允许」来验证 |

## 托管 https 页面 → 本机回环桥接（2026-11-02 实测）

在线地址是 `https://iammezsh.github.io/…`，桥接是 `http://127.0.0.1:8765`。跨协议、跨站点、还要打进回环——
两道浏览器策略都得过，所以两条都当场测：

| 测法 | 结果 |
|---|---|
| 在在线地址上跑 ⑪ 全量自检 | **515 门 / 0 失败**（1.96 s），陆域 1374 块挂图，界面缺失 id 0 个，环境表里「协议」一行是 `https:` |
| 在在线地址上跑 ⑧ `traceroute 192.168.1.1` | 通道 `bridge`、`bridge_base=http://127.0.0.1:8765`（**没有**报 `bridge_unavailable`，说明 PNA 预检被放行）；那一网段不在这台机器的链路上，于是 3 跳全部如实显示「无响应（*）」、25011 ms，界面没有补一个跳数 |
| 同源对照：`http://127.0.0.1:8765/` 上跑 ⑧ `traceroute 192.168.2.1`（本机网关） | 通道 `bridge`、1 跳、到达目标、24 ms、目标归属「内网/本机（私有网段 192.168.2.1）」 |
| 预检响应（`OPTIONS` 带 `Access-Control-Request-Private-Network: true`，`Origin: https://iammezsh.github.io`） | `204 No Content` + `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Private-Network: true` + `Access-Control-Max-Age: 600` |
| 预检响应（**不带** PNA 头） | 响应里 `Access-Control-Allow-Private-Network` 出现 **0 次**（按需回显，不是无脑广播） |
| 静态文件（`GET /index.html` 带外部 `Origin`） | 响应里 `access-control-*` 头 **0 条**（API 是 4 条）——跨站页面读不到项目文件 |

要留一句余地：**PNA 由浏览器版本与开关决定**，不是本仓库能承诺的。真被拦下时界面落到
`bridge_unavailable`，并把桥接正文里的中文原因原样显示出来；换 `http://127.0.0.1:8765/` 打开同源页面即可绕过这一层。

## 从 GitHub 拿到之后（2026-11-02 当场跑的数）

| 拿法 | 实测结果 |
|---|---|
| `git clone --depth 1` | 63 个文件；在 clone 里 `node tests/run-all.mjs --with-server` → **540 门 / 0 失败** + 桥接 **87 项 / 0 失败**；`python tests/check-package.py` → **21 项 / 0 失败**；clone 里的 `启动-macOS.command` / `.sh` / `启动-Android.sh` 均为 **CRLF=0** 且带 `#!/bin/sh`，`启动-Windows.bat` 为 65 行 CRLF、**非 ASCII 字节=0** |
| clone 后**直接双击 `index.html`**（`file://`，不起桥接） | `isSecureContext=true`，11 个标签页齐，地图画布 586×358 有 113,338 个非透明像素，⑪ **515 门 / 0 失败**（1.87 s）、陆域 1374 块挂图、界面缺失 id=0，浏览器控制台 **0 条报错**；② 输入 `31.2304, 121.4737` → 十进制度候选（置信 0.90）+ DMS/度分/有效位；④ 距离交会 → `31.239988, 121.480015`，RMS 2.9 m、不确定半径 25.1 m、GDOP 1.19 |
| 桥接从 clone 起（`python server.py --port 8799`） | `/api/health` `ok=true`、`bind.loopback_only=true`，`/index.html` 返回的字节与 clone 磁盘上的 `index.html` **SHA-256 相同** |
| GitHub「Download ZIP」 | 4,178,540 B / 63 条目，与仓库逐字节相同；zip 内 `.bat` 存 CRLF、`.command`/`.js` 存 LF |

一处**没在本机复现、但你会遇到**的：浏览器下载 ZIP 时 Windows 会给文件打「来自网络」标记
（MOTW，用资源管理器解压会传给解出来的文件），双击 `启动-Windows.bat` 可能被 SmartScreen 拦一次——
「Windows 已保护你的电脑 → 更多信息 → 仍要运行」。macOS 的 Gatekeeper 对 `.command` 同理（右键 → 打开，
或 `xattr -d com.apple.quarantine 启动-macOS.command`）。`git clone` 下来的文件不带这个标记。
规避办法很省事：**直接双击 `index.html`**，网页与数据文件不需要执行权限，六个内核全跑，只是 ⑧ 没有路由追踪。

## 关于「一台设备的定位精度」

浏览器定位给的是系统混合定位（Wi-Fi/蜂窝/IP），几十到几百米是常态；本工具只转述它的精度圈，
不美化。要米级就走 ⑥ GNSS（自己喂 NMEA 或观测），要几十米就走 ③ 基站定时提前。
⑧ 的 IP 定位在城市/省一级，报告精度会刻意取保守值——宁可写 100 km，也不写源自己吹的 20 km。
