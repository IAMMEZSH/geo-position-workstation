# 离线数据：从哪来、怎么裁、怎么重建

三个数据文件都是**纯浏览器脚本**（IIFE 挂到 `globalThis.GEODATA`，不含 `import`/`export`/`require`），
所以 `<script>` 与 Node 的 `vm`/`require` 都能加载——这也是 537 门能在 Node 里跑同一份数据的原因。

| 文件 | 大小 | 内容 | 来源 | 许可 |
|---|---|---|---|---|
| `app/data/data-cities.js` | 2.0 MB | 全球城市（名称、国家码、lat/lon 4 位小数、人口） | GeoNames `cities15000.txt` | CC BY 4.0（要求署名） |
| `app/data/data-land.js` | 748 KB | 陆地多边形 **1374 块** | Natural Earth `ne_50m_land` | 公有领域 |
| `app/data/data-countries.js` | 12 KB | ISO 3166-1 α2 → 中/英文名 | ISO 代码表 | 事实数据 |

## 裁剪参数（`工具/build-data.mjs` 顶部，全是明写的常数）

- `CITY_MIN_POP = 10000` —— 与源文件名 `cities15000` 的量级一致。
- `CN_CITY_MIN_POP = 4000` —— 中国小城市是国内用户的搜索主力，单独放宽（所以中国行密度明显高）。
- `LAND_COORD_DP = 2` —— 陆地坐标保留 2 位小数 ≈ 1.1 km。够做**海陆粗判**和极简底图，
  不够做导航；这是刻意的取舍，换来 748 KB 而不是 40 MB。
- `LAND_MIN_AREA_DEG2 = 0.0025` —— 约 30 km² 的碎块阈值。1.1 km 网格下小于它的多边形会退化成噪声；
  而自检与海陆判断关心的最小陆块（瓦胡岛 ≈ 1545 km²）远大于它。

## 幂等与脏数据处理

- 输出**只由输入决定**（不含时间戳），同一份输入重跑产生逐字节相同的文件；输入缺失时保留旧文件并以非 0 退出。
- 原始文件路径可用环境变量覆盖：`GEO_RAW_CITIES` / `GEO_RAW_LAND` / `GEO_OUT_DIR`。
- 落盘前递归扫描：`NaN` / `Infinity` / `undefined` / `null` 一律视为脏数据，**宁可构建失败也不落盘**。
- 生成后立刻在 Node 里按浏览器方式执行一遍（靠全局副作用），验证真的能加载。

## 原始输入的确切出处（2026-11-02 实测）

| 输入 | URL | 字节数 | SHA-256 |
|---|---|---|---|
| GeoNames zip | `https://download.geonames.org/export/dump/cities15000.zip` | 3,365,609 | `c7b7482b115463874798824f76381f84103233c0a9db9d43efe8501719200dc9` |
| 解出的成员 | `cities15000.txt`（zip 内唯一成员） | 8,546,918 | `15c40acb067f02528249715f42c21feb3769192debd79b73d6479a1f980b69ae` |
| Natural Earth | `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson` | 1,636,166 | `e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b` |

`naturalearthdata.com` 的 `ne_50m_land.zip` 当时返回 HTTP 500，所以上面用的是 Natural Earth 官方
vector 仓库里的 GeoJSON 派生件（同一份数据、同一许可），别改成前者否则构建会卡住。

重建校验结果（用上面这份输入跑 `工具/build-data.mjs` 与随包数据对比）：

- `data-land.js`、`data-countries.js`：**逐字节相同**（763,002 B / 9,395 B，1374 块、195 国不变）。
- `data-cities.js`：差 68 字节 —— GeoNames 的 dump **每天重发布**，这次拉到的是 4 个城市变了
  （Luján de Cuyo 多了 `PPLA2` 类别、Bad Friedrichshall / Umluj / Göködepe 的人口或类别更新），
  不是构建器的不确定性。所以「逐字节可重建」的准确说法是**同一份输入下逐字节相同**。

重建：

```bash
# 1. 拉上面表格里两份官方原始数据（zip 要解出 cities15000.txt）
# 2. 指到本地路径；GEO_OUT_DIR 省略就直接写进 app/data/
GEO_RAW_CITIES=/path/cities15000.txt GEO_RAW_LAND=/path/ne_land.geojson \
  node 工具/build-data.mjs
```

## 陆域数据的形状（踩过坑，写清楚）

```
blocks = [块, 块, …]
块      = [外环, 洞环, …]          # 一个块可以带洞
环      = [lon, lat, lon, lat, …]  # 扁平数组，不闭合存储
```

所以遍历必须**钻两层**：外层是块，内层是环，环内部再按 `(x, y)` 成对取值，并在收尾补上闭合点。
只钻一层时，每个「块」会被当成扁平数组、`length < 6` 判断直接跳过，结果是 1374 块全丢、
MultiPolygon 为空、画布一个像素都不画——而所有内核闸门依旧全绿。

现在的防线是 ⑪ 环境表里的「矢量陆域」一行：断言 `layerStats().land_blocks > 0` 且 `base` 图层有对象，
`bad` 计数里也带上它。

## 数据在内核里的用途

- **最近城市反查**：给定坐标 → 距离排序取前 N（`GEOUI_MAP.nearestCity`）。准星读数条、① 面板
  的浏览器定位结果、⑧ 的 IP 融合点都靠它做「这个坐标像不像个地方」。
- **海陆粗判**：点在陆域外 → 明确说水域，不给你一个假城市。
- **国家归属**：`countryName(cc)` 用 ISO 表把国家码翻成中文，界面里不出现裸的两位码。
- **偏转区判断**：配合 `GEODATUM` 决定 GCJ-02 / BD-09 转换是否适用（`outOfChina` 会直接告诉你偏移不适用）。

## 分发时要保留什么

GeoNames 是 CC BY 4.0，**再分发必须保留署名**。`说明书.md` 第 9 节和 `LICENSE` 末尾的第三方说明
就是为此存在的，别删。Leaflet 1.9.4（BSD-2-Clause）、qrcode.js（MIT, Kazuhiko Arase）同理。
在线底图瓦片的 © OpenStreetMap contributors（ODbL）只在你打开「在线底图」时才相关，
瓦片不属于本包。
