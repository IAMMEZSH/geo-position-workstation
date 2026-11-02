/*
 * build-data.mjs — 经纬度定位工作站 · 离线数据生成器
 * 输入：GeoNames cities15000.txt（TAB 分隔）+ Natural Earth ne_land.geojson（50m 陆地）。
 * 输出：app/data/data-cities.js / data-land.js / data-countries.js —— 纯浏览器脚本（IIFE 挂 GEODATA），
 *       不含 import/export/require，浏览器 <script> 与 Node require 均可加载。
 * 幂等：输出只由输入决定（不含时间戳），重跑产生逐字节相同的文件；输入缺失时保留旧文件、退出码非 0。
 * 原始文件路径可用环境变量覆盖：GEO_RAW_CITIES / GEO_RAW_LAND / GEO_OUT_DIR。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQ = createRequire(import.meta.url);

/* ---------------------------------------------------------------- 0. 配置 */
const RAW_CITIES = process.env.GEO_RAW_CITIES || path.join(HERE, '..', '..', '_build', 'dl', 'cities15000.txt');
const RAW_LAND = process.env.GEO_RAW_LAND || path.join(HERE, '..', '..', '_build', 'dl', 'ne_land.geojson');
const OUT_DIR = process.env.GEO_OUT_DIR || path.join(HERE, '..', 'app', 'data');

const CITY_MIN_POP = 10000;      // 全球通用门槛：与源文件名 cities15000 量级一致，兼容低人口省会
const CN_CITY_MIN_POP = 4000;    // 中国小城市是国内用户搜索主力，单独放宽
const LAND_COORD_DP = 2;         // 陆地坐标 2 位小数 ≈1.1 km：够做海陆粗判与极简底图
const LAND_MIN_AREA_DEG2 = 0.0025; // 碎块阈值：≈30 km²。0.01°(1.1km) 网格下小于此面积的多边形会退化成噪声；
                                   // 而自检与海陆判断关心的最小陆块（瓦胡岛 ≈1545 km²）远大于它。

/* ---------------------------------------------------------------- 1. 工具 */
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; }
function round(v, dp) { const p = 10 ** dp; return Math.round(v * p) / p; }
function fail(msg) { console.error('[build-data] FAIL: ' + msg); process.exit(1); }
function wrap180(x) { const w = ((x + 540) % 360) - 180; return w === -180 ? 180 : w; }
function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

function writeFile(name, body) {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, body, 'utf8');
  return fs.statSync(p).size;
}

// 生成的数据文件统一 IIFE 外壳：Object.assign 允许三个文件各自追加命名空间
function iife(comment, varName, literal) {
  return '/* ' + comment + ' */\n'
    + "(function (g) {\n  'use strict';\n"
    + '  var ' + varName + ' = ' + literal + ';\n'
    + '  g.GEODATA = Object.assign(g.GEODATA || {}, ' + varName + ');\n'
    + "})(typeof globalThis !== 'undefined' ? globalThis : window);\n";
}

// 递归扫描：NaN / undefined / null 一律视为脏数据，宁可构建失败也不落盘
function assertClean(v, where) {
  if (typeof v === 'number' && !Number.isFinite(v)) fail(where + ' 含非有限数 ' + v);
  if (v === undefined || v === null) fail(where + ' 含 ' + String(v));
  if (Array.isArray(v)) v.forEach((x, i) => assertClean(x, where + '[' + i + ']'));
  else if (typeof v === 'object') Object.keys(v).forEach((k) => assertClean(v[k], where + '.' + k));
}

// 在 Node 里按浏览器方式执行数据文件（无 module.exports，靠全局副作用），并验证可加载
function loadGenerated(file) {
  delete globalThis.GEODATA;
  REQ(path.join(OUT_DIR, file));
  if (!globalThis.GEODATA) fail(file + ' 加载后未产生 globalThis.GEODATA');
  return globalThis.GEODATA;
}

