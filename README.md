<p align="center">
  <b>经纬度定位工作站</b> · Geo Position Workstation<br>
  <sub>离线优先的多源定位与测量工作站：双击 <code>index.html</code> 就能用，六个自研内核、541 道自检闸门、零依赖、零遥测。</sub>
</p>

<p align="center">
  <a href="https://github.com/IAMMEZSH/geo-position-workstation/actions/workflows/ci.yml"><img alt="gates CI" src="https://github.com/IAMMEZSH/geo-position-workstation/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green.svg">
  <img alt="no dependencies" src="https://img.shields.io/badge/%E7%AC%AC%E4%B8%89%E6%96%B9%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-blue.svg">
  <img alt="offline first" src="https://img.shields.io/badge/%E9%BB%98%E8%AE%A4-offline%20first-orange.svg">
  <img alt="gates" src="https://img.shields.io/badge/%E8%87%AA%E6%A3%80%E9%97%B8%E9%97%A8-541%20%E9%97%A8%20%2F%200%20%E5%A4%B1%E8%B4%A5-brightgreen.svg">
  <img alt="no python needed" src="https://img.shields.io/badge/%E4%B8%8D%E8%A3%85%20Python%20%E4%B9%9F%E8%83%BD%E7%94%A8-PowerShell%20%E6%A1%A5-blueviolet.svg">
  <img alt="platforms" src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Android%20%C2%B7%20iOS-lightgrey.svg">
</p>

---

**这一页只是索引。** 全部讲解、全部实测数字、全部实现约定与踩过的坑都在
[**说明书.md**](说明书.md)（一份写完，不再拆成多页，也不在两处各写一遍）；
本页只放「这是什么 / 怎么打开 / 想查什么翻第几节 / 图在哪」。

## 这是什么

十一个面板摆在同一张桌子上：坐标格式与投影、基准转换、基站（蜂窝）、三角交会、信号测距、
GNSS 卫星、天象、联网与 IP/路由、批处理导出、历史收藏、内核自检。默认全部在本机 JS 里算，
城市与陆域数据随包；只有 ⑧ 面板会出网，而且要你在面板里显式授权。
内核算不出就返回 `null`，界面就显示「算不出」和缺什么观测——不插值、不借用别的源、
不拿城市中心点冒充你的位置。

在线地址（GitHub Pages 直接把仓库根目录当静态站发布，与下载版逐字节相同）：
**<https://iammezsh.github.io/geo-position-workstation/>**

## 怎么打开

- **不想装任何东西** → 打开上面的在线地址。六个内核、地图、离线数据、⑪ 自检全跑；
  只有 ⑧ 的逐跳路由追踪需要你本机另起一个桥接。
- **Windows，要 ⑧ 全功能** → 下载后双击 `启动-Windows.bat`。它会依次尝试
  Python 桥 → PowerShell 桥 → 直接开页面，**没装 Python 也会用 Windows 自带的 PowerShell 起桥**，
  十一个面板全开。
- **macOS / Linux / Android / iPhone / iPad** → 逐平台写法、三级回退、iSH 路径、
  换端口、以及「不跑桥接会失去什么」写在 **说明书第 2 节**。

打开后先到 **⑪ 内核自检 → 运行全部自检**，看到「515 门 / 0 失败」再往下用。

![离线矢量陆域 + 中心准星 + 城市注记 + 读数条（不发任何瓦片请求）](images/02-crosshair-readout.png)

## 想查什么，翻说明书第几节

| 你要找的 | 在说明书 |
|---|---|
| 一分钟上手、下载与解压、第一次打开该点什么 | 第 0 节 |
| 包里 62 个文件逐个是干什么的 | 第 1 节 |
| 各平台怎么启动；两份桥（`server.py` 与 `bridge-powershell.ps1`）为什么是同一个契约 | 第 2 节（2.3 两份桥 / 2.5 托管 https 页连本机桥 / 2.6 逐请求来源守卫 / 2.7 iSH） |
| 十一个面板逐个：吃什么、给什么、2026-11-02 当天实测出来的数 | 第 3 节 |
| `示例数据/` 那 10 份样例为什么能互相对账 | 第 4 节 |
| 小数位、GCJ-02 不可逆、IP 定位的保守精度、天文时间尺度 | 第 5 节 + 图 `docs/img/decision-flow.svg` |
| 分层结构、内核写法约定、地图层、联网层、界面转义模型、加一个新面板要做什么 | 第 6 节 + 图 `docs/img/architecture.svg` |
| 会离开本机的四类请求、十一条代码级红线、内网目标的取舍、数据留在哪里 | 第 7 节 + 图 `docs/img/privacy-boundary.svg` |
| 六层门怎么复核（515 / 541 / 101·102 / 187 / 33 / 40）与每条闸门长什么样 | 第 8 节（8.6 写清 ubuntu 与 windows 两份 job 的差别） |
| 平台矩阵、三条「设计上就不给」、逐面板实测、托管页→桥接、clone 与 ZIP 验证 | 第 9 节 |
| 离线数据的来源、SHA-256、裁剪参数、怎么重建 | 第 10 节 |
| 16 条踩过的坑（内核全绿但界面是坏的） | 第 11 节 |
| 常见问题 | 第 12 节 |
| 第三方数据来源与许可、署名要求 | 第 13 节 |

## 复核用的三条命令

零依赖：不需要 `npm install`，不需要 `pip install`。`package.json` 只是脚本入口与元信息。

```bash
node tests/run-all.mjs --with-server --with-bridge   # 内核 541 门 + Python 桥 101 项 + PowerShell 桥 187 项
python tests/bridge-parity.py                        # 两份桥实机对账 33 用例
python tests/check-package.py                        # 打包体检 40 项
```

浏览器侧的第 6 层门是 ⑪ 面板本身：**515 门 / 0 失败**（GEONET 的 26 道异步门只在 Node 侧跑，
所以两边数不一样，构成见说明书第 8.1 节）。CI 在 Ubuntu 与 Windows 上各把这三条跑一遍。

## 图

15 张截图不是装饰图，全部嵌在说明书对应小节的正文旁边（哪张图配哪一段，跟着读才有意义）：
⑪ 自检全绿 `09`、① 会话表 `12`、② 解析与投影 `03`、③ 基站多边 `04`、④ 方位交会 `10`、
⑤ 信号测距 `11`、⑥ GNSS 最小二乘 `05`、⑦ 天象 `06`、⑧ IP 多源 `07`、⑧ 路由追踪 `08`、
⑧ 桥接自检 `15`、⑨ 批处理与二维码 `14`、准星叠层 `01`、浅色主题 `13`，加上本页首屏的 `02`。
文件在 [`images/`](images/)，三张机制 SVG 在 [`docs/img/`](docs/img/)。

## 许可与署名

MIT（见 [LICENSE](LICENSE)）。第三方不在 MIT 覆盖范围内，其中
GeoNames `cities15000`（CC BY 4.0）**再分发需保留署名**；Natural Earth `ne_50m_land` 公有领域、
Leaflet 1.9.4 BSD-2-Clause、qrcode.js MIT（Kazuhiko Arase）。完整表格与在线底图瓦片的
© OpenStreetMap contributors（ODbL）适用条件写在说明书第 13 节。
