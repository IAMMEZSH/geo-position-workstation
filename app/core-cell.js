/*
 * core-cell.js — 经纬度定位工作站 · 基站 / 信号 / 三角定位计算引擎
 * 纯浏览器脚本：无 import/export、无 DOM、无 fetch、无第三方库；Node 下可直接 require 做数值自检。
 * 所有测地计算均在本文件内基于 WGS84 完成，不依赖任何外部模块。
 */
(function (global) {
  'use strict';

  /* ============================================================== 0. 局部工具 */
  var PI = Math.PI, D2R = PI / 180, R2D = 180 / PI, LN10 = Math.log(10);
  var WGS84 = { a: 6378137.0, f: 1 / 298.257223563 };
  WGS84.b = WGS84.a * (1 - WGS84.f);
  WGS84.e2 = WGS84.f * (2 - WGS84.f);
  var MEAN_R = 6371008.8;          // IUGG 平均半径（球面近似用）
  var C_MS = 299792458;            // 真空中光速 m/s
  var NS_TO_M = C_MS / 1e9;        // 1 ns = 0.299792458 m
  var FSPL_K = 32.4411066649;      // 20*log10(4*pi*1km*1MHz/c)
  // 局部等距切平面缩放：米/度 = 曲率半径 × π/180（子午圈用 a(1-e²)，卯酉圈用 a 的赤道值）
  var M_PER_DEG_LAT = WGS84.a * (1 - WGS84.e2) * (PI / 180);
  var M_PER_DEG_LON = WGS84.a * (PI / 180);

  function toRad(d) { return d * D2R; }
  function toDeg(r) { return r * R2D; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function lg(v) { return Math.log(v) / LN10; }
  function rnd(v, n) { if (!isNum(v)) return null; var p = Math.pow(10, n == null ? 2 : n); return Math.round(v * p) / p; }
  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function wrap180(a) { var x = wrap360(a); return x > 180 ? x - 360 : x; }
  function safe(v, fb) { return isNum(v) ? v : fb; }
  function esc(v) { return String(v == null ? '' : v); }

  // 宽松数字解析：容忍 "1 650"、"-105 dBm"、空串；失败返回 null，绝不返回 NaN
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null) return null;
    var s = esc(v).replace(/[^0-9.eE+-]/g, '');
    if (!/[-+]?\d/.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function intNum(v) { var n = num(v); return n == null ? null : Math.round(n); }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    if (!isNum(lat1) || !isNum(lon1) || !isNum(lat2) || !isNum(lon2)) return null;
    var p1 = toRad(lat1), p2 = toRad(lat2), dp = p2 - p1, dl = toRad(lon2 - lon1);
    var h = Math.pow(Math.sin(dp / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
    return 2 * MEAN_R * Math.asin(clamp(Math.sqrt(h), -1, 1));
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    var p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return wrap360(toDeg(Math.atan2(y, x)));
  }
  function destinationPoint(lat, lon, brg, dist_m) {
    var d = dist_m / MEAN_R, th = toRad(brg), p1 = toRad(lat), l1 = toRad(lon);
    var p2 = Math.asin(clamp(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th), -1, 1));
    var l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: toDeg(p2), lon: wrap360(toDeg(l2) + 180) - 180 };
  }
  function toPlane(ref, lat, lon) {
    var k = Math.max(Math.cos(toRad(ref.lat)), 1e-6);   // 极点保护
    return { x: (lon - ref.lon) * M_PER_DEG_LON * k, y: (lat - ref.lat) * M_PER_DEG_LAT };
  }
  function toLatLon(ref, x, y) {
    var k = Math.max(Math.cos(toRad(ref.lat)), 1e-6);
    return { lat: clamp(ref.lat + y / M_PER_DEG_LAT, -90, 90), lon: wrap360(ref.lon + x / (M_PER_DEG_LON * k) + 180) - 180 };
  }
  function planeToLatLon(ref, p) { return toLatLon(ref, p.x, p.y); }
  function centroid(arr) {
    var s = 0, n = 0, sx = 0, sy = 0;
    arr.forEach(function (t) { if (isNum(t.lat) && isNum(t.lon)) { s += t.lat; sx += t.lon; n++; } });
    if (!n) return null;
    return { lat: s / n, lon: sx / n };
  }

  /* 2x2 / NxN 线性代数（闭式，避免引入库） */
  function inv2(m) {
    var a = m[0][0], b = m[0][1], c = m[1][0], d = m[1][1];
    var det = a * d - b * c;
    // 阈值相对化：法方程元素量级为 1/σ²（σ 为百米级时 |det| 自然小于 1e-12），绝对阈值会误判为奇异
    var sc = a * a + b * b + c * c + d * d;
    if (!isNum(det) || !isNum(sc) || sc === 0 || Math.abs(det) <= 1e-12 * sc) return null;
    return [[d / det, -b / det], [-c / det, a / det]];
  }
  function matInv(A) { // Gauss-Jordan + 部分主元，主元阈值按矩阵尺度相对化
    var n = A.length, i, j, k, sc = 0;
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) sc = Math.max(sc, Math.abs(A[i][j]));
    if (!isNum(sc) || sc === 0) return null;
    var eps = 1e-13 * sc;
    var M = A.map(function (row, r) { return row.slice().concat(row.map(function (_, c) { return r === c ? 1 : 0; })); });
    for (i = 0; i < n; i++) {
      var piv = i;
      for (j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[piv][i])) piv = j;
      if (Math.abs(M[piv][i]) < eps) return null;
      var t = M[i]; M[i] = M[piv]; M[piv] = t;
      var d = M[i][i];
      for (j = 0; j < 2 * n; j++) M[i][j] /= d;
      for (k = 0; k < n; k++) {
        if (k === i) continue;
        var f = M[k][i];
        if (!f) continue;
        for (j = 0; j < 2 * n; j++) M[k][j] -= f * M[i][j];
      }
    }
    return M.map(function (row) { return row.slice(n); });
  }
  function eig2(m) { // 对称 2x2 特征分解闭式；特征值降序，theta 为长轴方位角(自 +x/东 逆时针)
    var a = m[0][0], b = (m[0][1] + m[1][0]) / 2, d = m[1][1];
    var tr = a + d;
    var dd = Math.sqrt(Math.max(0, ((a - d) / 2) * ((a - d) / 2) + b * b));
    var l1 = tr / 2 + dd, l2 = tr / 2 - dd;
    var th = Math.abs(b) < 1e-15 ? (a >= d ? 0 : PI / 2) : 0.5 * Math.atan2(2 * b, a - d);
    return { l1: Math.max(l1, 0), l2: Math.max(l2, 0), theta: th };
  }

  /* ============================================================== 1. 静态数据表 */
  var MODELS = {
    fspl: { id: 'fspl', name: '自由空间路径损耗 (FSPL)', freq_range_mhz: [10, 100000], description: '32.44 + 20lg(d_km) + 20lg(f_MHz)，无遮挡真空模型，全频段可用，作其它模型的基准。' },
    okumura: { id: 'okumura', name: 'Okumura–Hata 经验模型', freq_range_mhz: [150, 1500], description: '150–1500 MHz / 1–20 km 宏蜂窝经验式，含基站与移动台天线高度修正及中小城市 / 郊区 / 农村修正。' },
    cost231: { id: 'cost231', name: 'COST-231 Hata 模型', freq_range_mhz: [1500, 2000], description: 'Hata 的 1500–2000 MHz 扩展，路径损耗指数由 44.9 提高，含移动台高度修正项。' },
    '3gpp_38901_urban': { id: '3gpp_38901_urban', name: '3GPP TR38.901 城区 (UMi/UMa)', freq_range_mhz: [5925, 71250], description: 'TR 38.901 城市 LOS/NLOS 简化式：32.4 + 21.4lg(d_m) + 19lg(f_GHz)（UMi LOS），NLOS 换成 22.4 指数。' },
    '3gpp_38901_rural': { id: '3gpp_38901_rural', name: '3GPP TR38.901 乡村 (RMa)', freq_range_mhz: [700, 6000], description: 'RMa LOS：20lg(650d/λ) + 26.6lg(d_km) + 31.6，有效 87.5 m–130 km（本实现按 1 m–100 km 截断）。' },
    log_normal: { id: 'log_normal', name: '通用对数距离 + 阴影衰落', freq_range_mhz: [10, 100000], description: 'PL = PL0 + 10n·lg(d/d0)，n 按环境取值，σ 为 dB 标准差，距离不确定度 σ_d = ln10/10·d·σ/n。' },
    custom: { id: 'custom', name: '自定义链路预算', freq_range_mhz: [1, 100000], description: '用户给出 PL0 / d0 / n 或 1 m 参考 RSSI，直接按链路预算反演距离。' }
  };

  var ENV = {
    indoor: { n: 4.5, sigma: 8, extra_db: 10, label: '室内' },
    urban: { n: 3.5, sigma: 6, extra_db: 0, label: '市区' },
    dense_urban: { n: 4.0, sigma: 7, extra_db: 6, label: '密集城区' },
    suburban: { n: 3.0, sigma: 5, extra_db: 0, label: '郊区' },
    rural: { n: 2.7, sigma: 4, extra_db: 0, label: '农村' },
    outdoor: { n: 2.8, sigma: 6, extra_db: 0, label: '室外' }
  };

  // LTE EARFCN -> 下行中心频率（36.101 常用频段），供 freq 推断与 RAT 表复用
  var LTE_BANDS = [
    { band: 1, earfcn: '0-599', f: 1970, duplex: 'FDD' },
    { band: 1, earfcn: '1800-1999', f: 2155, duplex: 'FDD' },
    { band: 2, earfcn: '1850-1919', f: 1960, duplex: 'FDD' },
    { band: 3, earfcn: '1650-1739', f: 1842.5, duplex: 'FDD' },
    { band: 5, earfcn: '2400-2649', f: 881.5, duplex: 'FDD' },
    { band: 7, earfcn: '2850-3049', f: 2655, duplex: 'FDD' },
    { band: 8, earfcn: '3450-3749', f: 942.5, duplex: 'FDD' },
    { band: 20, earfcn: '6152-6449', f: 806, duplex: 'FDD' },
    { band: 28, earfcn: '7250-7499', f: 773, duplex: 'FDD' },
    { band: 34, earfcn: '3600-3799', f: 2080, duplex: 'TDD' },
    { band: 38, earfcn: '3775-3904', f: 2600, duplex: 'TDD' },
    { band: 39, earfcn: '39649-40959', f: 1890, duplex: 'TDD' },
    { band: 40, earfcn: '3995-4094', f: 2350, duplex: 'TDD' },
    { band: 41, earfcn: '4095-4158', f: 2593, duplex: 'TDD' }
  ];

  var RAT_INFO = {
    gsm: { name: 'GSM 2G', full_name: 'Global System for Mobile Communications', typical_range_m: 35000, note: 'BCCH 绝对频点；900 段下行 935–960 MHz，1800 段(DCS) 下行 1710–1785 MHz。', bands: [ { earfcn_or_arfcn_range: '0-124', freq_mhz: 947.5, duplex: 'FDD' }, { earfcn_or_arfcn_range: '512-885', freq_mhz: 1747.5, duplex: 'FDD' }, { earfcn_or_arfcn_range: '960-1023', freq_mhz: 947, duplex: 'FDD' } ] },
    cdma: { name: 'CDMA2000 / IS-95', full_name: 'Code Division Multiple Access', typical_range_m: 30000, note: '以 PN 偏置/经度标识小区，反向导频 RSSI 与 RSSI 混合，链路预算模型偏差较大。', bands: [ { earfcn_or_arfcn_range: 'BCD 0-7997 (A-band)', freq_mhz: 836.5, duplex: 'FDD' }, { earfcn_or_arfcn_range: '100-4510 (BCD0)', freq_mhz: 875, duplex: 'FDD' } ] },
    wcdma: { name: 'WCDMA 3G (UTRAN)', full_name: 'Wideband CDMA', typical_range_m: 5000, note: '频点即 UARFCN：10560–11224 对应 Band1 下行 2110–2170 MHz；2939–3086 对应 Band8 下行 925–960 MHz。', bands: [ { earfcn_or_arfcn_range: '10560-11224', freq_mhz: 2140, duplex: 'FDD' }, { earfcn_or_arfcn_range: '2939-3086', freq_mhz: 942.5, duplex: 'FDD' }, { earfcn_or_arfcn_range: '9262-9537', freq_mhz: 1910, duplex: 'FDD' } ] },
    lte: { name: 'LTE 4G (E-UTRAN)', full_name: 'Long Term Evolution', typical_range_m: 2000, note: 'RSRP/RSRQ 精度优于 RSSI；TA 一步 ≈ 78 m（单程），宏蜂窝半径典型 0.5–2 km。', bands: LTE_BANDS.map(function (b) { return { band: b.band, earfcn_or_arfcn_range: b.earfcn, freq_mhz: b.f, duplex: b.duplex }; }) },
    nr5g: { name: 'NR 5G (NG-RAN)', full_name: 'New Radio', typical_range_m: 800, note: 'SSB ARFCN 全局栅格步长与频段相关，本表给出常用频点参考值；SS-RSRP 用于链路预算。', bands: [ { band: 'n41', earfcn_or_arfcn_range: '528000-529999', freq_mhz: 2593, duplex: 'TDD' }, { band: 'n78', earfcn_or_arfcn_range: '627264-653999', freq_mhz: 3500, duplex: 'TDD' }, { band: 'n79', earfcn_or_arfcn_range: '674999-701999', freq_mhz: 4800, duplex: 'TDD' }, { band: 'n28', earfcn_or_arfcn_range: '158666-171666', freq_mhz: 773, duplex: 'FDD' }, { band: 'n1', earfcn_or_arfcn_range: '42200-50200', freq_mhz: 2155, duplex: 'FDD' }, { band: 'n77', earfcn_or_arfcn_range: '725000-794999', freq_mhz: 3900, duplex: 'TDD' } ] },
    wifi: { name: 'Wi-Fi (IEEE 802.11)', full_name: 'Wireless LAN', typical_range_m: 45, note: '2.4 GHz 穿透损耗大、RSSI 抖动 6–10 dB，适合指纹定位；5/6 GHz 视距衰减快。', bands: [ { earfcn_or_arfcn_range: 'channel 1-14', freq_mhz: 2412, duplex: 'TDD' }, { earfcn_or_arfcn_range: 'channel 36-177', freq_mhz: 5180, duplex: 'TDD' }, { earfcn_or_arfcn_range: 'channel 1-233', freq_mhz: 5955, duplex: 'TDD' } ] },
    bluetooth: { name: 'Bluetooth LE / iBeacon', full_name: 'Bluetooth Low Energy', typical_range_m: 30, note: '广播 TX 功率通常为 -30…+4 dBm；RSSI 噪声大，单点距离不确定度 ≥ 2–4 m。', bands: [ { earfcn_or_arfcn_range: 'adv ch 37-39 (2402/2426/2480)', freq_mhz: 2440, duplex: 'TDD' }, { earfcn_or_arfcn_range: 'data ch 0-39', freq_mhz: 2400, duplex: 'TDD' } ] }
  };

  /* 运营商：中国全部实际在用 MNC + 常用国际运营商（MCC 460 = 中国）。字段顺序 mcc,mnc,name,country,iso2 */
  var OP_ROWS = [
    ['460', '00', '中国移动 China Mobile', '中国', 'CN'], ['460', '02', '中国移动 China Mobile', '中国', 'CN'],
    ['460', '04', '中国移动 China Mobile (GIW)', '中国', 'CN'], ['460', '07', '中国移动 China Mobile', '中国', 'CN'],
    ['460', '08', '中国移动 China Mobile', '中国', 'CN'], ['460', '13', '中国移动 China Mobile (TD)', '中国', 'CN'],
    ['460', '14', '中国移动 China Mobile (物联网)', '中国', 'CN'], ['460', '01', '中国联通 China Unicom', '中国', 'CN'],
    ['460', '06', '中国联通 China Unicom', '中国', 'CN'], ['460', '09', '中国联通 China Unicom', '中国', 'CN'],
    ['460', '10', '中国联通 China Unicom (数据)', '中国', 'CN'], ['460', '03', '中国电信 China Telecom', '中国', 'CN'],
    ['460', '05', '中国电信 China Telecom (CDMA)', '中国', 'CN'], ['460', '11', '中国电信 China Telecom', '中国', 'CN'],
    ['460', '12', '中国电信 China Telecom', '中国', 'CN'], ['460', '15', '中国广电 China Broadnet', '中国', 'CN'],
    ['460', '18', '中国广电 China Broadnet (测试)', '中国', 'CN'], ['460', '20', '中国铁路 GSM-R', '中国', 'CN'],
    ['460', '99', '中国电信测试网', '中国', 'CN'],
    ['202', '01', 'Cosmote', '希腊', 'GR'], ['204', '04', 'Vodafone NL', '荷兰', 'NL'], ['204', '16', 'T-Mobile NL', '荷兰', 'NL'],
    ['206', '01', 'Proximus', '比利时', 'BE'], ['208', '01', 'Orange', '法国', 'FR'], ['208', '10', 'SFR', '法国', 'FR'],
    ['208', '20', 'Bouygues Telecom', '法国', 'FR'], ['214', '01', 'Movistar', '西班牙', 'ES'], ['214', '03', 'Orange ES', '西班牙', 'ES'],
    ['214', '07', 'Vodafone ES', '西班牙', 'ES'], ['222', '01', 'TIM', '意大利', 'IT'], ['222', '10', 'Vodafone IT', '意大利', 'IT'],
    ['222', '99', 'ILIAD (170)', '意大利', 'IT'], ['226', '01', 'Vodafone RO', '罗马尼亚', 'RO'], ['226', '05', 'Digi Mobil', '罗马尼亚', 'RO'],
    ['228', '01', 'Swisscom', '瑞士', 'CH'], ['228', '02', 'Sunrise', '瑞士', 'CH'], ['230', '01', 'T-Mobile CZ', '捷克', 'CZ'],
    ['230', '02', 'O2 Czech', '捷克', 'CZ'], ['231', '01', 'Orange SK', '斯洛伐克', 'SK'], ['232', '01', 'A1 Telekom Austria', '奥地利', 'AT'],
    ['234', '10', 'O2 / Three UK', '英国', 'GB'], ['234', '15', 'Vodafone UK', '英国', 'GB'], ['234', '30', 'EE (T-Mobile)', '英国', 'GB'],
    ['234', '33', 'EE', '英国', 'GB'], ['235', '94', 'Three UK', '英国', 'GB'], ['238', '01', 'TDC', '丹麦', 'DK'],
    ['240', '01', 'Telia', '瑞典', 'SE'], ['242', '01', 'Telenor', '挪威', 'NO'], ['244', '05', 'Elisa', '芬兰', 'FI'],
    ['250', '01', 'MTS', '俄罗斯', 'RU'], ['250', '02', 'MegaFon', '俄罗斯', 'RU'], ['255', '01', 'Vodafone UA', '乌克兰', 'UA'],
    ['255', '03', 'Kyivstar', '乌克兰', 'UA'], ['260', '01', 'Orange PL', '波兰', 'PL'], ['260', '02', 'Play', '波兰', 'PL'],
    ['262', '01', 'Telekom DE', '德国', 'DE'], ['262', '02', 'Vodafone DE', '德国', 'DE'], ['262', '03', 'E-Plus (O2)', '德国', 'DE'],
    ['268', '01', 'MEO', '葡萄牙', 'PT'], ['270', '01', 'POST LUXGSM', '卢森堡', 'LU'], ['284', '01', 'A1 Bulgaria', '保加利亚', 'BG'],
    ['293', '41', 'Mobilkom SI', '斯洛文尼亚', 'SI'], ['302', '220', 'Telus', '加拿大', 'CA'], ['302', '370', 'Fido', '加拿大', 'CA'],
    ['302', '720', 'Rogers', '加拿大', 'CA'], ['310', '120', 'Sprint', '美国', 'US'], ['310', '260', 'T-Mobile US', '美国', 'US'],
    ['310', '410', 'AT&T', '美国', 'US'], ['311', '480', 'Verizon', '美国', 'US'], ['334', '02', 'Telcel', '墨西哥', 'MX'],
    ['370', '01', 'Altice', '多米尼加', 'DO'], ['404', '03', 'Airtel', '印度', 'IN'], ['404', '04', 'Vi (IDEA)', '印度', 'IN'],
    ['404', '10', 'Airtel (德里)', '印度', 'IN'], ['405', '845', 'Reliance Jio', '印度', 'IN'], ['414', '01', 'MPT', '缅甸', 'MM'],
    ['416', '01', 'JTT (Zain)', '约旦', 'JO'], ['419', '02', 'Zain KW', '科威特', 'KW'], ['420', '01', 'STC', '沙特', 'SA'],
    ['425', '01', 'Cellcom', '以色列', 'IL'], ['425', '02', 'Partner', '以色列', 'IL'], ['426', '01', 'Batelco', '巴林', 'BH'],
    ['429', '01', 'Ncell', '尼泊尔', 'NP'], ['432', '35', 'MCI', '伊朗', 'IR'], ['440', '10', 'NTT docomo', '日本', 'JP'],
    ['440', '20', 'SoftBank', '日本', 'JP'], ['440', '07', 'KDDI (au)', '日本', 'JP'], ['450', '05', 'SK Telecom', '韩国', 'KR'],
    ['450', '06', 'LG U+', '韩国', 'KR'], ['450', '08', 'KT Olleh', '韩国', 'KR'], ['452', '01', 'Mobifone', '越南', 'VN'],
    ['454', '03', '中国电信（香港）', '中国香港', 'HK'], ['454', '00', 'CSL', '中国香港', 'HK'], ['455', '01', 'CTM', '中国澳门', 'MO'],
    ['466', '01', '远东电信 Fei-Tsu', '中国台湾', 'TW'], ['466', '92', '中華電信 Chunghwa', '中国台湾', 'TW'],
    ['472', '01', 'Dhiraagu', '马尔代夫', 'MV'], ['505', '01', 'Telstra', '澳大利亚', 'AU'], ['505', '02', 'Optus', '澳大利亚', 'AU'],
    ['505', '03', 'Vodafone AU', '澳大利亚', 'AU'], ['510', '10', 'Telkomsel', '印度尼西亚', 'ID'], ['510', '11', 'XL Axiata', '印度尼西亚', 'ID'],
    ['515', '02', 'Globe Telecom', '菲律宾', 'PH'], ['515', '03', 'Smart', '菲律宾', 'PH'], ['520', '01', 'AIS', '泰国', 'TH'],
    ['520', '03', 'dtac', '泰国', 'TH'], ['520', '04', 'TrueMove H', '泰国', 'TH'], ['525', '01', 'Singtel', '新加坡', 'SG'],
    ['525', '03', 'M1', '新加坡', 'SG'], ['525', '05', 'StarHub', '新加坡', 'SG'], ['530', '01', 'Vodafone NZ (One NZ)', '新西兰', 'NZ'],
    ['530', '05', 'Spark', '新西兰', 'NZ'], ['540', '01', 'BFT', '喀麦隆', 'CM'], ['602', '01', 'Telecom Egypt', '埃及', 'EG'],
    ['602', '02', 'Orange Egypt', '埃及', 'EG'], ['605', '02', 'Ooredoo TN', '突尼斯', 'TN'], ['614', '02', 'Orange NE', '尼日尔', 'NE'],
    ['621', '30', 'MTN Nigeria', '尼日利亚', 'NG'], ['622', '01', 'Airtel TD', '乍得', 'TD'], ['655', '01', 'Vodacom', '南非', 'ZA'],
    ['655', '07', 'Cell C', '南非', 'ZA'], ['655', '10', 'MTN SA', '南非', 'ZA'], ['724', '02', 'TIM Brasil', '巴西', 'BR'],
    ['724', '23', 'Claro Brasil', '巴西', 'BR'], ['730', '01', 'Entel', '智利', 'CL'], ['732', '101', 'Claro Colombia', '哥伦比亚', 'CO'],
    ['748', '01', 'Antel', '乌拉圭', 'UY']
  ];
  var OPERATORS = OP_ROWS.map(function (r) { return { mcc: r[0], mnc: r[1], name: r[2], country: r[3], iso2: r[4] }; });
  var OP_INDEX = (function () { // 键：'mcc-mnc'，MNC 去零前缀，使 460-01(联通) 与 460-11(电信) 不混淆
    var m = Object.create(null);
    OPERATORS.forEach(function (o) { m[keyOf(o.mcc, o.mnc)] = o; });
    return m;
  })();
  function keyOf(mcc, mnc) {
    var a = intNum(mcc), b = intNum(mnc);
    if (a == null || b == null) return null;
    return a + '-' + b;
  }

  /* ============================================================== 2. 字段规范化 */
  var RAT_ALIAS = {
    gsm: 'gsm', gsmpcs: 'gsm', gprs: 'gsm', edge: 'gsm', geran: 'gsm', '2g': 'gsm',
    cdma: 'cdma', cdma2000: 'cdma', ehrpd: 'cdma', onxrtt: 'cdma',
    wcdma: 'wcdma', utra: 'wcdma', hsdpa: 'wcdma', hsupa: 'wcdma', umts: 'wcdma', '3g': 'wcdma',
    lte: 'lte', eutra: 'lte', lteca: 'lte', '4g': 'lte',
    nr: 'nr5g', nr5g: 'nr5g', nwra: 'nr5g', '5g': 'nr5g', '5gnr': 'nr5g',
    wifi: 'wifi', wlan: 'wifi', dot11: 'wifi', he: 'wifi',
    bluetooth: 'bluetooth', ble: 'bluetooth', ibeacon: 'bluetooth'
  };
  var FIELD_ALIAS = {
    mcc: ['mcc', 'mmcc', 'mobilecountrycode', 'mcccode', 'plmnmcc', 'cidmcc'],
    mnc: ['mnc', 'mmnc', 'mobilenetworkcode', 'operatorid', 'plmnmnc', 'cidmnc'],
    lac: ['lac', 'tac', 'mtac', 'mlac', 'nctac', 'locationareacode', 'trackingareacode', 'cidtac', 'rtag'],
    ci: ['ci', 'cid', 'mci', 'mcid', 'nci', 'mnci', 'cellidentity', 'cellid', 'globalcellid', 'servercid'],
    network: ['network', 'operator', 'operatorname', 'carrier', 'alphatag', 'longalphatag', 'shortalphatag', 'spn'],
    arfcn: ['arfcn', 'earfcn', 'uarfcn', 'muarfcn', 'mnrarfcn', 'nrarfcn', 'nrfcn', 'channelnumber', 'rfchannel', 'bccharfcn', 'dlearfcn', 'mearfcn', 'marfcn'],
    pci: ['pci', 'psc', 'mpci', 'mpsc', 'physcellid', 'primariescramblingcode'],
    rat: ['rat', 'nettype', 'networktype', 'radiotype', 'celltype', 'radioaccesstechnology', 'technology', 'cellrat'],
    rssi_dbm: ['rssi', 'mrssi', 'rssidbm', 'rssidb', 'signalstrength', 'msignalstrength', 'level', 'signal', 'dbm', 'mcdmasignalstrength', 'mrsrssignalstrength'],
    rsrp_dbm: ['rsrp', 'mrsrp', 'rsrpdbm', 'ssrsrp', 'crssrsrp', 'mssrsrp', 'mcrssrsrp', 'mdcrsssrsrp', 'mnrlevel'],
    rsrq_dbm: ['rsrq', 'mrsrq', 'rsrqdbm', 'ssrsrq', 'mrsrsrq', 'mssrsrq'],
    sinr_db: ['sinr', 'rsrpsinr', 'mrsrsinr', 'mrsrsiq', 'sssinr', 'rsrssinr', 'msssinr'],
    tx_power_dbm: ['tx', 'txpower', 'txpowerdbm', 'eirp', 'eirpdbm', 'mme', 'measuredpower', 'measuredpowerdbm', 'pathloss0'],
    freq_mhz: ['freq', 'frequency', 'freqmhz', 'frequency_mhz', 'centerfreq', 'channel'],
    timing_advance: ['ta', 'timingadvance', 'timingadv', 'mtimingadvance', 'msslcdr'],
    azimuth: ['azimuth', 'az', 'heading', 'orient', 'azimuthdeg'],
    beamwidth: ['beamwidth', 'beamwidthdeg', 'sectorwidth', 'angle'],
    lat: ['lat', 'latitude', 'mlat', 'y'],
    lon: ['lon', 'lng', 'long', 'longitude', 'mlon', 'x'],
    range_m: ['range', 'rangem', 'distance', 'dist', 'distm', 'estimateddistance'],
    accuracy_m: ['accuracy', 'accuracy_m', 'radius', 'uncertainty', 'confidencem'],
    label: ['label', 'name', 'title', 'desc', 'description', 'note', 'ssid', 'remark']
  };
  var CID_HEX_KEYS = ['cid_hex', 'hexcid', 'cellhex', 'hexcellid', 'cidhex'];

  function normKey(k) { return esc(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function normVal(v) { return v == null ? null : (typeof v === 'string' ? v : String(v)); }
  function parseHex(v) {
    var m = esc(v).trim().match(/^(?:0x)?([0-9a-fA-F]+)$/i);   // 严格十六进制：'NaN'/'12,34' 之类混入杂质即判失败
    if (!m) return null;
    if (!/[a-fA-F]/.test(m[1])) return null;   // 纯数字交给十进制解析，避免 CID:41177 被当 16 进制
    var n = parseInt(m[1], 16);
    return isFinite(n) ? n : null;
  }
  function normalizeRat(v) {
    if (v == null) return null;
    var s = normVal(v).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!s) return null;
    if (RAT_ALIAS[s]) return RAT_ALIAS[s];
    if (/^nr/.test(s) || s === '5g') return 'nr5g';
    if (/^(lte|eutra)/.test(s)) return 'lte';
    if (/^(gsm|geran|edge|gprs)/.test(s)) return 'gsm';
    if (/^(utra|wcdma|hsdpa|hsupa|umts)/.test(s)) return 'wcdma';
    if (/cdma/.test(s)) return 'cdma';
    return null;
  }
  // 由 rat + 频点号反推下行中心频率（估计值，误差可达 50 MHz，仅用于链路预算）
  function guessFreqMhz(rat, arfcn) {
    if (!isNum(arfcn)) return null;
    var i = Math.round(arfcn);
    if (rat === 'lte') {
      for (var i1 = 0; i1 < LTE_BANDS.length; i1++) {
        var b = LTE_BANDS[i1], rg = b.earfcn.split('-');
        if (i >= num(rg[0]) && i <= num(rg[1])) return b.f;
      }
      return null;
    }
    if (rat === 'wcdma') {
      if (i >= 10560 && i <= 11224) return 2110 + (i - 10560) / 50;
      if (i >= 2939 && i <= 3086) return 925 + (i - 2939) / 50;
      if (i >= 9262 && i <= 9537) return 1900 + (i - 9262) / 50;
      return null;
    }
    if (rat === 'gsm') {   // GSM 信道栅格为 200 kHz：900 段下行 935.0+0.2n，E-GSM 975–1023 落在 925.2–934.8，DCS 下行 1710+0.2(n-512)
      if (i <= 124) return 935 + i * 0.2;
      if (i >= 975 && i <= 1023) return 935 + (i - 1024) * 0.2;
      if (i >= 512 && i <= 885) return 1710 + (i - 512) * 0.2;
      return null;
    }
    return null;
  }
  function bandToFreq(band, rat) {
    var b = intNum(String(esc(band)).replace(/^[^\d]*/g, ''));
    if (b == null) return null;
    if (rat === 'nr5g' || /^n\d+$/.test(normVal(band))) {
      var nrMap = { 1: 2155, 3: 1850, 5: 880, 8: 945, 28: 773, 41: 2593, 77: 3900, 78: 3500, 79: 4800, 80: 1825, 84: 2100 };
      return nrMap[b] == null ? null : nrMap[b];
    }
    for (var i = 0; i < LTE_BANDS.length; i++) if (LTE_BANDS[i].band === b) return LTE_BANDS[i].f;
    return null;
  }

  /* ============================================================== 3. 运营商 / 基站规范化 */
  function operatorName(mcc, mnc) {
    var k = keyOf(mcc, mnc);
    var o = k ? OP_INDEX[k] : null;
    var a = intNum(mcc), b = intNum(mnc);
    return {
      operator: o ? o.name : '未知运营商',
      country: o ? o.country : '未知地区',
      mcc: o ? o.mcc : (a == null ? null : String(a).padStart(3, '0')),
      mnc: o ? o.mnc : (b == null ? null : padMnc(mnc, b)),
      iso2: o ? o.iso2 : null
    };
  }
  function padMnc(raw, n) {
    var s = esc(raw).replace(/[^0-9]/g, '');
    if (n == null) return null;
    if (!s) return String(n);
    return String(n).padStart(clamp(s.length, 2, 3), '0');
  }

  function pickField(map, canonical) {
    var al = FIELD_ALIAS[canonical] || [canonical];
    for (var i = 0; i < al.length; i++) {
      var k = normKey(al[i]);
      if (map[k] !== undefined && map[k] !== null && esc(map[k]).trim() !== '') return map[k];
    }
    return null;
  }
  function pickNum(map, canonical) {
    var v = pickField(map, canonical);
    if (v == null) return null;
    var n = num(v);
    if (n == null) n = parseHex(v);
    return n;
  }
  function pickStr(map, canonical) {
    var v = pickField(map, canonical);
    return v == null ? null : esc(v).trim();
  }

  function normalizeTower(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var flat = {};   // 键归一化，值保留原样（支持嵌套一层）
    Object.keys(raw).forEach(function (k) {
      var v = raw[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.keys(v).forEach(function (k2) { flat[normKey(k + k2)] = v[k2]; });
        flat[normKey(k)] = v;
      } else flat[normKey(k)] = v;
    });
    var t = {};
    ['mcc', 'mnc', 'lac', 'ci', 'arfcn', 'pci', 'rssi_dbm', 'rsrp_dbm', 'rsrq_dbm', 'sinr_db',
      'tx_power_dbm', 'freq_mhz', 'timing_advance', 'azimuth', 'beamwidth', 'lat', 'lon', 'range_m', 'accuracy_m'].forEach(function (k) { t[k] = null; });
    t.mcc = inRange(pickNum(flat, 'mcc'), 200, 999);
    t.mnc = inRange(pickNum(flat, 'mnc'), 0, 999);
    t.lac = inRange(pickNum(flat, 'lac'), 0, 16777215);
    t.ci = inRange(pickNum(flat, 'ci'), 0, 68719476735);
    t.arfcn = inRange(pickNum(flat, 'arfcn'), 0, 268435455);
    t.pci = inRange(pickNum(flat, 'pci'), 0, 1007);
    t.rssi_dbm = inRange(pickNum(flat, 'rssi_dbm'), -200, 40);
    t.rsrp_dbm = inRange(pickNum(flat, 'rsrp_dbm'), -200, 0);
    t.rsrq_dbm = inRange(pickNum(flat, 'rsrq_dbm'), -60, 40);
    t.sinr_db = inRange(pickNum(flat, 'sinr_db'), -60, 80);
    t.tx_power_dbm = inRange(pickNum(flat, 'tx_power_dbm'), -80, 100);
    t.freq_mhz = inRange(pickNum(flat, 'freq_mhz'), 1, 300000);
    t.timing_advance = inRange(pickNum(flat, 'timing_advance'), 0, 65535);
    t.azimuth = pickNum(flat, 'azimuth') == null ? null : wrap360(pickNum(flat, 'azimuth'));
    t.beamwidth = inRange(pickNum(flat, 'beamwidth'), 1, 360);
    t.lat = inRange(pickNum(flat, 'lat'), -90, 90);
    t.lon = inRange(pickNum(flat, 'lon'), -180, 180);
    t.range_m = inRange(pickNum(flat, 'range_m'), 0.5, 2e7);
    t.accuracy_m = inRange(pickNum(flat, 'accuracy_m'), 0.5, 2e7);

    // cid_hex：显式给出优先，否则由 LAC+CI 组合（28bit 组合式 CID 的常见写法）
    var hex = null;
    CID_HEX_KEYS.forEach(function (k) { var v = pickStr(flat, k); if (!hex && v) hex = parseHex(v); });
    if (isNum(hex) && hex >= 0 && hex <= 4294967295) {
      if (hex > 268435455) {          // >28bit 只能是 16bit LAC + 16bit CI 的老式 32 位写法
        if (t.ci == null) t.ci = hex & 0xFFFF;
        if (t.lac == null) t.lac = Math.floor(hex / 0x10000);
      } else {                        // LTE 28bit 组合式：TAC<<20 | CI
        if (t.ci == null) t.ci = hex & 0xFFFFF;
        if (t.lac == null && hex > 0xFFFFF) t.lac = Math.floor(hex / 0x100000);
      }
    }
    t.cid_hex = isNum(t.ci) ? hexOf(t.lac, t.ci) : (isNum(hex) ? pad(hex, 8) : null);

    t.rat = normalizeRat(pickStr(flat, 'rat'));
    if (t.freq_mhz == null) {
      var bRaw = flat.band || flat.siband || flat.dlband || flat.nrbandid;
      if (bRaw != null) t.freq_mhz = bandToFreq(bRaw, t.rat);
      if (t.freq_mhz == null && t.rat) t.freq_mhz = guessFreqMhz(t.rat, t.arfcn);
      if (t.freq_mhz == null && !t.rat) {   // 未标制式：按 LTE→WCDMA→GSM 依次试频点号区间
        ['lte', 'wcdma', 'gsm'].some(function (rr) { t.freq_mhz = guessFreqMhz(rr, t.arfcn); return t.freq_mhz != null; });
      }
    }
    var op = (t.mcc != null && t.mnc != null) ? operatorName(t.mcc, t.mnc) : null;
    t.network = pickStr(flat, 'network') || (op && op.operator !== '未知运营商' ? op.operator : null);
    t.label = pickStr(flat, 'label') || buildLabel(t);

    var meaningful = ['mcc', 'mnc', 'lac', 'ci', 'arfcn', 'pci', 'rssi_dbm', 'rsrp_dbm', 'freq_mhz', 'lat', 'lon', 'range_m', 'tx_power_dbm', 'sinr_db']
      .some(function (k) { return isNum(t[k]); });
    if (!meaningful && !t.label) return null;
    return t;
  }
  function inRange(v, lo, hi) { return isNum(v) && v >= lo && v <= hi ? v : null; }
  function pad(n, w) { var s = Math.round(n).toString(16).toUpperCase(); while (s.length < w) s = '0' + s; return s; }
  function hexOf(lac, ci) {
    if (!isNum(ci)) return null;
    return (isNum(lac) ? pad(lac, 4) : '') + pad(ci, isNum(lac) ? 4 : 8);
  }
  function buildLabel(t) {
    var p = [];
    if (t.rat && RAT_INFO[t.rat]) p.push(RAT_INFO[t.rat].name);
    if (t.network) p.push(t.network);
    if (t.cid_hex) p.push('CID ' + t.cid_hex);
    else if (isNum(t.ci)) p.push('CI ' + t.ci);
    if (isNum(t.pci)) p.push('PCI ' + t.pci);
    if (isNum(t.rssi_dbm)) p.push(t.rssi_dbm + ' dBm');
    else if (isNum(t.rsrp_dbm)) p.push('RSRP ' + t.rsrp_dbm);
    return p.length ? p.join(' · ') : null;
  }

  /* ============================================================== 4. 杂乱文本解析 */
  var KV_RE = /([A-Za-z_][A-Za-z0-9_.]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g;
  var NESTED_RE = /[A-Za-z][A-Za-z0-9_.]*\s*[:=]/;
  var COORD_RE = /(?:^|[\s([<])([+-]?\d{1,2}\.\d{3,})(?:\s*([NSns]))?[\s,]+([+-]?\d{1,3}\.\d{3,})(?:\s*([EWew]))?/;
  var CID_DASH_RE = /(?:^|[^\d])(\d{3})[-_](\d{2,3})[-_](\d{2,6})[-_](\d{3,10})(?![\d])/;
  var CID_SP_RE = /(?:^|[^\d(])(\d{3})[\s,]+(\d{2,3})[\s,]+(\d{2,6})[\s,]+(\d{3,10})(?![\d])\s*$/;
  var POS_ORDER = ['mcc', 'mnc', 'lac', 'ci', 'arfcn', 'rssi_dbm', 'pci'];
  var FIELD_HINT = (function () {
    var h = Object.create(null);
    Object.keys(FIELD_ALIAS).forEach(function (c) { FIELD_ALIAS[c].forEach(function (a) { h[normKey(a)] = c; }); });
    CID_HEX_KEYS.forEach(function (k) { h[normKey(k)] = 'cid_hex'; });
    return h;
  })();

  function kvMap(line) {
    var m = Object.create(null), queue = [line];
    while (queue.length) {
      var s = queue.shift();
      KV_RE.lastIndex = 0;
      var x;
      while ((x = KV_RE.exec(s))) {
        var v = x[2].replace(/^["']|["']$/g, '');
        if (NESTED_RE.test(v)) queue.push(v);   // 值里又嵌了一层 kv（dumpsys 常见）
        var k = normKey(x[1]);
        if (m[k] === undefined) m[k] = v;
      }
    }
    return m;
  }
  function isEmptyMap(m) { return Object.keys(m).length === 0; }
  function coordPair(line) {
    var m = line.match(COORD_RE);
    if (!m) return null;
    var lat = num(m[1]), lon = num(m[3]);
    if (m[2] && /[sS]/.test(m[2])) lat = -Math.abs(lat);
    if (m[4] && /[wW]/.test(m[4])) lon = -Math.abs(lon);
    if (!isNum(lat) || !isNum(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: lat, lon: lon };
  }
  function compactCid(line) {
    var m = line.match(CID_DASH_RE) || line.match(CID_SP_RE);
    if (!m) return null;
    var a = { mcc: num(m[1]), mnc: num(m[2]), lac: num(m[3]), ci: num(m[4]) };
    if (a.mcc < 200 || a.mcc > 999) return null;
    return a;
  }
  function ratFromLine(line) {
    var m = line.match(/Cell(?:Identity|Info)(Lte|Nr|Wcdma|Gsm|Cdma|TdScdma)/i);
    if (m) return normalizeRat(m[1]);
    if (/\b5G\s*NR\b|NR小区|NR:/i.test(line)) return 'nr5g';
    if (/LTE|EUTRAN/i.test(line)) return 'lte';
    if (/WCDMA|HSDPA|UTRAN|UMTS/i.test(line)) return 'wcdma';
    if (/GSM|GERAN|EDGE/i.test(line)) return 'gsm';
    if (/CDMA|IS95|1XRTT/i.test(line)) return 'cdma';
    return null;
  }
  var NOISE_RE = /^(mServiceState|mCallState|mDataState|mVoiceRegState|mDataRegState|mReadyChannel|mPrecise|mAllDc|mDefaultDc|mNetworkForeground|mNotifiers|mLastDataConnectionState|mCellInfoHeartbeat|mUuConfig|mCellSignalStrengths|mCellLocation|mLastObservedCellInfo|lastKnownCellInfo|mNetworkRegistrationInfo|mAllCellInfo|mCellInfoSnapshot|mDefaultStorageIds|mModemCapacities|mSupportedModem|mSlotId|mPhoneId|mUiccSlot|mIsWorldPhone|mHomePLMNSearch|mEmergency|mAllowedNetworkTypes|mConfig|Telephony Registry|SubscriptionController|UiccController|CarrierFactory|DcNetworkAgent|Dump of|DUMPSYS|RIL\s*(REQUEST|Response)|RIL[0-9]|SST\s*:|DAR\s*:|SML\s*:|UICC\s*:|^\s*})/i;
  function isNoise(line) { return NOISE_RE.test(line); }
  function isRow(line) {
    if (/[:=]/.test(line)) return false;
    var cells = line.split(/[\t,]/);
    return cells.length >= 3 && cells.some(function (c) { return /\S/.test(c); });
  }
  /* 分隔符不能写成 /[\t,]+/：连续两个逗号之间的空单元格会被吞掉，后面的列整排左移，
     于是 lat 列被当成 pci、lon 列被丢掉——一份「rsrp 留空」的正常 CSV 就这样全站失去坐标。 */
  function parseRow(line, state) {
    var cells = line.split(/[\t,]/).map(function (c) { return c.trim(); });
    var looksHeader = cells.filter(function (c) { return FIELD_HINT[normKey(c)]; }).length >= 2 &&
      cells.every(function (c) { return !c || /^[A-Za-z ._()\/-]+$/.test(c); });
    if (looksHeader) {
      state.cols = cells.map(function (c) { return FIELD_HINT[normKey(c)] || null; });
      return { header: true };
    }
    var m = Object.create(null), useCols = state.cols || POS_ORDER.map(function (k, i) { return i < cells.length ? k : null; });
    cells.forEach(function (c, i) {
      var k = useCols[i];
      if (!k || c === '' || c == null) return;
      var n = num(c);
      if (n == null) n = parseHex(c);
      if (n != null || k === 'label' || k === 'network' || k === 'rat') m[k] = n == null ? c : n;
    });
    return { map: m };
  }
  function levelToRssi(v) {
    // Android 信号格 0..4 → 该档 dBm 中值，仅当原始值像是"等级"而非 dBm 时使用
    return Math.round(-112 + (v + 0.5) * 9);
  }
  function towerFromLine(line, state) {
    var map = null;
    if (state.csvMode && isRow(line)) {
      var r = parseRow(line, state);
      if (r.header) return { header: true };
      map = r.map;
    } else if (isRow(line) && !map) {
      var r2 = parseRow(line, state);
      // parseRow 认出头时已把列映射写进 state.cols；这里不能再拿 r2.cols（未返回，恒为
      // undefined）去覆盖它——否则表头被识别却立刻被清空，后续数据行退回 POS_ORDER 位置序，
      // 于是 CSV 里 lat/lon 两列被当成 rssi/pci，整表错位。
      if (r2.header) { state.csvMode = true; return { header: true }; }
      map = r2.map;
    }
    if (!map || isEmptyMap(map)) map = kvMap(line);
    if (!map.rat && !map.network) { var rh = ratFromLine(line); if (rh) map.rat = rh; }
    var co = coordPair(line);
    if (co) { if (map.lat == null) map.lat = co.lat; if (map.lon == null) map.lon = co.lon; }
    if (map.network != null && typeof map.network === 'string') {
      var rr = normalizeRat(map.network);
      if (rr && map.rat == null) map.rat = rr;
    }
    // 0..4 的信号格不是 dBm：转换后再交给 normalizeTower
    ['rssi_dbm'].forEach(function (k) {
      var raw = num(map[k]);
      if (raw != null && raw > -25 && raw <= 5 && /signalstrength|level|mss/i.test(Object.keys(map).join(''))) map[k] = levelToRssi(raw);
    });
    if (isEmptyMap(map)) { var cc = compactCid(line); if (cc) map = cc; }
    else if (map.mcc == null) {
      var cc2 = compactCid(line);
      if (cc2) { map.mcc = cc2.mcc; map.mnc = cc2.mnc; map.lac = cc2.lac; map.ci = cc2.ci; }
    }
    return { map: map };
  }

  /* ---- JSON 输入：运营商城管/抓取工具常直接给 {"towers":[...]} 或 [...]{...}。
   * 逐行解析对 JSON 无意义（一行一个 kv，坐标会被坐标正则误吃），所以先整体试 JSON.parse。 */
  var JSON_ARRAY_KEYS = ['towers', 'cells', 'objects', 'cellinfo', 'list', 'data', 'results', 'items', 'measurements', 'neighbors', 'scans'];

  function jsonScalarDefaults(root) {
    var d = {};
    Object.keys(root).forEach(function (k) {
      var v = root[k];
      if (v === null || typeof v === 'object') return;
      var c = FIELD_HINT[normKey(k)];
      if (!c) return;                 // 只继承能映射到已知字段的标量（rat/operator/mcc…）
      // 顶层的 label/name/note/description 是给人看的整段说明，不是某台基站的身份证。
      // 继承下去会让每台基站顶着一句注释当名字，清单里全是重复长句（单站的 label 仍照常生效）。
      if (c === 'label') return;
      d[k] = v;
    });
    return d;
  }

  function jsonTowerArray(root) {
    if (Array.isArray(root)) return root;
    if (!root || typeof root !== 'object') return null;
    var keys = Object.keys(root);
    // 具名数组优先（towers/cells/…），其次任意「元素是对象」的数组
    for (var i = 0; i < keys.length; i++) {
      var v = root[keys[i]];
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && JSON_ARRAY_KEYS.indexOf(normKey(keys[i])) >= 0) return v;
    }
    for (var j = 0; j < keys.length; j++) {
      var w = root[keys[j]];
      if (Array.isArray(w) && w.length && w[0] && typeof w[0] === 'object') return w;
    }
    // {"cellA":{...},"cellB":{...}} 字典形式；否则把对象自己当一个基站
    var objs = keys.map(function (k) { return root[k]; }).filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x); });
    var towerish = ['mcc', 'mnc', 'lac', 'tac', 'ci', 'cid', 'rssi', 'rsrp', 'pci', 'arfcn', 'lat', 'latitude'];
    if (objs.length >= 2 && objs.every(function (o) { return Object.keys(o).some(function (k) { return towerish.indexOf(normKey(k)) >= 0; }); })) return objs;
    return [root];
  }

  function jsonTowers(text) {
    var t = esc(text).trim();
    if (!/^[{[]/.test(t)) return null;
    var root;
    try { root = JSON.parse(t); } catch (e) { return null; }
    var arr = jsonTowerArray(root);
    if (!arr) return [];
    var def = jsonScalarDefaults(root && !Array.isArray(root) ? root : {});
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (typeof item === 'string') {
        var r = towerFromLine(item, { csvMode: false, cols: null });
        if (r.map) { var tt = normalizeTower(Object.assign({}, def, r.map)); if (tt) out.push(tt); }
        continue;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      var merged = Object.assign({}, def, item);
      // 嵌套一层（如 {"lte":{"mcc":460,...}}）已由 normalizeTower 展平，这里只需处理数组套数组
      var nest = Object.keys(item).filter(function (k) { return Array.isArray(item[k]) && item[k].length && typeof item[k][0] === 'object'; });
      if (nest.length) {
        nest.forEach(function (k) {
          item[k].forEach(function (sub) {
            var s = normalizeTower(Object.assign({}, def, merged, sub));
            if (s) out.push(s);
          });
        });
        continue;
      }
      var one = normalizeTower(merged);
      if (!one) {
        // 再降一层：{"lte":{...}} 这类按制式分组的对象，拿子对象直接喂字段表
        Object.keys(item).forEach(function (k) {
          var sub = item[k];
          if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
          var s = normalizeTower(Object.assign({}, def, sub));
          if (s) out.push(s);
        });
      } else out.push(one);
    }
    return out;
  }

  function parseInput(text) {
    var res = { towers: [], warnings: [], summary: { count: 0, with_position: 0, with_rssi: 0, with_cid: 0 } };
    var unparsed = 0, noise = 0;
    var jt = jsonTowers(text);
    if (jt === null) {
      var lines = esc(text).replace(/\r\n?/g, '\n').split('\n');
      var state = { csvMode: false, cols: null };
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        if (/^(#|\/\/|;|\*|--)/.test(line)) continue;
        if (isNoise(line)) { noise++; continue; }
        var r = towerFromLine(line, state);
        if (r.header) continue;
        var t = normalizeTower(r.map);
        if (t) res.towers.push(t);
        else { unparsed++; }
      }
    } else if (jt.length) {
      res.towers = jt;
      res.summary.json = true;
    } else {
      res.warnings.push('看起来是 JSON，但解析后没有识别出任何基站字段');
    }
    res.towers.forEach(function (t) {
      res.summary.count++;
      if (isNum(t.lat) && isNum(t.lon)) res.summary.with_position++;
      if (isNum(t.rssi_dbm) || isNum(t.rsrp_dbm)) res.summary.with_rssi++;
      if (isNum(t.ci) || t.cid_hex) res.summary.with_cid++;
    });
    if (unparsed > 0) res.warnings.push('有 ' + unparsed + ' 行无法识别为基站信息，已跳过');
    if (noise > 0) res.warnings.push('已忽略 ' + noise + ' 行 dumpsys 状态噪声');
    if (res.summary.count === 0) res.warnings.push('未解析到任何基站，请检查格式（支持 MCC/MNC/LAC/CID、460-00-20515-41177、CSV、JSON、dumpsys）');
    if (res.summary.with_position === 0 && res.summary.count > 0) res.warnings.push('全部基站均无经纬度，只能做距离/覆盖绘制，无法三角定位');
    var noRssi = res.towers.filter(function (t) { return !isNum(t.rssi_dbm) && !isNum(t.rsrp_dbm) && !isNum(t.range_m) && !isNum(t.timing_advance); }).length;
    if (noRssi > 0) res.warnings.push(noRssi + ' 个基站缺少信号强度或距离，定位时将按覆盖半径缺省值处理');
    return res;
  }

  /* ============================================================== 5. 路径损耗模型 */
  // 各模型的距离有效域（米）；超出即截断并标记，因为经验公式在域外会给出物理不可能的值
  var MODEL_RANGE = {
    fspl: [1, 100000], okumura: [1000, 20000], cost231: [1000, 20000],
    '3gpp_38901_urban': [10, 5000], '3gpp_38901_rural': [10, 20000],
    log_normal: [1, 100000], custom: [1, 100000]
  };
  function normOpts(o) {
    o = o || {};
    var env = ENV[o.environment] ? o.environment : (MODELS[o.model] ? 'urban' : 'urban');
    return {
      model: MODELS[o.model] ? o.model : 'fspl',
      freq_mhz: clamp(safe(num(o.freq_mhz), 1800), 5, 100000),
      tx: safe(num(o.tx_power_dbm), 43),
      gain: safe(num(o.antenna_gain_db), 0),
      hb: clamp(safe(num(o.bs_antenna_height_m), 32), 10, 200),
      hm: clamp(safe(num(o.ms_antenna_height_m), 1.5), 1, 10),
      city: o.city === 'large' ? 'large' : 'small',
      exponent: clamp(safe(num(o.exponent), ENV[env].n), 1.2, 7),
      sigma_db: clamp(safe(num(o.shadow_sigma_db), ENV[env].sigma), 0, 20),
      pl0: num(o.path_loss_at_1m_db),
      ref_rssi: num(o.reference_rssi_dbm_at_1m),
      d0: clamp(safe(num(o.reference_distance_m), 1), 0.1, 1000),
      env: env
    };
  }
  function fsplDb(d_m, f_mhz) { return FSPL_K + 20 * lg(d_m / 1000) + 20 * lg(f_mhz); }
  // Hata 移动台高度增益 a(hm)：中小城市为线性式；大城市按 f 是否 >=400 MHz 取两种二次式
  function hataAhm(f, hm, city) {
    if (city !== 'large') return (1.1 * lg(f) - 0.7) * hm - (1.56 * lg(f) - 0.8);
    return f >= 400 ? 3.2 * Math.pow(lg(11.75 * hm), 2) - 4.97 : 8.85 * Math.pow(lg(1.28 * hm), 2) - 5.4;
  }
  function pathLossDb(model, d_m, o) {
    var f = o.freq_mhz, lgf = lg(f), lgd = lg(d_m / 1000), a = hataAhm(f, o.hm, o.city), pl;
    if (model === 'fspl') return fsplDb(d_m, f);
    if (model === 'okumura') {
      pl = 69.55 + 26.16 * lgf - 13.82 * lg(o.hb) + (44.9 - 6.55 * lg(o.hb)) * lgd + a;
      if (o.env === 'suburban') { var t = lg(f / 28); pl -= 2 * t * t + 5.62; }
      else if (o.env === 'rural') pl -= 4.78 * lgf * lgf - 18.34 * lgf + 40.05;
      return pl;
    }
    if (model === 'cost231') {
      return 46.3 + 33.9 * lgf - 13.82 * lg(o.hb) + (44.9 - 6.55 * lg(o.hb)) * lgd + a
        - (o.city === 'large' ? 3.2 * Math.pow(lg(11.75 * o.hm), 2) - 3 : 0);
    }
    var fg = f / 1000, lgm = lg(d_m);
    if (model === '3gpp_38901_rural') return 28.0 + 22 * lgm + 20 * lg(fg);          // RMa/UMa LOS 简化式
    if (model === '3gpp_38901_urban') {
      if (o.env === 'indoor' || o.env === 'dense_urban') return 35.3 + 22.4 * lgm + 19 * lg(fg) + 8;  // UMi NLOS
      return 32.4 + 21.4 * lgm + 19 * lg(fg);                                        // UMi LOS
    }
    var pl0 = o.pl0;
    if (pl0 == null && o.ref_rssi != null) pl0 = o.tx + o.gain - o.ref_rssi;
    if (pl0 == null) pl0 = fsplDb(o.d0, f);
    return pl0 + 10 * o.exponent * lg(d_m / o.d0) + (model === 'log_normal' ? ENV[o.env].extra_db : 0);
  }
  function effExp(model, d, o) {
    var s = (pathLossDb(model, d * 1.05, o) - pathLossDb(model, d / 1.05, o)) / (10 * (lg(d * 1.05) - lg(d / 1.05)));
    return clamp(isNum(s) ? s : o.exponent, 0.5, 12);
  }
  function modelFreqOk(model, f) {
    var rg = MODELS[model] ? MODELS[model].freq_range_mhz : [1, 100000];
    return isNum(f) && f >= rg[0] && f <= rg[1];
  }
  function modelSpan(model) {
    var rg = MODEL_RANGE[model] || [1, 100000];
    var lo = clamp(rg[0], 1, 100000), hi = clamp(rg[1], lo + 1, 100000);
    return [lo, hi];
  }

  function rssiToDistance(rssi_dbm, opts) {
    var o = normOpts(opts), r = num(rssi_dbm), sp = modelSpan(o.model), lo = sp[0], hi = sp[1];
    var out = {
      dist_m: null, sigma_m: null, model: o.model, path_loss_db: null, clamped: false, clamped_reason: null,
      freq_mhz: o.freq_mhz, environment: o.env, exponent: null, eirp_dbm: o.tx + o.gain, rssi_dbm: r
    };
    if (r == null) { out.clamped = true; out.clamped_reason = '缺少有效的 RSSI/RSRP'; return out; }
    if (!modelFreqOk(o.model, o.freq_mhz)) {
      out.clamped = true;
      out.clamped_reason = '频率 ' + o.freq_mhz + ' MHz 超出 ' + o.model + ' 经验域，结果按域内趋势外推';
    }
    var want = o.tx + o.gain - r, d;
    if (want <= pathLossDb(o.model, lo, o)) {
      d = lo; out.clamped = true;
      out.clamped_reason = '信号过强，距离小于模型有效下限 ' + lo + ' m，已截断';
    } else if (want >= pathLossDb(o.model, hi, o)) {
      d = hi; out.clamped = true;
      out.clamped_reason = '信号过弱，距离大于模型有效上限 ' + hi + ' m，已截断';
    } else {
      var a1 = lg(lo), b1 = lg(hi), mid;
      for (var i = 0; i < 90 && b1 - a1 > 1e-10; i++) {
        mid = (a1 + b1) / 2;
        if (pathLossDb(o.model, Math.pow(10, mid), o) < want) a1 = mid; else b1 = mid;
      }
      d = Math.pow(10, (a1 + b1) / 2);
    }
    out.dist_m = clamp(d, 1, 100000);
    out.path_loss_db = pathLossDb(o.model, out.dist_m, o);
    out.exponent = effExp(o.model, out.dist_m, o);
    // 阴影衰落 σ[dB] 折算成距离 σ：PL=A+10n·lg d ⇒ σ_d = ln10/10 · σ_db · d / n
    out.sigma_m = Math.max(1, LN10 / 10 * out.dist_m * o.sigma_db / out.exponent);
    return out;
  }

  function distanceToRssi(dist_m, opts) {
    var o = normOpts(opts), d = num(dist_m), sp = modelSpan(o.model), clamped = false, reason = null;
    if (d == null) { d = 100; clamped = true; reason = '缺少距离，按 100 m 计算'; }
    if (d < sp[0]) { clamped = true; reason = rnd(d, 0) + ' m 低于 ' + o.model + ' 有效下限，已按 ' + sp[0] + ' m 计算'; d = sp[0]; }
    else if (d > sp[1]) { clamped = true; reason = rnd(d, 0) + ' m 高于 ' + o.model + ' 有效上限，已按 ' + sp[1] + ' m 计算'; d = sp[1]; }
    if (!modelFreqOk(o.model, o.freq_mhz)) { clamped = true; reason = (reason ? reason + '；' : '') + '频率超出模型经验域'; }
    var pl = pathLossDb(o.model, d, o);
    return {
      rssi_dbm: o.tx + o.gain - pl, model: o.model, path_loss_db: pl, clamped: clamped, clamped_reason: reason,
      dist_m: d, freq_mhz: o.freq_mhz, environment: o.env, eirp_dbm: o.tx + o.gain
    };
  }

  /* ============================================================== 6. 覆盖扇区 */
  function sectorPolygon(tower, opts) {
    opts = opts || {};
    var t = tower && typeof tower === 'object' ? tower : {}, res = { points: [], area_km2: 0, note: '' };
    if (!isNum(t.lat) || !isNum(t.lon)) { res.note = '缺少基站经纬度，无法生成覆盖扇区'; return res; }
    var dflt = (RAT_INFO[t.rat] || {}).typical_range_m || 1500;
    var rMax = clamp(safe(num(opts.max_range_m), safe(num(t.range_m), dflt)), 1, 1e7);
    var rMin = clamp(safe(num(opts.floor_range_m), 0), 0, rMax * 0.999);
    var bw = clamp(safe(num(t.beamwidth, safe(num(opts.beamwidth), 360)), 360), 1, 360);
    var az = num(t.azimuth) != null ? num(t.azimuth) : num(opts.azimuth);
    var segs = Math.max(4, Math.round(safe(num(opts.segments, num(opts.rings)), 24)));
    var omni = az == null || bw >= 359.9, a0 = omni ? 0 : wrap360(az) - bw / 2, sweep = omni ? 360 : bw;
    var pts = [], i, p1, p2, ref = { lat: t.lat, lon: t.lon }, ar = 0;
    if (!omni && rMin <= 0) pts.push({ lat: t.lat, lon: t.lon });
    for (i = 0; i <= segs; i++) pts.push(destinationPoint(t.lat, t.lon, wrap360(a0 + sweep * i / segs), rMax));
    if (rMin > 0) for (i = segs; i >= 0; i--) pts.push(destinationPoint(t.lat, t.lon, wrap360(a0 + sweep * i / segs), rMin));
    for (i = 0; i < pts.length; i++) {   // 鞋带公式在局部切平面求面积，与 0.5·r²·θ 的偏差来自圆弧弦化，<1%
      p1 = toPlane(ref, pts[i].lat, pts[i].lon);
      p2 = toPlane(ref, pts[(i + 1) % pts.length].lat, pts[(i + 1) % pts.length].lon);
      ar += p1.x * p2.y - p2.x * p1.y;
    }
    res.points = pts;
    res.area_km2 = Math.abs(ar) / 2 / 1e6;
    res.note = (omni ? '全向圆覆盖（无方位角）' : '扇区覆盖 方位 ' + rnd(wrap360(az), 1) + '° / 波束 ' + rnd(bw, 0) + '°')
      + '，半径 ' + rnd(rMax, 0) + ' m' + (rMin > 0 ? '，内圈 ' + rnd(rMin, 0) + ' m' : '') + '，圆弧 ' + segs + ' 段';
    return res;
  }

  /* ============================================================== 7. 最小二乘核心 */
  function mkResult(method) {
    return {
      ok: false, method: method, lat: null, lon: null, estimated_from: [], ranges_m: [], iterations: 0,
      n_used: 0, n_rejected: 0, residual_rmse_m: null, max_residual_m: null, confidence_radius_m: null,
      ellipsis: { semi_major_m: null, semi_minor_m: null, orientation_deg: null },
      covariance_m2: [[null, null], [null, null]], gdop: null, warnings: [], candidates: []
    };
  }
  function quantile(arr, q) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    var pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function median(arr) { return quantile(arr, 0.5); }
  // 稳健判据：|z| 的 Tukey 围栏与 3.5σ 取较松者，避免单点粗差把 IQR 撑爆
  function outlierMask(res, sig) {
    var az = res.map(function (v, i) { return Math.abs(v) / Math.max(1, sig[i]); });
    var q1 = quantile(az, 0.25), q3 = quantile(az, 0.75);
    var lim = Math.max(3.5, q3 + 1.5 * (q3 - q1));
    var hit = az.filter(function (v) { return v > lim; }).length;
    if (!hit || hit >= res.length) return null;
    return az.map(function (v) { return v <= lim; });
  }
  function fillError(res, cov, priorSigma) {
    var s = Math.max(1, safe(priorSigma, 100));
    if (!cov) {   // 秩亏：共线基站/观测不足，退化为按先验 σ 的圆近似
      res.covariance_m2 = [[rnd(s * s, 1), 0], [0, rnd(s * s, 1)]];
      res.ellipsis = { semi_major_m: rnd(s, 1), semi_minor_m: rnd(s, 1), orientation_deg: null };
      res.confidence_radius_m = rnd(2 * s, 1);
      res.warnings.push('几何构型退化，协方差不可解，按先验 σ 给出圆近似不确定度');
      return;
    }
    res.covariance_m2 = [[rnd(cov[0][0], 1), rnd(cov[0][1], 1)], [rnd(cov[1][0], 1), rnd(cov[1][1], 1)]];
    var e = eig2(cov), mj = Math.sqrt(Math.max(0, e.l1)), mn = Math.sqrt(Math.max(0, e.l2));
    res.ellipsis = { semi_major_m: rnd(mj, 1), semi_minor_m: rnd(mn, 1), orientation_deg: rnd(wrap360(90 - toDeg(e.theta)), 1) };
    // 置信半径 = √λ1 + √λ2：1σ 误差椭圆两半轴之和，作为保守圆形包络
    res.confidence_radius_m = rnd(mj + mn, 1);
  }
  function fitStats(res, rr, sig) {
    var s = 0, mx = 0;
    rr.forEach(function (v) { s += v * v; mx = Math.max(mx, Math.abs(v)); });
    res.residual_rmse_m = rnd(Math.sqrt(s / Math.max(1, rr.length)), 1);
    res.max_residual_m = rnd(mx, 1);
    if (mx > Math.max(1, median(sig)) * 4) res.warnings.push('存在大残差（最大 ' + rnd(mx, 0) + ' m），距离估计可能受非视距影响');
  }
  /* 残差远大于估距自带的 σ，说明「估出来的距离」和「站址」彼此不自洽：
     最小二乘照样会吐一个坐标（置信半径可能几千公里），但那不是位置，必须说破。 */
  function consistencyWarning(res, set) {
    var s = median(set.map(function (m) { return m.sigma; }));
    if (!isNum(res.residual_rmse_m) || res.residual_rmse_m <= Math.max(1, s) * 3) return;
    res.warnings.push('残差 RMS ' + rnd(res.residual_rmse_m, 0) + ' m 远大于单站估距不确定度 σ≈' + rnd(s, 0) +
      ' m：估距与站址不自洽，解出的位置不可用。请核对基站经纬度，或按信号强度/覆盖半径另做估计。');
  }
  function baseWeights(L, mode) {
    if (mode === 'uniform') return L.map(function () { return 1; });
    if (mode === 'range') {
      var mx = Math.max.apply(null, L.map(function (m) { return m.r; }));
      return L.map(function (m) { return clamp(mx / Math.max(1, m.r), 0.02, 50); });
    }
    if (mode === 'rssi') {
      var vals = L.map(function (m) { return safe(m.t.rsrp_dbm, safe(m.t.rssi_dbm, -110)); });
      var top = Math.max.apply(null, vals);
      return L.map(function (m, i) { return clamp(Math.pow(10, (vals[i] - top) / 10), 0.02, 1); });
    }
    return L.map(function (m) { return 1 / (m.sigma * m.sigma); });   // auto：σ^-2 信息矩阵权重
  }
  // 高斯-牛顿（局部切平面 2 参数），rf(p)->{r:[],J:[[dx,dy],…]}，残差=模型-观测，步长阻尼 3 km
  function gaussNewton(rf, p0, wOf, maxIter) {
    var p = [p0[0], p0[1]], iter = 0, degen = false, i, u, v;
    for (i = 0; i < maxIter; i++) {
      iter = i + 1;
      var o = rf(p), r = o.r, J = o.J, w = wOf(r, p);
      if (!r.length) break;
      var A = [[0, 0], [0, 0]], b = [0, 0];
      for (var a = 0; a < r.length; a++) {
        for (u = 0; u < 2; u++) {
          b[u] += w[a] * J[a][u] * r[a];
          for (v = 0; v < 2; v++) A[u][v] += w[a] * J[a][u] * J[a][v];
        }
      }
      var inv = inv2(A);
      if (!inv) { degen = true; break; }
      var dx = inv[0][0] * b[0] + inv[0][1] * b[1], dy = inv[1][0] * b[0] + inv[1][1] * b[1];
      var mag = Math.sqrt(dx * dx + dy * dy);
      if (mag > 3000) { dx *= 3000 / mag; dy *= 3000 / mag; }
      p[0] -= dx; p[1] -= dy;
      if (!isNum(p[0]) || !isNum(p[1])) { degen = true; break; }
      if (mag < 0.005) break;
    }
    var fin = rf(p), fr = fin.r, fw = wOf(fr, p), A2 = [[0, 0], [0, 0]], s2 = 0;
    for (i = 0; i < fr.length; i++) {
      s2 += fw[i] * fr[i] * fr[i];
      for (u = 0; u < 2; u++) for (v = 0; v < 2; v++) A2[u][v] += fw[i] * fin.J[i][u] * fin.J[i][v];
    }
    // s2 = Σ w·r² 无量纲（w=1/σ²），期望值≈自由度；故 scale 也是无量纲的 χ²/dof，兜底同样取无量纲值
    var scale = s2 / Math.max(1, fr.length - 2);
    if (scale < 0.25) scale = 0.25;   // 零残差的合成数据不应报出 0 不确定度，按先验 1/4 保守兜底
    var iv = inv2(A2);
    var cov = iv ? [[iv[0][0] * scale, iv[0][1] * scale], [iv[1][0] * scale, iv[1][1] * scale]] : null;
    return { p: p, iterations: iter, cov: cov, residuals: fr, degenerate: degen || !iv };
  }
  // 定时提前量的一步 = 该制式的「一个时间单位对应的单程距离」，由标准里的基本时间单位直接导出：
  //   GSM   1 bit   = 1/270.833 kHz    → c/2 × 3.6923 µs = 554.69 m（TA 0…31 ⇒ 0…17.2 km，与 GSM 最大小区半径一致）
  //   LTE/NR 1 TA   = 16·Ts，Ts = 1/(15 kHz × 2048) → c/2 × 0.5208 µs = 78.17 m
  //   WCDMA 1 chip  = 1/3.84 Mcps      → c/2 × 0.2604 µs = 39.06 m
  // 一律按 LTE 步长处理会把 2G 的距离算小 7 倍，所以必须按制式分支。
  var TA_STEP_M = { gsm: 554.69, cdma: 554.69, lte: 78.17, nr5g: 78.17, wcdma: 39.06 };
  var TA_STEP_UNIT = { gsm: '1 bit（3.6923 µs）', cdma: '1 bit（按 GSM 量级，CDMA 实际用 PN 码片偏置）', lte: '1 TA=16Ts（0.5208 µs）', nr5g: '1 TA=16Ts（0.5208 µs）', wcdma: '1 chip（0.2604 µs）' };
  function taStepM(rat) { return TA_STEP_M[rat] != null ? TA_STEP_M[rat] : 78.17; }
  function taStepNote(rat) {
    return TA_STEP_UNIT[rat] != null ? TA_STEP_UNIT[rat] : '制式未识别，按 LTE 步长 78.17 m 假定';
  }

  function rangeOfTower(t, mo) {
    if (isNum(t.range_m)) return { r: clamp(t.range_m, 1, 1e6), sigma: Math.max(1, safe(t.accuracy_m, t.range_m * 0.3)), note: '给定距离 ' + rnd(t.range_m, 0) + ' m' };
    if (isNum(t.timing_advance)) {
      var r = t.timing_advance * taStepM(t.rat);
      return { r: r, sigma: Math.max(10, safe(t.accuracy_m, r * 0.05 + 30)), note: 'TA=' + t.timing_advance + '（' + taStepNote(t.rat) + '）→ ' + rnd(r, 0) + ' m' };
    }
    var pref = (t.rat === 'lte' || t.rat === 'nr5g') && isNum(t.rsrp_dbm);
    var sig = pref ? t.rsrp_dbm : safe(t.rssi_dbm, t.rsrp_dbm);
    if (!isNum(sig)) return null;
    var d = rssiToDistance(sig, {
      model: mo.model, freq_mhz: safe(t.freq_mhz, mo.freq_mhz), tx_power_dbm: safe(t.tx_power_dbm, mo.tx_power_dbm),
      environment: mo.environment, exponent: mo.exponent, shadow_sigma_db: mo.shadow_sigma_db,
      reference_rssi_dbm_at_1m: mo.reference_rssi_dbm_at_1m
    });
    if (!isNum(d.dist_m)) return null;
    return {
      r: clamp(d.dist_m, 1, 1e6), sigma: Math.max(1, safe(t.accuracy_m, d.sigma_m)),
      note: d.model + ' ' + sig + ' dBm → ' + rnd(d.dist_m, 0) + ' m' + (d.clamped ? '（' + d.clamped_reason + '）' : '')
    };
  }
  function prepTowers(towers, opts, res) {
    var mo = {
      model: MODELS[opts.model] ? opts.model : 'fspl', environment: opts.environment, freq_mhz: opts.freq_mhz,
      tx_power_dbm: opts.tx_power_dbm, exponent: opts.exponent, shadow_sigma_db: opts.shadow_sigma_db,
      reference_rssi_dbm_at_1m: opts.reference_rssi_dbm_at_1m
    };
    var arr = Array.isArray(towers) ? towers : (towers && towers.towers ? towers.towers : []), L = [];
    arr.forEach(function (raw) {
      var t = normalizeTower(raw);
      if (!t) return;
      if (!isNum(t.lat) || !isNum(t.lon)) { res.warnings.push((t.label || '基站') + ' 缺少经纬度，无法参与定位'); return; }
      var rg = rangeOfTower(t, mo);
      if (!rg) { res.warnings.push((t.label || '基站') + ' 无信号强度/距离，已排除'); return; }
      L.push({ t: t, r: rg.r, sigma: isNum(opts.sigma_m) ? Math.max(1, opts.sigma_m) : rg.sigma, note: rg.note });
    });
    return L;
  }

  /* ============================================================== 8. 距离三角定位 */
  function trilaterate(towers, opts) {
    opts = opts || {};
    var res = mkResult('none');
    var L = prepTowers(towers, opts, res);
    res.n_used = L.length;
    if (!L.length) { res.warnings.push('没有可用于定位的基站（需同时具备经纬度与距离或信号强度）'); return res; }
    var ref = centroid(L.map(function (m) { return m.t; }));
    L.forEach(function (m) { m.p = toPlane(ref, m.t.lat, m.t.lon); m.sig = m.sigma; });
    L.forEach(function (m) { res.ranges_m.push(rnd(m.r, 1)); res.estimated_from.push((m.t.label || '基站') + '：' + m.note); });
    var huber = opts.huber !== false, mode = opts.weights || 'auto';
    var bw = baseWeights(L, mode);
    var wOf = function (r) {
      if (!huber) return bw;
      return bw.map(function (w, i) { var z = Math.abs(r[i]) / Math.max(1, L[i].sigma); return w * Math.min(1, 1.345 / Math.max(z, 1e-9)); });
    };
    var rf = function (set) {
      return function (p) {
        var r = [], J = [];
        set.forEach(function (m) {
          var dx = p[0] - m.p.x, dy = p[1] - m.p.y, d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          r.push(d - m.r); J.push([dx / d, dy / d]);
        });
        return { r: r, J: J };
      };
    };
    var maxIt = Math.max(3, Math.round(safe(num(opts.max_iterations), 40)));
    var init = function (set) {
      var i = opts.init === 'first' ? 0 : opts.init === 'last' ? set.length - 1 : null;
      if (i != null) return [set[i].p.x, set[i].p.y];
      var sx = 0, sy = 0, sw = 0;
      set.forEach(function (m, k) { sx += m.p.x * bw[k]; sy += m.p.y * bw[k]; sw += bw[k]; });
      return sw > 0 ? [sx / sw, sy / sw] : [0, 0];
    };

    if (L.length === 1) {
      res.method = 'single-tower'; res.ok = true;
      res.lat = L[0].t.lat; res.lon = L[0].t.lon;
      fillError(res, null, L[0].sigma);
      res.confidence_radius_m = rnd(Math.max(L[0].r, L[0].sigma), 1);
      res.candidates = [{ lat: L[0].t.lat, lon: L[0].t.lon, weight: 1 }];
      res.warnings.push('仅 1 个基站：位置退化为基站坐标，不确定度取覆盖半径');
      return res;
    }
    if (L.length === 2) {
      res.method = 'two-tower-ambiguity';
      var a = L[0], c = L[1], ddx = c.p.x - a.p.x, ddy = c.p.y - a.p.y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
      var pts = null;
      if (dd > 1e-6) {
        var tt = (a.r * a.r - c.r * c.r + dd * dd) / (2 * dd), h2 = a.r * a.r - tt * tt;
        var xm = a.p.x + ddx * tt / dd, ym = a.p.y + ddy * tt / dd;
        if (h2 >= 0) {
          var h = Math.sqrt(h2), ox = -ddy / dd * h, oy = ddx / dd * h;
          pts = [{ x: xm + ox, y: ym + oy }, { x: xm - ox, y: ym - oy }];
        } else pts = [{ x: xm, y: ym }];   // 两圆不相交：取根轴与基站连线的最近点
      }
      if (!pts) { res.method = 'weighted-centroid'; res.warnings.push('两基站距离无法构成交点，退化为加权质心'); }
      else {
        var cand = pts.map(function (q) {
          var rr = rf(L)(q), sc = 0;
          rr.r.forEach(function (v, i) { sc += (v * v) / (L[i].sigma * L[i].sigma); });
          return { x: q.x, y: q.y, chi: sc, w: 1 / (1 + sc) };
        });
        var tw = cand.reduce(function (s, k) { return s + k.w; }, 0);
        res.candidates = cand.map(function (k) {
          var ll = toLatLon(ref, k.x, k.y);
          return { lat: ll.lat, lon: ll.lon, weight: rnd(k.w / tw, 4) };
        });
        var best = cand.slice().sort(function (p, q) { return p.chi - q.chi; })[0];
        var llb = toLatLon(ref, best.x, best.y);
        res.lat = llb.lat; res.lon = llb.lon; res.ok = true;
        var fit = gaussNewton(rf(L), [best.x, best.y], wOf, maxIt);   // 两圆交点已定，仅用其算协方差
        var rankLoss = !isNum(fit.p[0]) || Math.abs(fit.p[0] - best.x) > 5e5;
        fillError(res, rankLoss ? null : fit.cov, median(L.map(function (m) { return m.sigma; })));
        res.iterations = fit.iterations;
        var rr2 = rf(L)([best.x, best.y]).r;
        fitStats(res, rr2, L.map(function (m) { return m.sigma; }));
        if (pts.length === 2) res.warnings.push('两塔距离存在前后两个交点，已按卡方选优；权重见 candidates');
        else res.warnings.push('两塔距离圆不相交（可能测距偏小或基站位置不准），交点按根轴外推');
        res.gdop = rnd(gdopFromGeometry(L.map(function (m) { return { lat: m.t.lat, lon: m.t.lon }; }), { lat: res.lat, lon: res.lon }, { clock: false }).gdop, 2);
        return res;
      }
    }
    if (res.method === 'weighted-centroid' || L.length === 2) {
      var sx2 = 0, sy2 = 0, sw2 = 0;
      L.forEach(function (m, k) { sx2 += m.p.x * bw[k]; sy2 += m.p.y * bw[k]; sw2 += bw[k]; });
      var ll2 = toLatLon(ref, sx2 / sw2, sy2 / sw2);
      res.lat = ll2.lat; res.lon = ll2.lon; res.ok = true; res.n_used = L.length;
      fillError(res, null, Math.max(50, median(L.map(function (m) { return m.r; })) / 2));
      var rs = L.map(function (m) { var d = haversineMeters(res.lat, res.lon, m.t.lat, m.t.lon) - m.r; return isNum(d) ? d : 0; });
      fitStats(res, rs, L.map(function (m) { return m.sigma; }));
      res.candidates = [{ lat: res.lat, lon: res.lon, weight: 1 }];
      return res;
    }

    var set = L.slice(), rejected = 0;
    var p0 = L.length === 3 ? (threeStationSolve(set) || init(set)) : init(set);
    var fit2 = gaussNewton(rf(set), p0, wOf, maxIt);
    if (opts.reject_outliers_iqr !== false && set.length >= 4) {
      var mask = outlierMask(fit2.residuals, set.map(function (m) { return m.sigma; }));
      if (mask) {
        var kept = set.filter(function (_, i) { return mask[i]; });
        var rej = set.filter(function (_, i) { return !mask[i]; });
        rejected = rej.length;
        res.warnings.push('按 IQR/3.5σ 剔除 ' + rejected + ' 个粗差基站：' + rej.map(function (m) { return m.t.label || '基站'; }).join('、'));
        set = kept;
        fit2 = gaussNewton(rf(set), fit2.p, wOf, maxIt);
      }
    }
    res.method = set.length === 3 ? 'trilateration-3' : 'trilateration-n';
    res.n_used = set.length; res.n_rejected = rejected; res.iterations = fit2.iterations;
    if (fit2.degenerate || !isNum(fit2.p[0]) || !isNum(fit2.p[1])) {
      res.method = 'weighted-centroid';
      var q0 = init(set), llq = toLatLon(ref, q0[0], q0[1]);
      res.lat = llq.lat; res.lon = llq.lon; res.ok = true;
      fillError(res, null, median(set.map(function (m) { return m.sigma; })));
      res.warnings.push('法方程奇异（基站共线或重复），退化为加权质心');
      return res;
    }
    var ll = toLatLon(ref, fit2.p[0], fit2.p[1]);
    res.lat = ll.lat; res.lon = ll.lon; res.ok = true;
    fillError(res, fit2.cov, median(set.map(function (m) { return m.sigma; })));
    fitStats(res, fit2.residuals, set.map(function (m) { return m.sigma; }));
    consistencyWarning(res, set);
    res.candidates = [{ lat: res.lat, lon: res.lon, weight: 1 }];
    res.gdop = rnd(gdopFromGeometry(set.map(function (m) { return { lat: m.t.lat, lon: m.t.lon }; }), ll, { clock: false }).gdop, 2);
    if (res.gdop == null) res.warnings.push('几何构型退化（站点共线或重复），GDOP 不可解，不确定度以误差椭圆/置信半径为准');
    if (res.gdop != null && res.gdop > 8) res.warnings.push('GDOP=' + res.gdop + '，基站几何构型较差（近共线），横向误差被放大');
    if (rejected) res.warnings.push('已剔除粗差，参与定位基站 ' + set.length + ' 个');
    return res;
  }
  function threeStationSolve(L) {
    var p0 = L[0].p, p1 = L[1].p, p2 = L[2].p;
    var A = [[2 * (p1.x - p0.x), 2 * (p1.y - p0.y)], [2 * (p2.x - p0.x), 2 * (p2.y - p0.y)]];
    var b = [L[0].r * L[0].r - L[1].r * L[1].r + p1.x * p1.x + p1.y * p1.y - p0.x * p0.x - p0.y * p0.y,
      L[0].r * L[0].r - L[2].r * L[2].r + p2.x * p2.x + p2.y * p2.y - p0.x * p0.x - p0.y * p0.y];
    var inv = inv2(A);
    if (!inv) return null;
    var x = inv[0][0] * b[0] + inv[0][1] * b[1], y = inv[1][0] * b[0] + inv[1][1] * b[1];
    return isNum(x) && isNum(y) ? [x, y] : null;
  }

  /* ============================================================== 9. 纯方位交汇 */
  function triangulateBearings(observations, opts) {
    opts = opts || {};
    var res = mkResult('bearing-intersection'), obs = [];
    (Array.isArray(observations) ? observations : []).forEach(function (o, idx) {
      o = o || {};
      var a = num(o.azimuth_deg != null ? o.azimuth_deg : o.azimuth), lat = num(o.lat), lon = num(o.lon);
      if (!isNum(lat) || !isNum(lon) || !isNum(a)) { res.warnings.push('第 ' + (idx + 1) + ' 条方位观测缺少经纬度或方位角，已忽略'); return; }
      obs.push({
        lat: lat, lon: lon, az: wrap360(a), label: esc(o.label) || ('地标' + (obs.length + 1)),
        sigma: clamp(safe(num(o.bearing_sigma_deg), 2), 0.05, 60)
      });
    });
    res.n_used = obs.length;
    if (!obs.length) { res.method = 'none'; res.warnings.push('没有可用的方位观测'); return res; }
    var ref = centroid(obs);
    obs.forEach(function (o) {
      o.p = toPlane(ref, o.lat, o.lon);
      o.u = { x: Math.sin(toRad(o.az)), y: Math.cos(o.az * D2R) };   // 单位方位向量（东,北）
    });
    var maxIt = Math.max(3, Math.round(safe(num(opts.max_iterations), 40)));
    var angRes = function (list, p) {   // 角度残差折算为米（垂直偏移 = Δθ·d）
      return list.map(function (o) {
        var dx = p[0] - o.p.x, dy = p[1] - o.p.y, d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        var brg = wrap360(toDeg(Math.atan2(dx, dy)));
        return { v: wrap180(brg - o.az) * D2R * d, d: d, deg: wrap180(brg - o.az) };
      });
    };
    var wOfAng = function (list) {
      return function (r) {
        return list.map(function (o, i) {
          var sd = Math.max(1, o.sigma * D2R * Math.max(10, list[i].lastD || 100));
          var z = Math.abs(r[i]) / sd, h = opts.huber === false ? 1 : Math.min(1, 1.345 / Math.max(z, 1e-9));
          return h / (sd * sd);
        });
      };
    };
    var rfB = function (list) {
      return function (p) {
        var a = angRes(list, p), r = [], J = [], e = 0.5;
        list.forEach(function (o) { o.lastD = Math.max(10, a[list.indexOf(o)].d); });
        r = a.map(function (k) { return k.v; });
        for (var i = 0; i < list.length; i++) {
          var px = [p[0] + e, p[1]], py = [p[0], p[1] + e];
          J.push([(angRes(list, px)[i].v - r[i]) / e, (angRes(list, py)[i].v - r[i]) / e]);
        }
        return { r: r, J: J };
      };
    };
    if (obs.length === 1) {
      res.method = 'single-tower'; res.ok = true;
      res.lat = obs[0].lat; res.lon = obs[0].lon;
      fillError(res, null, 5000);
      res.warnings.push('仅 1 条方位线：只能给出方向，位置退化为观测点');
      res.estimated_from = [obs[0].label + ' 方位 ' + rnd(obs[0].az, 1) + '°'];
      res.candidates = [{ lat: obs[0].lat, lon: obs[0].lon, weight: 1 }];
      return res;
    }
    if (obs.length === 2) {
      var o1 = obs[0], o2 = obs[1];
      var det = o1.u.x * (-o2.u.y) - (-o2.u.x) * o1.u.y, dx = o2.p.x - o1.p.x, dy = o2.p.y - o1.p.y;
      if (Math.abs(det) < 1e-9) {
        res.method = 'weighted-centroid';
        var ll0 = toLatLon(ref, (o1.p.x + o2.p.x) / 2, (o1.p.y + o2.p.y) / 2);
        res.lat = ll0.lat; res.lon = ll0.lon; res.ok = true;
        fillError(res, null, 2000);
        res.warnings.push('两条方位线接近平行，无法交汇，退化为中点');
        return res;
      }
      var t1 = (dx * (-o2.u.y) - (-o2.u.x) * dy) / det, t2 = (o1.u.x * dy - o1.u.y * dx) / det;
      var P = [o1.p.x + t1 * o1.u.x, o1.p.y + t1 * o1.u.y];
      var cands = [], flip = [[1, 1], [-1, 1], [1, -1], [-1, -1]];   // 方位前后向的 4 种解释
      flip.forEach(function (f) {
        var list = [obs[0], obs[1]].map(function (o, i) {
          return { p: o.p, sigma: o.sigma, label: o.label, az: wrap360(o.az + (f[i] < 0 ? 180 : 0)), lastD: 1 };
        });
        var ar = angRes(list, P), chi = 0;
        ar.forEach(function (k, i) { chi += (k.deg / list[i].sigma) * (k.deg / list[i].sigma); });
        var ll = toLatLon(ref, P[0], P[1]);
        cands.push({ lat: ll.lat, lon: ll.lon, weight: Math.exp(-chi / 2), chi: chi, fwd: f[0] > 0 && f[1] > 0 });
      });
      cands.sort(function (a, b) { return a.chi - b.chi; });
      var tw = cands.reduce(function (s, k) { return s + Math.max(1e-9, k.weight); }, 0);
      res.candidates = cands.map(function (k) { return { lat: k.lat, lon: k.lon, weight: rnd(Math.max(1e-9, k.weight) / tw, 4) }; });
      var llb = cands[0]; res.lat = llb.lat; res.lon = llb.lon; res.ok = true;
      res.ranges_m = [];
      res.estimated_from = ['两条方位线交点（方位前后向按卡方选优）', obs[0].label + ' 方位 ' + rnd(obs[0].az, 1) + '°', obs[1].label + ' 方位 ' + rnd(obs[1].az, 1) + '°'];
      var sdMean = (o1.sigma + o2.sigma) / 2 * D2R * Math.max(50, Math.sqrt(Math.abs(t1 * t2)));
      fillError(res, [[sdMean * sdMean, 0], [0, sdMean * sdMean]], sdMean);
      res.iterations = 1;
      fitStats(res, angRes(obs, P).map(function (k) { return k.v; }), obs.map(function (o) { return Math.max(1, o.sigma * D2R * 500); }));
      if (!(t1 > 0 && t2 > 0)) res.warnings.push('交点落在至少一条方位线的反向延长线上，请确认方位是"站→目标"还是"目标→站"');
      return res;
    }
    var list2 = obs.map(function (o) { return { p: o.p, sigma: o.sigma, label: o.label, az: o.az, lastD: 500 }; });
    var p0b = [0, 0];
    list2.forEach(function (o) { p0b[0] += o.p.x / list2.length; p0b[1] += o.p.y / list2.length; });
    var fitB = gaussNewton(rfB(list2), p0b, wOfAng(list2), maxIt);
    if (fitB.degenerate || !isNum(fitB.p[0])) {
      res.method = 'weighted-centroid';
      var llc = toLatLon(ref, p0b[0], p0b[1]);
      res.lat = llc.lat; res.lon = llc.lon; res.ok = true;
      fillError(res, null, 2000);
      res.warnings.push('方位最小二乘奇异，退化为观测点质心');
      return res;
    }
    var ll = toLatLon(ref, fitB.p[0], fitB.p[1]);
    res.method = obs.length > 3 ? 'best_fit' : 'bearing-intersection';
    res.lat = ll.lat; res.lon = ll.lon; res.ok = true; res.n_used = obs.length;
    res.iterations = fitB.iterations; res.ranges_m = [];
    fillError(res, fitB.cov, median(obs.map(function (o) { return o.sigma * D2R * 500; })));
    fitStats(res, fitB.residuals, obs.map(function (o) { return Math.max(1, o.sigma * D2R * 300); }));
    res.estimated_from = obs.map(function (o) { return o.label + ' 方位 ' + rnd(o.az, 1) + '° (σ=' + rnd(o.sigma, 1) + '°)'; });
    res.candidates = [{ lat: res.lat, lon: res.lon, weight: 1 }];
    res.gdop = rnd(gdopFromGeometry(obs, ll, { clock: false }).gdop, 2);
    var big = fitB.residuals.map(function (v, i) { return Math.abs(v); }).filter(function (v, i) { return list2[i] && Math.abs(fitB.residuals[i]) > 4 * Math.max(1, list2[i].sigma * D2R * list2[i].lastD); }).length;
    if (big) res.warnings.push('有 ' + big + ' 条方位残差超过 4σ，可能存在方位基准错误或目标在观测线反向');
    return res;
  }

  /* ============================================================== 10. TDOA 到达时差 */
  function tdoaDistanceFromNs(ns) {
    var v = num(ns);
    return v == null ? null : v * NS_TO_M;
  }
  function multilaterateTDOA(stations, tdoa_s, opts) {
    opts = opts || {};
    var res = mkResult('tdoa-n'), S = [];
    (Array.isArray(stations) ? stations : []).forEach(function (o, i) {
      o = o || {};
      var lat = num(o.lat), lon = num(o.lon);
      if (!isNum(lat) || !isNum(lon)) { res.warnings.push('TDOA 站点缺少经纬度，已忽略'); return; }
      S.push({ lat: lat, lon: lon, label: esc(o.label) || ('站' + (i + 1)) });
    });
    var td = (Array.isArray(tdoa_s) ? tdoa_s : []).map(function (v) { return safe(num(v), 0); });
    if (!td.length) { res.warnings.push('未提供 TDOA 观测量'); return res; }
    if (td[0] == null) td[0] = 0;
    res.n_used = S.length;
    if (S.length < 3) { res.method = 'none'; res.warnings.push('TDOA 至少需要 3 个站点（2 条时差），当前 ' + S.length + ' 个'); return res; }
    var ref = centroid(S), D = td.map(function (v) { return v * C_MS; });
    S.forEach(function (m, i) {
      m.p = toPlane(ref, m.lat, m.lon);
      m.d = isNum(D[i]) ? D[i] : 0;
      m.sigma = clamp(safe(num(opts.sigma_m), Math.max(15, Math.abs(m.d) * 0.02 + 30)), 1, 1e7);
    });
    var rfT = function (p) {
      var r = [], J = [], d0v = Math.max(1e-6, Math.sqrt(Math.pow(p[0] - S[0].p.x, 2) + Math.pow(p[1] - S[0].p.y, 2)));
      var u0x = (p[0] - S[0].p.x) / d0v, u0y = (p[1] - S[0].p.y) / d0v;
      for (var i = 1; i < S.length; i++) {
        var dx = p[0] - S[i].p.x, dy = p[1] - S[i].p.y, di = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
        r.push((di - d0v) - S[i].d);
        J.push([dx / di - u0x, dy / di - u0y]);
      }
      return { r: r, J: J };
    };
    // Chan 线性化：以 (x,y,r0) 为未知数解 2·Δs·p + 2·D·r0 = |s_i|²-|s_0|²-D_i²，作 GN 初值
    var rows = [], rhs = [], W = [];
    for (var i = 1; i < S.length; i++) {
      rows.push([2 * (S[i].p.x - S[0].p.x), 2 * (S[i].p.y - S[0].p.y), 2 * S[i].d]);
      rhs.push(S[i].p.x * S[i].p.x + S[i].p.y * S[i].p.y - S[0].p.x * S[0].p.x - S[0].p.y * S[0].p.y - S[i].d * S[i].d);
      W.push(1 / (S[i].sigma * S[i].sigma));
    }
    var initP = null;
    if (rows.length >= 3) {
      var A3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b3 = [0, 0, 0], u, v;
      for (var k = 0; k < rows.length; k++) {
        for (u = 0; u < 3; u++) {
          b3[u] += W[k] * rows[k][u] * rhs[k];
          for (v = 0; v < 3; v++) A3[u][v] += W[k] * rows[k][u] * rows[k][v];
        }
      }
      var iv3 = matInv(A3);
      if (iv3) {
        var xs = iv3[0][0] * b3[0] + iv3[0][1] * b3[1] + iv3[0][2] * b3[2];
        var ys = iv3[1][0] * b3[0] + iv3[1][1] * b3[1] + iv3[1][2] * b3[2];
        var r0 = iv3[2][0] * b3[0] + iv3[2][1] * b3[1] + iv3[2][2] * b3[2];
        if (isNum(xs) && isNum(ys) && r0 > 0) initP = [xs, ys];
      }
    }
    if (!initP) initP = opts.init === 'first' ? [S[0].p.x, S[0].p.y] : [0, 0];
    var wT = function (r) {
      return r.map(function (v, idx) {
        var sd = S[idx + 1].sigma, z = Math.abs(v) / sd, h = opts.huber === false ? 1 : Math.min(1, 1.345 / Math.max(z, 1e-9));
        return h / (sd * sd);
      });
    };
    var fit = gaussNewton(rfT, initP, wT, Math.max(3, Math.round(safe(num(opts.max_iterations), 60))));
    if (fit.degenerate || !isNum(fit.p[0]) || !isNum(fit.p[1])) {
      res.method = 'weighted-centroid';
      var ll = toLatLon(ref, initP[0], initP[1]);
      res.lat = ll.lat; res.lon = ll.lon; res.ok = true;
      fillError(res, null, 1000);
      res.warnings.push('TDOA 法方程奇异（站点共线），退化为初值');
      return res;
    }
    var llt = toLatLon(ref, fit.p[0], fit.p[1]);
    res.lat = llt.lat; res.lon = llt.lon; res.ok = true; res.iterations = fit.iterations;
    res.method = 'tdoa-n';
    res.ranges_m = S.map(function (m) { return rnd(haversineMeters(res.lat, res.lon, m.lat, m.lon), 1); });
    res.estimated_from = ['TDOA 双曲线组：以 ' + S[0].label + ' 为参考站，时差转距离 ' + S.slice(1).map(function (m) { return rnd(m.d, 1) + ' m'; }).join('/')];
    fillError(res, fit.cov, median(S.map(function (m) { return m.sigma; })));
    fitStats(res, fit.residuals, S.slice(1).map(function (m) { return m.sigma; }));
    res.candidates = [{ lat: res.lat, lon: res.lon, weight: 1 }];
    res.gdop = rnd(gdopFromGeometry(S, llt, { clock: false }).gdop, 2);
    if (res.gdop > 8) res.warnings.push('GDOP=' + res.gdop + '，TDOA 站点几何构型差');
    return res;
  }

  /* ============================================================== 11. 几何精度因子 */
  function ecef(lat, lon, alt) {
    var p = toRad(num(lat) || 0), l = toRad(num(lon) || 0), h = safe(num(alt), 0);
    var s = Math.sin(p), c = Math.cos(p);
    var N = WGS84.a / Math.sqrt(1 - WGS84.e2 * s * s);
    return [
      (N + h) * c * Math.cos(l),
      (N + h) * c * Math.sin(l),
      (N * (1 - WGS84.e2) + h) * s
    ];
  }
  // 默认（opts.clock!==false）为 GNSS 式四维 DOP：单位向量 + 钟差列，需 ≥4 个不共面站点。
  // 基站几乎都在地面，钟差与高度不可分离会使 4D DOP 爆炸，故解算器传 {clock:false} 取二维距离/方位构型 DOP。
  function gdopFromGeometry(stations, point, opts) {
    opts = opts || {};
    var out = { gdop: null, pdop: null, hdop: null, vdop: null, tdop: null, geometry_matrix: [], condition_number: null, warnings: [] };
    var arr = Array.isArray(stations) ? stations : [];
    var pt = point || {}, u = ecef(pt.lat, pt.lon, pt.alt || 0), rows = [], i, j, k;
    var clock = opts.clock !== false;   // false：2D 距离/方位几何 DOP（基站共面时钟差维不可分离）
    var need = clock ? 4 : 2;
    for (i = 0; i < arr.length; i++) {
      var s = arr[i] || {};
      if (!isNum(s.lat) || !isNum(s.lon)) continue;
      if (!clock) {
        var pl = toPlane(pt, s.lat, s.lon), dn2 = Math.sqrt(pl.x * pl.x + pl.y * pl.y);
        if (dn2 < 1e-6) continue;
        rows.push([pl.x / dn2, pl.y / dn2]);   // 局部平面单位向量（东,北）
        continue;
      }
      var se = ecef(s.lat, s.lon, s.alt || 0);
      var dv = [u[0] - se[0], u[1] - se[1], u[2] - se[2]];
      var dn = Math.sqrt(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
      if (dn < 1e-6) continue;
      rows.push([dv[0] / dn, dv[1] / dn, dv[2] / dn, 1]);   // 第 4 列为接收机钟差（等效距离）
    }
    out.geometry_matrix = rows.map(function (r) { return r.map(function (v) { return rnd(v, 8); }); });
    if (rows.length < need) {
      out.warnings.push(clock ? '几何因子需至少 4 个站点（3 位置 + 1 钟差），当前仅 ' + rows.length + ' 个'
        : '二维几何至少需 2 个站点，当前仅 ' + rows.length + ' 个');
      return out;
    }
    if (!clock) {
      var A2 = [[0, 0], [0, 0]];
      for (i = 0; i < rows.length; i++) for (j = 0; j < 2; j++) for (k = 0; k < 2; k++) A2[j][k] += rows[i][j] * rows[i][k];
      var n2 = inv2(A2);
      if (!n2) { out.warnings.push('二维几何矩阵奇异（站点共线），DOP 不可解'); return out; }
      var d2 = Math.max(1e-12, n2[0][0] + n2[1][1]);
      out.pdop = out.hdop = out.gdop = rnd(Math.sqrt(Math.max(0, n2[0][0] + n2[1][1])), 3);
      var e2v = eig2(A2);
      out.condition_number = rnd(Math.sqrt(Math.max(1, e2v.l1 / Math.max(1e-12, e2v.l2))), 3);
      return out;
    }
    var GtG = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (i = 0; i < rows.length; i++) for (j = 0; j < 4; j++) for (k = 0; k < 4; k++) GtG[j][k] += rows[i][j] * rows[i][k];
    var Ninv = matInv(GtG);
    if (!Ninv) { out.warnings.push('几何矩阵奇异，DOP 不可解'); return out; }
    out.pdop = rnd(Math.sqrt(Math.max(0, Ninv[0][0] + Ninv[1][1] + Ninv[2][2])), 3);
    out.hdop = rnd(Math.sqrt(Math.max(0, Ninv[0][0] + Ninv[1][1])), 3);
    out.vdop = rnd(Math.sqrt(Math.max(0, Ninv[2][2])), 3);
    out.tdop = rnd(Math.sqrt(Math.max(0, Ninv[3][3])), 3);
    out.gdop = rnd(Math.sqrt(Math.max(0, Ninv[0][0] + Ninv[1][1] + Ninv[2][2] + Ninv[3][3])), 3);
    var fro = 0, dt = Math.abs(det4(GtG));
    for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) fro += GtG[i][j] * GtG[i][j];
    // 条件数以 ‖G‖_F / |det|^(1/4) 作近似上界，避免再引入 SVD
    out.condition_number = rnd(Math.min(1e12, Math.sqrt(fro) / Math.max(1e-12, Math.pow(dt, 0.25))), 3);
    return out;
  }
  function det4(m) {
    var i, j, s = 0;
    function sub(a, col) {
      var r = [];
      for (var x = 1; x < 4; x++) { var row = []; for (var y = 0; y < 4; y++) if (y !== col) row.push(a[x][y]); r.push(row); }
      return r;
    }
    function det3(a) { return a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]); }
    for (i = 0; i < 4; i++) s += (i % 2 ? -1 : 1) * m[0][i] * det3(sub(m, i));
    return s;
  }

  /* ============================================================== 12. Wi-Fi 信道与扫描 */
  var BAND_2G = [1, 14], BAND_5G = [32, 177], BAND_6G = [1, 233];
  function isDfs(chan, freq) {
    if (chan == null) { var fc = freqToChannel(freq); chan = fc.channel; }
    if (!isNum(chan)) return false;
    return (chan >= 52 && chan <= 64) || (chan >= 100 && chan <= 144);   // UNII-2 / UNII-2E 需 DFS
  }
  function channelToFreq(ch, band) {
    var c = intNum(ch);
    if (c == null || c < 1) return null;
    if (band === '2.4GHz' || (!band && c <= 14)) {                 // 1–13 全球，14 仅日本 802.11b
      if (c === 14) return 2484;
      return c >= 1 && c <= 13 ? 2407 + c * 5 : null;
    }
    if (band === '6GHz') return c >= 1 && c <= 233 ? 5950 + c * 5 : null;
    if (band === '5GHz' || (!band && c >= 32 && c <= 233)) {
      if (c >= 32 && c <= 177) return 5000 + c * 5;
      if (c >= 181 && c <= 233) return 5950 + c * 5;               // 6GHz 高段与 5GHz 连续编号重叠
    }
    return c >= 1 && c <= BAND_6G[1] ? 5950 + c * 5 : null;
  }
  function freqToChannel(mhz) {
    var f = num(mhz), out = { band: null, channel: null, freq_mhz: f, dfs: false };
    if (!isNum(f)) return out;
    var r2 = (f - 2407) / 5, r5 = (f - 5000) / 5, r6 = (f - 5950) / 5;
    if (Math.abs(f - 2484) < 1) { out.band = '2.4GHz'; out.channel = 14; }
    else if (f >= 2401 && f <= 2483.5 && Math.abs(r2 - Math.round(r2)) < 0.4) { out.band = '2.4GHz'; out.channel = Math.round(r2); }
    else if (f >= 5150 && f <= 5895 && Math.abs(r5 - Math.round(r5)) < 0.4) { out.band = '5GHz'; out.channel = Math.round(r5); }
    else if (f >= 5925 && f <= 7125 && Math.abs(r6 - Math.round(r6)) < 0.4) { out.band = '6GHz'; out.channel = Math.round(r6); }
    if (out.channel != null) out.dfs = isDfs(out.channel, f);
    return out;
  }
  function normBssid(s) { return s ? String(s).toUpperCase().replace(/[_-]/g, ':').replace(/[^0-9A-F:]/g, '').replace(/^:|:$/g, '') : null; }
  function isBssidStr(s) { return /^(?:[0-9a-fA-F]{2}[:_-]){5}[0-9a-fA-F]{2}$/.test(String(s).trim()); }
  function secFromLine(L, cur) {
    var l = L.toLowerCase();
    if (/wpa3|sae/.test(l)) return 'WPA3';
    if (/wpa2|psk/.test(l)) return cur && cur.security === 'WPA3' ? 'WPA3' : 'WPA2';
    if (/\bwpa\b/.test(l)) return cur && /wpa2|psk/.test(l) ? 'WPA2' : 'WPA';
    if (/wep|encryption key:\s*on|password=true/.test(l)) return 'WEP';
    if (/encryption key:\s*off|\bopen\b|ismixed=false|password=false/.test(l)) return '开放';
    return null;
  }
  function deriveFreqChan(net) {
    if (net.freq_mhz == null && net.channel != null) net.freq_mhz = channelToFreq(net.channel);
    if (net.channel == null && net.freq_mhz != null) { var f = freqToChannel(net.freq_mhz); net.channel = f.channel; net.band = f.band; net.dfs = f.dfs; }
    else if (net.freq_mhz != null) { var g = freqToChannel(net.freq_mhz); net.band = g.band; net.dfs = g.dfs || isDfs(net.channel, net.freq_mhz); }
    return net;
  }
  function wifiScanParse(text) {
    var res = { networks: [], warnings: [] }, cur = null, unparsed = 0;
    function push(net) { res.networks.push(deriveFreqChan(net)); }
    function finish() {
      if (cur && (cur.bssid || cur.ssid != null || cur.rssi_dbm != null)) push(cur);
      cur = null;
    }
    function mk(o) { return { bssid: o.bssid || null, ssid: o.ssid == null ? null : o.ssid, rssi_dbm: o.rssi_dbm == null ? null : o.rssi_dbm, channel: o.channel == null ? null : o.channel, freq_mhz: o.freq_mhz == null ? null : o.freq_mhz, security: o.security == null ? null : o.security, quality: o.quality == null ? null : o.quality }; }
    function strictNum(s) { return /^[-+]?\d+(\.\d+)?$/.test(String(s).trim()); }
    var lines = esc(text).replace(/\r\n?/g, '\n').split('\n');
    lines.forEach(function (raw) {
      var L = raw.trim(), m, hit = false;
      if (!L || /^[#;]/.test(L) || /^(dumpsys|interfaces:?|-----|wall|Wi-?Fi (service|scanner|impl))/i.test(L)) return;
      // CSV 表头（纯字母列名，无数字）：BSSID,RSSI,SSID 之类，静默跳过
      var hc = L.split(/[,;\t]/);
      if (hc.length >= 2 && !/\d/.test(L) && /(bssid|ssid|rssi|signal|mac|quality|channel|freq)/i.test(L) &&
        hc.every(function (c) { return /^[A-Za-z _()\/-]*$/.test(c.trim()); })) return;
      // (1) Android dumpsys wifi： [bssid / freq / signal / password / ssid]
      m = L.match(/\[\s*"?((?:[0-9a-fA-F]{2}[:_.-]){5}[0-9a-fA-F]{2})"?\s*\/\s*(\d{3,5})\s*\/\s*(-?\d{2,3})\s*\/\s*(\w+)\s*\/\s*"?([^"\]\n]*)/);
      if (m) { finish(); push(mk({ bssid: normBssid(m[1]), freq_mhz: num(m[2]), rssi_dbm: num(m[3]), ssid: m[5].trim(), security: m[4] === 'true' ? '加密' : '开放' })); return; }
      // (2) nmcli -a wifi rescan：network: "SSID" / frequency: 2437
      m = L.match(/^network:\s*(?:"([^"]*)"|<any>)\s*\/\s*frequency:\s*(\d{3,5})/i);
      if (m) { finish(); cur = mk({ ssid: m[1] || null, freq_mhz: num(m[2]) }); hit = true; }
      // (3) iwlist / dumpsys 逐行块
      if (!hit && /^(cell\s*\d+|address\s*:|essid\s*:|channel\s*:|frequency\s*:|quality\s*[=:]|signal(?:\s*level)?\s*[:=]|encryption key|wpa|psk|rsn|group cipher|pairwise cipher)/i.test(L)) {
        m = L.match(/address\s*[:=]\s*((?:[0-9a-fA-F]{2}[:_.-]){5}[0-9a-fA-F]{2})/i);
        if (m) { finish(); cur = mk({ bssid: normBssid(m[1]) }); }
        else if (/^cell\s*\d+/i.test(L)) { finish(); cur = mk({}); }
        else if (cur) {
          if ((m = L.match(/essid\s*[:=]\s*"?(.*?)"?\s*$/i))) cur.ssid = m[1];
          else if ((m = L.match(/frequency\s*[:=]\s*(\d{1,2})\.(\d{1,3})\s*GHz/i))) cur.freq_mhz = num(m[1] + '.' + m[2]) * 1000;
          else if ((m = L.match(/frequency\s*[:=]\s*(\d{3,5})/i))) cur.freq_mhz = num(m[1]);
          else if ((m = L.match(/channel\s*[:=]\s*(\d{1,3})/i))) cur.channel = num(m[1]);
          else if ((m = L.match(/signal\s*(?:-\s*)?(?:level\s*)?[:=]?\s*(-?\d{2,3})/i))) cur.rssi_dbm = num(m[1]);   // 优先于 quality：同一行里 dBm 比 0-100 更准
          else if ((m = L.match(/quality\s*[=:](\d{1,3})\/(\d{1,3})/i))) {
            cur.quality = num(m[1]);
            if (cur.rssi_dbm == null) cur.rssi_dbm = Math.round(clamp(num(m[1]), 0, 100) / 2 - 100);   // 0-100 质量折算 dBm 的经验映射
          }
          var sc = secFromLine(L, cur); if (sc) cur.security = sc;
        }
        if (cur) hit = true;   // 属于某条记录的续行，无论是否取到字段都不算垃圾行
      }
      // (4) 分隔符表格 / CSV：BSSID,RSSI,SSID 或 nmcli 对齐表
      if (!hit) {
        var cells = L.split(/[,;\t]|\s{2,}/).map(function (c) { return c.trim(); }), bi = -1;
        if (!cells.some(function (c, k) { if (isBssidStr(c)) { bi = k; return true; } return false; })) {
          cells = L.split(/\s+/); bi = -1;
          cells.forEach(function (c, k) { if (bi < 0 && isBssidStr(c)) bi = k; });
        }
        if (bi >= 0) {
          var rssi = null, freq = null, chan = null, qual = null, ssid = null, sec = null;
          cells.forEach(function (c, k) {
            if (k === bi || !c || /[:=]/.test(c)) return;
            if (strictNum(c)) {
              var n = num(c);
              if (rssi == null && n <= -10 && n >= -120) rssi = n;
              else if (freq == null && n >= 2400 && n <= 7200) freq = n;
              else if (chan == null && n >= 1 && n <= 233) chan = n;
              else if (qual == null && n >= 0 && n <= 100) qual = n;
              return;
            }
            if (/^(wpa\d?|wep|none|open|sae|infra|infrastructure|ad-hoc|ibss|mgbe?|Mbps?)$/i.test(c)) { if (/wpa|wep|none|open|sae/i.test(c)) sec = c.toUpperCase(); return; }
            if (/[A-Za-z]/.test(c) && ssid == null && !/mbit|ghz|dbm|bars/i.test(c)) ssid = c;
          });
          if (rssi == null && qual != null) rssi = Math.round(qual / 2 - 100);
          push(mk({ bssid: normBssid(cells[bi]), ssid: ssid, rssi_dbm: rssi, freq_mhz: freq, channel: chan, security: sec || secFromLine(L) }));
          hit = true;
        }
      }
      if (!hit) unparsed++;
    });
    finish();
    if (unparsed) res.warnings.push(unparsed + ' 行无法识别为 Wi-Fi 扫描结果，已跳过');
    if (!res.networks.length) res.warnings.push('未解析到 Wi-Fi 网络（支持 dumpsys wifi / nmcli / iwlist / BSSID,RSSI,SSID CSV）');
    var noRssi = res.networks.filter(function (n) { return n.rssi_dbm == null; }).length;
    if (noRssi) res.warnings.push(noRssi + ' 个网络没有信号强度，指纹匹配时将按 -100 dBm 处理');
    res.networks.forEach(function (n) { if (n.rssi_dbm == null) n.rssi_dbm = -100; });
    return res;
  }

  /* ============================================================== 13. 指纹定位 / BLE */
  /* 指纹两种常见写法都要吃：{"AA:BB:…":-62} 映射表，和 [{bssid:"AA:BB:…",rssi:-62}] 数组。
   * 数组是设备扫描输出的原始形状，逼调用方先自己折成映射表只会让 UI 里出错位。 */
  function apsToMap(list) {
    var m = {};
    if (!Array.isArray(list)) return null;
    list.forEach(function (a) {
      if (!a || typeof a !== 'object' || a.bssid == null) return;
      var v = a.rssi != null ? a.rssi : a.rssi_dbm;
      if (isNum(num(v))) m[String(a.bssid)] = num(v);
    });
    return m;
  }

  function fingerprintMatch(fingerprints, scan, opts) {
    opts = opts || {};
    var out = { lat: null, lon: null, confidence_m: null, matched: [], method: 'knn', warning: null };
    var fp = Array.isArray(fingerprints) ? fingerprints : [];
    var scArr = apsToMap(scan);
    var sc = scArr || (scan && typeof scan === 'object' ? scan : {});
    if (!fp.length) { out.warning = '指纹库为空'; return out; }
    var scanN = {};
    Object.keys(sc).forEach(function (kk) { scanN[String(kk).toUpperCase().replace(/[_-]/g, ':')] = sc[kk]; });
    var keys = Object.keys(scanN);
    if (!keys.length) { out.warning = '扫描结果为空'; return out; }
    var k = Math.max(1, Math.round(safe(num(opts.k), 3)));
    var eps = safe(num(opts.eps), 1);
    var sim = opts.similarity === 'euclidean' ? 'euclidean' : 'cosine';
    var scores = [];
    fp.forEach(function (f, idx) {
      if (!f || !isNum(f.lat) || !isNum(f.lon)) return;
      var fsMap = f.rssi && typeof f.rssi === 'object' && !Array.isArray(f.rssi) ? f.rssi : apsToMap(f.rssi);
      if (!fsMap || !Object.keys(fsMap).length) fsMap = apsToMap(f.aps) || {};
      var fs = Object.assign({}, fsMap);   // 不写回调用方给的对象
      var bKeys = Object.keys(fs).map(function (kk) { return String(kk).toUpperCase().replace(/[_-]/g, ':'); });
      var orig = {};
      bKeys.forEach(function (bk, ix) { orig[bk] = Object.keys(fs)[ix]; });
      var inter = keys.filter(function (kk) { return bKeys.indexOf(kk) >= 0; });
      if (inter.length < Math.max(1, safe(num(opts.min_ap), 1))) return;
      var dot = 0, na = 0, nb = 0, de = 0;
      inter.forEach(function (kk) {
        var av = num(scanN[kk]), bv = num(fs[orig[kk]]);
        if (av == null || bv == null) return;
        dot += av * bv; na += av * av; nb += bv * bv; de += (av - bv) * (av - bv);
      });
      if (!dot && !de) return;
      var cos = dot / (Math.sqrt(na) * Math.sqrt(nb) + eps);
      var dist = Math.sqrt(de);
      var s = sim === 'euclidean' ? -dist : cos / (1 + dist / 40);
      scores.push({ i: idx, f: f, score: s, cos: cos, dist: dist, common: inter.length, w: 1 / (dist + eps) });
    });
    if (!scores.length) { out.warning = '指纹库中没有与本次扫描重叠的 AP，无法匹配'; return out; }
    scores.sort(function (a, b) { return b.score - a.score; });
    var top = scores.slice(0, Math.min(k, scores.length));
    out.method = opts.method === 'centroid' ? 'centroid' : (opts.weights === false ? 'knn' : 'weighted-knn');
    var sw = 0, sx = 0, sy = 0, sd = 0;
    top.forEach(function (s) { var w = out.method === 'knn' ? 1 : s.w; sw += w; sx += w * s.f.lat; sy += w * s.f.lon; });
    out.lat = sx / sw; out.lon = sy / sw;
    top.forEach(function (s) { var w = out.method === 'knn' ? 1 : s.w; sd += w * Math.pow(haversineMeters(out.lat, out.lon, s.f.lat, s.f.lon) || 0, 2); });
    out.confidence_m = rnd(Math.sqrt(sd / Math.max(1e-9, sw)), 1);
    out.matched = top.map(function (s) { return { label: esc(s.f.label) || ('指纹' + (s.i + 1)), score: rnd(s.score, 4), common_ap: s.common, dist_m: rnd(s.dist, 1) }; });
    if (top.length === 1) out.warning = '只有 1 个候选指纹点，置信距离可能偏乐观';
    return out;
  }
  function bleProximity(rssi, opts) {
    opts = opts || {};
    var r = num(rssi), mp = safe(num(opts.measured_power_dbm, num(opts.measuredPower)), -59), n = clamp(safe(num(opts.exponent), 2.3), 1, 6);
    var out = { dist_m: null, confidence: '低', measured_power_dbm: mp, note: '' };
    if (r == null) { out.note = '缺少 BLE RSSI'; return out; }
    var raw = Math.pow(10, (mp - r) / (10 * n));
    out.dist_m = rnd(clamp(raw, 0.05, 1000), 2);
    var sd = clamp(Math.abs(mp - r) * 0.18 + 1.2, 1, 60);
    out.sigma_m = rnd(sd, 2);
    out.confidence = out.dist_m < 3 && r > -70 ? '高' : (out.dist_m < 15 && r > -85 ? '中' : '低');
    out.note = 'iBeacon 模型 d = 10^((A-RSSI)/(10n))，A=' + mp + ' dBm@1m，n=' + n + (raw > 100 ? '；RSSI 过弱，距离外推不可靠' : '')
      + (r > -30 ? '；RSSI 异常偏高（可能紧贴信标）' : '');
    return out;
  }

  /* ============================================================== 14. 数值自检 */
  var TESTS = [];
  function T(name, fn) { TESTS.push({ name: name, fn: fn }); }
  function ok(cond, msg) { if (!cond) throw new Error(msg); return msg; }
  function near(a, b, tol, what) {
    if (!isNum(a)) throw new Error((what || '数值') + ' 不是有效数：' + a);
    if (Math.abs(a - b) > tol) throw new Error((what || '数值') + ' 期望 ' + b + '±' + tol + '，实得 ' + a);
    return (what || '数值') + '=' + rnd(a, 4) + '（期望 ' + b + '±' + tol + '）';
  }
  // 递归扫描返回值：任何 NaN/±Infinity 都视为缺陷（规范要求"NEVER return NaN"）
  function bad(v, path) {
    path = path || '结果';
    if (typeof v === 'number') return isFinite(v) ? null : path + ' = ' + v;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) { var e1 = bad(v[i], path + '[' + i + ']'); if (e1) return e1; }
      return null;
    }
    if (v && typeof v === 'object') {
      var ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) { var e2 = bad(v[ks[j]], path + '.' + ks[j]); if (e2) return e2; }
    }
    return null;
  }
  function clean(v, path) { var e = bad(v, path); ok(!e, e + ' 出现非有限数值'); return '返回值全为有限数'; }
  function distM(a, b) { return haversineMeters(a.lat, a.lon, b.lat, b.lon); }

  T('FSPL 基准值 + RSSI↔距离往返 <0.01 dB', function () {
    var o = { model: 'fspl', freq_mhz: 1800, tx_power_dbm: 43 };
    var r1 = distanceToRssi(1500, o);
    near(r1.path_loss_db, 101.068, 0.01, 'PL(1.5km,1800MHz)');
    near(r1.rssi_dbm, -58.068, 0.01, 'RSSI');
    var r2 = rssiToDistance(r1.rssi_dbm, o);
    near(r2.dist_m, 1500, 0.5, '反演距离');
    var r3 = distanceToRssi(r2.dist_m, o);
    ok(Math.abs(r3.rssi_dbm - r1.rssi_dbm) < 0.01, '往返偏差 ' + (r3.rssi_dbm - r1.rssi_dbm) + ' dB ≥0.01');
    return 'PL 101.068 dB，往返 ' + rnd(r2.dist_m, 3) + ' m / Δ' + rnd(r3.rssi_dbm - r1.rssi_dbm, 6) + ' dB';
  });

  T('七模型往返一致（28 点全部 <0.01 dB）', function () {
    var cfg = [
      [{ model: 'fspl', freq_mhz: 900 }, [10, 500, 5000, 50000]],
      [{ model: 'okumura', freq_mhz: 800, environment: 'suburban' }, [1050, 3000, 9000, 19000]],
      [{ model: 'cost231', freq_mhz: 1800, city: 'large' }, [1050, 3000, 9000, 19000]],
      [{ model: '3gpp_38901_urban', freq_mhz: 28000, environment: 'indoor' }, [12, 100, 800, 4500]],
      [{ model: '3gpp_38901_rural', freq_mhz: 700 }, [12, 300, 5000, 18000]],
      [{ model: 'log_normal', freq_mhz: 2400, environment: 'indoor', reference_rssi_dbm_at_1m: -40, tx_power_dbm: 0 }, [2, 20, 200, 5000]],
      [{ model: 'custom', freq_mhz: 5800, exponent: 2.7, reference_rssi_dbm_at_1m: -35, tx_power_dbm: 30 }, [2, 20, 200, 5000]]
    ];
    var n = 0, worst = 0;
    cfg.forEach(function (c) {
      var o = c[0];
      c[1].forEach(function (d) {
        var rs = distanceToRssi(d, o).rssi_dbm;
        var back = rssiToDistance(rs, o);
        var rs2 = distanceToRssi(back.dist_m, o).rssi_dbm;
        var de = Math.abs(rs2 - rs);
        if (!isNum(de)) throw new Error(o.model + ' @' + d + ' m 往返产生 NaN');
        ok(de < 0.01, o.model + ' @' + d + ' m 往返偏差 ' + de + ' dB');
        ok(Math.abs(back.dist_m - d) / d < 0.002, o.model + ' @' + d + ' m 距离偏差 ' + rnd(back.dist_m - d, 2) + ' m');
        worst = Math.max(worst, de); n++;
      });
    });
    return n + ' 组往返，最大 RSSI 偏差 ' + rnd(worst, 8) + ' dB';
  });

  T('Okumura-Hata 量级合理（800MHz/城市）', function () {
    var o = { model: 'okumura', freq_mhz: 800, tx_power_dbm: 43 };
    near(pathLossDb('okumura', 1500, normOpts(o)), 130.875, 0.05, 'PL(1.5km)');
    var d = rssiToDistance(-95, o);
    near(d.dist_m, 2397, 40, '−95 dBm 距离');
    ok(d.clamped === false, '不该截断：' + d.clamped_reason);
    clean(d, 'hata');
    return 'PL(1.5k)=130.88 dB；−95 dBm→' + rnd(d.dist_m, 0) + ' m，σ≈' + rnd(d.sigma_m, 0) + ' m';
  });

  T('模型域外截断与标记', function () {
    var a = rssiToDistance(-20, { model: 'okumura', freq_mhz: 800 });
    ok(a.clamped === true && a.dist_m === 1000, '过强信号应截到 1000 m，实得 ' + a.dist_m);
    var b = rssiToDistance(-160, { model: 'fspl', freq_mhz: 1800 });
    ok(b.clamped === true && b.dist_m === 100000, '过弱信号应截到 100 km，实得 ' + b.dist_m);
    var c = rssiToDistance(-95, { model: 'okumura', freq_mhz: 1800 });
    ok(c.clamped === true && /频率/.test(c.clamped_reason || ''), 'Hata 用 1800 MHz 需报频率域外');
    var e = distanceToRssi(5, { model: 'cost231', freq_mhz: 1800 });
    ok(e.clamped === true && /有效下限/.test(e.clamped_reason || ''), '5 m 低于 COST-231 下限应截断');
    clean(b, 'fspl-clamp');
    return '1000 m / 100000 m / 频率域外 / 下限截断均标记';
  });

  T('COST-231 与 38.901 斜率', function () {
    var o = { model: 'cost231', freq_mhz: 1800 };
    near(pathLossDb('cost231', 1500, normOpts(o)), 142.062, 0.1, 'COST231 PL(1.5km)');
    var u = normOpts({ model: '3gpp_38901_urban', freq_mhz: 3500 });
    near(pathLossDb('3gpp_38901_urban', 100, u), 85.537, 0.05, 'UMi LOS(100m,3.5GHz)');
    near(pathLossDb('3gpp_38901_urban', 1000, u) - pathLossDb('3gpp_38901_urban', 100, u), 21.4, 0.01, 'UMi 十倍距斜率');
    near(pathLossDb('3gpp_38901_urban', 100, normOpts({ model: '3gpp_38901_urban', freq_mhz: 3500, environment: 'indoor' })), 98.437, 0.05, 'UMi NLOS(100m)');
    near(fsplDb(100, 3500), 83.322, 0.02, '同点 FSPL');
    var r = normOpts({ model: '3gpp_38901_rural', freq_mhz: 700 });
    near(pathLossDb('3gpp_38901_rural', 2000, r), 97.525, 0.05, 'RMa(2km,700MHz)');
    near(pathLossDb('3gpp_38901_rural', 20000, r) - pathLossDb('3gpp_38901_rural', 2000, r), 22, 0.01, 'RMa 十倍距斜率');
    return 'UMi LOS 85.54 dB（比 FSPL 83.32 高 2.2 dB，含绕射项）；NLOS +12.9；RMa 斜率 22 dB/dec';
  });

  T('对数距离 σ[dB] → 距离 σ 换算', function () {
    var o = { model: 'log_normal', freq_mhz: 2400, environment: 'urban', tx_power_dbm: 20, reference_rssi_dbm_at_1m: -30 };
    var d = rssiToDistance(-70, o);
    near(d.dist_m, 13.895, 0.05, '距离');
    near(d.exponent, 3.5, 0.02, '有效指数');
    var rel = d.sigma_m / d.dist_m;
    near(rel, LN10 / 10 * 6 / 3.5, 0.002, 'σ_d/d');
    clean(d, 'log_normal');
    return 'd=' + rnd(d.dist_m, 2) + ' m，σ_d=' + rnd(d.sigma_m, 2) + ' m，σ_d/d=' + rnd(rel, 4) + '（=ln10/10·σ/n）';
  });

  T('custom 链路预算：n=2 时每倍距 6.02 dB', function () {
    var o = { model: 'custom', exponent: 2, tx_power_dbm: 0, reference_rssi_dbm_at_1m: -40 };
    var a = distanceToRssi(10, o), b = distanceToRssi(20, o);
    near(a.rssi_dbm, -60, 0.01, 'RSSI@10m');
    near(b.rssi_dbm - a.rssi_dbm, -6.0206, 0.01, '倍距衰减');
    near(rssiToDistance(-60, o).dist_m, 10, 0.01, '反演 10 m');
    return 'PL0=40 dB@1m，10→20 m 衰减 ' + rnd(a.rssi_dbm - b.rssi_dbm, 4) + ' dB';
  });

  T('测地工具自洽（WGS84/切平面）', function () {
    var P = { lat: 31.2304, lon: 121.4737 };
    var E = destinationPoint(P.lat, P.lon, 90, 1000);
    near(haversineMeters(P.lat, P.lon, E.lat, E.lon), 1000, 0.5, '1 km 东移');
    near(bearingDeg(P.lat, P.lon, E.lat, E.lon), 90, 0.01, '方位回推');
    var bj = haversineMeters(31.2304, 121.4737, 39.9042, 116.4074);
    ok(bj > 1040000 && bj < 1095000, '上海—北京大圆距离异常：' + rnd(bj, 0) + ' m');
    var q = toLatLon(P, 500, -700);          // 平面量：东 500 m / 南 700 m
    var qs = distM(P, q);
    near(qs, Math.sqrt(500 * 500 + 700 * 700), 6, '平面↔球面');   // 椭球 110574/111319 与球面 111195 的尺度差 ~0.4%
    near(bearingDeg(P.lat, P.lon, q.lat, q.lon), wrap360(toDeg(Math.atan2(500, -700))), 0.25, '平面方位一致性');
    var s = toPlane(P, P.lat, P.lon);
    ok(s.x === 0 && s.y === 0, '参考点平面坐标应为原点');
    var back = toLatLon(P, 1234.5, -678.9);
    ok(Math.abs(toPlane(P, back.lat, back.lon).x - 1234.5) < 1e-6 && Math.abs(toPlane(P, back.lat, back.lon).y + 678.9) < 1e-6, '平面↔经纬度不可逆');
    return '球面 ' + rnd(bj / 1000, 1) + ' km（沪↔京）；平面↔球面差 ' + rnd(qs - 860.23, 2) + ' m / ' + rnd(M_PER_DEG_LAT, 0) + ' m per °lat';
  });

  T('normalizeTower 规范化与缺失处理', function () {
    var t = normalizeTower({ rat: 'GSM', mcc: 460, mnc: '00', lac: 20515, ci: 41177, arfcn: 51, rssi: -91, lat: 31.2304, lon: 121.4737 });
    ok(t && typeof t === 'object', '合法输入应返回对象');
    var keys = ['mcc', 'mnc', 'lac', 'ci', 'cid_hex', 'network', 'arfcn', 'pci', 'rat', 'rssi_dbm', 'rsrp_dbm',
      'rsrq_dbm', 'sinr_db', 'tx_power_dbm', 'freq_mhz', 'timing_advance', 'azimuth', 'beamwidth', 'lat', 'lon',
      'range_m', 'accuracy_m', 'label'];
    keys.forEach(function (k) { ok(Object.prototype.hasOwnProperty.call(t, k), '缺少字段 ' + k); });
    ok(t.mnc === 0 && t.lac === 20515 && t.ci === 41177 && t.rssi_dbm === -91, '数值字段不符：' + JSON.stringify([t.mnc, t.lac, t.ci, t.rssi_dbm]));
    near(t.freq_mhz, 945.2, 0.01, 'GSM ARFCN 51 下行');
    ok(t.cid_hex === '5023A0D9', 'cid_hex 期望 5023A0D9，实得 ' + t.cid_hex);
    ok(/中国移动/.test(t.network || ''), '运营商回填失败：' + t.network);
    ok(t.rat === 'gsm' || t.rat === null, '制式字段异常：' + t.rat);
    clean(t, 'tower');
    ok(normalizeTower(null) === null && normalizeTower({}) === null && normalizeTower('abc') === null && normalizeTower(42) === null,
      '非法输入必须返回 null');
    ok(normalizeTower({ mcc: 'abc', rssi: '??', lat: 'NaN' }) === null, '全空字段应返回 null');
    var z = normalizeTower({ lac: 1, ci: 2 });
    ok(z.mcc === null && z.pci === null && z.rsrp_dbm === null, '缺失字段必须是 null 而不是 0/NaN');
    clean(z, 'sparse-tower');
    return 'cid_hex=' + t.cid_hex + '，freq=' + t.freq_mhz + ' MHz，缺字段=null';
  });

  T('cid_hex 反解 LAC/CI', function () {
    var t = normalizeTower({ cid_hex: '0x5023A0D9', mcc: 460, mnc: 0 });
    near(t.lac, 20515, 0, '由 hex 反解 LAC');
    near(t.ci, 41177, 0, '由 hex 反解 CI');
    ok(t.cid_hex === '5023A0D9', '回写 cid_hex 不符：' + t.cid_hex);
    var n = normalizeTower({ ci: 1048575 });
    ok(!/^[0-9A-F]{4}$/.test(n.cid_hex), '无 LAC 时 cid_hex 应为 8 位：' + n.cid_hex);
    return '0x5023A0D9 → LAC 20515 / CI 41177';
  });

  T('operatorName 查表（中国全 MNC + 国际）', function () {
    ok(/中国电信/.test(operatorName(460, 11).operator), '460-11 应为电信');
    ok(/中国联通/.test(operatorName('460', '01').operator), '460-01 应为联通（去零后不得与 460-11 混淆）');
    ok(/中国广电/.test(operatorName(460, '15').operator), '460-15 应为广电');
    ok(/中国移动/.test(operatorName('460', '00').operator), '460-00 应为移动');
    ok(/AT&T/.test(operatorName(310, 410).operator), '310-410 应为 AT&T');
    var u = operatorName(0, 999);
    ok(u.operator === '未知运营商' && u.iso2 === null, '未知 MCC/MNC 应回落：' + JSON.stringify(u));
    ok(operatorName(460, 11).iso2 === 'CN' && operatorName(460, 11).country === '中国', '国家/ISO 字段不符');
    var cn = OPERATORS.filter(function (o) { return o.mcc === '460'; }).length;
    var intl = OPERATORS.filter(function (o) { return o.mcc !== '460'; }).length;
    ok(cn >= 15, '中国 MNC 数量 ' + cn + ' 不足');
    ok(intl >= 40, '国际运营商 ' + intl + ' 不足 40');
    clean(u, 'operator');
    return '中国 460 段 ' + cn + ' 个 MNC，国际 ' + intl + ' 家';
  });

  T('parseInput 多格式混合（kv/短横/下划线/CSV/内嵌坐标）', function () {
    var txt = [
      '# 手工格式示例',
      'MCC=460 MNC=00 LAC=20515 CI=41177 RAT=GSM RSSI=-91 ARFCN=51',
      '460-01-20516-41178',
      '460_11_20517_41179',
      'mcc:460,mnc:0,lac:20518,ci:41180,rssi:-87,lat:31.2304,lon:121.4737',
      'rat=LTE pci=121 rsrp=-95 tac=20519 ci=41181 freq=1842.5 +31.2340 +121.4780',
      '完全无法识别的一行'
    ].join('\n');
    var r = parseInput(txt);
    ok(r.towers.length === 5, '期望 5 个基站，实得 ' + r.towers.length);
    ok(r.summary.count === 5 && r.summary.with_position === 2, 'summary 不符：' + JSON.stringify(r.summary));
    ok(r.summary.with_rssi === 3 && r.summary.with_cid === 5, 'with_rssi/with_cid 不符：' + JSON.stringify(r.summary));
    ok(r.towers[0].freq_mhz === 945.2, '第 1 条频点推算错：' + r.towers[0].freq_mhz);
    ok(r.towers[1].mnc === 1 && r.towers[1].ci === 41178, '短横式解析错：' + JSON.stringify([r.towers[1].mnc, r.towers[1].ci]));
    ok(r.towers[2].lac === 20517, '下划线式解析错：' + r.towers[2].lac);
    near(r.towers[3].lat, 31.2304, 1e-6, 'CSV 经纬度');
    ok(r.towers[4].rat === 'lte' && r.towers[4].pci === 121 && r.towers[4].rsrp_dbm === -95, 'kv+坐标解析错');
    near(r.towers[4].lat, 31.234, 1e-6, '内嵌坐标 +31.2340');
    ok(r.warnings.join('|').indexOf('无法识别') >= 0, '应给出未识别行告警：' + r.warnings.join('|'));
    clean(r, 'parseInput');
    return '5 基站（含 2 带坐标），1 行告警';
  });

  T('parseInput Android dumpsys（GSM 单小区）', function () {
    var txt = [
      'RILJ - solicitedActiveDataCallList',
      'DumpServiceState: {mCellInfoList=5}',
      '  CellInfoGsm: {mCellIdentity=CellIdentityGsm: {mMcc=460 mNc=00 mLac=20515 mCid=41177 mArfcn=51}, mSignalStrength=CellSignalStrengthGsm: {mSignalStrength=-67 mRssi=-91 mBitErrorRate=0 mTimingAdvance=5}, mTimestamp=Millis: 1234}',
      '}'
    ].join('\n');
    var r = parseInput(txt);
    ok(r.towers.length === 1, '期望恰好 1 个基站，实得 ' + r.towers.length + '：' + JSON.stringify(r.towers.map(function (t) { return t.label; })));
    var t = r.towers[0];
    ok(t.ci === 41177 && t.lac === 20515 && t.mcc === 460 && t.mnc === 0, '身份字段不符：' + JSON.stringify([t.mcc, t.mnc, t.lac, t.ci]));
    ok(t.rssi_dbm === -91, 'RSSI 应为 -91，实得 ' + t.rssi_dbm);
    ok(t.rat === 'gsm' && t.timing_advance === 5, '制式/TA 不符：' + t.rat + '/' + t.timing_advance);
    near(t.freq_mhz, 945.2, 0.01, 'BCCH 频点');
    clean(t, 'dumpsys-gsm');
    return '1 小区：460-00-20515-41177 / −91 dBm / ' + t.freq_mhz + ' MHz';
  });

  T('parseInput 多制式 dumpsys（LTE+WCDMA）', function () {
    var txt = [
      'CellInfoLte: {mCellIdentity=CellIdentityLte: {mCi=37538 mPci=121 mTac=20515 mMcc=460 mNc=11 mEarfcn=1650}, mSignalStrength=CellSignalStrengthLte: {mRsrp=-95 mRsrq=-11 mCsi=8}}',
      'CellInfoWcdma: {mCellIdentity=CellIdentityWcdma: {mLac=20515 mCid=41177 mPsc=327 mUarfcn=10663 mMcc=460 mNc=01}, mSignalStrength=CellSignalStrengthWcdma: {mRssi=-95 mEcNo=-14}}'
    ].join('\n');
    var r = parseInput(txt);
    ok(r.towers.length === 2, '期望 2 个小区，实得 ' + r.towers.length);
    var l = r.towers[0], w = r.towers[1];
    ok(l.rat === 'lte' && l.ci === 37538 && l.pci === 121 && l.rsrp_dbm === -95, 'LTE 字段不符：' + JSON.stringify([l.rat, l.ci, l.pci, l.rsrp_dbm]));
    near(l.freq_mhz, 1842.5, 0.01, 'EARFCN 1650 → Band3 下行');
    ok(w.rat === 'wcdma' && w.lac === 20515 && w.ci === 41177 && w.pci === 327 && w.rssi_dbm === -95, 'WCDMA 字段不符');
    ok(isNum(w.freq_mhz) && w.freq_mhz > 2110 && w.freq_mhz < 2170, 'Band1 下行应在 2110–2170，实得 ' + w.freq_mhz);
    ok(/电信/.test(l.network || '') && /联通/.test(w.network || ''), 'PLMN 归属错：' + l.network + ' / ' + w.network);
    clean(r, 'multi-rat');
    return 'LTE ' + l.freq_mhz + ' MHz RSRP ' + l.rsrp_dbm + '；WCDMA ' + rnd(w.freq_mhz, 2) + ' MHz';
  });

  T('parseInput 噪声与空输入不崩', function () {
    var r = parseInput('');
    ok(r.towers.length === 0 && r.summary.count === 0, '空文本应得 0 基站');
    ok(r.warnings.length > 0, '空文本应给提示');
    var r2 = parseInput('mNetworkRegistrationInfo: {state=HOME}\nSST: voice reg unknown\nRIL REQUEST\n');
    ok(r2.towers.length === 0, 'dumpsys 状态行不应生成基站：' + r2.towers.length);
    var r3 = parseInput(null);
    ok(r3.towers.length === 0, 'null 输入需安全返回空结果');
    clean(r3, 'null-input');
    return '空/噪声/null 输入均为 0 基站且无 NaN';
  });

  T('parseInput JSON（数组/具名键/标量继承/制式分组/坏 JSON 回退）', function () {
    // 独立口径：JSON 分支的结果必须与「同等信息量的 CSV」逐字段一致，
    // 否则说明字段表被 JSON 路径绕过（例如 tac/ci/nci 没走 FIELD_ALIAS）。
    var viaJson = parseInput(JSON.stringify({
      operator: 'China Mobile', rat: 'LTE',
      towers: [
        { mcc: 460, mnc: 0, tac: 33262, ci: 1154321, rssi: -71, timing_adv: 12 },
        { mcc: 460, mnc: 0, tac: 33262, ci: 1154322, rssi: -88, timing_adv: 31 }
      ]
    }));
    var viaCsv = parseInput('mcc,mnc,lac,ci,rssi,timing_advance,rat\n460,0,33262,1154321,-71,12,LTE\n460,0,33262,1154322,-88,31,LTE');
    ok(viaJson.towers.length === 2 && viaCsv.towers.length === 2, '两种口径计数不符：' + viaJson.towers.length + '/' + viaCsv.towers.length);
    var KEY = ['mcc', 'mnc', 'lac', 'ci', 'rssi_dbm', 'timing_advance', 'rat', 'cid_hex'];
    KEY.forEach(function (k) {
      ok(viaJson.towers[0][k] === viaCsv.towers[0][k], '字段 ' + k + ' JSON=' + viaJson.towers[0][k] + ' CSV=' + viaCsv.towers[0][k]);
    });
    ok(viaJson.summary.json === true, 'JSON 分支应在 summary 里留痕');
    ok(viaJson.towers[0].network === 'China Mobile' && viaCsv.towers[0].network === '中国移动 China Mobile',
      '顶层 operator 应覆盖查表结果：' + viaJson.towers[0].network + ' / ' + viaCsv.towers[0].network);

    var bare = parseInput('[{"lat":31.23,"lon":121.47,"rssi":-70},{"lat":31.24,"lon":121.48,"rssi":-80}]');
    ok(bare.towers.length === 2 && bare.summary.with_position === 2, '裸数组应按基站解析：' + JSON.stringify(bare.summary));

    var dict = parseInput('{"cellA":{"mcc":460,"mnc":1,"lac":11,"ci":22,"rssi":-60},"cellB":{"mcc":460,"mnc":1,"lac":11,"ci":23,"rssi":-70}}');
    ok(dict.towers.length === 2 && dict.towers[0].ci !== dict.towers[1].ci, '字典形式（无具名数组）应按值展开：' + dict.towers.length);

    var grouped = parseInput('{"towers":[{"nr":{"mcc":460,"mnc":11,"tac":5,"nci":6,"rssi":-66}}]}');
    ok(grouped.towers.length === 1 && grouped.towers[0].lac === 5 && grouped.towers[0].ci === 6,
      '按制式分组的嵌套对象应降一层解析：' + JSON.stringify(grouped.towers[0] || null));

    var broken = parseInput('{"towers":[ 这不是 JSON');
    ok(broken.towers.length === 0 && broken.warnings.length > 0, '坏 JSON 需回退逐行且不崩：' + JSON.stringify(broken.warnings));
    clean(broken, 'broken-json');

    var withPos = parseInput(JSON.stringify({
      rat: 'NR',
      towers: [
        { mcc: 460, mnc: 11, tac: 99, nci: 555001, rssi: -80, latitude: 31.2, longitude: 121.4 },
        { mcc: 460, mnc: 11, tac: 99, nci: 555002, rssi: -90, latitude: 30.05, longitude: 122.05 },
        { mcc: 460, mnc: 11, tac: 98, nci: 555003, rssi: -95, latitude: 31.8, longitude: 120.26 }
      ]
    }));
    ok(withPos.summary.with_position === 3, 'JSON 里的 latitude/longitude 应识别为坐标：' + withPos.summary.with_position);
    var sol = trilaterate(withPos.towers, {});
    ok(isNum(sol.lat) && isNum(sol.lon) && Math.abs(sol.lat) <= 90, 'JSON 基站清单应能直接进多边定位：' + JSON.stringify(sol.error || sol.lat));
    return 'JSON 与 CSV 同字段一致（8 字段逐一比对）；裸数组/字典/分组/坏 JSON 四条路径 + 3 站解算 ' + rnd(sol.lat, 4) + ',' + rnd(sol.lon, 4);
  });

  T('CSV 空单元格不得让后续列左移（分隔符不能用 [\\t,]+）', function () {
    var head = 'mcc,mnc,lac,ci,rssi,rsrp,timing_advance,rat,arfcn,pci,lat,lon';
    var rowFull = '460,0,33262,1154321,-57,,16,LTE,1650,213,31.2304,121.4737';
    var p = parseInput(head + '\n' + rowFull);
    ok(p.towers.length === 1, '应解析出 1 台基站：' + p.towers.length);
    var t = p.towers[0];
    ok(t.pci === 213, 'rsrp 留空后 pci 列被左移污染：pci=' + t.pci + '（应为 213）');
    ok(t.lat === 31.2304 && t.lon === 121.4737, '经纬度必须落在 lat/lon 列：' + [t.lat, t.lon].join(','));
    ok(t.timing_advance === 16 && t.rssi_dbm === -57 && t.rat === 'lte',
      '其余字段同步校验：ta=' + t.timing_advance + ' rssi=' + t.rssi_dbm + ' rat=' + t.rat);
    // 尾部空（没有坐标的那台）也必须按列位读，不能把 arfcn 挪到 lat
    var ghost = parseInput(head + '\n460,11,1024,5555,,-96,,NR,627264,,,');
    ok(ghost.towers.length === 1 && ghost.towers[0].rsrp_dbm === -96 && ghost.towers[0].lat == null,
      '空尾列应只填 rsrp：' + JSON.stringify([ghost.towers[0] && ghost.towers[0].rsrp_dbm, ghost.towers[0] && ghost.towers[0].lat]));
    // 两份口径同信息：CSV（含空格、制表符分隔）与 JSON 必须给出同样的站址
    var spaced = parseInput('mcc,mnc,ci,lat,lon\n460, 0, 1154321, 31.2304, 121.4737');
    ok(spaced.towers[0].lat === 31.2304 && spaced.towers[0].ci === 1154321, '逗号后空格应照常切列：' + JSON.stringify(spaced.towers[0] && [spaced.towers[0].ci, spaced.towers[0].lat]));
    var tabbed = parseInput('mcc\tci\tlat\tlon\n460\t1154321\t31.2304\t121.4737');
    ok(tabbed.towers[0].lon === 121.4737, '制表符分隔同样按列位读：' + JSON.stringify(tabbed.towers[0] && [tabbed.towers[0].ci, tabbed.towers[0].lon]));
    clean(p, 'csv-gap');
    var sol = trilaterate(p.towers, {});
    ok(isNum(sol.lat), '含空 rsrp 列的 CSV 应能直接进解算：' + JSON.stringify(sol.warnings));
    return '空列不串位：pci=213 lat=' + t.lat + '；尾空/空格/制表符三种写法各归其位';
  });

  T('wifiScanParse 三种来源（dumpsys / iwlist / CSV）', function () {
    var r1 = wifiScanParse([
      'Wi-Fi service impl:',
      '  [a1:b2:c3:d4:e5:f6 / 2437 / -46 / true / TP-LINK_ABC]',
      '  [11:22:33:44:55:66 / 5745 / -71 / false / Guest_5G]'
    ].join('\n'));
    ok(r1.networks.length === 2, 'dumpsys wifi 期望 2 条，实得 ' + r1.networks.length);
    var n1 = r1.networks[0];
    ok(n1.bssid === 'A1:B2:C3:D4:E5:F6' && n1.rssi_dbm === -46 && n1.channel === 6 && n1.security === '加密', 'dumpsys 字段不符：' + JSON.stringify(n1));
    ok(r1.networks[1].channel === 149 && r1.networks[1].security === '开放', '5G 频点折算不符');
    var r2 = wifiScanParse([
      'Cell 01 - Address: A1:B2:C3:D4:E5:F7',
      '          ESSID:"HomeAP"',
      '          Frequency: 2.462 GHz',
      '          Quality=62/100  Signal level=-53 dBm',
      '          Encryption key:off'
    ].join('\n'));
    ok(r2.networks.length === 1, 'iwlist 期望 1 条，实得 ' + r2.networks.length);
    var n2 = r2.networks[0];
    ok(n2.ssid === 'HomeAP' && n2.rssi_dbm === -53 && n2.freq_mhz === 2462 && n2.channel === 11 && n2.security === '开放', 'iwlist 字段不符：' + JSON.stringify(n2));
    var r3 = wifiScanParse('BSSID,RSSI,SSID,Channel\naa-bb-cc-dd-ee-ef,-88,OfficeAP,36\n');
    ok(r3.networks.length === 1, 'CSV 期望 1 条，实得 ' + r3.networks.length + '，告警 ' + r3.warnings.join('|'));
    var n3 = r3.networks[0];
    ok(n3.bssid === 'AA:BB:CC:DD:EE:EF' && n3.rssi_dbm === -88 && n3.channel === 36 && n3.freq_mhz === 5180 && n3.ssid === 'OfficeAP', 'CSV 字段不符：' + JSON.stringify(n3));
    var r4 = wifiScanParse('这里什么也不是\n第二行');
    ok(r4.networks.length === 0 && /无法识别/.test(r4.warnings.join('|')), '垃圾行应有告警');
    [r1, r2, r3, r4].forEach(function (r, i) { clean(r, 'wifi#' + i); });
    return 'dumpsys 2 条 / iwlist 1 条 / CSV 1 条，信道折算一致';
  });

  T('信道↔频率表（2.4G 含日本 14 / 5G DFS / 6G）', function () {
    near(channelToFreq(1), 2412, 0, 'ch1');
    near(channelToFreq(13), 2472, 0, 'ch13');
    near(channelToFreq(14), 2484, 0, 'ch14 仅日本 802.11b');
    near(channelToFreq(36), 5180, 0, 'ch36');
    near(channelToFreq(144), 5720, 0, 'ch144');
    near(channelToFreq(233, '6GHz'), 7115, 0, '6G ch233');
    var a = freqToChannel(2412), b = freqToChannel(2484), c = freqToChannel(5520), d = freqToChannel(5955), e = freqToChannel(2450);
    ok(a.band === '2.4GHz' && a.channel === 1, '2412→ch1 不符：' + JSON.stringify(a));
    ok(b.channel === 14 && b.band === '2.4GHz', '2484→ch14 不符');
    ok(c.band === '5GHz' && c.channel === 104 && c.dfs === true, '5520 应为 DFS 信道 104：' + JSON.stringify(c));
    ok(d.band === '6GHz' && d.channel === 1, '5955→6G ch1 不符');
    ok(e.channel === null, '2450 不落在 5 MHz 栅格，应无信道');
    [1, 2, 6, 11, 13].forEach(function (ch) { ok(freqToChannel(channelToFreq(ch)).channel === ch, '2.4G 往返失配 ch' + ch); });
    [36, 100, 149, 165].forEach(function (ch) { var f = channelToFreq(ch); ok(freqToChannel(f).channel === ch, '5G 往返失配 ch' + ch); });
    clean(c, 'freqToChannel');
    return '13/14/36/144/233 信道与 DFS 判定一致';
  });

  T('三站三角定位复原已知点（<5 m）', function () {
    var K = { lat: 31.2304, lon: 121.4737 };
    var T1 = { lat: 31.2320, lon: 121.4700 }, T2 = { lat: 31.2280, lon: 121.4760 }, T3 = { lat: 31.2350, lon: 121.4770 };
    var tw = [T1, T2, T3].map(function (t, i) {
      return { label: '站' + (i + 1), lat: t.lat, lon: t.lon, range_m: haversineMeters(K.lat, K.lon, t.lat, t.lon) };
    });
    var r = trilaterate(tw, {});
    ok(r.ok === true && r.method === 'trilateration-3', '方法/状态不符：' + r.method + ' ok=' + r.ok);
    var e = distM(r, K);
    ok(e < 5, '误差 ' + rnd(e, 2) + ' m 超过 5 m');
    ok(r.n_used === 3 && r.n_rejected === 0 && r.iterations >= 1, '统计字段不符：' + JSON.stringify([r.n_used, r.n_rejected, r.iterations]));
    ok(r.ranges_m.length === 3 && r.estimated_from.length === 3, 'ranges/estimated_from 长度不符');
    ok(r.residual_rmse_m < 1 && isNum(r.confidence_radius_m), '残差/置信半径不符：' + r.residual_rmse_m + '/' + r.confidence_radius_m);
    ok(r.confidence_radius_m < 3000, 'σ=0.3·距离时置信半径不应爆炸：' + r.confidence_radius_m + ' m');
    ok(isNum(r.gdop) && r.gdop >= 1 && r.gdop < 20, '3 站二维 GDOP 不符：' + r.gdop);
    ok(isNum(r.ellipsis.semi_major_m) && r.ellipsis.semi_major_m >= r.ellipsis.semi_minor_m, '误差椭圆半轴不符');
    var tw4 = [T1, T2, T3, { lat: 31.2260, lon: 121.4700 }].map(function (t, i) {
      return { label: '站' + (i + 1), lat: t.lat, lon: t.lon, accuracy_m: 40, range_m: haversineMeters(K.lat, K.lon, t.lat, t.lon) };
    });
    var r4 = trilaterate(tw4, {});
    ok(r4.method === 'trilateration-n' && r4.n_used === 4, '4 站应为 trilateration-n，实得 ' + r4.method + '/' + r4.n_used);
    ok(isNum(r4.gdop) && r4.gdop > 0 && r4.gdop < 20, '4 站 GDOP 应可解且量级合理：' + r4.gdop);
    ok(distM(r4, K) < 5, '4 站误差 ' + rnd(distM(r4, K), 2) + ' m');
    clean(r4, 'trilaterate4');
    return '3 站误差 ' + rnd(e, 3) + ' m，GDOP ' + r.gdop + '，置信半径 ' + r.confidence_radius_m + ' m；4 站误差 ' + rnd(distM(r4, K), 2) + ' m / GDOP ' + r4.gdop;
  });

  T('粗差剔除（4 站含 1 个 +9 km 伪距）', function () {
    var K = { lat: 31.2304, lon: 121.4737 };
    var pos = [{ lat: 31.2320, lon: 121.4700 }, { lat: 31.2280, lon: 121.4760 }, { lat: 31.2350, lon: 121.4770 }, { lat: 31.2260, lon: 121.4700 }];
    var tw = pos.map(function (t, i) {
      var d = haversineMeters(K.lat, K.lon, t.lat, t.lon);
      return { label: '站' + (i + 1), lat: t.lat, lon: t.lon, accuracy_m: 60, range_m: i === 3 ? d + 9000 : d };
    });
    var r = trilaterate(tw, { reject_outliers_iqr: true });
    ok(r.n_rejected >= 1, '未剔除粗差：n_rejected=' + r.n_rejected);
    ok(r.n_used === 3, '有效站数应为 3，实得 ' + r.n_used);
    var e = distM(r, K);
    ok(e < 15, '剔除后误差 ' + rnd(e, 1) + ' m > 15 m');
    ok(/粗差/.test(r.warnings.join('|')), '应给出剔除告警');
    var keep = trilaterate(tw, { reject_outliers_iqr: false, huber: false });
    ok(distM(keep, K) > e * 3, '不剔除时应明显更差（实际 ' + rnd(distM(keep, K), 1) + ' vs ' + rnd(e, 1) + '）');
    clean(r, 'outlier');
    return '剔除 1 站后误差 ' + rnd(e, 2) + ' m（关闭稳健判据 ' + rnd(distM(keep, K), 1) + ' m）';
  });

  T('缺坐标基站不参与交会 / 估距不自洽必须说破 / 文档注释不串名', function () {
    // ① 站址缺失的基站绝不能凭「典型覆盖半径」凑一个距离进方程：凑出来的坐标比"无解"更危险
    var K = { lat: 31.2304, lon: 121.4737 };
    var pos = [{ lat: 31.2320, lon: 121.4700 }, { lat: 31.2280, lon: 121.4760 }, { lat: 31.2350, lon: 121.4770 }];
    var good = pos.map(function (t, i) {
      return { label: '有址' + (i + 1), lat: t.lat, lon: t.lon, range_m: haversineMeters(K.lat, K.lon, t.lat, t.lon) };
    });
    var withGhost = good.concat([{ label: '无址站', mcc: 460, mnc: 11, lac: 1024, ci: 5555, rssi_dbm: -96, rat: 'nr5g' }]);
    var r3 = trilaterate(good, {}), rg = trilaterate(withGhost, {});
    ok(r3.n_used === 3 && rg.n_used === 3, '无址站不得参与交会：3 站=' + r3.n_used + '，加无址站=' + rg.n_used);
    ok(/缺少经纬度/.test(rg.warnings.join('|')), '无址站应留下说明：' + JSON.stringify(rg.warnings));
    ok(distM(rg, K) < 5, '多一台无址站不该把答案带跑：偏 ' + rnd(distM(rg, K), 2) + ' m');
    ok(rg.lat === r3.lat && rg.lon === r3.lon, '同 3 站同距离必须同一解：' + rg.lat + '/' + r3.lat);

    // ② 独立算例：Urban LTE（TA 步长 78 m）+ 一台按 GSM 位（554.7 m）解读的 TA=55 → 30 km 伪距
    //    三站基线才 3 km，解算残差 4 万米，此时给出的坐标没有意义，必须明说
    var bogus = [
      { label: 'LTE-A', lat: 31.2304, lon: 121.4737, timing_advance: 12, rat: 'lte' },
      { label: 'LTE-B', lat: 31.2530, lon: 121.4620, timing_advance: 31, rat: 'lte' },
      { label: 'GSM-C', lat: 31.2480, lon: 121.4960, timing_advance: 55, rat: 'gsm' }
    ];
    var rb = trilaterate(bogus, {});
    ok(rb.residual_rmse_m > 1000, '构造不出大残差算例，实测 RMS ' + rb.residual_rmse_m + ' m');
    ok(/不自洽/.test(rb.warnings.join('|')), '大残差应判为「位置不可用」：' + JSON.stringify(rb.warnings));
    var selfOk = trilaterate(good, {});
    ok(!/不自洽/.test(selfOk.warnings.join('|')), '自洽算例被误判：RMS ' + selfOk.residual_rmse_m + ' m');

    // ③ 文档级 note/description 是给人看的整段说明，不能被继承成每台基站的名字
    var dj = parseInput(JSON.stringify({
      note: '这是一段写在文档最外层的说明文字，长度已经够长，不该出现在基站名上',
      towers: [{ mcc: 460, mnc: 0, tac: 1, ci: 2, rssi: -70, lat: 31.23, lon: 121.47 },
        { mcc: 460, mnc: 0, tac: 1, ci: 3, rssi: -80, lat: 31.24, lon: 121.48 }]
    }));
    ok(dj.towers.length === 2, '文档级 note 影响了基站计数：' + dj.towers.length);
    ok(dj.towers[0].label !== dj.towers[1].label, '两台基站的 label 应各自独立：' + dj.towers[0].label);
    ok(dj.towers.every(function (t) { return !/这是一段/.test(t.label || ''); }),
      'label 里不应出现文档说明：' + dj.towers[0].label);
    var perTower = parseInput('{"towers":[{"label":"浦东机房 A 区","mcc":460,"mnc":0,"ci":7,"rssi":-70}]}');
    ok(perTower.towers[0].label === '浦东机房 A 区', '单站自己的 label 仍须生效：' + perTower.towers[0].label);
    clean(rg, 'ghost'); clean(rb, 'bogus');
    return '无址站剔除后解不变（' + rnd(distM(rg, K), 2) + ' m）；不自洽算例 RMS ' + rnd(rb.residual_rmse_m, 0) +
      ' m 已说破；note 不串名、单站 label 保留';
  });

  T('RSSI 反演接入定位与两塔双解', function () {
    // 两圆需真实相交：站间距 571 m，半径各 600 m
    var A = { label: 'A', lat: 31.2300, lon: 121.4700, range_m: 600 };
    var B = { label: 'B', lat: 31.2300, lon: 121.4760, range_m: 600 };
    var fs = trilaterate([A, B], {});
    ok(fs.method === 'two-tower-ambiguity', '两站应给出双解：' + fs.method);
    ok(fs.candidates.length === 2, '候选应恰为 2 个，实得 ' + fs.candidates.length);
    var ws = fs.candidates.reduce(function (s, c) { return s + c.weight; }, 0);
    near(ws, 1, 0.001, '候选权重和');
    ok(isNum(fs.candidates[0].lat) && Math.abs(fs.candidates[0].lat - fs.candidates[1].lat) > 1e-6, '双解应关于基站连线对称');
    ok(Math.abs(distM(fs.candidates[0], A) - 600) < 3, '候选应落在两圆交点上，偏差 ' + rnd(distM(fs.candidates[0], A) - 600, 2) + ' m');
    ok(/两个交点/.test(fs.warnings.join('|')), '应提示双解歧义');
    clean(fs, 'two-tower');
    // RSRP → 距离必须与 rssiToDistance 完全一致
    var t1 = { label: 'A', lat: 31.2300, lon: 121.4700, rsrp: -85, tx_power_dbm: 43, freq_mhz: 1800 };
    var ref = rssiToDistance(-85, { model: 'fspl', freq_mhz: 1800, tx_power_dbm: 43 });
    var byRsrp = trilaterate([t1], { model: 'fspl' });
    near(byRsrp.ranges_m[0], rnd(ref.dist_m, 1), 0.6, '单站 RSRP 反演距离');
    var single = trilaterate([t1], { model: 'fspl' });
    ok(single.method === 'single-tower' && single.ok === true && single.candidates.length === 1, '单站应退化为单站法：' + single.method);
    var none = trilaterate([], {});
    ok(none.method === 'none' && none.ok === false && none.warnings.length > 0, '空输入应安全返回 none');
    return '双解权重 ' + fs.candidates.map(function (c) { return c.weight; }).join('/') + '，RSRP 反演 ' + rnd(ref.dist_m, 0) + ' m 与模型一致';
  });

  T('双方位交汇与解析解一致', function () {
    var P = { lat: 31.2, lon: 121.4 };
    // 目标/副站均用切平面构造（与解算器同一尺度），避免椭球-球面尺度差带来的伪误差
    var S2 = toLatLon(P, 1000, 0);       // 副站在正东 1 km
    var Tg = toLatLon(P, 0, 1000);       // 目标在正北 1 km ⇒ A 方位 0°、B 方位 315°
    var r = triangulateBearings([
      { label: '塔A', lat: P.lat, lon: P.lon, azimuth: 0 },
      { label: '塔B', lat: S2.lat, lon: S2.lon, azimuth: 315 }
    ], {});
    ok(r.ok === true, '双方位应可解');
    var e = distM(r, Tg);
    ok(e < 2, '交点偏差 ' + rnd(e, 2) + ' m > 2 m');
    ok(r.ranges_m.length === 0, '纯方位不应给出距离');
    near(haversineMeters(P.lat, P.lon, r.lat, r.lon), haversineMeters(P.lat, P.lon, Tg.lat, Tg.lon), 0.5, '塔A 距离');
    near(haversineMeters(S2.lat, S2.lon, r.lat, r.lon), haversineMeters(S2.lat, S2.lon, Tg.lat, Tg.lon), 0.5, '塔B 距离');
    ok(Math.abs(haversineMeters(P.lat, P.lon, Tg.lat, Tg.lon) - 1000) < 8, '手算 1 km 基准不成立');
    ok(Math.abs(haversineMeters(S2.lat, S2.lon, Tg.lat, Tg.lon) - 1414.21) < 12, '手算 √2 km 基准不成立');
    ok(!/反向延长线/.test(r.warnings.join('|')), '正向交点不应报反向告警');
    var rev = triangulateBearings([
      { label: '塔A', lat: P.lat, lon: P.lon, azimuth: 180 },
      { label: '塔B', lat: S2.lat, lon: S2.lon, azimuth: 315 }
    ], {});
    ok(/反向延长线/.test(rev.warnings.join('|')), '反向情形应告警');
    clean(r, 'bearing2');
    return '交点偏差 ' + rnd(e, 3) + ' m，两站距离 ' + rnd(haversineMeters(P.lat, P.lon, r.lat, r.lon), 1) + '/' + rnd(haversineMeters(S2.lat, S2.lon, r.lat, r.lon), 1) + ' m';
  });

  T('四方位最优拟合（best_fit）', function () {
    var Tg = { lat: 31.2300, lon: 121.4700 };
    var st = [[0, 1000], [90, 1000], [180, 1000], [270, 1000]].map(function (b, i) {
      var p = destinationPoint(Tg.lat, Tg.lon, b[0], b[1]);
      return { label: 'L' + i, lat: p.lat, lon: p.lon, azimuth_deg: bearingDeg(p.lat, p.lon, Tg.lat, Tg.lon), bearing_sigma_deg: 1 };
    });
    var r = triangulateBearings(st, {});
    ok(r.method === 'best_fit', '4 条方位应为 best_fit，实得 ' + r.method);
    var e = distM(r, Tg);
    ok(e < 5, '拟合偏差 ' + rnd(e, 2) + ' m > 5 m');
    ok(r.iterations >= 1 && r.n_used === 4, '迭代/用量不符：' + r.iterations + '/' + r.n_used);
    ok(isNum(r.confidence_radius_m), '应有置信半径：' + r.confidence_radius_m);
    var three = triangulateBearings(st.slice(0, 3), {});
    ok(three.method === 'bearing-intersection', '3 条方位应为交点法，实得 ' + three.method);
    ok(distM(three, Tg) < 5, '3 方位误差 ' + rnd(distM(three, Tg), 2) + ' m');
    var one = triangulateBearings([st[0]], {});
    ok(one.method === 'single-tower', '单方位应退化：' + one.method);
    clean(r, 'bearing4');
    return '4 方位拟合 ' + rnd(e, 3) + ' m，3 方位 ' + rnd(distM(three, Tg), 3) + ' m';
  });

  T('TDOA 双曲线定位（Chan 初值 + 最小二乘）', function () {
    var S = [{ lat: 31.2300, lon: 121.4700 }, { lat: 31.2300, lon: 121.4800 }, { lat: 31.2400, lon: 121.4700 }, { lat: 31.2400, lon: 121.4800 }];
    var K = { lat: 31.2335, lon: 121.4725 };
    var d0 = haversineMeters(S[0].lat, S[0].lon, K.lat, K.lon);
    var td = S.map(function (s) { return (haversineMeters(s.lat, s.lon, K.lat, K.lon) - d0) / C_MS; });
    var r = multilaterateTDOA(S, td, {});
    ok(r.ok === true && r.method === 'tdoa-n', '方法不符：' + r.method + ' ok=' + r.ok);
    var e = distM(r, K);
    ok(e < 8, 'TDOA 误差 ' + rnd(e, 2) + ' m > 8 m');
    ok(r.ranges_m.length === 4 && r.iterations >= 1, '距离列表/迭代不符');
    ok(/TDOA/.test(r.estimated_from.join('')), 'estimated_from 应说明时差基线');
    ok(isNum(r.gdop) && r.gdop < 50, 'TDOA 二维 GDOP 量级异常：' + r.gdop);
    near(tdoaDistanceFromNs(1), 0.299792458, 1e-9, '1 ns 距离');
    near(tdoaDistanceFromNs(10), 2.99792458, 1e-8, '10 ns 距离');
    ok(tdoaDistanceFromNs('x') === null && tdoaDistanceFromNs(null) === null, '非数值应返回 null');
    var two = multilaterateTDOA(S.slice(0, 2), td.slice(0, 2), {});
    ok(two.method === 'none' && /至少/.test(two.warnings.join('')), '2 站 TDOA 应拒绝并告警');
    clean(r, 'tdoa');
    return '误差 ' + rnd(e, 2) + ' m，σ=' + rnd(r.confidence_radius_m, 1) + ' m，GDOP ' + r.gdop;
  });

  T('DOP 几何因子', function () {
    var S = [{ lat: 31.230, lon: 121.470 }, { lat: 31.230, lon: 121.480 }, { lat: 31.240, lon: 121.470 }, { lat: 31.235, lon: 121.475, alt: 80 }];
    var g = gdopFromGeometry(S, { lat: 31.2335, lon: 121.4725 });
    ok(isNum(g.gdop) && g.gdop >= g.hdop && g.gdop >= g.pdop, 'GDOP 应不小于 HDOP/PDOP：' + JSON.stringify([g.gdop, g.hdop, g.pdop]));
    ok(isNum(g.tdop) && g.tdop > 0, 'TDOP 不符：' + g.tdop);
    ok(g.geometry_matrix.length === 4 && g.geometry_matrix[0].length === 4, '几何矩阵形状不符');
    ok(isNum(g.condition_number) && g.condition_number >= 1, '条件数不符：' + g.condition_number);
    var g3 = gdopFromGeometry(S.slice(0, 3), { lat: 31.2335, lon: 121.4725 });
    ok(g3.gdop === null && g3.warnings.length > 0, '3 站应缺钟差维度并告警');
    var g2 = gdopFromGeometry(S.slice(0, 3), { lat: 31.2335, lon: 121.4725 }, { clock: false });
    ok(isNum(g2.gdop) && g2.vdop === null && g2.geometry_matrix[0].length === 2, '二维 DOP 模式不符：' + JSON.stringify([g2.gdop, g2.vdop]));
    ok(isNum(g2.gdop) && g2.gdop >= 1, '二维 GDOP 应 ≥1：' + g2.gdop);
    var g0 = gdopFromGeometry(null, null);
    ok(isNum(g0.gdop) ? false : g0.gdop === null, '空输入应返回 null DOP');
    clean(g, 'dop');
    return 'GDOP ' + g.gdop + ' / HDOP ' + g.hdop + ' / TDOP ' + g.tdop + '，条件数 ' + rnd(g.condition_number, 1);
  });

  T('Wi-Fi 指纹匹配（weighted-knn / knn / 无重叠）', function () {
    var DB = [
      { label: 'A', lat: 31.2300, lon: 121.4700, rssi: { 'AA:BB:CC:DD:EE:01': -50, 'AA:BB:CC:DD:EE:02': -65, 'AA:BB:CC:DD:EE:03': -80 } },
      { label: 'B', lat: 31.2320, lon: 121.4720, rssi: { 'AA:BB:CC:DD:EE:01': -70, 'AA:BB:CC:DD:EE:02': -60, 'AA:BB:CC:DD:EE:04': -75 } },
      { label: 'C', lat: 31.2340, lon: 121.4680, rssi: { 'AA:BB:CC:DD:EE:03': -55, 'AA:BB:CC:DD:EE:04': -70 } }
    ];
    var scan = { 'AA:BB:CC:DD:EE:01': -52, 'AA:BB:CC:DD:EE:02': -64, 'AA:BB:CC:DD:EE:03': -78 };
    var m = fingerprintMatch(DB, scan, { k: 3 });
    ok(m.matched.length > 0 && m.matched[0].label === 'A', '最近指纹应为 A：' + JSON.stringify(m.matched));
    ok(m.method === 'weighted-knn', 'method 应为 weighted-knn：' + m.method);
    var e = distM(m, { lat: 31.2300, lon: 121.4700 });
    ok(e < 150, '加权位置离 A ' + rnd(e, 1) + ' m > 150 m');
    ok(isNum(m.confidence_m) && m.confidence_m >= 0, '置信距离不符：' + m.confidence_m);
    ok(m.matched[0].score >= m.matched[m.matched.length - 1].score, 'score 应降序排列');
    ok(m.method === 'knn' || m.method === 'weighted-knn' || m.method === 'centroid', 'method 取值非法：' + m.method);
    var knn = fingerprintMatch(DB, scan, { k: 1, weights: false });
    ok(knn.method === 'knn' && distM(knn, { lat: 31.2300, lon: 121.4700 }) < 5, 'k=1 应直接命中 A：' + rnd(distM(knn, DB[0]), 1));
    var none = fingerprintMatch(DB, { 'FF:FF:FF:FF:FF:FF': -60 }, {});
    ok(none.lat === null && /重叠/.test(none.warning || ''), '无重叠 AP 应给出告警：' + none.warning);
    var empty = fingerprintMatch([], scan, {});
    ok(empty.warning === '指纹库为空' && empty.lat === null, '空库告警不符');
    // 同一份指纹的两种写法必须逐字段一致：设备扫描输出的就是 aps[] 数组形状，
    // 让调用方（UI / 说明书示例）先自己折成映射表只会多一处出错位。
    var DBaps = DB.map(function (f) {
      return { label: f.label, lat: f.lat, lon: f.lon, aps: Object.keys(f.rssi).map(function (b) { return { bssid: b, rssi: f.rssi[b] }; }) };
    });
    var scanArr = Object.keys(scan).map(function (b) { return { bssid: b, rssi: scan[b] }; });
    var m2 = fingerprintMatch(DBaps, scanArr, { k: 3 });
    ok(m2.lat === m.lat && m2.lon === m.lon && m2.confidence_m === m.confidence_m && m2.matched.length === m.matched.length,
      'aps[] 与映射表两种形状结果不一致：' + JSON.stringify([m.lat, m2.lat, m.confidence_m, m2.confidence_m]));
    ok(Object.keys(DB[0].rssi).length === 3 && DB[0].aps === undefined, '不得把归一化结果写回调用方的输入对象');
    clean(empty, 'fp-empty');
    clean(m, 'fp');
    return 'top=' + m.matched[0].label + '（score ' + m.matched[0].score + '），偏移 ' + rnd(e, 1) + ' m，置信 ' + m.confidence_m + ' m';
  });

  T('BLE 近场距离（iBeacon 模型）', function () {
    var a = bleProximity(-59, { measured_power_dbm: -59 });
    near(a.dist_m, 1, 0.01, '1 m 处 RSSI=标定功率');
    ok(a.confidence === '高', '近场置信度应为高：' + a.confidence);
    var b = bleProximity(-65, { measured_power_dbm: -59 });
    near(b.dist_m, 1.824, 0.02, '−65 dBm 距离');
    ok(b.confidence === '高', '−65 dBm 置信度应为高');
    var c = bleProximity(-75, { measured_power_dbm: -59, exponent: 2.3 });
    near(c.dist_m, 4.962, 0.05, '−75 dBm 距离');
    ok(c.confidence === '中', '−75 dBm 置信度应为中：' + c.confidence);
    var d = bleProximity(-110, { measured_power_dbm: -59 });
    ok(d.confidence === '低' && /不可靠/.test(d.note), '远场应降置信并提示：' + d.note);
    ok(bleProximity('abc').dist_m === null, '非数值 RSSI 应返回 null');
    clean(b, 'ble');
    return 'd=10^((A−RSSI)/10n)：−65 dBm→' + b.dist_m + ' m，−75 dBm→' + c.dist_m + ' m';
  });

  T('扇区/全向覆盖多边形面积', function () {
    var tw = { lat: 31.23, lon: 121.47, azimuth: 0, beamwidth: 60 };
    var s = sectorPolygon(tw, { max_range_m: 1000, rings: 24 });
    ok(s.points.length === 26, '60° 扇区应为顶点+25 弧点 = 26，实得 ' + s.points.length);
    near(s.area_km2, 0.5236, 0.005, '120°/60° 扇区面积(0.5r²θ)');
    ok(/扇区覆盖/.test(s.note) && /波束 60°/.test(s.note), 'note 不符：' + s.note);
    var o = sectorPolygon({ lat: 31.23, lon: 121.47 }, { max_range_m: 1000, rings: 24 });
    ok(o.points.length === 25, '全向应为 25 点，实得 ' + o.points.length);
    near(o.area_km2, Math.PI, 0.05, '全向圆面积 πr²');
    ok(/全向/.test(o.note), '全向 note 不符：' + o.note);
    var ring = sectorPolygon(tw, { max_range_m: 1000, floor_range_m: 200, rings: 24 });
    near(ring.area_km2, 0.5 * (1e6 - 4e4) * (Math.PI / 3) / 1e6, 0.01, '圆环扇形面积');
    ok(ring.points.length === 50, '圆环扇形应为外弧 25 + 内弧 25 = 50 点，实得 ' + ring.points.length);
    var bad = sectorPolygon({ lat: null, lon: null }, {});
    ok(bad.points.length === 0 && /缺少/.test(bad.note), '无坐标应返回空多边形');
    clean(s, 'sector');
    return '60°@1km 面积 ' + rnd(s.area_km2, 4) + ' km²（理论 0.5236），全向 ' + rnd(o.area_km2, 4) + ' km²';
  });

  T('定时提前量按制式取步长（GSM/LTE/WCDMA 各自的基本时间单位独立导出）', function () {
    var C = 299792458;
    // 三条步长都不写「我记得 554.69」，而是从标准的/basic 时间单位重算：
    var gsmUnit = 1 / (270.833 * 1e3);            // GSM 1 bit = 1/270.833 kbit/s
    var lteUnit = 16 / (15e3 * 2048);             // LTE 1 TA = 16·Ts，Ts = 1/(15 kHz × 2048)
    var wcdmaUnit = 1 / 3.84e6;                   // UTRAN 1 chip = 1/3.84 Mcps
    var d = function (t) { return C * t / 2; };   // 单程距离 = c × 往返时间 / 2
    near(taStepM('gsm'), d(gsmUnit), d(gsmUnit) * 0.01, 'GSM 一步');
    near(taStepM('lte'), d(lteUnit), d(lteUnit) * 0.01, 'LTE 一步');
    near(taStepM('nr5g'), d(lteUnit), d(lteUnit) * 0.01, 'NR 一步（与 LTE 同单位）');
    near(taStepM('wcdma'), d(wcdmaUnit), d(wcdmaUnit) * 0.01, 'WCDMA 一步');
    // 物理包络：GSM TA 上限 31（扩展 63）→ 小区半径必须落在 17 km / 35 km 量级，这是标准里写死的
    near(31 * taStepM('gsm'), 17195, 200, 'GSM TA=31 的覆盖半径');
    near(63 * taStepM('gsm'), 34945, 300, 'GSM 扩展 TA=63 的覆盖半径');
    return 'gsm ' + taStepM('gsm').toFixed(2) + ' / lte ' + taStepM('lte').toFixed(2) +
      ' / wcdma ' + taStepM('wcdma').toFixed(2) + ' m·每步；GSM TA31 → ' + (31 * taStepM('gsm') / 1000).toFixed(2) + ' km';
  });
  T('同一 TA 在 2G/4G 下的估距必须差 7.1 倍（否则 2G 距离被系统性算小）', function () {
    var mk = function (rat) {
      return [{ lat: 31.2304, lon: 121.4737, rat: rat, timing_advance: 20, mcc: 460, mnc: 0, ci: 1 },
      { lat: 31.2404, lon: 121.4837, rat: rat, timing_advance: 20, mcc: 460, mnc: 0, ci: 2 },
      { lat: 31.2204, lon: 121.4937, rat: rat, timing_advance: 20, mcc: 460, mnc: 0, ci: 3 }];
    };
    var g = trilaterate(mk('gsm')), l = trilaterate(mk('lte'));
    var rg = Math.max.apply(null, g.ranges_m), rl = Math.max.apply(null, l.ranges_m);
    ok(rg / rl > 6.5 && rg / rl < 7.7, 'GSM/LTE 距离比应≈7.10，实得 ' + (rg / rl).toFixed(3));
    ok(/bit/.test(g.estimated_from.join('')), '2G 依据里必须写明单位是 bit：' + g.estimated_from[0]);
    ok(/TA=16Ts/.test(l.estimated_from.join('')), '4G 依据里必须写明 16Ts：' + l.estimated_from[0]);
    return 'GSM ' + rnd(rg, 0) + ' m vs LTE ' + rnd(rl, 0) + ' m，比 ' + (rg / rl).toFixed(3);
  });

  T('数据表完整性（7 模型 / 7 制式 / 运营商）', function () {
    ['fspl', 'okumura', 'cost231', '3gpp_38901_urban', '3gpp_38901_rural', 'log_normal', 'custom'].forEach(function (id) {
      var m = MODELS[id];
      ok(m && m.id === id, '缺少模型 ' + id);
      ok(/[\u4e00-\u9fa5]/.test(m.name), '模型名应为中文：' + m.name);
      ok(Array.isArray(m.freq_range_mhz) && m.freq_range_mhz.length === 2, '频率范围不符：' + id);
      ok(m.description && m.description.length > 10, '说明过短：' + id);
    });
    ['gsm', 'cdma', 'wcdma', 'lte', 'nr5g', 'wifi', 'bluetooth'].forEach(function (id) {
      var r = RAT_INFO[id];
      ok(r && Array.isArray(r.bands) && r.bands.length > 0, '制式 ' + id + ' 缺频段表');
      ok(isNum(r.typical_range_m) && r.typical_range_m > 0, id + ' 缺典型覆盖半径');
      ok(/[\u4e00-\u9fa5]/.test(r.note || '') || /[\u4e00-\u9fa5]/.test(r.name), id + ' 说明应为中文');
      r.bands.forEach(function (b, i) {
        ok(isNum(b.freq_mhz) && b.freq_mhz > 0, id + ' 频段 ' + i + ' 频率非数值');
        ok(b.earfcn_or_arfcn_range && b.duplex, id + ' 频段 ' + i + ' 字段不全');
      });
    });
    OPERATORS.forEach(function (o, i) {
      ok(/^\d{3}$/.test(o.mcc), 'MCC 应为 3 位：' + o.mcc + ' @' + i);
      ok(/^\d{2,3}$/.test(o.mnc), 'MNC 格式不符：' + o.mnc + ' @' + i);
      ok(o.name && o.country, '运营商字段缺失：' + JSON.stringify(o));
    });
    ok(OPERATORS.length >= 100, '运营商总数 ' + OPERATORS.length + ' 少于 100');
    return '模型 7 / 制式 7 / 运营商 ' + OPERATORS.length + ' 条，字段齐备';
  });

  T('健壮性：全 API 垃圾输入不抛异常、不产 NaN', function () {
    var junk = [undefined, null, NaN, Infinity, -Infinity, '', 'abc', {}, [], [NaN, 'x'], { lat: 'x', lon: null }];
    var fns = ['operatorName', 'normalizeTower', 'parseInput', 'rssiToDistance', 'distanceToRssi', 'sectorPolygon',
      'trilaterate', 'triangulateBearings', 'multilaterateTDOA', 'tdoaDistanceFromNs', 'gdopFromGeometry',
      'fingerprintMatch', 'wifiScanParse', 'channelToFreq', 'freqToChannel', 'bleProximity', 'pathLoss'];
    var calls = 0, threw = 0, dirty = [];
    fns.forEach(function (name) {
      junk.forEach(function (a) {
        junk.slice(0, 4).forEach(function (b) {
          calls++;
          var v;
          try { v = API[name](a, b); }
          catch (e) { threw++; dirty.push(name + '(' + JSON.stringify(a) + ') 抛异常 ' + e.message); return; }
          var d = bad(v, name);
          if (d) dirty.push(d);
        });
      });
    });
    ok(threw === 0, threw + ' 次调用抛出异常');
    ok(!dirty.length, dirty.slice(0, 3).join('；'));
    var r = trilaterate([{ label: '共线A', lat: 31.23, lon: 121.47, range_m: 500 }, { label: '共线B', lat: 31.24, lon: 121.47, range_m: 400 },
      { label: '共线C', lat: 31.25, lon: 121.47, range_m: 300 }], {});
    ok(r.ok === true || r.method === 'weighted-centroid', '共线基站应退化而非崩溃：' + r.method);
    clean(r, 'collinear');
    return calls + ' 次垃圾调用，0 异常，' + dirty.length + ' 个 NaN 泄漏';
  });

  T('导出面与内部一致性', function () {
    var need = ['MODELS', 'RAT_INFO', 'OPERATORS', 'operatorName', 'normalizeTower', 'parseInput', 'rssiToDistance',
      'distanceToRssi', 'sectorPolygon', 'trilaterate', 'triangulateBearings', 'multilaterateTDOA', 'tdoaDistanceFromNs',
      'gdopFromGeometry', 'fingerprintMatch', 'wifiScanParse', 'channelToFreq', 'freqToChannel', 'bleProximity', 'selfTest'];
    need.forEach(function (k) { ok(API[k] != null, 'GEOCELL 缺少导出 ' + k); });
    ok(globalThis.GEOCELL === API || global.GEOCELL === API, '未挂到全局 GEOCELL');
    ok(/[\u4e00-\u9fa5]/.test(API.MODELS.okumura.name), '用户可见标签应为中文');
    var r1 = API.rssiToDistance(-95, { model: 'okumura', freq_mhz: 800 });
    var r2 = trilaterate([{ lat: 31.23, lon: 121.47, rsrp: -95, freq_mhz: 800, tx_power_dbm: 43 }], { model: 'okumura' });
    ok(Math.abs(r2.ranges_m[0] - r1.dist_m) < 1, 'trilaterate 内部距离应与 rssiToDistance 一致：' + r2.ranges_m[0] + ' vs ' + r1.dist_m);
    return '必需导出 ' + need.length + ' 项齐备，内部链路预算一致';
  });

  // 运行器：任何用例异常都转成失败记录，selfTest 本身绝不抛异常
  function selfTest() {
    var out = [];
    TESTS.forEach(function (t) {
      var rec = { name: t.name, pass: false, detail: '' };
      try { rec.detail = String(t.fn() || 'ok'); rec.pass = true; }
      catch (e) { rec.detail = '失败：' + (e && e.message ? e.message : String(e)); }
      out.push(rec);
    });
    return out;
  }

  function pathLossExposed(dist_m, opts) {
    var o = normOpts(opts), d = clamp(safe(num(dist_m), 1), 1, 1e7);
    return { model: o.model, dist_m: d, path_loss_db: pathLossDb(o.model, d, o), freq_mhz: o.freq_mhz,
      environment: o.env, eirp_dbm: o.tx + o.gain };
  }

  var API = {
    VERSION: '1.0.0',
    MODELS: MODELS, RAT_INFO: RAT_INFO, OPERATORS: OPERATORS, WGS84: WGS84,
    SPEED_OF_LIGHT_M_S: C_MS, M_PER_DEGREE_LAT: rnd(M_PER_DEG_LAT, 3), M_PER_DEGREE_LON_EQUATOR: rnd(M_PER_DEG_LON, 3),
    operatorName: operatorName, normalizeTower: normalizeTower, parseInput: parseInput,
    rssiToDistance: rssiToDistance, distanceToRssi: distanceToRssi, pathLoss: pathLossExposed,
    sectorPolygon: sectorPolygon, trilaterate: trilaterate, triangulateBearings: triangulateBearings,
    multilaterateTDOA: multilaterateTDOA, tdoaDistanceFromNs: tdoaDistanceFromNs, gdopFromGeometry: gdopFromGeometry,
    fingerprintMatch: fingerprintMatch, wifiScanParse: wifiScanParse,
    channelToFreq: channelToFreq, freqToChannel: freqToChannel, bleProximity: bleProximity, selfTest: selfTest,
    haversineMeters: haversineMeters, bearingDeg: bearingDeg, destinationPoint: destinationPoint,
    toPlane: toPlane, toLatLon: toLatLon, clamp: clamp, wrap360: wrap360
  };
  global.GEOCELL = API;
  globalThis.GEOCELL = API;
})(globalThis);