/* ---------------------------------------------------------------- 2. 城市表 */
function pickZh(alts) {
  // 从 alternatenames 里挑简体中文名：只含 CJK（含音译分隔点）；惩罚含繁体字的候选，
  // 以区分同词形的日/韩汉字译名（如 東京/首爾）；长度作次要键。
  // 只列繁简/中日写法确有差异的字，避免误伤「天津/德国」这类繁简同形字
  const TRAD = /[東門車馬魚鳥龍風雲電爾灣關開寧縣陽陰書會話臺漢廣見觀講獵]/;

  let best = '', bestKey = Infinity;
  for (const a of alts.split(',')) {
    const s = a.trim();
    if (!s || !/^[㐀-䶿一-鿿·]{2,12}$/.test(s)) continue;
    const key = s.length + (TRAD.test(s) ? 32 : 0);
    if (key < bestKey) { bestKey = key; best = s; }
  }
  return best;
}

function buildCities() {
  const text = fs.readFileSync(RAW_CITIES, 'utf8');
  const rows = [];
  let skipped18 = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line[0] === '#') continue; // 注释/空行防御性跳过（当前下载版无 # 行）
    const f = line.split('\t');
    // 新版 19 列（含 admin4+timezone），旧版 18 列：人口列位置不同
    if (f.length < 18) { skipped18++; continue; }
    const popIdx = f.length >= 19 ? 14 : 13;
    const lat = num(f[4]), lon = num(f[5]), pop = num(f[popIdx]) || 0;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const cc = f[8];
    if (!(pop >= CITY_MIN_POP || (cc === 'CN' && pop >= CN_CITY_MIN_POP))) continue;
    rows.push([f[2], pickZh(f[3]), round(lat, 4), round(lon, 4), cc, Math.round(pop), f[10] || '', f[7] || '']);
  }
  assertClean(rows, 'cities.rows');
  const comment = [
    '自动生成，请勿手改：由 工具/build-data.mjs 从 GeoNames cities15000（纯离线）转换而来，名称字段全部为源文件原文。',
    '行格式（数组，顺序固定）：[ascii名, 中文名或"", 纬度, 经度, ISO2国家码, 人口, admin1码, feature_code]。',
    '经纬度 4 位小数（≈11 m）；中文名取自 alternatenames 的简体中文写法，缺失时为空串；查询索引由 UI 层自建。',
    '收录规则：人口 ≥ ' + CITY_MIN_POP + '，或国家码 CN 且人口 ≥ ' + CN_CITY_MIN_POP + '。',
  ].join('\n');
  const head = '/*\n * ' + comment.split('\n').join('\n * ') + '\n */\n';
  // 行不加缩进：3.4 万行 × 4 空格 ≈ 137 KB，直接关系到 2 MB 体积上限
  const body = rows.map((r) => JSON.stringify(r)).join(',\n');
  const fields = "fields: ['asciiname', 'zh_name', 'lat', 'lon', 'cc', 'population', 'admin1', 'feature_code']";
  const literal = '{\n  cities: {\n    ' + fields + ',\n    rows: [\n' + body + '\n  ]\n}\n}';
  const bytes = writeFile('data-cities.js', head + iife('data-cities.js — 城市离线表（浏览器/Node 双兼容，无模块语法）', 'D', literal));
  console.log('[cities] 行数=%d  跳过异常行=%d  文件大小=%d B (%s)', rows.length, skipped18, bytes, kb(bytes));
  return rows.length;
}

/* ---------------------------------------------------------------- 3. 陆地轮廓 */
// 环存成扁平数组 [lon,lat,lon,lat,...]（比点对数组省一半括号）；块 = [外环, 洞环...]。
// 先按「相邻点最短角差」把环展开成连续经度链再落盘：跨 ±180 的环（如南极大陆整圈）在查询侧
// 只需 x = 存储经度 - 测试经度 即可保持连续；NaturalEarth 的 ±180 裁切边也随之成为普通竖边。
function cleanRing(ring, dp) {
  const out = [];
  let prevRaw = ring[0][0], acc = ring[0][0];
  for (let i = 0; i < ring.length; i++) {
    if (i > 0) {
      let d = ring[i][0] - prevRaw;
      if (d > 180) d -= 360; else if (d < -180) d += 360;
      acc += d; prevRaw = ring[i][0];
    }
    const x = round(acc, dp), y = round(ring[i][1], dp);
    const n = out.length;
    if (n >= 2 && out[n - 2] === x && out[n - 1] === y) continue; // 网格重合点
    out.push(x, y);
  }
  if (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2; // 统一不闭合存储
  let changed = true;
  while (changed && out.length >= 6) {
    changed = false;
    const kept = [];
    const n = out.length / 2;
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n, q = (i + 1) % n;
      const ax = out[2 * p], ay = out[2 * p + 1], bx = out[2 * i], by = out[2 * i + 1], cx = out[2 * q], cy = out[2 * q + 1];
      // 展开坐标里相邻顶点经度差不会超过半圈；再出现 |Δx|>180 只可能是被共线压缩后的整圈闭合边，不动它
      if (Math.abs(cx - ax) <= 180 && (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) { changed = true; continue; }
      kept.push(bx, by);
    }
    out.length = 0; Array.prototype.push.apply(out, kept);
  }
  return out;
}

function shoelaceDeg2(flat) {
  let s = 0;
  for (let i = 0, n = flat.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    s += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1];
  }
  return Math.abs(s) / 2;
}

function buildLand() {
  const gj = JSON.parse(fs.readFileSync(RAW_LAND, 'utf8'));
  const blocks = [];
  let pts = 0, dropped = 0;
  for (const feat of gj.features) {
    const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
    for (const poly of polys) {
      const rings = poly.map((r) => cleanRing(r, LAND_COORD_DP)).filter((r) => r.length >= 6);
      if (!rings.length) { dropped++; continue; }
      if (shoelaceDeg2(rings[0]) < LAND_MIN_AREA_DEG2) { dropped++; continue; }
      blocks.push(rings);
      pts += rings.reduce((a, r) => a + r.length / 2, 0);
    }
  }
  console.log('[land  ] 块数=%d  丢弃碎块=%d  顶点数=%d', blocks.length, dropped, pts);

  const runtime = `
  var LAND = D.land.blocks;
  function wrap180(x) { return ((x % 360) + 540) % 360 - 180; }
  // 射线法：把测试点经度旋转到 0，环经先展开（存储时已保证相邻点经度差 <180）直接整体平移，
  // 跨 ±180 的整圈大陆（南极）不会被接缝截断；洞环参与同一奇偶计数，自动实现「湖=非陆」。
  function isLand(lat, lon) {
    if (!(lat >= -90 && lat <= 90) || lon !== +lon) return false;
    lon = wrap180(lon);
    var hit = false;
    for (var b = 0; b < LAND.length; b++) {
      var rings = LAND[b];
      for (var r = 0; r < rings.length; r++) {
        var f = rings[r], n = f.length / 2;
        var x0 = wrap180(f[0] - lon);           // 首顶点在「以测试点为 0°」的局部经度系中的位置
        var px = x0, py = f[1];
        for (var i = 1; i <= n; i++) {          // i==n 时回到首顶点，闭合环
          var k = i % n;
          var cx = x0 + (f[2 * k] - f[0]), cy = f[2 * k + 1];
          if ((py > lat) !== (cy > lat)) {
            var xint = px + (lat - py) * (cx - px) / (cy - py);
            if (xint > 0) hit = !hit;
          }
          px = cx; py = cy;
        }
      }
    }
    return hit;
  }
  var POINTS = [
    ['珠穆朗玛峰', 27.9881, 86.925, true],
    ['马里亚纳海沟侧', 11.35, 142.2, false],
    ['上海', 31.23, 121.47, true],
    ['檀香山', 21.31, -157.86, true],
    ['南极点', -89.9, 0, true],
    ['南大西洋', -20.0, -10.0, false]
  ];
  function selfTest() {
    var bad = [];
    for (var i = 0; i < POINTS.length; i++) {
      var p = POINTS[i], got = isLand(p[1], p[2]);
      if (got !== p[3]) bad.push({ name: p[0], lat: p[1], lon: p[2], expect: p[3] ? 'land' : 'sea', got: got ? 'land' : 'sea' });
    }
    return bad; // 空数组 = 全部通过
  }
`;
  const comment = [
    '自动生成，请勿手改：源 Natural Earth ne_50m_land（ne_land.geojson），坐标全部来自原文四舍五入，无手工增删。',
    '结构：blocks = [块, ...]；块 = [外环, 洞环, ...]；环 = 扁平数组 [lon,lat,lon,...]（不闭合存储，查询时自动封口）。',
    '环经度已按相邻点最短角差展开为连续链（跨 ±180 的环允许出现 |lon|>180 的存储值），isLand 内只做整体平移，无接缝误差。',
    '坐标精度 2 位小数（≈1.1 km）；已删除圆整后重合/共线的冗余点；面积 < 0.0025 平方度（≈30 km²）的碎块被丢弃——',
    '该尺度在 0.01° 网格上无法成形，且不影响海陆粗判。用途：离线「坐标是否在陆地」判定 + 极简底图，不做精确边界。',
    'isLand(lat, lon) 用射线法逐边展开经度，正确处理跨 ±180 的块；selfTest() 返回不通过点列表（空=通过）。',
  ].join('\n');
  const head = '/*\n * ' + comment.split('\n').join('\n * ') + '\n */\n';
  const literal = '{\n  land: {\n    coordDecimals: ' + LAND_COORD_DP + ',\n    minAreaDeg2: ' + LAND_MIN_AREA_DEG2 + ',\n'
    + '    stats: { blocks: ' + blocks.length + ', points: ' + pts + ' },\n    blocks: [\n'
    + blocks.map((b) => '      ' + JSON.stringify(b)).join(',\n') + '\n    ]\n  }\n}';
  const src = head + "(function (g) {\n  'use strict';\n  var D = " + literal + ';\n'
    + runtime + '\n  D.land.isLand = isLand;\n  D.land.selfTest = selfTest;\n'
    + '  g.GEODATA = Object.assign(g.GEODATA || {}, D);\n'
    + "})(typeof globalThis !== 'undefined' ? globalThis : window);\n";
  const bytes = writeFile('data-land.js', src);
  console.log('[land  ] 文件大小=%d B (%s)', bytes, kb(bytes));
  return blocks;
}

/* ---------------------------------------------------------------- 4. 国家名表 */
// 手工维护的展示用名称表（非源文件转换）：ISO2 → {en, zh}，zh 为大陆通行简体中文译名；
// 译名不确定的政体（科索沃、西撒哈拉等）宁缺毋滥。
const COUNTRIES = [
  ['AF', 'Afghanistan', '阿富汗'], ['AL', 'Albania', '阿尔巴尼亚'], ['DZ', 'Algeria', '阿尔及利亚'], ['AD', 'Andorra', '安道尔'],
  ['AO', 'Angola', '安哥拉'], ['AG', 'Antigua and Barbuda', '安提瓜和巴布达'], ['AR', 'Argentina', '阿根廷'], ['AM', 'Armenia', '亚美尼亚'],
  ['AU', 'Australia', '澳大利亚'], ['AT', 'Austria', '奥地利'], ['AZ', 'Azerbaijan', '阿塞拜疆'], ['BS', 'Bahamas', '巴哈马'],
  ['BH', 'Bahrain', '巴林'], ['BD', 'Bangladesh', '孟加拉国'], ['BB', 'Barbados', '巴巴多斯'], ['BY', 'Belarus', '白俄罗斯'],
  ['BE', 'Belgium', '比利时'], ['BZ', 'Belize', '伯利兹'], ['BJ', 'Benin', '贝宁'], ['BT', 'Bhutan', '不丹'],
  ['BO', 'Bolivia', '玻利维亚'], ['BA', 'Bosnia and Herzegovina', '波斯尼亚和黑塞哥维那'], ['BW', 'Botswana', '博茨瓦纳'], ['BR', 'Brazil', '巴西'],
  ['BN', 'Brunei', '文莱'], ['BG', 'Bulgaria', '保加利亚'], ['BF', 'Burkina Faso', '布基纳法索'], ['BI', 'Burundi', '布隆迪'],
  ['KH', 'Cambodia', '柬埔寨'], ['CM', 'Cameroon', '喀麦隆'], ['CA', 'Canada', '加拿大'], ['CV', 'Cabo Verde', '佛得角'],
  ['CF', 'Central African Republic', '中非共和国'], ['TD', 'Chad', '乍得'], ['CL', 'Chile', '智利'], ['CN', 'China', '中国'],
  ['CO', 'Colombia', '哥伦比亚'], ['KM', 'Comoros', '科摩罗'], ['CG', 'Congo', '刚果（布）'], ['CD', 'DR Congo', '刚果（金）'],
  ['CR', 'Costa Rica', '哥斯达黎加'], ['HR', 'Croatia', '克罗地亚'], ['CU', 'Cuba', '古巴'], ['CY', 'Cyprus', '塞浦路斯'],
  ['CZ', 'Czechia', '捷克'], ['DK', 'Denmark', '丹麦'], ['DJ', 'Djibouti', '吉布提'], ['DM', 'Dominica', '多米尼克'],
  ['DO', 'Dominican Republic', '多米尼加'], ['EC', 'Ecuador', '厄瓜多尔'], ['EG', 'Egypt', '埃及'], ['SV', 'El Salvador', '萨尔瓦多'],
  ['GQ', 'Equatorial Guinea', '赤道几内亚'], ['ER', 'Eritrea', '厄立特里亚'], ['EE', 'Estonia', '爱沙尼亚'], ['SZ', 'Eswatini', '埃斯瓦蒂尼'],
  ['ET', 'Ethiopia', '埃塞俄比亚'], ['FJ', 'Fiji', '斐济'], ['FI', 'Finland', '芬兰'], ['FR', 'France', '法国'],
  ['GA', 'Gabon', '加蓬'], ['GM', 'Gambia', '冈比亚'], ['GE', 'Georgia', '格鲁吉亚'], ['DE', 'Germany', '德国'],
  ['GH', 'Ghana', '加纳'], ['GR', 'Greece', '希腊'], ['GD', 'Grenada', '格林纳达'], ['GT', 'Guatemala', '危地马拉'],
  ['GN', 'Guinea', '几内亚'], ['GW', 'Guinea-Bissau', '几内亚比绍'], ['GY', 'Guyana', '圭亚那'], ['HT', 'Haiti', '海地'],
  ['HN', 'Honduras', '洪都拉斯'], ['HU', 'Hungary', '匈牙利'], ['IS', 'Iceland', '冰岛'], ['IN', 'India', '印度'],
  ['ID', 'Indonesia', '印度尼西亚'], ['IR', 'Iran', '伊朗'], ['IQ', 'Iraq', '伊拉克'], ['IE', 'Ireland', '爱尔兰'],
  ['IL', 'Israel', '以色列'], ['IT', 'Italy', '意大利'], ['CI', "Côte d'Ivoire", '科特迪瓦'], ['JM', 'Jamaica', '牙买加'],
  ['JP', 'Japan', '日本'], ['JO', 'Jordan', '约旦'], ['KZ', 'Kazakhstan', '哈萨克斯坦'], ['KE', 'Kenya', '肯尼亚'],
  ['KI', 'Kiribati', '基里巴斯'], ['KP', 'North Korea', '朝鲜'], ['KR', 'South Korea', '韩国'], ['KW', 'Kuwait', '科威特'],
  ['KG', 'Kyrgyzstan', '吉尔吉斯斯坦'], ['LA', 'Laos', '老挝'], ['LV', 'Latvia', '拉脱维亚'], ['LB', 'Lebanon', '黎巴嫩'],
  ['LS', 'Lesotho', '莱索托'], ['LR', 'Liberia', '利比里亚'], ['LY', 'Libya', '利比亚'], ['LI', 'Liechtenstein', '列支敦士登'],
  ['LT', 'Lithuania', '立陶宛'], ['LU', 'Luxembourg', '卢森堡'], ['MG', 'Madagascar', '马达加斯加'], ['MW', 'Malawi', '马拉维'],
  ['MY', 'Malaysia', '马来西亚'], ['MV', 'Maldives', '马尔代夫'], ['ML', 'Mali', '马里'], ['MT', 'Malta', '马耳他'],
  ['MH', 'Marshall Islands', '马绍尔群岛'], ['MR', 'Mauritania', '毛里塔尼亚'], ['MU', 'Mauritius', '毛里求斯'], ['MX', 'Mexico', '墨西哥'],
  ['FM', 'Micronesia', '密克罗尼西亚'], ['MD', 'Moldova', '摩尔多瓦'], ['MC', 'Monaco', '摩纳哥'], ['MN', 'Mongolia', '蒙古'],
  ['ME', 'Montenegro', '黑山'], ['MA', 'Morocco', '摩洛哥'], ['MZ', 'Mozambique', '莫桑比克'], ['MM', 'Myanmar', '缅甸'],
  ['NA', 'Namibia', '纳米比亚'], ['NR', 'Nauru', '瑙鲁'], ['NP', 'Nepal', '尼泊尔'], ['NL', 'Netherlands', '荷兰'],
  ['NZ', 'New Zealand', '新西兰'], ['NI', 'Nicaragua', '尼加拉瓜'], ['NE', 'Niger', '尼日尔'], ['NG', 'Nigeria', '尼日利亚'],
  ['MK', 'North Macedonia', '北马其顿'], ['NO', 'Norway', '挪威'], ['OM', 'Oman', '阿曼'], ['PK', 'Pakistan', '巴基斯坦'],
  ['PW', 'Palau', '帕劳'], ['PA', 'Panama', '巴拿马'], ['PG', 'Papua New Guinea', '巴布亚新几内亚'], ['PY', 'Paraguay', '巴拉圭'],
  ['PE', 'Peru', '秘鲁'], ['PH', 'Philippines', '菲律宾'], ['PL', 'Poland', '波兰'], ['PT', 'Portugal', '葡萄牙'],
  ['QA', 'Qatar', '卡塔尔'], ['RO', 'Romania', '罗马尼亚'], ['RU', 'Russia', '俄罗斯'], ['RW', 'Rwanda', '卢旺达'],
  ['WS', 'Samoa', '萨摩亚'], ['SM', 'San Marino', '圣马力诺'], ['ST', 'Sao Tome and Principe', '圣多美和普林西比'], ['SA', 'Saudi Arabia', '沙特阿拉伯'],
  ['SN', 'Senegal', '塞内加尔'], ['RS', 'Serbia', '塞尔维亚'], ['SC', 'Seychelles', '塞舌尔'], ['SL', 'Sierra Leone', '塞拉利昂'],
  ['SG', 'Singapore', '新加坡'], ['SK', 'Slovakia', '斯洛伐克'], ['SI', 'Slovenia', '斯洛文尼亚'], ['SB', 'Solomon Islands', '所罗门群岛'],
  ['SO', 'Somalia', '索马里'], ['ZA', 'South Africa', '南非'], ['ES', 'Spain', '西班牙'], ['LK', 'Sri Lanka', '斯里兰卡'],
  ['LC', 'Saint Lucia', '圣卢西亚'], ['VC', 'St. Vincent & Grenadines', '圣文森特和格林纳丁斯'], ['SD', 'Sudan', '苏丹'], ['SR', 'Suriname', '苏里南'],
  ['SE', 'Sweden', '瑞典'], ['CH', 'Switzerland', '瑞士'], ['SY', 'Syria', '叙利亚'], ['TJ', 'Tajikistan', '塔吉克斯坦'],
  ['TH', 'Thailand', '泰国'], ['TL', 'Timor-Leste', '东帝汶'], ['TG', 'Togo', '多哥'], ['TO', 'Tonga', '汤加'],
  ['TT', 'Trinidad and Tobago', '特立尼达和多巴哥'], ['TN', 'Tunisia', '突尼斯'], ['TR', 'Turkey', '土耳其'], ['TM', 'Turkmenistan', '土库曼斯坦'],
  ['TV', 'Tuvalu', '图瓦卢'], ['UG', 'Uganda', '乌干达'], ['UA', 'Ukraine', '乌克兰'], ['AE', 'United Arab Emirates', '阿拉伯联合酋长国'],
  ['GB', 'United Kingdom', '英国'], ['US', 'United States', '美国'], ['UY', 'Uruguay', '乌拉圭'], ['UZ', 'Uzbekistan', '乌兹别克斯坦'],
  ['VU', 'Vanuatu', '瓦努阿图'], ['VA', 'Vatican City', '梵蒂冈'], ['VE', 'Venezuela', '委内瑞拉'], ['VN', 'Vietnam', '越南'],
  ['YE', 'Yemen', '也门'], ['ZM', 'Zambia', '赞比亚'], ['ZW', 'Zimbabwe', '津巴布韦'],
  ['TW', 'Taiwan, China', '中国台湾'], ['HK', 'Hong Kong, China', '中国香港'], ['MO', 'Macao, China', '中国澳门'], ['PS', 'Palestine', '巴勒斯坦'],
];

function buildCountries() {
  const seen = new Set();
  for (const [c] of COUNTRIES) { if (seen.has(c)) fail('国家码重复: ' + c); seen.add(c); }
  assertClean(COUNTRIES, 'countries');
  const comment = [
    '展示用名称表：ISO 3166-1 alpha-2 → {en 英文名, zh 简体中文名}，共 ' + COUNTRIES.length + ' 条。',
    '仅用于把国家码翻译成可读名称，不用于任何几何/边界计算；未收录的码（如 XK/EH）由 UI 回退显示原始码。',
    '台湾按“中国台湾”、港澳按“中国香港/中国澳门”处理；译名不确定的政体未收录。来源：通行简体中文官方译名（人工维护，非源文件转换）。',
  ].join('\n');
  const head = '/*\n * ' + comment.split('\n').join('\n * ') + '\n */\n';
  const map = '{\n' + COUNTRIES.map(([c, en, zh]) => "    " + JSON.stringify(c) + ': {en: ' + JSON.stringify(en) + ', zh: ' + JSON.stringify(zh) + '}').join(',\n') + '\n  }';
  const bytes = writeFile('data-countries.js', iife('data-countries.js — 国家码 → 展示名称（浏览器/Node 双兼容，无模块语法）', 'D', '{\n  countries: ' + map + '\n}'));
  console.log('[country] 条目=%d  文件大小=%d B (%s)', COUNTRIES.length, bytes, kb(bytes));
  return COUNTRIES.length;
}

/* ---------------------------------------------------------------- 5. 主流程 */
function main() {
  for (const [p, label] of [[RAW_CITIES, 'cities15000'], [RAW_LAND, 'ne_land']]) {
    if (!fs.existsSync(p)) fail('缺少原始文件 ' + label + ': ' + p);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('[config ] 原始目录输入 → 输出 ' + OUT_DIR);

  const nCities = buildCities();
  buildLand();
  const nCountries = buildCountries();

  // 加载验证：三个文件都必须是浏览器风格的纯脚本且无 NaN/undefined
  loadGenerated('data-cities.js');
  const land = loadGenerated('data-land.js');
  const g = loadGenerated('data-countries.js');
  const bad = land.land.selfTest();
  if (bad.length) fail('陆地自检未通过: ' + JSON.stringify(bad));
  console.log('[verify ] GEODATA keys=%j  cities=%d  landBlocks=%d  countries=%d  selfTest=PASS',
    Object.keys(g), nCities, land.land.blocks.length, nCountries);

  let total = 0;
  for (const f of ['data-cities.js', 'data-land.js', 'data-countries.js']) {
    const s = fs.statSync(path.join(OUT_DIR, f)).size; total += s;
    console.log('[size   ] %s = %d B (%s)', f, s, kb(s));
  }
  console.log('[size   ] 合计 = %d B (%s)', total, kb(total));
  console.log('[done   ] 构建成功');
}

main();
