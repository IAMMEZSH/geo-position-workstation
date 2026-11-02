/*
 * core-gnss.js — 经纬度定位工作站 · GNSS 卫星定位引擎
 * 纯浏览器脚本：无 import/export、无 DOM、无 fetch、无第三方库；Node 下可直接 require 跑数值自检。
 *
 * 覆盖：NMEA-0183 全文本解析与生成、GPS/BDS/GAL 广播星历→卫星位置、GLONASS 导航电文→卫星位置、
 *       单点加权最小二乘 + 卫星钟差/相对论/地球自转改正、对流层与电离层延迟模型、
 *       DOP 几何强度、卡方完整性检验与故障剔除(FDE)、QZS L6 / BDS PPP-B2b / BeiDou-3 CSAS 修复弹道解算、
 *       定位质量评估（CEP/σ/星历龄期/信噪比）、定位结果加权融合（GNSS/基站/Wi-Fi/IP）。
 *
 * 诚实性约定（这个项目里最重要的一条）：
 *   1) 所有来自规范文档的常数都在注释里写明「是谁的哪条公式」，并在 selfTest() 里配一条
 *      **与该常数无关的几何/分析恒等式**去抓「常数抄错、弧度当角度、符号写反」这类错误；
 *      没有任何断言是靠「我记得标准答案是多少」来判定通过的。
 *   2) 本文件**不内置任何几何高程基准面（大地水准面差距 N）**：EGM96/EGM2008 的球谐系数没有随包分发，
 *      凭空给一个 N 值就是编数据。所有涉及正高/正常高的接口都要求调用方显式提供 N，并在返回里标注来源。
 *   3) 修复弹道解算（L6 / PPP-B2b / CSAS）是「播发格式解析 + 单程伪距定位」的教科书实现，
 *      它不实现 PPP 载波相位模糊度解算，因此精度量级是米级~分米级，返回里必须原样带上这个说明。
 */
(function (global) {
  'use strict';

  /* ================================================================ 0. 基础工具 */
  const PI = Math.PI, D2R = PI / 180, R2D = 180 / PI;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const round = (v, n) => { const p = Math.pow(10, n == null ? 6 : n); return Math.round(v * p) / p; };
  const wrap360 = (a) => ((a % 360) + 360) % 360;
  const wrap180 = (a) => { const x = wrap360(a); return x > 180 ? x - 360 : x; };
  const wrap2pi = (a) => { const t = 2 * PI; return ((a % t) + t) % t; };

  // WGS84（大地测量常数取 GEOGEO，缺失时用同一套数值的本地副本，保证独立可跑）
  const G = () => (typeof global.GEOGEO === 'object' && global.GEOGEO ? global.GEOGEO : null);
  const WGS84 = { a: 6378137.0, f: 1 / 298.257223563 };
  WGS84.b = WGS84.a * (1 - WGS84.f);
  WGS84.e2 = WGS84.f * (2 - WGS84.f);
  WGS84.ep2 = WGS84.e2 / (1 - WGS84.e2);

  const C_LIGHT = 299792458;          // m/s，SI 定义值（精确）
  const OMEGA_E_DOT = 7.2921151467e-5; // rad/s，WGS84 定义的地球自转角速率
  // 地心引力常数：ICD-GPS-200 在用户段把开普勒平均角速率定义为 n = sqrt(μ / A^(3/2))，
  // 取 μ = 3.988065984e14（这是规范里的规定值，与物理 GM=3.986004418e14 略有差异）。
  // 差异为什么无关紧要：控制段拟合 Δn 时用的是它自己的 μ，用户段的偏差被广播的 Δn 吸收，
  // 残差只体现在 (t−toe) 的高阶项上。selfTest 用「与 μ 无关的轨道几何恒等式」抓其它错误。
  const MU_GPS = 3.988065984e14;
  const MU_BDS = 3.9886004418e14;     // BDS-SIS-ICD-3.0 规定值（同样被 Δn 吸收）
  const MU_GAL = 3.986004418e14;      // Galileo ICD 使用 GGM05 值
  const MU_GLN = 3.986004418e14;      // GLONASS PZ-90.11 的 μ
  const F_REL_GPS = -4.442807633e-10; // ICD-GPS-200 相对论修正系数 F（= −2·√μ / c²）
  const F_REL_BDS = -4.442807633e-10;
  const F_REL_GAL = -4.442807633e-10;

  // 大地坐标 → ECEF（标准椭球公式，测试用「赤道/极点/45° 的解析值」三条恒等式抓错）
  function geodeticToEcef(lat, lon, h) {
    if (!isNum(lat) || !isNum(lon)) return { error: '经纬度非法' };
    const p = clamp(lat, -90, 90), l = wrap180(lon) * D2R, hh = isNum(h) ? h : 0;
    const s = Math.sin(p * D2R), c = Math.cos(p * D2R);
    const nu = WGS84.a / Math.sqrt(1 - WGS84.e2 * s * s);
    return {
      x: (nu + hh) * c * Math.cos(l),
      y: (nu + hh) * c * Math.sin(l),
      z: (nu * (1 - WGS84.e2) + hh) * s,
      nu: nu
    };
  }
  // ECEF → 大地坐标：用解析的 Ferrari/Bowring 闭式（不迭代），恒等式测试抓符号错
  function ecefToGeodetic(x, y, z) {
    if (!isNum(x) || !isNum(y) || !isNum(z)) return { error: 'ECEF 需要三个数值' };
    const p = Math.hypot(x, y);
    if (p < 1e-9) {
      return { lat: z >= 0 ? 90 : -90, lon: 0, h: Math.abs(z) - WGS84.b, ellipsoid_height: Math.abs(z) - WGS84.b };
    }
    const th = Math.atan2(z * WGS84.a, p * WGS84.b);           // 简化纬度（Bowring 1976）
    const st = Math.sin(th), ct = Math.cos(th);
    const lat = Math.atan2(z + WGS84.ep2 * WGS84.b * st * st * st,
      p - WGS84.e2 * WGS84.a * ct * ct * ct);
    const s = Math.sin(lat), nu = WGS84.a / Math.sqrt(1 - WGS84.e2 * s * s);
    const lon = Math.atan2(y, x);
    const h = p / Math.cos(lat) - nu;
    return { lat: lat * R2D, lon: wrap180(lon * R2D), h: h, ellipsoid_height: h, nu: nu };
  }
  // 站心 ENU 旋转矩阵（用于 DOP 与误差椭圆）
  function enuMatrix(lat, lon) {
    if (!isNum(lat) || !isNum(lon)) return { error: 'enuMatrix 需要有限的纬度与经度' };
    const p = lat * D2R, l = lon * D2R, s = Math.sin(p), c = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
    return [
      [-sl, cl, 0],
      [-s * cl, -s * sl, c],
      [c * cl, c * sl, s]
    ];
  }
  // 经纬度差 → 本地米（近似用平均半径；需要椭球精度时由调用方改用 GEOGEO）
  const MEAN_R = 6371008.8;            // IUGG 平均半径
  const mPerDegLat = () => MEAN_R * D2R;
  const mPerDegLon = (lat) => MEAN_R * Math.cos(lat * D2R) * D2R;

  /* ================================================================ 1. 时间系统 */
  // 日历 → 儒略日（格里历 1582-10-15 起生效，之前按儒略历；Meeus 第 7 章）
  // B 项必须是「2 − A + INT(A/4)」（格里历）或 0（儒略历）。写成 floor(y/4)+… 那种形式
  // 会带来约 480 天的常数偏差——逐日差分测不出来（差分把常数消掉了），只有绝对锚点能抓。
  function jdFromCalendar(year, month, dayFrac) {
    if (!isNum(year) || !isNum(month) || !isNum(dayFrac)) return NaN;
    let y = year, m = month;
    if (m <= 2) { y -= 1; m += 12; }
    const a = Math.floor(y / 100);
    const gregorian = !(y < 1582 || (y === 1582 && (m < 10 || (m === 10 && dayFrac < 15))));
    const b = gregorian ? (2 - a + Math.floor(a / 4)) : 0;
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + dayFrac + b - 1524.5;
  }
  function jdToCalendar(jd) {
    if (!isNum(jd)) return { error: 'JD 非法' };
    // 范围闸门：|JD| 超过 1e8（约 27 万年）时浮点已经无法精确表示「一天」，
    // 与其给一个看起来像日期的错误值，不如明确报错。
    if (Math.abs(jd) > 1e8) return { error: 'JD 超出可用范围（|JD| ≤ 1e8）' };
    // Meeus《Astronomical Algorithms》第 7 章的严格逆算法：
    // 它是 jdFromCalendar 的解析逆，1582-10-15 的历法切换由 Z 的分档自动处理，
    // 不需要「估年 + 按年积日校正」那种近似（近似版在切换年前后会把整月判错）。
    const z = Math.floor(jd + 0.5), f = jd + 0.5 - z;
    let a;
    if (z < 2299161) {
      a = z;                                          // 儒略历日期：不加格里修正
    } else {
      const alpha = Math.floor((z - 1867216.25) / 36524.25);
      a = z + 1 + alpha - Math.floor(alpha / 4);
    }
    const b = a + 1524;
    const c = Math.floor((b - 122.1) / 365.25);
    const d = Math.floor(365.25 * c);
    const e = Math.floor((b - d) / 30.6001);
    const day = Math.floor(b - d - Math.floor(30.6001 * e) + f);
    const month = (e < 14) ? e - 1 : e - 13;
    const year = (month > 2) ? c - 4716 : c - 4715;
    if (!Number.isInteger(day) || month < 1 || month > 12) return { error: 'JD 无法落到合法日历（' + jd + '）' };
    const doy = Math.round(z - jdFromCalendar(year, 1, 1) + 0.5);
    return { year: year, month: month, day: day, day_of_year: Number.isInteger(doy) && doy >= 1 ? doy : null, fractional_day: f, date: isoFromParts(year, month, day, f) };
  }
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const MONTH_LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const monthLen = (y, m) => (!isNum(m) || m < 1 || m > 12) ? NaN : (m === 2 && isLeap(y)) ? 29 : MONTH_LEN[m - 1];
  function isoFromParts(y, m, d, f) {
    const secs = Math.round(f * 86400);
    const hh = Math.floor(secs / 3600) % 24, mm = Math.floor(secs / 60) % 60, ss = secs % 60;
    const pad = (n, w) => String(Math.abs(n)).padStart(w || 2, '0');
    // 公元前（天文纪年，0 年 = 公元前 1 年）必须显式标注，否则 -4713 会被印成 4713，
    // 看起来像一个合法的公元年份——这是「静默错误答案」，比报错更糟。
    return (y < 0 ? 'BCE-' : '') + pad(y, 4) + '-' + pad(m) + '-' + pad(d) + 'T' + pad(hh) + ':' + pad(mm) + ':' + pad(ss) + 'Z';
  }
  // GPS 周内秒：以 1980-01-06 00:00:00 UTC(JD 2444244.5, 即 1980 年第 6 天) 为原点。
  // 注意：GPS 周计数不含闰秒，t_gps = UTC 的时刻差（本函数按「UTC≈GPST 的日期部分」处理，
  // 差值由 leapSeconds 参数显式给出，绝不在内部猜闰秒表）。
  const GPS_EPOCH_JD = 2444244.5;
  function gpsWeekSecond(jdUtc, leapSeconds) {
    if (!isNum(jdUtc)) return { error: 'JD 非法' };
    const ls = isNum(leapSeconds) ? leapSeconds : 0;
    const towTotal = (jdUtc + ls / 86400 - GPS_EPOCH_JD) * 86400;
    const week = Math.floor(towTotal / 604800);
    return { week: week, tow: towTotal - week * 604800, total_seconds: towTotal };
  }
  function jdFromGpsWeekSecond(week, tow, leapSeconds) {
    if (!isNum(week) || !isNum(tow)) return { error: '周号/TOW 非法' };
    const ls = isNum(leapSeconds) ? leapSeconds : 0;
    return { jd_utc: GPS_EPOCH_JD + (week * 604800 + tow - ls) / 86400, tow_within_week: tow - Math.floor(tow / 604800) * 604800 };
  }
  // 年积日（自研电文常用 YYYYDDD + HHMMSS，GLONASS 的 ND/TK 也是这套）
  function dayOfYear(year, month, day) {
    // 必须校验：month=Infinity 会让「逐月累加」的循环永不退出，month=13 会读到月份表外的 undefined。
    if (!isNum(year) || !isNum(month) || !isNum(day)) return null;
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    if (!Number.isInteger(day) || day < 1 || day > monthLen(year, month)) return null;
    let d = day;
    for (let m = 1; m < month; m++) d += monthLen(year, m);
    return d;
  }
  // 闰秒表：**不内置**。内置一张不完整的表会让用户以为它是新的。
  // 因此所有需要 UTC↔GPST 的接口都要求显式传入 leapSeconds；未传时按 0 计算并在返回里标注。
  // UI 层可以从联网层拿到当前值（见 core-net.js 的 /api/leapsecond），离线时明确告知用户。
  function parseUtc(input) {
    if (isNum(input)) return { jd: input, kind: 'julian_day' };
    const s = String(input == null ? '' : input).trim();
    if (!s) return { error: '时间输入为空' };
    let m = s.match(/^(-?\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
      const off = m[7] ? zoneOffsetMinutes(m[7]) : 0;
      const mo = Number(m[2]), dy = Number(m[3]), hr = Number(m[4]), mi = Number(m[5]), sc = Number(m[6] || 0);
      // 正则只保证「两位数字」，不保证它是合法日历：99 月 / 25 时都得挡下来，
      // 否则会返回一个看起来像 JD 的数（静默错误答案）。
      if (mo < 1 || mo > 12 || dy < 1 || dy > 31 || hr > 23 || mi > 59 || sc > 60) {
        return { error: 'ISO 时间分量为 0 或越界（月 1-12 / 日 1-31 / 时 0-23 / 分秒 0-59，闰秒允许 60）' };
      }
      if (dy > monthLen(Number(m[1]), mo)) return { error: m[1] + '-' + m[2] + ' 只有 ' + monthLen(Number(m[1]), mo) + ' 天，给的是 ' + m[3] + ' 日' };
      const secOfDay = hr * 3600 + mi * 60 + sc;
      const jd = jdFromCalendar(Number(m[1]), mo, dy + secOfDay / 86400) - off / 1440;
      return { jd: jd, year: Number(m[1]), month: mo, day: dy, sec_of_day: secOfDay, offset_min: off, kind: 'iso' };
    }
    m = s.match(/^(\d{4})(\d{3})[T ]?(\d{2})(\d{2})(\d{2})?$/);   // YYYYDDD + HHMMSS
    if (m) {
      const y = Number(m[1]), d0 = Number(m[2]);
      if (d0 < 1 || d0 > (isLeap(y) ? 366 : 365)) return { error: '年第 ' + d0 + ' 天超出该年长度（' + y + ' ' + (isLeap(y) ? '闰' : '平') + '年）' };
      let mo = 1, dd = d0;
      while (dd > monthLen(y, mo)) { dd -= monthLen(y, mo); mo++; }
      const sod = Number(m[3]) * 3600 + Number(m[4]) * 60 + Number(m[5] || 0);
      return { jd: jdFromCalendar(y, mo, dd + sod / 86400), year: y, month: mo, day: dd, sec_of_day: sod, kind: 'doy' };
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return { jd: jdFromCalendar(Number(m[1]), Number(m[2]), Number(m[3])), year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), sec_of_day: 0, kind: 'date' };
    const n = Number(s);
    if (isFinite(n) && Math.abs(n) > 1e5) return { jd: n, kind: 'numeric_jd' };
    return { error: '时间格式无法识别，支持 ISO8601 / YYYYDDDHHMMSS / YYYY-MM-DD / 数值 JD' };
  }
  function zoneOffsetMinutes(z) {
    const m = String(z).match(/^(?:Z|([+-])(\d{2}):?(\d{2}))$/);
    if (!m || !m[1]) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  }

  /* ================================================================ 2. 频点 / 信号表 */
  // 频点值取各系统公开规范；selfTest 用两条恒等式抓错：λ = c/f 必须落在 L 波段(0.17~0.30 m)，
  // 且同一频率在不同系统里必须给出一致波长（L5/E5a/B2a 标称同频 1176.45 MHz 就是这种交叉校验）。
  const SIGNALS = [
    { sys: 'GPS', id: 'L1', f_mhz: 1575.42, mod: 'C/A·P(Y)·L1C', use: '标准单点/电离层一阶' },
    { sys: 'GPS', id: 'L2', f_mhz: 1227.60, mod: 'P(Y)·Q·L2C', use: '无电离层组合的第二频点' },
    { sys: 'GPS', id: 'L5', f_mhz: 1176.45, mod: 'I/Q (L5)', use: '安全业务， chip 率高' },
    { sys: 'GAL', id: 'E1', f_mhz: 1575.42, mod: 'BOC(1,1)', use: '与 GPS L1 同频' },
    { sys: 'GAL', id: 'E5a', f_mhz: 1176.45, mod: 'AltBOC(15,10,6,1)', use: '与 L5/B2a 同频' },
    { sys: 'GAL', id: 'E5b', f_mhz: 1207.14, mod: 'AltBOC(15,10,6,1)', use: '与 B2/B2b 同频' },
    { sys: 'GAL', id: 'E6', f_mhz: 1278.75, mod: 'BPSM', use: '高精度 HAS 播发频段' },
    { sys: 'BDS', id: 'B1I', f_mhz: 1561.098, mod: 'DHPSK(2,1)', use: '北斗二号基本频点' },
    { sys: 'BDS', id: 'B1C', f_mhz: 1575.42, mod: 'BOC(1,6,1,1)', use: '北斗三号与 GPS L1 兼容' },
    { sys: 'BDS', id: 'B2a', f_mhz: 1176.45, mod: 'BPSM(10.23)', use: 'PPP-B2b 修复弹道在此频点' },
    { sys: 'BDS', id: 'B2b', f_mhz: 1207.14, mod: 'BPSM(10.23)', use: '与 E5b 同频' },
    { sys: 'BDS', id: 'B3I', f_mhz: 1268.52, mod: 'BPSM(10.23)', use: '高精度/CSAS 修正播发' },
    { sys: 'QZS', id: 'L1', f_mhz: 1575.42, mod: 'C/A·L1SAIF', use: '厘米级 GRES / MICHIBIKI' },
    { sys: 'QZS', id: 'L2', f_mhz: 1227.60, mod: 'L2C', use: '与 GPS L2 同频' },
    { sys: 'QZS', id: 'L5', f_mhz: 1176.45, mod: 'I/Q', use: '与 GPS L5 同频' },
    { sys: 'QZS', id: 'L6', f_mhz: 1278.75, mod: 'PSK', use: '亚米级 CLAS 修复播发' },
    { sys: 'IRN', id: 'L5', f_mhz: 1176.45, mod: 'I/Q', use: 'NavIC 区域服务' },
    { sys: 'IRN', id: 'S', f_mhz: 2492.028, mod: 'BPSK', use: 'S 频段（波长 0.12 m）' },
    { sys: 'SBAS', id: 'L1', f_mhz: 1575.42, mod: 'C/A', use: '星基增强 GEO 伪卫星' }
  ];
  // 数值函数用 NaN 表示「定义域外」；±Infinity 一律不外泄——除零得到的「无穷大波长」会被 UI 当成真数显示。
  const safeNum = (v) => (isFinite(v) ? v : NaN);
  const wavelengthM = (f_mhz) => safeNum(isNum(f_mhz) ? C_LIGHT / (f_mhz * 1e6) : NaN);
  // GLONASS FDMA：频道号 k → L1/L2 载波频率（2016 年后扩展了负频道与 k=13..19，但 k≤12 为现行主流）
  function glonassChannelFreq(k) {
    const kk = Number(k);
    if (!isFinite(kk) || kk < -7 || kk > 14) return { error: 'GLONASS 频道 k 需为 −7~14，收到 ' + k };
    return {
      f1_mhz: 1602 + 0.5625 * kk,
      f2_mhz: 1246 + 0.4375 * kk,
      f3_mhz: 1202.0625 + 0.6875 * kk,
      lambda1_m: wavelengthM(1602 + 0.5625 * kk)
    };
  }

  /* ================================================================ 3. NMEA-0183 */
  // 校验和：$ 与 * 之间所有字符的 XOR，输出为两位大写十六进制（NMEA-0183 定义）
  function nmeaChecksum(body) {
    let c = 0;
    const s = String(body || '');
    for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i) & 0x7f;
    return c;
  }
  function nmeaWrap(body) {
    return '$' + body + '*' + nmeaChecksum(body).toString(16).toUpperCase().padStart(2, '0');
  }
  const TALKER = {
    GP: 'GPS', GL: 'GLONASS', GA: 'Galileo', BD: 'BeiDou 北斗', CB: 'BeiDou(北斗新标识)',
    GN: '多星座合并', GQ: 'QZSS', QZ: 'QZSS', LJ: 'NavIC/IRNSS', SB: 'SBAS 伪卫星',
    II: '印度 GAGAN(SBAS)', WL: 'WAAS(SBAS)', ML: 'MSAS(SBAS)', MH: 'GAGAN(SBAS)', CD: '北斗(CD)'
  };
  const NMEA_WORDS = {
    A: '有效', V: '无效', S: '模拟', N: 'GPS 定位', M: '米制', E: '预估', P: '精确', K: '卡尔曼',
    R: '差分已使用', F: 'RTK 固定解', G: 'RTK 浮动解', W: '手动输入', U: '数据更新超时'
  };
  function splitSentence(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { error: '空语句' };
    let body = s, ckIn = null;
    const star = s.lastIndexOf('*');
    if (star >= 0) {
      body = s.slice(0, star);
      const hx = s.slice(star + 1).replace(/[^0-9A-Fa-f]/g, '');
      ckIn = parseInt(hx, 16);
      if (!isFinite(ckIn)) return { error: '校验和不是十六进制：' + s.slice(star + 1) };
    }
    const dollar = body.indexOf('$');
    const excl = body.indexOf('!');
    const start = Math.max(dollar, excl);
    if (start < 0) return { error: '缺少 $ 或 ! 起始符' };
    const content = body.slice(start + 1).split('\r')[0].split('\n')[0];
    const computed = nmeaChecksum(body.slice(start + 1));
    const parts = content.split(',');
    const head = parts[0] || '';
    let type = head, talker = '';
    if (/^[A-Z]{2,3}/.test(head)) {
      // 两字 Talker + 三字类型；AIS 之类是 5 字母头，这里只处理定位语句
      if (head.length >= 5 && /^[A-Z]{5}$/.test(head)) { talker = head.slice(0, 2); type = head.slice(2); }
      else if (/^[A-Z]{2}[A-Z]{3}$/.test(head)) { talker = head.slice(0, 2); type = head.slice(2); }
      else if (/^[A-Z]{3,}/.test(head)) { talker = head.slice(0, 2); type = head.slice(2); }
    }
    return {
      raw: s, body: content, fields: parts.slice(1),
      talker, system: TALKER[talker] || (talker ? '未知 Talker ' + talker : '无 Talker'),
      type, checksum_input: ckIn, checksum_computed: computed,
      checksum_ok: ckIn == null ? null : ckIn === computed
    };
  }
  // 度分 → 十进制度：NMEA 的纬度是 DDMM.mmmm、经度是 DDDMM.mmmm
  function nmeaCoordToDeg(v, hemi) {
    if (v === '' || v == null) return { value: null };
    const num = Number(v);
    if (!isFinite(num)) return { error: '坐标字段不是数字：' + v };
    const sign = hemi === 'S' || hemi === 'W' ? -1 : 1;
    const deg = Math.trunc(num / 100);
    const min = Math.abs(num) - Math.abs(deg * 100);
    return { value: sign * (deg + min / 60), degrees: deg, minutes: min };
  }
  function degToNmeaCoord(lat, lon) {
    const conv = (v, isLat) => {
      const deg = Math.trunc(Math.abs(v));
      const min = (Math.abs(v) - deg) * 60;
      const txt = isLat ? String(deg).padStart(2, '0') + min.toFixed(4).padStart(7, '0')
        : String(deg).padStart(3, '0') + min.toFixed(4).padStart(7, '0');
      return txt;
    };
    return { lat: conv(lat, true), hemiLat: lat >= 0 ? 'N' : 'S', lon: conv(lon, false), hemiLon: lon >= 0 ? 'E' : 'W' };
  }
  function nmeaTime(txt) {
    const s = String(txt == null ? '' : txt);
    const m = s.match(/^(\d{2})(\d{2})(\d{2})(\.\d+)?$/);
    if (!m) return { error: '时间字段非法：' + s };
    return { hour: Number(m[1]), minute: Number(m[2]), second: Number(m[3]) + Number(m[4] || 0), hhmmss: s, fractional: m[4] || '' };
  }
  function nmeaDate(txt) {
    const s = String(txt == null ? '' : txt);
    const m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})?$/);   // ddmmyy（RMC/GLL 惯用）或 ddmmyyyy（ZDA 规定 4 位年）
    if (!m) return { error: '日期字段非法：' + s };
    const d = Number(m[1]), mo = Number(m[2]);
    let y = m[4] != null ? Number(m[3] + m[4]) : Number(m[3]);
    if (m[4] == null) y += (y >= 80 ? 1900 : 2000);   // 惯例：80~99 为 20 世纪，00~79 为 21 世纪（GPS 纪元起点）
    if (mo < 1 || mo > 12 || d < 1 || d > monthLen(y, mo)) return { error: '日期不存在：' + s };
    return { year: y, month: mo, day: d, jd: jdFromCalendar(y, mo, d), iso: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0') };
  }
  const numOr = (v, dflt) => { const n = Number(v); return isFinite(n) && String(v).trim() !== '' ? n : (dflt === undefined ? null : dflt); };
  // 卫星高度角的三个合法别名（elevation_deg / el / elev），全引擎统一走这一个入口
  const satElev = (s) => (s && s.elevation_deg != null ? numOr(s.elevation_deg, null)
    : (s && s.el != null ? numOr(s.el, null) : (s ? numOr(s.elev, null) : null)));

  function decodeNmea(raw) {
    const st = splitSentence(raw);
    if (st.error) return st;
    if (st.checksum_ok === false) st.warning = '校验和不符（输入 ' + (st.checksum_input == null ? '缺' : st.checksum_input.toString(16)) + '，计算 ' + st.checksum_computed.toString(16) + '），数值仍按原文解析';
    const F = st.fields, T = st.type;
    const out = Object.assign({
      type: T, system: st.system, talker: st.talker,
      checksum_ok: st.checksum_ok, checksum_input: st.checksum_input, checksum_computed: st.checksum_computed
    }, st.checksum_ok === false ? { warning: st.warning } : {});
    if (T === 'GGA' || T === 'GXA' || T === 'GNS') {
      let i = 0;
      const t = nmeaTime(F[i++]); if (t.error) out.time_error = t.error; else out.time = t;
      if (T === 'GXA') { out.mode = F[i++]; }
      const la = nmeaCoordToDeg(F[i], F[i + 1]); i += 2;
      const lo = nmeaCoordToDeg(F[i], F[i + 1]); i += 2;
      if (la.error) out.error = la.error; if (lo.error) out.error = lo.error;
      out.lat = la.value; out.lon = lo.value;
      if (T === 'GNS') {
        out.mode_indicator = F[i++]; out.sats = numOr(F[i++]); out.hdop = numOr(F[i++]); out.alt_geoid = numOr(F[i++]);
        out.geoid_sep = numOr(F[i++]); out.age = numOr(F[i++]); out.ref_station = F[i++];
        out.pos_type = out.mode_indicator;
      } else {
        out.fix_quality = numOr(F[i++]); out.sats = numOr(F[i++]); out.hdop = numOr(F[i++]);
        out.alt = numOr(F[i++]); out.alt_unit = F[i++];
        out.geoid_sep = numOr(F[i++]); out.geoid_unit = F[i++];
        out.age = numOr(F[i++]); out.ref_station = F[i++];
        out.fix = GGA_QUALITY[out.fix_quality] || { label: '未知质量 ' + out.fix_quality, usable: false };
      }
      // 正高 = 大地高 − N；这里 N 是语句自己给的 geoid_sep，不是本引擎编造的
      if (isNum(out.alt) && isNum(out.geoid_sep)) out.height_msl = out.alt - out.geoid_sep;
      if (isNum(out.alt)) out.height_ellipsoid = out.alt;
    } else if (T === 'RMC') {
      let i = 0;
      const t = nmeaTime(F[i++]); if (t.error) out.time_error = t.error; else out.time = t;
      out.status = F[i++]; out.status_text = NMEA_WORDS[out.status] || out.status;
      const la = nmeaCoordToDeg(F[i], F[i + 1]); i += 2;
      const lo = nmeaCoordToDeg(F[i], F[i + 1]); i += 2;
      if (la.error) out.error = la.error; if (lo.error) out.error = lo.error;
      out.lat = la.value; out.lon = lo.value;
      out.sog_knots = numOr(F[i++]); out.cog_deg = numOr(F[i++]);
      const d = nmeaDate(F[i++]); if (d.error) out.date_error = d.error; else { out.date = d; out.jd = d.jd + (out.time ? (out.time.hour * 3600 + out.time.minute * 60 + out.time.second) / 86400 : 0); }
      out.mv_deg = numOr(F[i++]); out.mv_dir = F[i++];
      out.mode_indicator = F[i++]; out.nav_status = F[i++];
      if (isNum(out.sog_knots)) out.sog_mps = out.sog_knots * 0.5144444444;  // 1 海里 = 1852 m，精确
    } else if (T === 'GLL') {
      const la = nmeaCoordToDeg(F[0], F[1]);
      const lo = nmeaCoordToDeg(F[2], F[3]);
      out.lat = la.value; out.lon = lo.value;
      if (la.error) out.error = la.error; if (lo.error) out.error = lo.error;
      const t = nmeaTime(F[4]); if (t.error) out.time_error = t.error; else out.time = t;
      out.status = F[5]; out.date = F[6]; out.pos_type = F[7];
    } else if (T === 'GSA') {
      out.mode = F[0]; out.fix_type = Number(F[1]);
      out.fix_type_text = { 1: '无定位', 2: '2D（不估计高度）', 3: '3D' }[Number(F[1])] || '未知';
      const prns = F.slice(2, 14).map((x) => (String(x).trim() === '' ? null : Number(x)));
      out.satellite_prns = prns; out.satellites_used = prns.filter((x) => x != null && isFinite(x)).length;
      out.pdop = numOr(F[14]); out.hdop = numOr(F[15]); out.vdop = numOr(F[16]);
    } else if (T === 'GSV') {
      out.msg_number = Number(F[0]); out.msg_total = Number(F[1]);
      out.sats_in_view_total = numOr(F[2]);
      // 步长判定：NMEA-4.1 在每颗星后面多加一个「signal id」字段（步长 5），老版本是 4
      const rest = F.length - 3;
      const stride = (rest % 5 === 0 && rest % 4 !== 0) ? 5 : 4;
      out.field_stride = stride;
      const rec = [];
      for (let i = 3; i + stride - 1 < F.length; i += stride) {
        const prn = String(F[i]).trim();
        if (prn === '') continue;
        rec.push({
          prn: Number(prn),
          elevation_deg: numOr(F[i + 1]),
          azimuth_deg: numOr(F[i + 2]),
          snr_db: numOr(F[i + 3]),
          signal_id: stride === 5 ? F[i + 4] : undefined
        });
      }
      out.satellites = rec;
    } else if (T === 'VTG') {
      out.cog_true_deg = numOr(F[0]); out.cog_mag_deg = numOr(F[2]);
      out.sog_knots = numOr(F[4]); out.sog_kmh = numOr(F[6]);
      if (isNum(out.sog_kmh)) out.sog_mps = out.sog_kmh / 3.6;
      if (isNum(out.sog_knots)) out.sog_mps = out.sog_mps || out.sog_knots * 0.5144444444;
      out.pos_type = F[7] || F[5];
    } else if (T === 'GST') {
      const t = nmeaTime(F[0]); if (t.error) out.time_error = t.error; else out.time = t;
      out.rms = numOr(F[1]); out.semi_major_m = numOr(F[2]); out.semi_minor_m = numOr(F[3]);
      out.orientation_deg = numOr(F[4]);
      out.lat_err_m = numOr(F[5]); out.lon_err_m = numOr(F[6]); out.alt_err_m = numOr(F[7]);
    } else if (T === 'ZDA') {
      const t = nmeaTime(F[0]); if (t.error) out.time_error = t.error; else out.time = t;
      const d = nmeaDate(F[1] + F[2] + F[3]);
      if (d.error) out.date_error = d.error; else out.date = d;
      out.zone_hours = numOr(F[4]); out.zone_minutes = numOr(F[5]);
      if (out.time && out.date) out.jd = out.date.jd + (out.time.hour * 3600 + out.time.minute * 60 + out.time.second) / 86400 - (out.zone_hours || 0) / 24 - (out.zone_minutes || 0) / 1440;
    } else if (T === 'GBS') {
      out.status = F[0];
      out.lat_res_m = numOr(F[1]); out.lon_res_m = numOr(F[2]); out.alt_res_m = numOr(F[3]);
      out.prn_suspect = F[4] ? Number(F[4]) : null; out.suspect_used = F[5]; out.error_estimation = F[6];
      out.residual_range_m = numOr(F[7]);
    } else if (T === 'HDT') { out.heading_true_deg = numOr(F[0]); out.mode = F[1];
    } else if (T === 'HDG') {
      // 字段序：磁航向, 自差(deviation), 磁偏(declination/variation), 偏的方向 E/W, 传感器零偏
      //   把磁偏当成第 2 个字段会把整条罗经链错位一格（$HEHDG,005.1,,5.4,E 里第 2 项是空的自差）
      out.heading_mag_deg = numOr(F[0]);
      out.deviation_deg = numOr(F[1]);
      out.declination_deg = numOr(F[2]);
      out.declination_dir = String(F[3] || '').trim() || null;
      out.heading_sensor_offset_deg = numOr(F[4]);
      const sgn = out.declination_dir === 'E' ? 1 : (out.declination_dir === 'W' ? -1 : null);
      if (isNum(out.heading_mag_deg) && isNum(out.declination_deg) && sgn != null) {
        out.heading_true_deg = wrap360(out.heading_mag_deg + sgn * out.declination_deg + (isNum(out.deviation_deg) ? out.deviation_deg : 0));
        out.heading_note = '真航向 = 磁航向 + 自差 + 磁偏（东偏为正）';
      } else if (isNum(out.heading_mag_deg)) out.heading_note = '缺磁偏方向或数值，无法化算真航向（不猜 0）';
    } else if (T === 'ROT') { out.rate_of_turn_dps = numOr(F[0]); out.mode = F[1];
    } else if (T === 'ALM' || T === 'STM') { out.not_supported = T + '（' + (T === 'ALM' ? 'alm 需要完整历书拟合，建议用卫星系统级星历文件' : '状态语句') + '）'; out.words = F;
    } else if (/^[A-Z]{3}$/.test(T)) { out.unknown_type = T; out.words = F;
    } else { out.unknown_type = T; out.words = F; }
    if (isNum(out.lat) && isNum(out.lon) && Math.abs(out.lat) > 90) out.error = '纬度越界 ' + out.lat;
    return out;
  }
  const GGA_QUALITY = {
    0: { label: '无定位', usable: false, sigma_m: null },
    1: { label: 'SPS 单点（C/A）', usable: true, sigma_m: 5 },
    2: { label: 'SBAS 差分', usable: true, sigma_m: 1.5 },
    3: { label: 'GG 普通 DGPS', usable: true, sigma_m: 0.8 },
    4: { label: 'GG 高精度 DGPS', usable: true, sigma_m: 0.5 },
    5: { label: 'RTK 固定解', usable: true, sigma_m: 0.02 },
    6: { label: 'RTK 浮动解', usable: true, sigma_m: 0.1 },
    7: { label: '手工/模拟输入', usable: false, sigma_m: null },
    8: { label: '基站位置', usable: false, sigma_m: null },
    9: { label: '连续 GNSS（无检测）', usable: true, sigma_m: 5 }
  };
  // SNR(C/N0 dB-Hz) → 伪距 1σ（经验模型：低信噪比噪声大，35~45 dB-Hz 之间约按 −8 dB/σ² 衰减）
  function snrToUere(snr_db, multipath) {
    const s = Number(snr_db);
    if (!isFinite(s)) return { error: 'C/N0 非法' };
    const mp = isFinite(Number(multipath)) ? Number(multipath) : 0.3;
    // 采用 1σ ≈ σ0 · 10^(−(s−s0)/20) 的量级模型（相位噪声与热噪声的 √S/N 关系），σ0 取 0.3 m @45 dB-Hz
    const base = 0.3 * Math.pow(10, -(clamp(s, 0, 60) - 45) / 20);
    const mpTerm = mp * clamp(1 - (s - 25) / 30, 0.05, 1);
    const iono = 1.5;      // 无电离层模型时给单频典型量级（白天低纬可到 10 m 以上，见电离层模块）
    return { sigma_m: base + mpTerm + iono, noise_m: base, multipath_m: mpTerm, ionosphere_m: iono };
  }
  // 生成 NMEA（用于导出/回放/自检）
  function buildNmea(obj) {
    if (!obj || !obj.type) return { error: '需要 {type:...}' };
    const t = obj.talker || 'GN';
    if (obj.type === 'GGA') {
      const c = degToNmeaCoord(obj.lat, obj.lon);
      const body = [t + 'GGA', hmsto(obj.time), c.lat, c.hemiLat, c.lon, c.hemiLon, obj.fix_quality == null ? 1 : obj.fix_quality,
      obj.sats == null ? 0 : obj.sats, obj.hdop == null ? 0 : obj.hdop, obj.alt == null ? 0 : obj.alt, 'M',
      obj.geoid_sep == null ? 0 : obj.geoid_sep, 'M', obj.age == null ? '' : obj.age, obj.ref_station == null ? '' : obj.ref_station].join(',');
      return { sentence: nmeaWrap(body) };
    }
    if (obj.type === 'RMC') {
      const c = degToNmeaCoord(obj.lat, obj.lon);
      const d = obj.date || '';
      const body = [t + 'RMC', hmsto(obj.time), obj.status || 'A', c.lat, c.hemiLat, c.lon, c.hemiLon,
      obj.sog_knots == null ? '' : obj.sog_knots, obj.cog_deg == null ? '' : obj.cog_deg, d, '', '', obj.mode_indicator || 'A'].join(',');
      return { sentence: nmeaWrap(body) };
    }
    if (obj.type === 'GSA') {
      const f = [t + 'GSA', obj.mode || 'A', obj.fix_type == null ? 3 : obj.fix_type];
      for (let i = 0; i < 12; i++) {
        const p = obj.prns ? obj.prns[i] : null;
        f.push(p == null || p === '' ? '' : String(p).padStart(2, '0'));
      }
      f.push(obj.pdop == null ? '' : obj.pdop, obj.hdop == null ? '' : obj.hdop, obj.vdop == null ? '' : obj.vdop);
      return { sentence: nmeaWrap(f.join(',')) };
    }
    if (obj.type === 'GSV') {
      const sats = obj.satellites || [];
      const per = 4, total = Math.max(1, Math.ceil(sats.length / per));
      const out = [];
      for (let m = 0; m < total; m++) {
        const f = [t + 'GSV', m + 1, total, obj.sats_in_view_total == null ? sats.length : obj.sats_in_view_total];
        for (let i = 0; i < per; i++) {
          const s = sats[m * per + i];
          f.push(s ? s.prn : '', s ? s.elevation_deg : '', s ? s.azimuth_deg : '', s ? s.snr_db : '');
        }
        out.push(nmeaWrap(f.join(',')));
      }
      return { sentences: out };
    }
    return { error: '暂不生成 ' + obj.type + ' 语句' };
  }
  const hmsto = (t) => {
    if (t == null) return '';
    if (typeof t === 'string') return t;
    const s = t.hour * 3600 + t.minute * 60 + t.second;
    const pad = (n) => String(Math.floor(n)).padStart(2, '0');
    return pad(s / 3600) + pad((s % 3600) / 60) + pad(s % 60);
  };
  // 多语句合并（GSV 分片、GGA+RMC+GSV+GSA 同一历元）
  function mergeNmea(lines) {
    const arr = Array.isArray(lines) ? lines : String(lines == null ? '' : lines).split(/\r?\n/);
    const res = { warnings: [], gsv_by_talker: {}, sats_in_view: [], used: [], fix: null, count: 0, skipped: 0 };
    let latest = null;
    for (const ln of arr) {
      if (!String(ln).trim()) continue;
      const d = decodeNmea(ln);
      if (d.error) { res.warnings.push(d.error + ' → ' + String(ln).slice(0, 60)); res.skipped++; continue; }
      res.count++;
      if (d.warning) res.warnings.push(d.warning);
      if (d.type === 'GSV') {
        const k = (d.talker || '?') + String(d.msg_number) + '/' + String(d.msg_total);
        if (!res.gsv_by_talker[k]) res.gsv_by_talker[k] = [];
        res.gsv_by_talker[k].push(d);
        (d.satellites || []).forEach((s) => res.sats_in_view.push(Object.assign({ system: d.system, talker: d.talker }, s)));
      } else if (d.type === 'GSA') {
        res.used = (d.satellite_prns || []).map((p) => p);
        res.pdop = d.pdop; res.hdop = d.hdop; res.vdop = d.vdop; res.fix_type = d.fix_type_text;
      } else if (d.type === 'GGA' || d.type === 'RMC' || d.type === 'GNS' || d.type === 'GLL') {
        if (isNum(d.lat) && isNum(d.lon) && (!latest || !isNum(latest.lat))) latest = d;
        if (isNum(d.lat) && isNum(d.lon)) res.fix = Object.assign({}, res.fix, d);
      } else if (d.type === 'GST') res.uncertainty = d;
      else if (d.type === 'VTG') res.motion = d;
      else if (d.type === 'HDT' || d.type === 'HDG') res.heading = d;
      else if (d.type === 'GBS') res.integrity = d;
      else if (d.type === 'ZDA') res.clock = d;
    }
    res.satellites_in_view = res.sats_in_view;
    res.used_prns = res.used;
    return res;
  }

  /* ================================================================ 4. 广播星历 → 卫星位置 */
  // 开普勒方程 E − e·sinE = M：Newton（初值按 e 大小选择），残差在返回里回显供自检
  function keplerEccentricAnomaly(M, e) {
    if (!isNum(M) || !isNum(e) || e < 0 || e >= 1) return { error: '轨道参数非法（e 必须在 [0,1)）' };
    // 裸牛顿法在高偏心率（e≈0.99）且 M 接近 ±π 时会跳出根区并一路发散——
    // 这里用「牛顿 + 二分保护区间」：E − e·sinE = M 且 |sinE| ≤ 1 ⇒ 根必在 [M−e, M+e] 内，
    // 该区间是严格成立的（不靠猜），所以只要牛顿候选越界就退回中点，收敛是有保证的。
    const k = Math.round(M / (2 * PI));            // 先折到 [−π, π] 求解，最后加回 2π 的整数倍
    const Mr = M - k * 2 * PI;
    let lo = Mr - e, hi = Mr + e;
    let E = Mr + 0.85 * e * (Mr >= 0 ? 1 : -1);    // Danby 起步值，落在区间内
    if (!(E > lo && E < hi)) E = Mr;
    let it = 0, ok = false;
    for (; it < 100; it++) {
      const f = E - e * Math.sin(E) - Mr;
      if (f > 0) hi = E; else lo = E;
      const fp = Math.max(1 - e * Math.cos(E), 1e-16);
      const cand = E - f / fp;
      E = (cand > lo && cand < hi) ? cand : (lo + hi) / 2;
      if (hi - lo < 1e-15) { ok = true; break; }
      if (Math.abs(E - e * Math.sin(E) - Mr) < 1e-14) { ok = true; break; }
    }
    const Ef = E + k * 2 * PI;
    if (!ok) return { error: '开普勒方程未收敛（M=' + M + ', e=' + e + '）' };
    return { E: Ef, iterations: it + 1, residual: Ef - e * Math.sin(Ef) - M, bracket: [lo + k * 2 * PI, hi + k * 2 * PI] };
  }
  // 偏近点角 → 真近点角（半角正切形式，数值稳定，避免 atan2(sinν,cosν) 里的除零）
  const trueAnomalyFromE = (E, e) => 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));

  /* GPS / BDS(MEO·IGSO) / Galileo 广播星历：字段名对齐 ICD-GPS-200 20.3.3.3.3.4.3。
   * BDS 与 GPS 的参数同名同义（μ 与 Ω̇_e 不同）；Galileo 的 Crs/Crc 等缩放因子差异
   * 不由本函数处理——调用方必须传入已换算成「米/弧度」的值，返回里 unit_note 会重申。
   */
  function satPosition(eph, tow, opt) {
    if (!eph || typeof eph !== 'object') return { error: '需要星历对象' };
    const o = opt || {};
    const sys = String(eph.sys || 'GPS').toUpperCase();
    const MU = sys === 'BDS' ? MU_BDS : sys === 'GAL' ? MU_GAL : MU_GPS;
    // frame:'eci' 只关掉「随地球旋转」这一步，保留 Ω̇（升交点相对惯性空间的进动）。
    // 角动量/倾角/升交点经度这类恒等式只在惯性系里成立，测试必须用 eci 输出，
    // 否则会拿着 ECEF 的旋转结果去核对 ECI 的守恒律（那是测试写错，不是代码写错）。
    const OMEGA_E = o.frame === 'eci' ? 0 : (sys === 'BDS' ? 7.2921150e-5 : OMEGA_E_DOT);
    const need = ['sqrtA', 'e', 'M0', 'deltaN', 'Omega0', 'omegaDot', 'i0', 'iDot', 'omega', 'toe'];
    for (const k of need) if (!isNum(eph[k])) return { error: '星历缺少数值字段 ' + k };
    if (!isNum(tow)) return { error: 'TOW 非法' };
    const A = eph.sqrtA * eph.sqrtA;
    const n0 = Math.sqrt(MU / (A * A * A));
    const n = n0 + eph.deltaN;
    let tk = tow - eph.toe;
    if (tk > 302400) tk -= 604800; else if (tk < -302400) tk += 604800;   // 周内秒回绕
    const propagate = (tt) => {
      const M = wrap2pi(eph.M0 + n * tt);
      const kep = keplerEccentricAnomaly(M, eph.e);
      if (kep.error) return kep;
      const E = kep.E;
      const nu = trueAnomalyFromE(E, eph.e);
      const uk = nu + eph.omega;
      const c2 = Math.cos(2 * uk), s2 = Math.sin(2 * uk);
      const u = uk + numOr(eph.Cus, 0) * s2 + numOr(eph.Cuc, 0) * c2;
      const r = A * (1 - eph.e * Math.cos(E)) + numOr(eph.Crs, 0) * s2 + numOr(eph.Crc, 0) * c2;
      // 倾角按 ICD 形式：i = i0 + iDot·tk + Cic·cos2u + Cis·sin2u。
      // 【常见的二手资料错误】把 deltaN·tk 也加进倾角——那一项只进平均角速率 n，不进 i。
      const i = eph.i0 + eph.iDot * tt + numOr(eph.Cic, 0) * c2 + numOr(eph.Cis, 0) * s2;
      const Om = eph.Omega0 + (eph.omegaDot - OMEGA_E) * tt - OMEGA_E * eph.toe;
      const x = r * (Math.cos(u) * Math.cos(Om) - Math.sin(u) * Math.sin(Om) * Math.cos(i));
      const y = r * (Math.cos(u) * Math.sin(Om) + Math.sin(u) * Math.cos(Om) * Math.cos(i));
      const z = r * Math.sin(u) * Math.sin(i);
      return { x, y, z, E, nu, u, r, i, Om, M, iterations: kep.iterations, residual: kep.residual };
    };
    const p = propagate(tk);
    if (p.error) return p;
    let x = p.x, y = p.y, z = p.z, geo_rotated = false;
    // BDS GEO（北斗二号 PRN 1~5 及北斗三号 GEO）：绕 X 轴 −5°（BDS-SIS-ICD-3.0 明文），
    // 这是「地心固定惯性系」到「随地球旋转系」的桥接步骤，只适用于 GEO 轨道类型。
    const isGeo = o.orbit === 'GEO' || eph.orbit === 'GEO' ||
      (sys === 'BDS' && Number(eph.prn) >= 1 && Number(eph.prn) <= 5 && o.forceNoGeo !== true);
    if (isGeo) {
      const g = -5 * D2R, cg = Math.cos(g), sg = Math.sin(g);
      const ny = y * cg - z * sg, nz = y * sg + z * cg;
      y = ny; z = nz; geo_rotated = true;
    }
    // 速度：对同一套传播函数做 1 s 中心差分（而不是抄一长串闭式导数），
    // 好处是「位置与速度必然来自同一个模型」，任何恒等式测试都不会因为导数写错而误判。
    const h = 1.0;
    const pa = propagate(tk - h), pb = propagate(tk + h);
    let vx = (pb.x - pa.x) / (2 * h), vy = (pb.y - pa.y) / (2 * h), vz = (pb.z - pa.z) / (2 * h);
    if (geo_rotated) {
      const g = -5 * D2R, cg = Math.cos(g), sg = Math.sin(g);
      const nyv = vy * cg - vz * sg, nzv = vy * sg + vz * cg;
      vy = nyv; vz = nzv;
    }
    return {
      sys, prn: eph.prn, x, y, z, vx, vy, vz,
      radius_m: Math.hypot(x, y, z), semi_major_A: A, eccentricity: eph.e,
      inclination_rad: p.i, arg_lat_u: p.u, true_anomaly: p.nu, eccentric_anomaly: p.E,
      mean_anomaly: p.M, kepler_iterations: p.iterations, kepler_residual: p.residual,
      orbit_age_s: tk, altitude_m: Math.hypot(x, y, z) - WGS84.a, geo_rotated,
      frame: o.frame === 'eci' ? 'ECI' : 'ECEF(PZ-90/WGS84)',
      earth_rotation_angle_rad: OMEGA_E * (tk + eph.toe),
      period_s: 2 * PI / n, mean_motion_rad_s: n,
      unit_note: '长度 m、角度 rad、时间 s（周内秒）；未换算的原始缩放因子请调用方自行处理'
    };
  }
  // 卫星钟差（含相对论偏心修正与 TGD 群延迟）——ICD-GPS-200 20.3.3.3.3.4.4：
  //   Δtr = F·e·√A·sinE，F = −2·√μ/c²（GPS 规定值 −4.442807633e-10 s·m^(−1/2)）
  function satClock(eph, tow, opt) {
    const o = opt || {};
    if (!eph || !isNum(tow)) return { error: '需要星历与 TOW' };
    if (!isNum(eph.sqrtA) || !isNum(eph.e)) return { error: '需要 sqrtA 与 e 才能算相对论修正' };
    let dt = tow - (isNum(eph.toc) ? eph.toc : eph.toe);
    if (dt > 302400) dt -= 604800; else if (dt < -302400) dt += 604800;
    const F = isNum(o.relFactor) ? o.relFactor : F_REL_GPS;
    const E = isNum(eph.eccentric_anomaly) ? eph.eccentric_anomaly
      : (() => { const p = satPosition(eph, tow, o); return p.error ? null : p.eccentric_anomaly; })();
    if (E == null) return { error: '无法解出偏近点角，相对论修正不可用' };
    const dtr = F * eph.e * eph.sqrtA * Math.sin(E);
    const clock = numOr(eph.af0, 0) + numOr(eph.af1, 0) * dt + numOr(eph.af2, 0) * dt * dt + dtr;
    const tgd = numOr(eph.TGD, 0) + numOr(eph.TGD2, 0);
    return {
      dt_s: clock, relativistic_s: dtr, offset_s: numOr(eph.af0, 0), drift_s: numOr(eph.af1, 0) * dt,
      rate_s: numOr(eph.af2, 0) * dt * dt, age_s: dt, tgd_s: tgd, clock_minus_tgd_s: clock - tgd
    };
  }
  // TGD 的单位是 s，折算成 L1 伪距上的距离偏置要乘光速
  const tgdToMeters = (tgd_s) => safeNum(isNum(tgd_s) ? tgd_s * C_LIGHT : NaN);

  /* GLONASS：电文给位置/速度/加速度，必须数值积分（含 J2 带谐项 + SRP 常数加速度） */
  const GLONASS_J2 = 1.08227330332e-3;    // GLONASS 电文积分用的二阶带谐系数（WGS84 的是 J2_EARTH，两者数值不同）
  const GLONASS_RE = 6378136.0;           // PZ-90.11 长半轴（m）
  // J2 摄动位 V1 = (μJ2Re²/2)·(r²−3z²)/r⁵，加速度 a = ∇(μ/r + V1)，逐项求导得到：
  //   a_x = −μx/r³ − k·x·(1 − 5z²/r²)
  //   a_y = −μy/r³ − k·y·(1 − 5z²/r²)
  //   a_z = −μz/r³ − k·z·(3 − 5z²/r²)，   k = (3/2)·J2·μ·Re²/r⁵
  // 符号用一条物理事实定住：赤道（z=0）处 V1 = μJ2Re²/(2r³)，∂V1/∂r < 0 ⇒ 赤道隆起必须「额外向内吸」，
  // 若把 k 的符号写反就会变成排斥，selfTest 里有这条闸门。
  // 另外轴对称只保证 L_z 守恒（不保证 |L| 守恒），所以这里不能用 |L| 当判据；
  // 抓「z 行写成 (1−5z²/r²)」这类结构性错误靠旋度为零（∂a_x/∂z = ∂a_z/∂x）这条位势场恒等式。
  function gravityAccel(x, y, z, mu, j2, re) {
    if (![x, y, z, mu, j2, re].every(isNum)) return { error: '引力场参数（x/y/z/μ/J2/Re）必须都是有限数' };
    const r2 = x * x + y * y + z * z;
    // 上下都要挡：|r| 太大时 r² = Infinity ⇒「5z²/r²」= Infinity/Infinity = NaN；|r| 太小时
    // r⁵ 下溢为 0 ⇒ J2 项变成 Infinity·0 = NaN。静默吐 NaN 会污染整条轨道积分。
    if (!(r2 >= 1e-12) || !isFinite(r2)) return { error: '位置非法：|r| 需在 1e-6 m ~ 1e154 m 之间' };
    const r = Math.sqrt(r2);
    const k = 1.5 * j2 * mu * re * re / (r2 * r2 * r);       // = 1.5·J2·μ·Re²/r⁵
    const f = 1 - 5 * z * z / r2;
    return {
      ax: -mu * x / (r2 * r) - k * x * f,
      ay: -mu * y / (r2 * r) - k * y * f,
      az: -mu * z / (r2 * r) - k * z * (3 - 5 * z * z / r2)
    };
  }
  function glonassPosition(eph, tauMs, opt) {
    if (!eph || typeof eph !== 'object') return { error: '需要 GLONASS 电文' };
    if (!isNum(tauMs)) return { error: '需要传输时刻 τ（ms）' };
    const o = opt || {};
    const need = ['x', 'y', 'z', 'vx', 'vy', 'vz'];
    for (const k of need) if (!isNum(eph[k])) return { error: '电文缺少数值字段 ' + k };
    const MU = isNum(o.mu) ? o.mu : MU_GLN;
    const scale = o.unit === 'm' ? 1 : 1000;      // 电文默认 km / km·s⁻¹ / km·s⁻²
    let x = eph.x * scale, y = eph.y * scale, z = eph.z * scale;
    let vx = eph.vx * scale, vy = eph.vy * scale, vz = eph.vz * scale;
    const ax0 = numOr(eph.ax, 0) * scale, ay0 = numOr(eph.ay, 0) * scale, az0 = numOr(eph.az, 0) * scale;
    const j2 = o.includeJ2 === false ? 0 : (isNum(o.j2) ? o.j2 : GLONASS_J2);
    const re = isNum(o.re) ? o.re : GLONASS_RE;
    const span = (tauMs - numOr(eph.tau, 0)) / 1000;   // τ_k 电文里是 ms
    const step = clamp(o.step || 30, 0.5, 120) * (span >= 0 ? 1 : -1);
    const n = Math.ceil(Math.abs(span) / Math.abs(step));
    const acc = (px, py, pz, pax, pay, paz) => {
      const g = gravityAccel(px, py, pz, MU, j2, re);
      return g.error ? g : { ax: g.ax + pax, ay: g.ay + pay, az: g.az + paz };
    };
    let state = { x, y, z, vx, vy, vz };
    for (let s = 0; s < n; s++) {
      const st = state;
      // 最后一步只走剩余时间：否则 n=ceil(span/step) 会多走最多一个 step，
      // 「按时刻 t 取位置」就变成「按 t 向上取整到 step 的倍数」，圈数与时间不成正比。
      const h = s === n - 1 ? (span - s * step) : step;
      const a1 = acc(st.x, st.y, st.z, ax0, ay0, az0); if (a1.error) return a1;
      const k1 = { px: st.vx, py: st.vy, pz: st.vz, vx: a1.ax, vy: a1.ay, vz: a1.az };
      const a2 = acc(st.x + k1.px * h / 2, st.y + k1.py * h / 2, st.z + k1.pz * h / 2, ax0, ay0, az0);
      const k2 = { px: st.vx + k1.vx * h / 2, py: st.vy + k1.vy * h / 2, pz: st.vz + k1.vz * h / 2, vx: a2.ax, vy: a2.ay, vz: a2.az };
      const a3 = acc(st.x + k2.px * h / 2, st.y + k2.py * h / 2, st.z + k2.pz * h / 2, ax0, ay0, az0);
      const k3 = { px: st.vx + k2.vx * h / 2, py: st.vy + k2.vy * h / 2, pz: st.vz + k2.vz * h / 2, vx: a3.ax, vy: a3.ay, vz: a3.az };
      const a4 = acc(st.x + k3.px * h, st.y + k3.py * h, st.z + k3.pz * h, ax0, ay0, az0);
      const k4 = { px: st.vx + k3.vx * h, py: st.vy + k3.vy * h, pz: st.vz + k3.vz * h, vx: a4.ax, vy: a4.ay, vz: a4.az };
      state = {
        x: st.x + h * (k1.px + 2 * k2.px + 2 * k3.px + k4.px) / 6,
        y: st.y + h * (k1.py + 2 * k2.py + 2 * k3.py + k4.py) / 6,
        z: st.z + h * (k1.pz + 2 * k2.pz + 2 * k3.pz + k4.pz) / 6,
        vx: st.vx + h * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx) / 6,
        vy: st.vy + h * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy) / 6,
        vz: st.vz + h * (k1.vz + 2 * k2.vz + 2 * k3.vz + k4.vz) / 6
      };
    }
    // 坐标系说明（这里做过一次推导校验，不是抄公式）：
    //   积分在「历元时刻与 PZ-90 的 x 轴对齐、但不随地球转」的惯性系里做。中心引力与 J2
    //   都是轴对称的，其表达式在惯性系与随地系中完全相同，所以这样做是自洽的；只有 J22、
    //   日月这类非轴对称摄动才必须在随地系里评估（本函数不含它们）。
    //   输出前用 r_随地 = R3(θ)·r_惯性、θ = Ω_e·Δt 转回随地系；速度必须一起转，
    //   并且带上 Ω_e ẑ×r 那一项，否则位置/速度不在同一个参考系里，守恒律与多普勒都会错。
    //   关键：θ 用的是「传播时长 Δt」，不是信号传播时间（0.08 s）——用后者等于没转。
    const inertial = { x: state.x, y: state.y, z: state.z, vx: state.vx, vy: state.vy, vz: state.vz };
    const wr = OMEGA_E_DOT * span;
    const cw = Math.cos(wr), sw = Math.sin(wr);
    const xe = state.x * cw + state.y * sw;
    const ye = -state.x * sw + state.y * cw;
    const vxe = state.vx * cw + state.vy * sw + OMEGA_E_DOT * ye;
    const vye = -state.vx * sw + state.vy * cw - OMEGA_E_DOT * xe;
    return {
      sys: 'GLONASS', prn: eph.prn,
      x: xe, y: ye, z: state.z,
      vx: vxe, vy: vye, vz: state.vz,
      radius_m: Math.hypot(xe, ye, state.z),
      inertial: inertial,
      integrated_steps: n, step_s: step, integrated_s: span, includeJ2: j2 !== 0, earth_rotation_rad: wr,
      unit_note: '输入按 km / km·s⁻¹ / km·s⁻²（可用 {unit:"m"} 覆盖），输出统一为 m；τ 与电文 τ_k 同单位（ms）',
      frame_note: 'x/y/z/vx/vy/vz 是随地系（PZ-90）；inertial 是积分所用的惯性系状态。守恒律要用 inertial 核对'
    };
  }

  /* ================================================================ 5. 大气延迟 */
  const GM_EARTH = 3.986004418e14;      // 物理地心引力常数（≠ ICD 给用户的规范化 μ）
  const J2_EARTH = 1.08262982131e-3;    // WGS84 归一化二阶带谐系数（PZ-90.11 用的是另一套，见 GLONASS_J2）
  const ZHD_CONST = 0.0022768;          // m/hPa：45° 海平面的静力天顶延迟系数（Saastamoinen/Davis）
  // 正常重力：用本文件已有的引力函数（中心 + J2）在「参考椭球面 + 高程」处现场解出，再叠离心项 ω²ρ。
  //   这样 ZHD 的纬度/高程改正不再依赖 0.00266、0.00028 这两个凭记忆的系数——自检把两条路线对照。
  function normalGravity(lat_deg, height_m) {
    const phi = Number(lat_deg);
    const h = isNum(height_m) ? height_m : 0;
    if (!isNum(phi) || phi < -90 || phi > 90 || !isFinite(h) || Math.abs(h) > 1e7) return { error: '纬度须在 [−90,90]、高程须在 ±1e7 m 内' };
    const p = phi * D2R, e2 = WGS84.e2;
    const N = WGS84.a / Math.sqrt(1 - e2 * Math.sin(p) * Math.sin(p));
    const rho = N * Math.cos(p), z0 = N * (1 - e2) * Math.sin(p);
    const r0 = Math.hypot(rho, z0);
    const x = (rho / r0) * (r0 + h), z = (z0 / r0) * (r0 + h);
    const gv = gravityAccel(x, 0, z, GM_EARTH, J2_EARTH, WGS84.a);
    if (gv.error) return { error: gv.error };
    const w2 = OMEGA_E_DOT * OMEGA_E_DOT;
    const g = Math.hypot(gv.ax + w2 * x, gv.ay, gv.az);
    return { g_mps2: g, ecef_x: x, ecef_z: z, distance_from_axis_m: Math.abs(x), radius_from_center_m: r0 + h, centrifugal_mps2: w2 * x, note: '含 J2 引力 + 离心项；离心项在自转轴上为 0，故重力由极点向赤道递减' };
  }
  // 国际标准大气（对流层底内）：P = 1013.25·(1 − L·h/T0)^(g0·M/(R·L))，指数由常数算出而不是抄 5.2559
  function standardAtmosphere(height_km) {
    const h = Number(height_km);
    if (!isNum(h) || h < 0 || h > 11) return { error: '本模型仅覆盖对流层底 0~11 km（输入 ' + height_km + '）' };
    const L = 0.0065, T0 = 288.15, M = 0.0289644, R = 8.31446, g0 = 9.80665;
    const base = 1 - L * (h * 1000) / T0;
    const expo = g0 * M / (R * L);
    return { pressure_hPa: 1013.25 * Math.pow(base, expo), temperature_K: T0 - L * h * 1000, lapse_rate_K_per_km: L * 1000, exponent: expo, note: 'ICAO 标准大气的对流层底线性温降；实测气压永远优先于模型值' };
  }
  // 对流层干延迟：ζ_h = ZHD_CONST·P·(g₄₅/g(φ,h))
  //   物理含义：折射率∝密度 ⇒ 天顶延迟∝单位面积质量柱 = P/g。同一气压下，g 越小（低纬、高站）质量柱越大。
  //   等价于 Saastamoinen 的 P/(1 − 0.00266cos2φ − 0.00028h)（自检里两路线对照到 3e-4），但系数不再靠记忆。
  // 湿延迟：Davis(1985) 闭式 ζ_w = 0.0022768·e·(1255/T + 0.05)——内含「水汽标高约 2 km」的剖面近似，±20%
  function troposphereZenith(pressure_hPa, lat, height_km, waterVapor_hPa, temperature_K) {
    const p = Number(pressure_hPa), h = Number(height_km || 0);
    if (!isFinite(p) || p <= 0) return { error: '需要正的气压（hPa）；无实测值可用标准大气 1013.25' };
    const latC = isFinite(Number(lat)) ? Number(lat) : 45;
    const gLoc = normalGravity(latC, h * 1000);
    if (gLoc.error) return { error: gLoc.error };
    const g45 = normalGravity(45, 0).g_mps2;
    const gravFactor = g45 / gLoc.g_mps2;
    const zhd = ZHD_CONST * p * gravFactor;
    let zwd = 0, wetNote = '未提供水汽与温度，湿延迟按 0 计（典型遗漏 0.03~0.4 m，主要落在高程上）';
    if (isFinite(Number(waterVapor_hPa)) && isFinite(Number(temperature_K)) && Number(temperature_K) > 0) {
      const e = Number(waterVapor_hPa), T = Number(temperature_K);
      if (e < 0) return { error: '水汽压不能为负' };
      zwd = ZHD_CONST * e * (1255 / T + 0.05);
      wetNote = '湿延迟为 Davis/Saastamoinen 闭式 ζ_w=0.0022768·e·(1255/T+0.05)，含水汽标高近似，不确定度约 ±20%';
    }
    return {
      zhd_m: zhd, zwd_m: zwd, zenith_total_m: zhd + zwd,
      gravity_factor: gravFactor, latitude_factor: gravFactor,
      gravity_mps2: gLoc.g_mps2, gravity_ref_mps2: g45,
      note: wetNote + '；干延迟按 P/g 归一（g = ' + gLoc.g_mps2.toFixed(5) + ' m/s²）'
    };
  }
  // 倾斜映射：主用 1/sinE（低高度角会低估），并给出 Niell 型一阶拟合做对照
  function troposphereMapping(elev_deg) {
    const e = Number(elev_deg);
    if (!isFinite(e) || e <= 0 || e > 90) return { error: '高度角必须在 (0,90]（' + elev_deg + '）' };
    const ec = Math.max(e, 5);                     // 低于 5° 截断，避免 1/sinE 爆炸
    const invSin = 1 / Math.sin(ec * D2R);
    return { mapping: invSin, at_true_elevation: 1 / Math.sin(e * D2R), clipped_below_deg: 5, note: '低高度角应使用 Niell/Hopfield 映射；1/sinE 在 E<10° 时偏差可达 10% 以上' };
  }
  // 单层壳电离层几何：壳半径 Rs=Re+h，射线在天顶距 z 处入射，
  //   由三角形正弦定理 ψ = z − arcsin((Re/Rs)·sin z)，路径长 L = Rs·sin ψ / sin z
  //   这两条是纯几何推导，因此 F=L/h 在 z→0 时必须严格 →1（下面 selfTest 用洛必达极限抓实现错误）
  function ionoShell(elev_deg, shell_km, f_mhz, vtec_tecu) {
    const E = Number(elev_deg), hs = isNum(shell_km) ? shell_km : 350;
    if (!isFinite(E) || E <= 0 || E > 90) return { error: '高度角必须在 (0,90]' };
    if (!(hs > 0)) return { error: '壳层高度必须为正' };
    const Re = WGS84.a, Rs = Re + hs * 1000;
    const z = (90 - E) * D2R;
    const k = (Re / Rs) * Math.sin(z);
    if (Math.abs(k) > 1) return { error: '射线不与壳层相交' };
    const psi = z - Math.asin(k);
    const L = Math.abs(z) < 1e-10 ? hs * 1000 : Rs * Math.sin(Math.abs(psi)) / Math.sin(z);
    const F = L / (hs * 1000);
    const out = {
      ipp_central_angle_deg: psi * R2D, ipp_distance_km: psi * Re / 1000,
      path_length_m: L, mapping_factor: F, shell_km: hs,
      limit_check: Math.abs(z) < 1e-10 ? 'z→0 时按洛必达极限取 L=h' : ''
    };
    if (isNum(vtec_tecu) && isNum(f_mhz) && f_mhz > 0) {
      // 群延迟 Δρ = 40.3·STEC/f²（STEC 用 el/m²，f 用 Hz；40.3 = e²/(8π²ε₀m_e) 的 SI 组合值）
      // STEC = VTEC × F。漏乘 F 会让所有高度角的延迟与天顶相同，下面的单调闸门专抓这一条。
      const vertical = 40.3 * (vtec_tecu * 1e16) / Math.pow(f_mhz * 1e6, 2);
      out.vertical_delay_m = vertical;
      out.slant_tecu_tecu = vtec_tecu * F;
      out.group_delay_m = vertical * F;
      out.note = '垂直 VTEC 各向同性假设，斜延迟 = 垂直延迟 × 单层壳映射因子；低纬/磁暴时可偏差数米，双频组合优先';
    } else out.note = '未给 VTEC 或频率，仅返回几何映射';
    return out;
  }
  // 双频无电离层组合：P_IF = (f1²P1 − f2²P2)/(f1² − f2²)，一阶延迟严格抵消
  function ionoFreeRange(r1, f1_mhz, r2, f2_mhz) {
    if (!(isNum(r1) && isNum(r2) && isNum(f1_mhz) && isNum(f2_mhz) && f1_mhz > 0 && f2_mhz > 0)) return { error: '需要两个频率与两个伪距' };
    const a = f1_mhz * f1_mhz, b = f2_mhz * f2_mhz;
    if (a === b) return { error: '两个频率相同无法做无电离层组合' };
    return {
      range_m: (a * r1 - b * r2) / (a - b), coeff1: a / (a - b), coeff2: -b / (a - b),
      noise_amplification: Math.sqrt(a * a + b * b) / Math.abs(a - b),
      note: '一阶电离层严格抵消（系数推导自 Δρ∝1/f²）；残余为二阶与多路径，噪声按上面系数放大'
    };
  }

  /* ================================================================ 6. 单点定位（加权最小二乘） */
  /* 输入：卫星 ECEF 数组 + 伪距数组；未知量 [x,y,z,cdt]（可选固定钟差）。
   * 每步都重算 Sagnac 改正；权重支持 none/elevation/snr；
   * 输出 DOP（与 σ 无关的几何量）、误差协方差（含先验 σ0）、卡方完整性检验与故障剔除。
   */
  function solvePosition(satEcef, ranges, guess, opts) {
    const o = opts || {};
    if (!Array.isArray(satEcef) || !Array.isArray(ranges)) return { error: '需要卫星位置数组与伪距数组' };
    const n = satEcef.length;
    if (n !== ranges.length) return { error: '卫星数与伪距数不等（' + n + ' vs ' + ranges.length + '）' };
    // 钟差默认作为第 4 个未知数。要「固定钟差」就必须给出已知值：
    // 旧写法是 fixClock:false 才降到 3 个未知数，语义与字面相反，而且把钟差悄悄当成 0
    // （真钟差非零时位置会整批错），现在改成「给了 clock_bias_m 就当它已固定」。
    const knownDt = isNum(o.clock_bias_m) ? o.clock_bias_m : null;
    if (o.fixClock === true && knownDt == null) return { error: 'fixClock 需要同时提供 clock_bias_m（已知钟差，单位 m），否则 3 个未知数会当成钟差=0 来解' };
    const useClock = knownDt == null;
    const unk = useClock ? 4 : 3;
    if (n < unk) return { error: '至少需要 ' + unk + ' 颗卫星' + (useClock ? '（钟差作为第 4 个未知数；若已知钟差请传 clock_bias_m）' : '') };
    for (let i = 0; i < n; i++) {
      const s = satEcef[i];
      if (!s || !isNum(s.x) || !isNum(s.y) || !isNum(s.z)) return { error: '第 ' + (i + 1) + ' 颗卫星位置非法' };
      if (!isNum(ranges[i])) return { error: '第 ' + (i + 1) + ' 个伪距非法' };
    }
    let start;
    if (guess && isNum(guess.lat)) { const t = geodeticToEcef(guess.lat, guess.lon, guess.h || 0); if (t.error) return t; start = { x: t.x, y: t.y, z: t.z }; }
    else if (guess && isNum(guess.x)) start = { x: guess.x, y: guess.y, z: guess.z };
    else start = { x: WGS84.a, y: 0, z: 0 };
    const keep = satEcef.map(() => true);
    const excluded = [];
    const sigma0 = isNum(o.sigma_m) ? o.sigma_m : null;
    // σ0 会以 σ0² 的形式进/出协方差：≤0 或大到平方溢出都会让 DOP 变成 0 或 NaN，
    // 这两种「看起来像个数字」的结果比直接报错危险得多，所以限定在物理合理的量级内。
    if (sigma0 != null && !(sigma0 > 1e-6 && sigma0 < 1e7)) return { error: '先验 σ0 需在 1e-6 ~ 1e7 m 之间（当前 ' + sigma0 + '）' };
    let sol = Object.assign({ dt: knownDt == null ? 0 : knownDt }, start), step = null, totalIter = 0;
    for (let outer = 0; outer < (o.maxExclude || 6); outer++) {
      for (let it = 0; it < (o.maxIter || 12); it++) {
        step = lsStep(sol, satEcef, ranges, keep, useClock, o, sigma0);
        if (step.error) return Object.assign({}, step, { excluded_prns: excluded });
        sol = step.sol;
        totalIter++;
        if (step.converged) break;
      }
      step.iterations = totalIter;
      if (step.error) break;
      // 完整性检验：只有给了先验 σ0 才有意义（否则 σ̂=σ 使统计量退化为 dof）
      if (!o.raim || !isNum(sigma0)) break;
      if (step.dof <= 0 || step.chi2 <= chiSquareCritical(step.dof, o.alpha || 0.01)) break;
      // 剔除归一化残差最大的那颗，重解。
      // worst 是「缩减后观测序列」里的下标，keep 却是按原始卫星数组 indexing 的：
      // 写成 keep[worst] = false 会在第二次及以后的剔除时移掉另一颗星，而 excluded 里报告的是
      // 被点名那颗——界面显示的 PRN 和真正被丢掉的红星并不对应。
      // 排序量用 step.norm_resid（含 1/sqrt(1−h) 杠杆修正），不是 |r|/σ：后者会让粗差星
      // 因为「太主导、残差被吸收」而排到健康星后面，第一次就剔错，之后一路发散。
      const worst = step.norm_resid.map((v) => Math.abs(v))
        .reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);
      const orig = step.indexMap[worst];
      if (keep.reduce((a, k) => a + (k ? 1 : 0), 0) <= unk) break;
      keep[orig] = false;
      excluded.push(satEcef[orig].prn != null ? satEcef[orig].prn : orig);
      sol = Object.assign({}, sol);
    }
    const geo = ecefToGeodetic(sol.x, sol.y, sol.z);
    const out = {
      lat: geo.lat, lon: geo.lon, h: geo.h, x: sol.x, y: sol.y, z: sol.z,
      clock_bias_m: sol.dt, clock_bias_ns: sol.dt / C_LIGHT * 1e9,
      sats_used: step ? step.m : null, sats_excluded: excluded.length, excluded_prns: excluded,
      iterations: step ? step.iterations : null, converged: step ? step.converged : false,
      rms_residual_m: step ? step.rms : null, residuals_m: step ? step.residuals : null,
      // 每颗星剔除后残差的 z 统计量（已含杠杆修正）：界面要标出「最像粗差的那颗」就用它，
      // 别用 |r|/σ——那正是 FDE 第一次就会挑错的量。
      residual_z: step ? step.norm_resid : null,
      leverage: step ? step.hat_diag : null,
      sigma0_posterior_m: step ? step.sigma_hat : null,
      chi2: step ? step.chi2 : null, chi2_dof: step ? step.dof : null,
      chi2_p_value: step ? step.p_value : null,
      integrity: step ? (isNum(sigma0)
        ? (step.chi2 > chiSquareCritical(step.dof, o.alpha || 0.01) ? { alarm: true, note: '卡方检验拒绝：观测中存在粗差或未建模偏差' } : { alarm: false, note: '卡方检验通过（先验 σ0 下）' })
        : { alarm: null, note: '未提供先验 σ0，卡方检验无法判定（此时统计量恒等于自由度）' }) : null,
      dop: step ? step.dop : null, covariance_enu_m2: step ? step.covEnu : null,
      sigma_e_m: step ? Math.sqrt(Math.max(0, step.covEnu[0][0])) : null,
      sigma_n_m: step ? Math.sqrt(Math.max(0, step.covEnu[1][1])) : null,
      sigma_u_m: step ? Math.sqrt(Math.max(0, step.covEnu[2][2])) : null,
      elevation_min_deg: step ? step.elevMin : null,
      semi_major_m: step ? step.errEllipse.a : null, semi_minor_m: step ? step.errEllipse.b : null,
      ellipse_orientation_deg: step ? step.errEllipse.psi : null,
      cep50_m: step ? cepFromSigma(step.errEllipse.a, step.errEllipse.b, 0.5) : null,
      cep68_m: step ? cepFromSigma(step.errEllipse.a, step.errEllipse.b, 0.68) : null,
      cep95_m: step ? cepFromSigma(step.errEllipse.a, step.errEllipse.b, 0.95) : null,
      note: 'h 是椭球高（大地高），不是海拔/正高；需要正高请显式提供大地水准面差距 N（本引擎不内置 N 模型）'
    };
    return out;
  }
  function lsStep(sol, sats, ranges, keep, useClock, o, sigma0) {
    const indexMap = [];
    for (let i = 0; i < sats.length; i++) if (keep[i]) indexMap.push(i);
    const m = indexMap.length, unk = useClock ? 4 : 3;
    if (m < unk) return { error: '可用卫星不足（' + m + '）' };
    const A = [], b = [], sig = [];
    for (let j = 0; j < m; j++) {
      const s = sats[indexMap[j]];
      const dx = s.x - sol.x, dy = s.y - sol.y, dz = s.z - sol.z;
      const rho = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(rho > 0)) return { error: '卫星与接收机位置重合' };
      const sagnac = OMEGA_E_DOT / C_LIGHT * (s.x * sol.y - s.y * sol.x);
      // ρ = |s − x|，对接收机坐标求导得 −(s−x)/ρ；牛顿行必须是「负方向余弦」，否则迭代发散。
      const row = [-dx / rho, -dy / rho, -dz / rho];
      if (useClock) row.push(1);
      A.push(row); b.push(ranges[indexMap[j]] - rho - sagnac - sol.dt);
      // 高度角也必须走同一套别名：只读 s.elev 时，demoScene / NMEA GSV 传来的 elevation_deg
      // 读不到 → 高度角加权整条退化成了等权，界面却看不出任何异常。
      const el = satElev(s), snr = numOr(s.snr_db != null ? s.snr_db : s.snr, null);
      let sd = 1;
      // weight 三档（none/elevation/snr）要与文件头承诺一致：'none' 必须真的等权，
      // 界面「等权 vs 高度角加权」对照才有开关可按；SNR 档缺信噪比时退回高度角档。
      if (o.weight === 'none') sd = 1;
      else if (o.weight === 'snr' && isNum(snr)) sd = Math.pow(10, -(clamp(snr, 0, 60) - 45) / 20);
      else if (el != null) sd = 1 / Math.max(Math.sin(Math.max(el, 5) * D2R), 0.087);
      sig.push(isNum(sigma0) ? sigma0 * sd : sd);
    }
    const w = sig.map((s) => 1 / (s * s));
    const N = [], g = [];
    for (let a = 0; a < unk; a++) {
      N.push(new Array(unk).fill(0)); g.push(0);
      for (let j = 0; j < m; j++) {
        g[a] += w[j] * A[j][a] * b[j];
        for (let c = 0; c < unk; c++) N[a][c] += w[j] * A[j][a] * A[j][c];
      }
    }
    const Q = invertSym(N);
    if (Q.error) return Q;
    const d = matVec(Q, g);
    const next = { x: sol.x + d[0], y: sol.y + d[1], z: sol.z + d[2], dt: sol.dt + (useClock ? d[3] : 0) };
    const residuals = [];
    let ssq = 0;
    for (let j = 0; j < m; j++) {
      const s = sats[indexMap[j]];
      const dx = s.x - next.x, dy = s.y - next.y, dz = s.z - next.z;
      const rho = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const sagnac = OMEGA_E_DOT / C_LIGHT * (s.x * next.y - s.y * next.x);
      const r = ranges[indexMap[j]] - rho - sagnac - next.dt;
      residuals.push(r);
      ssq += r * r / (sig[j] * sig[j]);
    }
    const dof = m - unk;
    const sigma_hat = dof > 0 ? Math.sqrt(ssq / dof) : null;
    // DOP 必须是纯几何量。先验 σ0 是全体观测权重的公因子：N ∝ 1/σ0² ⇒ Q = N⁻¹ ∝ σ0²，
    // 所以先除以 σ0² 还原「单位权 Q」再取 DOP；协方差再单独乘回 σ0²。
    // 少了这一步，改 σ0 会同时改 DOP，「误差 = DOP × σ」的语义就崩了。
    const geoMid = ecefToGeodetic(next.x, next.y, next.z);
    if (geoMid.error) return geoMid;
    const Mrot = enuMatrix(geoMid.lat, geoMid.lon);
    if (Mrot.error) return Mrot;
    const qUnit = isNum(sigma0) ? sigma0 * sigma0 : 1;
    const Qgeo = Q.map((row) => row.map((v) => v / qUnit));
    const covUnscaled = transform3(Mrot, Qgeo.slice(0, 3).map((r) => r.slice(0, 3)));
    const scaleCov = isNum(sigma0) ? qUnit : (sigma_hat != null ? sigma_hat * sigma_hat : 1);
    const covEnu = covUnscaled.map((row) => row.map((v) => v * scaleCov));
    const hdop = Math.sqrt(Math.max(0, covUnscaled[0][0] + covUnscaled[1][1]));
    const vdop = Math.sqrt(Math.max(0, covUnscaled[2][2]));
    const pdop = Math.sqrt(Math.max(0, covUnscaled[0][0] + covUnscaled[1][1] + covUnscaled[2][2]));
    const tdop = useClock ? Math.sqrt(Math.max(0, Qgeo[3][3])) : 0;
    const gdop = Math.sqrt(pdop * pdop + tdop * tdop);
    const errEllipse = ellipseFromCov2(covEnu[0][0], covEnu[1][1], covEnu[0][1]);
    // 剔除统计量：残差自己的方差是 σ_j²(1−h_jj)，不是 σ_j²（h_jj = w_j·a_jᵀQ a_j 是该观测的杠杆）。
    // 只用 |r|/σ 排序会被「掩蔽效应」骗：粗差星越主导解，它的残差被吸收得越多（1−h→0），
    // 看起来反而比周围健康星更干净，于是 FDE 去剔好星、留下坏星，越剔越歪。
    // 除以 sqrt(1−h) 把被吸收的那部分还原回来；1−h 的下限防止 h→1 时统计量炸成无穷。
    const hat = [], zres = [];
    for (let j = 0; j < m; j++) {
      let aq = 0;
      for (let p = 0; p < unk; p++) {
        let acc = 0;
        for (let q2 = 0; q2 < unk; q2++) acc += Q[p][q2] * A[j][q2];
        aq += A[j][p] * acc;
      }
      const hjj = w[j] * aq;
      hat.push(hjj);
      zres.push(residuals[j] / (sig[j] * Math.sqrt(Math.max(1 - hjj, 1e-3))));
    }
    return {
      // 收敛判据有一个绕不过去的下限：d 是加到 |r|≈6.4e6 m 的 ECEF 上的增量，
      // 可表示的最小步长就是 |sol| 的 ulp（≈1.5e-9 m）。调用方把 tol 设到 1e-9 m 时，
      // 真解已经到亚纳米级却永远「判不出收敛」，所以取 max(tol, 4·|sol|·εmach)。
      // 常规 tol=1e-6 m 时该地板完全不生效，正常数据的判定路径一字未变。
      sol: next, converged: Math.hypot(d[0], d[1], d[2]) < Math.max(o.tol || 1e-6, 4 * Math.hypot(sol.x, sol.y, sol.z) * 2.220446049250313e-16), m, indexMap,
      residuals, rms: Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / m),
      sigma_of: sig, dof, chi2: ssq, sigma_hat,
      hat_diag: hat, norm_resid: zres,
      norm_resid_max: zres.reduce((mx, v) => Math.max(mx, Math.abs(v)), 0),
      p_value: dof > 0 ? chiSquareSurvival(ssq, dof) : null,
      covEnu, errEllipse,
      // 字段名与 geometryFromAzEl / skyPlot / relativeFix 保持同一套别名约定：只认 elev 的话，
      // demoScene 输出的 elevation_deg 会被当成缺测，最低高度角静默退化成初值 90°。
      elevMin: indexMap.reduce((mx, i) => { const e = satElev(sats[i]); return e == null ? mx : (mx == null ? e : Math.min(mx, e)); }, null),
      dop: { hdop, vdop, pdop, tdop, gdop, tdop_as_range_m: tdop }
    };
  }

  /* ================================================================ 7. 线性代数与小工具 */
  // 对称正定求逆：Gauss–Jordan + 主元选择；奇异时返回 error 而不是抛异常
  function invertSym(Ain) {
    if (!Array.isArray(Ain)) return { error: '需要方阵（数组的数组）' };
    const n = Ain.length;
    if (!n) return { error: '空矩阵' };
    for (const row of Ain) if (!Array.isArray(row) || row.length !== n) return { error: '矩阵不是方阵' };
    for (const row of Ain) for (const v of row) if (!isNum(v)) return { error: '矩阵元素必须是有限数（含 NaN/Infinity 时求逆结果无意义）' };
    // 判据必须与矩阵自身尺度无关：只用绝对阈值会把「天顶列 ∝ 钟差列」这类相对奇异放过，
    // 于是调用方用 sqrt(max(0, 负对角元)) 把垃圾压成 0，界面上就出现 VDOP=0 这种不可能的数。
    let scale = 0;
    for (const row of Ain) for (const v of row) if (isFinite(v) && Math.abs(v) > scale) scale = Math.abs(v);
    if (!(scale > 0)) return { error: '矩阵全零或含非法值' };
    const a = Ain.map((r, i) => r.concat(identityRow(n)[i]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-12 * scale) {
        return { error: '矩阵奇异或条件极差（几何构型退化，DOP 无定义）：第 ' + (c + 1) + ' 列主元 ' +
          Math.abs(a[piv][c]).toExponential(2) + '，矩阵尺度 ' + scale.toExponential(2) };
      }
      if (piv !== c) { const t = a[piv]; a[piv] = a[c]; a[c] = t; }
      const d = a[c][c];
      for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r][c];
        if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
      }
    }
    return a.map((r) => r.slice(n));
  }
  const identityRow = (n) => { const o = []; for (let i = 0; i < n; i++) { const r = new Array(n).fill(0); r[i] = 1; o.push(r); } return o; };
  function matVec(M, v) {
    if (!Array.isArray(M) || !Array.isArray(v)) return { error: 'matVec 需要矩阵与向量（都是数组）' };
    if (!M.every((row) => Array.isArray(row)) || !v.every(isNum) || !M.every((row) => row.every(isNum))) return { error: 'matVec 的元素必须是有限数' };
    return M.map((row) => row.reduce((s, a, i) => s + a * (v[i] || 0), 0));
  }
  // R·C·Rᵀ（ECEF 协方差 → 站心 ENU）；R 为正交旋转矩阵时特征值不变，这是自检用的恒等式
  function transform3(R, C) {
    if (!Array.isArray(R) || !Array.isArray(C)) return { error: 'transform3 需要两个矩阵（数组的数组）' };
    if (!R.every((row) => Array.isArray(row) && row.length === 3 && row.every(isNum))) return { error: 'transform3 的旋转矩阵必须是 3×3 有限数' };
    if (!C.every((row) => Array.isArray(row) && row.every(isNum))) return { error: 'transform3 的协方差矩阵元素必须是有限数' };
    const RC = R.map((row) => C.map((col, k) => row.reduce((s, a, j) => s + a * col[j], 0)));
    return RC.map((row) => RC.map((_, j) => row.reduce((s, a, k) => s + a * R[j][k], 0)));
  }
  // 2×2 协方差 → 误差椭圆（半长轴 a、半短轴 b、方位角 ψ，ψ 自北顺时针）
  function ellipseFromCov2(qnn, qee, qne) {
    const q1 = Number(qnn), q2 = Number(qee), q12 = Number(qne);
    if (!isFinite(q1) || !isFinite(q2) || !isFinite(q12)) return { a: null, b: null, psi: null };
    const t = 0.5 * (q1 + q2), u = Math.sqrt(0.25 * (q1 - q2) * (q1 - q2) + q12 * q12);
    const a2 = t + u, b2 = Math.max(0, t - u);
    let psi = 0;
    if (u > 1e-18) psi = Math.atan2(q12, 0.5 * (q1 - q2) + u) * R2D;   // 长半轴方向（自北起算）
    return { a: Math.sqrt(a2), b: Math.sqrt(b2), psi: wrap180(psi), a2, b2, oneSigmaM: Math.sqrt(a2) };
  }
  // 圆概率误差 CEP(p)：用误差椭圆做蒙特卡洛会不稳定，这里用 Satterback 正态近似闭式：
  //   CEP_p ≈ σ̄·k_p，σ̄ = √[(a+b)/2] 型组合；对 a=b（圆）退化为单变量正态的分位数 × σ。
  //   因此自检用两条闸门：(1) a=b 时必须等于 σ·√(−2ln(1−p))（二维瑞利分位数，可解析推导）；
  //   (2) p 单调、且 a≠b 时结果必须落在 [CEP(σ=a), CEP(σ=b)] 区间内。
  const NORM = {
    // 标准正态 CDF：Φ(z) = ½(1+erf(z/√2))，erf 走 Γ 函数路线（下面定义），双精度而非 1e-7
    cdf: (z) => (isNum(z) ? 0.5 * (1 + erf(z / Math.SQRT2)) : NaN),
    // 逆正态：不用任何分位数系数表（Acklam/Wichura 的常数一旦记错就整体偏 0.2，且错在尾部看不出来）。
    //   这里用「自家 CDF + 括号 + 二分」求根：Φ 单调、括号内必变号，根存在且唯一；
    //   110 次二分足以压到相邻双精度，最后再用 pdf 做一步牛顿（尾部 pdf 下溢时跳过，否则飞千里）。
    inv: (p) => {
      if (!isNum(p) || !(p > 0 && p < 1)) return NaN;
      let lo = -1, hi = 1;
      for (let i = 0; i < 60 && !(NORM.cdf(lo) <= p); i++) lo *= 2;
      for (let i = 0; i < 60 && !(NORM.cdf(hi) >= p); i++) hi *= 2;
      for (let i = 0; i < 110; i++) {
        const mid = 0.5 * (lo + hi);
        if (NORM.cdf(mid) > p) hi = mid; else lo = mid;
        if (hi - lo < 1e-15 * Math.max(1, Math.abs(mid))) break;
      }
      const x0 = 0.5 * (lo + hi);
      const pdf = Math.exp(-0.5 * x0 * x0) / Math.sqrt(2 * Math.PI);
      const step = (NORM.cdf(x0) - p) / pdf;
      return isFinite(step) && Math.abs(step) < 1 ? x0 - step : x0;
    }
  };
  // erf(x) = sgn(x)·P(½, x²)。推导：γ(½,y)=∫₀^y t^{-½}e^{-t}dt，令 t=u² 得 2∫₀^√y e^{-u²}du = √π·erf(√y)
  //   这条路比 A&S 7.1.26（|ε|≤1.5e-7）精确约 9 个量级，尾部分位数反解才不会飞掉。
  function erf(x) {
    if (!isNum(x)) return NaN;
    if (x === 0) return 0;
    return (x < 0 ? -1 : 1) * gammaincLower(0.5, x * x);
  }
  // 不完全伽马：P(a,x)（正则下）与 Q(a,x)（正则上），级数 + Lentz 连分式（Numerical Recipes 写法）。
  //   Q 必须单独返回连分式的原始乘积：sf=1−P 在 x 大时会把 e^{−x/2}≈1e-9 淹死在「1 的抵消」里。
  function gammaSeriesP(a, x) {
    const gln = logGamma(a);
    let ap = a, sum = 1 / a, del = sum;
    for (let i = 0; i < 500; i++) {
      ap += 1; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  function gammaincUpper(a, x) {
    if (!(a > 0) || !(x >= 0)) return NaN;
    if (x === 0) return 1;
    if (x < a + 1) return 1 - gammaSeriesP(a, x);     // 此处 Q≈1，「1−P」不产生有效位损失；
    let b = x + 1 - a, c = 1e300, d = 1 / b;          // 反过来在小 x 上硬跑连分式会残差 1e-9（自检抓过）
    let h = d;
    for (let i = 1; i <= 500; i++) {
      const an = -i * (i - a);
      b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  }
  function gammaincLower(a, x) {
    if (!(a > 0) || !(x >= 0)) return NaN;
    if (x === 0) return 0;
    return x < a + 1 ? gammaSeriesP(a, x) : 1 - gammaincUpper(a, x);
  }
  function logGamma(x) {
    if (!isNum(x) || !(x > 0)) return NaN;
    // 只用「能从伯努利数推出来」的常数，不抄 Lanczos 系数表（NR 的 6 项表实测 lnΓ 偏 4e-8，
    //   9 项表我记错一位偏 4e-6；两者都会把 erf/卡方尾概率整体带偏）。
    //   做法：递推 Γ(z+1)=z·Γ(z) 把自变量抬到 ≥20，再用 Stirling 渐展开
    //     lnΓ(z) = (z−½)ln z − z + ½ln(2π) + Σ_k B_{2k}/(2k(2k−1)·z^{2k−1})，B2..B12 = 1/6, −1/30, 1/42, −1/30, 5/66, −691/2730
    //   截断项 1/(156·z¹³) 在 z=20 处 ≈ 8e-19 ⇒ 实测 lnΓ(n)=ln(n!) 与 Γ(½)=√π 都到 1e-14 量级
    let acc = 0, z = x;
    while (z < 20) { acc -= Math.log(z); z += 1; }
    const inv = 1 / z, inv2 = inv * inv;
    const ser = inv * (1 / 12 + inv2 * (-1 / 360 + inv2 * (1 / 1260 + inv2 * (-1 / 1680 + inv2 * (1 / 1188 + inv2 * (-691 / 360360))))));
    const r = acc + (z - 0.5) * Math.log(z) - z + 0.5 * Math.log(2 * Math.PI) + ser;
    return isFinite(r) ? r : NaN;
  }
  const chiSquareCdf = (x, dof) => (isNum(x) && isNum(dof) && x >= 0 && dof > 0 ? gammaincLower(dof / 2, x / 2) : NaN);
  const chiSquareSurvival = (x, dof) => (isNum(x) && isNum(dof) && x >= 0 && dof > 0 ? gammaincUpper(dof / 2, x / 2) : NaN);
  // 卡方临界值：对 survival 做二分（单调性由 CDF 保证，避免记一张表）
  function chiSquareCritical(dof, probUpper) {
    if (!isNum(dof) || dof <= 0 || !isNum(probUpper) || !(probUpper > 0 && probUpper < 1)) return NaN;
    let lo = 0, hi = 10;
    while (chiSquareSurvival(hi, dof) > probUpper && hi < 1e7) hi *= 2;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (chiSquareSurvival(mid, dof) > probUpper) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  // CEP(p)：圆情形给解析瑞利分位数；一般情形用「等效能级 σ̄」的正态近似
  function cepFromSigma(a, b, p) {
    if (!isNum(a) || !isNum(b) || a < 0 || b < 0 || !isNum(p) || !(p > 0 && p < 1)) return null;
    if (Math.abs(a - b) < 1e-12) return a * Math.sqrt(-2 * Math.log(1 - p));   // 瑞利分布分位数（可解析推导）
    const s = Math.sqrt((a * a + b * b) / 2);                                  // 等效圆 σ（二次平均）
    return s * Math.sqrt(-2 * Math.log(1 - p));
  }

  /* ================================================================ 8. 完整性 / RAIM */
  // 卡方完整性检验（RAIM 的检测统计量）与逐星故障剔除
  function raimCheck(result, sigma0_m, alpha) {
    if (!result || !isNum(result.chi2) || !isNum(result.chi2_dof)) return { error: '需要 solvePosition 的输出（含 chi2/dof）' };
    const a = isNum(alpha) ? alpha : 0.01;
    const crit = chiSquareCritical(result.chi2_dof, a);
    return {
      test_statistic: result.chi2, dof: result.chi2_dof, critical_value: crit, alpha: a,
      alarm: isNum(result.chi2) && isNum(crit) ? result.chi2 > crit : null,
      protection_level_m: result.dop && isNum(result.dop.hdop) && isNum(sigma0_m)
        ? horizProtectionLevel(result.dop.hdop, sigma0_m, result.sats_used, a) : null,
      note: 'T = Σ(v_i/σ_i)²；solvePosition 未给先验 σ0 时 T 退化为自由度本身，检测失效——必须给 σ0'
    };
  }
  // 水平保护级（HPL）的简化闭式：HPL = K · σ0 · HDOP，K 由误警率与卫星数决定
  //   K 用「逐星剔除后最大位置偏差」的一阶近似，而不是照抄某一天的标准表；
  //   自检只验证单调性：σ0↑ ⇒ HPL↑，HDOP↑ ⇒ HPL↑，卫星数↑ ⇒ K↓。
  function horizProtectionLevel(hdop, sigma0_m, sats, alpha) {
    if (!isNum(hdop) || !isNum(sigma0_m) || sigma0_m <= 0) return null;
    const n = isNum(sats) ? clamp(sats, 4, 32) : 8;
    const a = isNum(alpha) ? clamp(alpha, 1e-6, 0.5) : 0.01;
    // K ≈ 正态分位(1−α/(2n)) 的一阶形式（RAIM 里常见的近似）
    const K = NORM.inv(1 - a / (2 * n));
    return K * sigma0_m * hdop;
  }
  // 逐星剔除（故障检测与剔除 FDE）的显式接口：给候选剔除集，返回每种剔除的残差与偏差
  function excludeAndResolve(satEcef, ranges, guess, opts) {
    const o = Object.assign({ raim: false }, opts || {});
    const base = solvePosition(satEcef, ranges, guess, o);
    if (base.error) return base;
    const trials = [];
    for (let i = 0; i < satEcef.length; i++) {
      const s = satEcef.filter((_, j) => j !== i), r = ranges.filter((_, j) => j !== i);
      if (s.length < (isNum(o.clock_bias_m) ? 3 : 4)) continue;
      const alt = solvePosition(s, r, { x: base.x, y: base.y, z: base.z }, o);
      if (alt.error) continue;
      trials.push({
        excluded_prn: satEcef[i].prn != null ? satEcef[i].prn : i,
        rms_residual_m: alt.rms_residual_m,
        position_shift_m: Math.hypot(alt.x - base.x, alt.y - base.y, alt.z - base.z),
        lat: alt.lat, lon: alt.lon, h: alt.h, hdop: alt.dop ? alt.dop.hdop : null
      });
    }
    trials.sort((x, y) => x.rms_residual_m - y.rms_residual_m);
    return { base_rms: base.rms_residual_m, best_exclusion: trials[0] || null, trials: trials.slice(0, 12) };
  }

  /* ================================================================ 9. 精密服务电文（修复弹道） */
  /* 三条链路的共同套路：解析「格点/区域改正」或「状态空间域改正」→ 当作伪距/位置修正使用。
   * 诚实说明：本引擎实现的是「播发内容的解算」，不是完整的 PPP（无载波相位、无模糊度解算）。
   *           因此修复后的精度量级是亚米~米级，返回里带 service_note，UI 必须原样展示。
   */
  // QZSS L6 / CLAS：RS 码帧（PRN 193~202）→ CLAS 子帧的「修复分层」计数。
  // 完整的 CLAS 是 3 层（卫星轨道钟差 / 格点电离层 / 码偏差）的比特池，这里解析到「子帧类型 + 尺寸 + 区域」，
  // 并把解析不确定的部分明确标记 unsupported，而不是猜。
  function decodeL6Frame(bits) {
    const s = String(bits == null ? '' : bits).replace(/[^01]/g, '');
    if (s.length < 24) return { error: 'L6 比特流不足 24 位（本接口接受 "0101…" 形式的原始比特）' };
    const u = (i, len) => { let v = 0; for (let k = 0; k < len; k++) v = (v << 1) | (Number(s[i + k]) || 0); return v; };
    const prn = u(0, 8), mt = u(8, 6), ncf = u(15, 3), sid = u(18, 2), batch = u(20, 2);
    const CLAS_MT = 63;
    const out = {
      prn_hint: prn, message_type: mt, ncf, satellite_information_id: sid, batch_id: batch,
      is_clas: mt === CLAS_MT,
      raw_bits: s.length,
      service_note: mt === CLAS_MT
        ? 'CLAS 亚米级服务：需要按 ARIB STD-T147 的 3 层比特池继续解包（残差轨道/钟差、格点电离层、码偏差）。本实现只解到帧头与批次，不猜测载荷内容。'
        : '非 CLAS 消息类型 ' + mt + '（1~58 为 submeter/报警等旧格式）'
    };
    if (mt === CLAS_MT) out.layers = ['residual orbit + clock', 'gridded ionosphere (STEC)', 'code bias (PDC)'];
    return out;
  }
  // BDS PPP-B2b：IADS 消息（B2b 信号）里的「精密轨道 + 钟差 + 网格电离层 + 码偏差」。
  // 这里实现可以确定的部分：域改正数（轨道径向/切向/法向 + 钟差）与 GEC 网格电离层的字段级解包，
  // 但比特位置（MSB 优先、字段长度）来自 BDS-SIS-ICD-3.0 的 IADS-B2b 定义；若与官方文档不符，
  // 返回里会明确标记 field_map_version 并把不确定的字段置 null，而不是填一个看起来合理的值。
  function decodePppB2b(bits, opt) {
    const o = opt || {};
    const s = String(bits == null ? '' : bits).replace(/[^01]/g, '');
    if (s.length < 8) return { error: 'PPP-B2b 比特流不足 8 位' };
    const u = (i, len) => { let v = 0; for (let k = 0; k < len; k++) v = (v << 1) | (Number(s[i + k]) || 0); return v; };
    const msgType = u(0, 6);
    const IADS_MSG_TYPES = { 1: 'IADS-B2b HFPI（广播星历+完好性）', 2: 'IADS-B2b PPP INS（惯导组合）', 3: 'IADS-B2b PPP（精密轨道钟差）', 4: 'IADS-B2b GEC（网格电离层码偏差）' };
    if (!IADS_MSG_TYPES[msgType]) return { error: '未知 IADS 消息类型 ' + msgType + '（有效值 1~4）', supported_types: IADS_MSG_TYPES };
    const out = { message_type: msgType, message_name: IADS_MSG_TYPES[msgType], raw_bits: s.length, field_map_version: 'BDS-SIS-ICD-3.0 摘要，未逐字段核对' };
    if (msgType === 3) {
      out.satellite_id = u(6, 6);
      out.iod = u(12, 4);
      // 轨道改正的三轴比例因子依赖消息里的 scale flag（0.25/1024·2^k，k 未提供），
      // 因此这里【不给猜测值】：radial 返回 null，只在调用方通过 opt.radial_scale 显式提供时才算。
      out.radial_m = isNum(o.radial_scale) ? signed(s, 16, 12) * o.radial_scale : null;
      out.tangential_m = null; out.normal_m = null; out.clock_bias_m = null;
      out.note = '比例因子未提供时不猜测；用 {radial_scale: 0.25/1024} 之类的显式值才能解出改正量';
    } else if (msgType === 4) {
      out.grid_type = 'GEC';
      out.note = '网格电离层 + 码偏差（STEC 三维格点）需要整批解包，这里只给出消息识别';
    } else out.note = '消息类型 ' + msgType + ' 仅识别，不解包';
    return out;
  }
  function signed(bitsStr, start, len) {
    let v = 0;
    for (let k = 0; k < len; k++) v = (v << 1) | (Number(bitsStr[start + k]) || 0);
    if (v & (1 << (len - 1))) v -= (1 << len);
    return v;
  }
  // BeiDou-3 CSAS（厘米级区域增强，B1C/B2a 播发）：状态空间域改正的「使用侧」实现——
  // 接受用户提供的 [dOrb_r, dOrb_t, dOrb_n, dClock, dIono_grid, dDcb]，把它们真正作用到伪距上。
  // 这一步是纯计算，没有编造：改正数由用户/播发提供，本函数负责正确的坐标旋转与符号。
  function applyOrbitCorrection(satEcef, satVelEcef, dRtn) {
    if (!satEcef || ![satEcef.x, satEcef.y, satEcef.z].every(isNum)) return { error: '需要卫星 ECEF 位置（x/y/z 都是有限数）' };
    if (!dRtn || !isNum(dRtn.radial_m) || !isNum(dRtn.tangential_m) || !isNum(dRtn.normal_m)) return { error: '需要 RTN 三轴的数值改正（m）' };
    const r = [satEcef.x, satEcef.y, satEcef.z];
    const rn = Math.hypot(r[0], r[1], r[2]);
    if (!(rn > 0)) return { error: '卫星位置为零' };
    const eR = r.map((v) => v / rn);
    const v0 = satVelEcef && [satVelEcef.vx, satVelEcef.vy, satVelEcef.vz].every(isNum) ? [satVelEcef.vx, satVelEcef.vy, satVelEcef.vz] : null;
    let eT;
    if (v0) {
      const vr = v0[0] * eR[0] + v0[1] * eR[1] + v0[2] * eR[2];
      const t = [v0[0] - vr * eR[0], v0[1] - vr * eR[1], v0[2] - vr * eR[2]];
      const tn = Math.hypot(t[0], t[1], t[2]);
      if (!(tn > 0)) return { error: '速度方向与位置共线，无法构造切向' };
      eT = t.map((x) => x / tn);
    } else eT = null;
    // 没有速度时无法定义 RTN 的切向/法向：只加径向改正，并明确返回 degraded=true 要求调用方补速度。
    if (!eT) {
      return {
        degraded: true,
        position: { x: satEcef.x + dRtn.radial_m * eR[0], y: satEcef.y + dRtn.radial_m * eR[1], z: satEcef.z + dRtn.radial_m * eR[2] },
        note: '未提供卫星速度：只能加「径向」改正，切向/法向需 RTN 定义，返回的 position 只含径向改正'
      };
    }
    const eNn = cross3(eR, eT);
    const dx = dRtn.radial_m * eR[0] + dRtn.tangential_m * eT[0] + dRtn.normal_m * eNn[0];
    const dy = dRtn.radial_m * eR[1] + dRtn.tangential_m * eT[1] + dRtn.normal_m * eNn[1];
    const dz = dRtn.radial_m * eR[2] + dRtn.tangential_m * eT[2] + dRtn.normal_m * eNn[2];
    return {
      degraded: false,
      position: { x: satEcef.x + dx, y: satEcef.y + dy, z: satEcef.z + dz, elev: satEcef.elev, az: satEcef.az, snr: satEcef.snr, prn: satEcef.prn },
      shift_m: Math.hypot(dx, dy, dz), rtn_axes: { r: eR, t: eT, n: eNn },
      service_note: 'CSAS/PPP-B2b 的域改正只到「轨道+钟差+电离层+码偏差」，不含载波相位模糊度，精度量级亚米~米'
    };
  }
  function cross3(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return { error: '叉积需要两个至少 3 分的向量' };
    if (![a[0], a[1], a[2], b[0], b[1], b[2]].every(isNum)) return { error: '叉积的向量元素必须是有限数' };
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  // 钟差改正作用到伪距：ρ_corrected = ρ − c·dt_sat + c·dt_rcv(未知) − 电离层 − 对流层 − 相对论 − Sagnac
  function correctPseudorange(raw_m, corrections) {
    if (!isNum(raw_m)) return { error: '需要有限的原始伪距（m）' };
    const c = (corrections && typeof corrections === 'object') ? corrections : {};
    const terms = {
      satellite_clock_m: isNum(c.sat_clock_s) ? -c.sat_clock_s * C_LIGHT : 0,
      tgd_m: isNum(c.tgd_s) ? -c.tgd_s * C_LIGHT : 0,
      ionosphere_m: isNum(c.iono_m) ? -c.iono_m : 0,
      troposphere_m: isNum(c.tropo_m) ? -c.tropo_m : 0,
      relativistic_m: isNum(c.rel_s) ? -c.rel_s * C_LIGHT : 0,
      sagnac_m: isNum(c.sagnac_m) ? -c.sagnac_m : 0,
      phase_center_m: isNum(c.pc_m) ? -c.pc_m : 0,
      service_correction_m: isNum(c.service_m) ? -c.service_m : 0
    };
    const sum = Object.keys(terms).reduce((a, k) => a + terms[k], 0);
    return { range_m: raw_m + sum, terms, applied_m: sum, note: '所有项都已按「加到伪距上」的符号给出；未提供的项按 0 计并在 terms 里显示' };
  }

  /* ================================================================ 10. 多源解融合 */
  /* 协方差加权（BLUE）+ 卡方一致性检验：把 GNSS / 基站 / Wi-Fi / IP 四类解合成一个点。
   * 输入每条解：{lat, lon, h?, sigma_m | sigma_e_m/sigma_n_m, source, weight_hint?}
   * 输出的 χ² 用于「离线解与联网解偏差是否可接受」的判定，是联网升级策略的依据。
   */
  function fuseSolutions(solutions, opt) {
    const o = opt || {};
    if (!Array.isArray(solutions) || !solutions.length) return { error: '需要至少一条定位解' };
    const list = [];
    const warnings = [];
    for (const s of solutions) {
      if (!s || !isNum(s.lat) || !isNum(s.lon)) { warnings.push('忽略缺经纬度的解：' + (s && s.source ? s.source : 'unknown')); continue; }
      const se = isNum(s.sigma_e_m) ? s.sigma_e_m : (isNum(s.sigma_m) ? s.sigma_m : null);
      const sn = isNum(s.sigma_n_m) ? s.sigma_n_m : (isNum(s.sigma_m) ? s.sigma_m : null);
      if (!isNum(se) || !isNum(sn) || se <= 0 || sn <= 0) { warnings.push('忽略缺不确定度的解：' + (s.source || 'unknown')); continue; }
      list.push({ source: s.source || 'solution', lat: clamp(s.lat, -90, 90), lon: wrap180(s.lon), h: isNum(s.h) ? s.h : null, se, sn, w: 1 / (se * se), wN: 1 / (sn * sn) });
    }
    if (!list.length) return { error: '没有带不确定度的可用解', warnings };
    const lat0 = list.reduce((a, x) => a + x.lat, 0) / list.length, lon0 = list.reduce((a, x) => a + x.lon, 0) / list.length;
    // 局部平面（米）→ 融合 → 回到经纬度
    const plane = list.map((x) => Object.assign({}, x, { e: mPerDegLon(lat0) * wrap180(x.lon - lon0), n: mPerDegLat() * (x.lat - lat0) }));
    const fuseAxis = (key, wkey) => {
      const sw = plane.reduce((a, x) => a + x[wkey], 0);
      const m = plane.reduce((a, x) => a + x[wkey] * x[key], 0) / sw;
      const varPost = 1 / sw;
      const chi2 = plane.reduce((a, x) => a + (x[key] - m) * (x[key] - m) * x[wkey], 0);
      return { mean: m, sigma: Math.sqrt(varPost), chi2, dof: plane.length - 1 };
    };
    const fe = fuseAxis('e', 'w'), fn = fuseAxis('n', 'wN');
    const dof = Math.max(1, plane.length - 1);
    const totalChi2 = fe.chi2 + fn.chi2, totalDof = 2 * dof;
    const p = chiSquareSurvival(totalChi2, totalDof);
    let hFuse = null, hSig = null;
    const hs = plane.filter((x) => isNum(x.h));
    if (hs.length) {
      const wsum = hs.reduce((a, x) => a + 1 / Math.pow(isNum(x.sigma_h_m) ? Math.max(x.sigma_h_m, 1e-6) : 5, 2), 0);
      hFuse = hs.reduce((a, x) => a + x.h / Math.pow(isNum(x.sigma_h_m) ? Math.max(x.sigma_h_m, 1e-6) : 5, 2), 0) / wsum;
      hSig = Math.sqrt(1 / wsum);
    }
    const inconsistent = p != null && p < (o.alpha || 0.001);
    return {
      lat: lat0 + fn.mean / mPerDegLat(), lon: wrap180(lon0 + fe.mean / mPerDegLon(lat0)),
      h: hFuse, sigma_e_m: fe.sigma, sigma_n_m: fn.sigma, sigma_h_m: hSig,
      cep68_m: cepFromSigma(fe.sigma, fn.sigma, 0.68),
      consistency: { chi2: totalChi2, dof: totalDof, p_value: p, inconsistent, threshold_alpha: o.alpha || 0.001 },
      sources: plane.map((x) => ({ source: x.source, lat: x.lat, lon: x.lon, sigma_m: Math.sqrt(1 / x.w), residual_n_m: x.n - fn.mean, residual_e_m: x.e - fe.mean })),
      warnings,
      recommendation: inconsistent
        ? '各解之间的偏差超出各自不确定度（χ² 检验 p=' + (p != null ? p.toExponential(2) : 'NA') + '）：优先信任不确定度最小者，并把其余标记为待核查；不要直接取平均'
        : '各解在不确定度范围内一致，可直接取加权平均'
    };
  }

  /* ================================================================ 11. 定位质量评估 */
  function qualityReport(fix, opts) {
    const o = opts || {};
    if (!fix || (!isNum(fix.lat) && !isNum(fix.x))) return { error: '需要定位解' };
    const out = { usable: fix.sats_used >= (o.minSats || 4) };
    const el = isNum(fix.elevation_min_deg) ? fix.elevation_min_deg : null;
    out.satellites = fix.sats_used || null;
    out.min_elevation_deg = el;
    out.hdop = fix.dop ? fix.dop.hdop : (isNum(fix.hdop) ? fix.hdop : null);
    out.pdop = fix.dop ? fix.dop.pdop : (isNum(fix.pdop) ? fix.pdop : null);
    out.gdop = fix.dop ? fix.dop.gdop : null;
    out.rms_residual_m = isNum(fix.rms_residual_m) ? fix.rms_residual_m : null;
    out.cep68_m = isNum(fix.cep68_m) ? fix.cep68_m : (out.hdop != null && isNum(o.sigma_m) ? cepFromSigma(out.hdop * o.sigma_m, out.hdop * o.sigma_m, 0.68) : null);
    out.grade = gradeFix(out, el, o);
    out.notes = [];
    if (el != null && el < 10) out.notes.push('最低高度角 ' + el.toFixed(1) + '°：多路径风险高，建议提高到 15° 截止角');
    if (out.hdop != null && out.hdop > 2) out.notes.push('HDOP ' + out.hdop.toFixed(2) + '：几何构型一般');
    if (out.rms_residual_m != null && out.rms_residual_m > 5) out.notes.push('残差 RMS ' + out.rms_residual_m.toFixed(2) + ' m：可能存在粗差或大气异常');
    if (!out.notes.length) out.notes.push('未见明显质量风险');
    return out;
  }
  function gradeFix(q, minEl, o) {
    const hd = q.hdop, rms = q.rms_residual_m, sats = q.satellites;
    let score = 100;
    if (isNum(hd)) score -= clamp((hd - 0.8) * 18, 0, 45);
    if (isNum(sats)) score -= clamp((12 - sats) * 3, 0, 20);
    if (isNum(minEl)) score -= clamp((15 - minEl) * 2.5, 0, 20);
    if (isNum(rms)) score -= clamp(rms * 4, 0, 25);
    if (q.integrity_alarm) score -= 40;
    const s = clamp(score, 0, 100);
    const label = s >= 85 ? '优' : s >= 70 ? '良' : s >= 50 ? '一般' : s >= 30 ? '差' : '不可用';
    void o;
    return { score: s, label, basis: '启发式加权（HDOP/星数/截止角/残差），不是任何标准规范里的量纲' };
  }

  /* ================================================================ 12. 由方位/高度角做几何分析 */
  // 视线单位矢量（站心 ENU）：az 自北顺时针、el 仰角
  function losEnu(az_deg, el_deg) {
    const a = Number(az_deg), e = Number(el_deg);
    if (!isFinite(a) || !isFinite(e)) return { error: '方位/高度角非法' };
    const c = Math.cos(e * D2R);
    return { e: c * Math.sin(a * D2R), n: c * Math.cos(a * D2R), u: Math.sin(e * D2R) };
  }
  // 只给 GSV（方位+高度角+信噪比）就能算 DOP 与局部线性化解：不需要卫星位置
  function geometryFromAzEl(list, opt) {
    const o = opt || {};
    if (!Array.isArray(list) || !list.length) return { error: '需要卫星列表' };
    // 与 solvePosition 同一套约定：默认把钟差当第 4 个未知数；fixClock:true（或给了 clock_bias_m）
    // 表示钟差已知，DOP 只由 3 个位置未知数构成。
    const useClock = !(o.fixClock === true || isNum(o.clock_bias_m));
    const unk = useClock ? 4 : 3;
    if (list.length < unk) return { error: '至少需要 ' + unk + ' 颗卫星' };
    const A = [], w = [];
    for (const s of list) {
      const l = losEnu(s.azimuth_deg != null ? s.azimuth_deg : s.az, s.elevation_deg != null ? s.elevation_deg : s.el);
      if (l.error) return l;
      const row = [-l.e, -l.n, -l.u];
      if (useClock) row.push(1);
      A.push(row);
      const snr = numOr(s.snr_db != null ? s.snr_db : s.snr, null);
      w.push(snr != null ? Math.pow(10, clamp(snr, 0, 60) / 10) : 1);
    }
    const N = [], Q = [];
    for (let a = 0; a < unk; a++) { N.push(new Array(unk).fill(0)); Q.push(new Array(unk).fill(0)); }
    for (let j = 0; j < A.length; j++) for (let a = 0; a < unk; a++) for (let c = 0; c < unk; c++) N[a][c] += w[j] * A[j][a] * A[j][c];
    const inv = invertSym(N);
    if (inv.error) return inv;
    const hd = Math.sqrt(Math.max(0, inv[0][0] + inv[1][1]));
    const vd = Math.sqrt(Math.max(0, inv[2][2]));
    const pd = Math.sqrt(Math.max(0, inv[0][0] + inv[1][1] + inv[2][2]));
    const td = useClock ? Math.sqrt(Math.max(0, inv[3][3])) : 0;
    return {
      hdop: hd, vdop: vd, pdop: pd, tdop: td, gdop: Math.sqrt(pd * pd + td * td),
      sats: A.length, identity: { gdop_minus: Math.sqrt(pd * pd + td * td) - Math.sqrt(Math.max(0, inv[0][0] + inv[1][1] + inv[2][2] + (useClock ? inv[3][3] : 0))) },
      note: '权重按 10^(SNR/10)（即 1/σ² 与 C/N0 的关系）；未给 SNR 时等权'
    };
  }
  // 天空图数据（UI 直接画图用）：按方位/高度整理，并给出遮蔽判断
  function skyPlot(list, mask_deg) {
    if (!Array.isArray(list)) return { error: '需要卫星列表（数组）' };
    const mk = isNum(mask_deg) ? mask_deg : (mask_deg === Infinity ? 89 : 0);
    const m = clamp(mk, 0, 89);
    const items = list.map((s) => ({
      prn: s && s.prn != null ? s.prn : null, system: (s && (s.system || s.talker)) || null,
      az: s ? numOr(s.azimuth_deg != null ? s.azimuth_deg : s.az, null) : null,
      el: s ? numOr(s.elevation_deg != null ? s.elevation_deg : s.el, null) : null,
      snr: s ? numOr(s.snr_db != null ? s.snr_db : s.snr, null) : null,
      visible: !!s && (numOr(s.elevation_deg != null ? s.elevation_deg : s.el, -90)) > m
    }));
    return { items, mask_deg: m, used: items.filter((x) => x.visible).length, total: items.length };
  }
  // 一条完整的「GSV + 伪距相对量」定位：以第 1 颗星为参考做单差（single difference）。
  // 模型：Δρ_i = −los_i·δ ⇒ 单差 Δρ_i − Δρ_0 = −(los_i − los_0)·δ。
  // 同一台接收机的钟差在单差里被完全抵消，因此未知数只有 (dE, dN, dU) 三个——不是四个。
  function relativeFix(list, rangeDeltas_m, guess, opt) {
    if (!Array.isArray(list) || !Array.isArray(rangeDeltas_m)) return { error: '需要卫星列表与伪距差数组' };
    if (list.length < 4) return { error: '需要至少 4 颗卫星（含参考星）' };
    if (list.length !== rangeDeltas_m.length) return { error: '卫星列表与伪距差数组长度不一致' };
    const sats = list.map((s) => Object.assign({}, s, { los: losEnu(s.azimuth_deg != null ? s.azimuth_deg : s.az, s.elevation_deg != null ? s.elevation_deg : s.el) }));
    if (sats.some((s) => s.los.error)) return { error: '存在非法的方位/高度角' };
    if (rangeDeltas_m.some((v) => !isNum(v))) return { error: '伪距差含非数值' };
    const ref = sats[0];
    const A = [], b = [];
    for (let i = 1; i < sats.length; i++) {
      A.push([-(sats[i].los.e - ref.los.e), -(sats[i].los.n - ref.los.n), -(sats[i].los.u - ref.los.u)]);
      b.push(rangeDeltas_m[i] - rangeDeltas_m[0]);
    }
    const wts = sats.map((s) => { const snr = numOr(s.snr_db != null ? s.snr_db : s.snr, null); return snr != null ? Math.pow(10, clamp(snr, 0, 60) / 10) : 1; });
    const N = [], g = [];
    for (let a = 0; a < 3; a++) { N.push(new Array(3).fill(0)); g.push(0); }
    for (let j = 0; j < A.length; j++) {
      const w = wts[j + 1];
      for (let a = 0; a < 3; a++) { g[a] += w * A[j][a] * b[j]; for (let c = 0; c < 3; c++) N[a][c] += w * A[j][a] * A[j][c]; }
    }
    const inv = invertSym(N); if (inv.error) return inv;
    const d = matVec(inv, g);
    const dof = A.length - 3;
    let sigma0 = null, formal = null;
    if (dof > 0) {
      let ssq = 0;
      for (let j = 0; j < A.length; j++) {
        const r = b[j] - (A[j][0] * d[0] + A[j][1] * d[1] + A[j][2] * d[2]);
        ssq += wts[j + 1] * r * r;
      }
      sigma0 = Math.sqrt(ssq / dof);
      formal = { dE_m: sigma0 * Math.sqrt(Math.max(0, inv[0][0])), dN_m: sigma0 * Math.sqrt(Math.max(0, inv[1][1])), dU_m: sigma0 * Math.sqrt(Math.max(0, inv[2][2])) };
    }
    const lat0 = guess && isNum(guess.lat) ? guess.lat : 0, lon0 = guess && isNum(guess.lon) ? guess.lon : 0;
    return {
      lat: lat0 + d[1] / mPerDegLat(), lon: wrap180(lon0 + d[0] / mPerDegLon(lat0)),
      dE_m: d[0], dN_m: d[1], dU_m: d[2],
      equations: A.length, dof, sigma0_m: sigma0, formal_std_m: formal,
      ddop_like: Math.sqrt(Math.max(0, inv[0][0] + inv[1][1])),
      clock_m: null,
      note: '单差已抵消接收机钟差（所以没有钟未知数），给出的是相对参考点的位移，不是绝对坐标；绝对定位请用 solvePosition'
    };
  }

  /* ================================================================ 12.5 内置演示星历场景 */
  /* UI 的 GNSS 页与自检都需要「真值已知的伪距观测量」。这里用一条参考星历（GPS 量级的轨道根数）
   * 把卫星在升交点/平近点角上铺开，逐颗做可见性判定，再按接收机真值合成
   * 几何距离 + Sagnac 改正 + 统一钟差。
   * 噪声用固定种子的线性同余：同一个 seed 必得同一个场景，否则自检门会随随机数抖动，
   * 演示结果也无法复现（这是「可复核」的前提，不是便利）。
   * 注意：这是**演示合成场景**，不是任何当周的广播星历；返回里带 ephemeris_source 说明。 */
  const REF_EPH = {
    sys: 'GPS', prn: 5, sqrtA: 5153.689, e: 0.0215, M0: 0.732, deltaN: 4.8e-9,
    Omega0: 1.234, omegaDot: -8.3e-11, i0: 0.965, iDot: 4.2e-11, omega: 0.317,
    toe: 200000, toc: 200000, af0: 4.2e-4, af1: 2.1e-12, af2: 0, TGD: -5.3e-9,
    Cuc: 1.1e-6, Cus: 8.4e-7, Crc: 122.5, Crs: 54.3, Cic: 2.4e-6, Cis: 1.8e-6
  };

  function azElFromEcef(sat, rcvEcef, lat, lon) {
    const m = enuMatrix(lat, lon);
    if (m.error) return m;
    const dx = sat.x - rcvEcef.x, dy = sat.y - rcvEcef.y, dz = sat.z - rcvEcef.z;
    const e = m[0][0] * dx + m[0][1] * dy + m[0][2] * dz;
    const n = m[1][0] * dx + m[1][1] * dy + m[1][2] * dz;
    const u = m[2][0] * dx + m[2][1] * dy + m[2][2] * dz;
    if (!isNum(e) || !isNum(n) || !isNum(u)) return { error: '卫星与接收机坐标不可算方位高度角' };
    const horiz = Math.hypot(e, n);
    return { azimuth_deg: wrap360(Math.atan2(e, n) * R2D), elevation_deg: Math.atan2(u, horiz) * R2D, range_m: Math.hypot(e, n, u) };
  }

  function demoScene(truth, opt) {
    const o = opt || {}, t = truth || {};
    const lat = isNum(t.lat) ? clamp(t.lat, -89.5, 89.5) : 31.2304;
    const lon = isNum(t.lon) ? wrap180(t.lon) : 121.4737;
    const h = isNum(t.h) ? t.h : 12;
    const want = clamp(Math.round(isNum(o.n) ? o.n : 9), 4, 12);
    const sigma = isNum(o.noise_m) && o.noise_m > 0 ? o.noise_m : 0;
    const mask = isNum(o.mask_deg) ? clamp(o.mask_deg, -5, 60) : 5;
    const seed = isNum(o.seed) ? Math.round(o.seed) : 20261101;
    const outlier = isNum(o.outlier_m) ? o.outlier_m : 0;
    let rs = (Math.abs(seed) % 4294967296) || 1;
    const uni = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
    // 12 个均匀数之和 −6：中心极限近似高斯，σ 偏差 <6%，演示与自检够用且完全可复现
    const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += uni(); return s - 6; };

    const rcv = geodeticToEcef(lat, lon, h);
    if (!rcv || !isNum(rcv.x)) return { error: '接收机先验坐标非法' };
    const cdt = isNum(o.clock_bias_m) ? o.clock_bias_m : 1734567.8901;
    const pool = [];
    for (let k = 0; k < 40 && pool.length < want; k++) {
      const isBds = k % 3 === 2;
      const candPrn = 5 + (k % 20);
      // 同一制式内 PRN 必须唯一：prn = 5 + (k % 20) 在 k 与 k+20 上是同一个号，
      // 于是 12 颗的池子里会塞进两颗「GPS PRN6」。 skyPlot / excluded_prns / 逐星剔除都按
      // sys+prn 认星，重号之后界面会出现两颗同名卫星，剔除记录也看着像 bug（[22,12,6,6,6,6]）。
      if (pool.some((it) => it.eph.sys === (isBds ? 'BDS' : 'GPS') && it.eph.prn === candPrn)) continue;
      const eph = Object.assign({}, REF_EPH, {
        sys: isBds ? 'BDS' : 'GPS',
        prn: candPrn,
        Omega0: wrap2pi(REF_EPH.Omega0 + k * (2 * PI / 9)),
        M0: wrap2pi(REF_EPH.M0 + k * 1.13),
        i0: clamp(REF_EPH.i0 + (k % 5) * 0.07, 0.55, 1.4),
        sqrtA: REF_EPH.sqrtA + (k % 4) * 6
      });
      const tow = REF_EPH.toe + ((k * 1900) % 4300);
      const p = satPosition(eph, tow);
      if (!p || p.error || !isNum(p.x)) continue;
      const ae = azElFromEcef(p, rcv, lat, lon);
      if (ae.error || !(ae.elevation_deg > mask)) continue;
      pool.push({ eph: eph, tow: tow, pos: p, az: ae.azimuth_deg, el: ae.elevation_deg, rho: ae.range_m });
    }
    if (pool.length < 4) {
      return {
        error: '演示场景在纬度 ' + round(lat, 2) + '、截止高度角 ' + mask + '° 下只有 ' + pool.length + ' 颗可见卫星',
        sats_visible: pool.length, hint: '降低 mask_deg、增大 n 候选池，或换一个接收点纬度'
      };
    }
    const oi = outlier !== 0 ? Math.floor(pool.length / 2) : -1;
    const sats = [], ranges = [], detail = [];
    for (let i = 0; i < pool.length; i++) {
      const it = pool[i];
      const sagnac = OMEGA_E_DOT / C_LIGHT * (it.pos.x * rcv.y - it.pos.y * rcv.x);
      const noise = sigma > 0 ? gauss() * sigma : 0;
      const kick = i === oi ? outlier : 0;
      const snr = clamp(28 + it.el * 0.45 + (sigma > 0 ? gauss() * 1.2 : 0), 12, 52);
      sats.push(Object.assign({}, it.pos, { prn: it.eph.prn, sys: it.eph.sys, azimuth_deg: it.az, elevation_deg: it.el, snr_db: snr, tow: it.tow }));
      ranges.push(it.rho + sagnac + cdt + noise + kick);
      detail.push({ prn: it.eph.prn, sys: it.eph.sys, geometric_m: it.rho, sagnac_m: sagnac, noise_m: noise, outlier_m: kick });
    }
    return {
      truth: { lat: lat, lon: lon, h: h, x: rcv.x, y: rcv.y, z: rcv.z },
      satellites: sats, ranges_m: ranges, obs_detail: detail,
      clock_bias_m: cdt, sigma_m: sigma, seed: seed, mask_deg: mask,
      outlier: oi >= 0 ? { prn: sats[oi].prn, offset_m: outlier } : null,
      sats_visible: pool.length,
      ephemeris_source: '内置参考星历（演示合成的场景，不是当周广播星历；换真实星历请粘贴设备输出的 NMEA/GNAV）',
      note: '伪距 = 几何距离 + Sagnac（地球自转） + 统一钟差' + (sigma > 0 ? ' + 高斯噪声 σ=' + sigma + ' m' : '（无噪声，用于收敛验证）')
    };
  }

  /* ================================================================ 13. 导出 */
  const API = {
    VERSION: '1.0.0',
    // 常数与表
    WGS84, C_LIGHT, OMEGA_E_DOT, MU_GPS, MU_BDS, MU_GAL, MU_GLN, F_REL_GPS, GLONASS_J2, GLONASS_RE,
    SIGNALS, TALKER, NMEA_WORDS, GGA_QUALITY,
    // 基础
    geodeticToEcef, ecefToGeodetic, enuMatrix, keplerEccentricAnomaly, trueAnomalyFromE,
    // 时间
    jdFromCalendar, jdToCalendar, gpsWeekSecond, jdFromGpsWeekSecond, parseUtc, dayOfYear, isLeap, monthLen, zoneOffsetMinutes,
    // 频率
    wavelengthM, glonassChannelFreq, tgdToMeters,
    // NMEA
    nmeaChecksum, nmeaWrap, splitSentence, nmeaCoordToDeg, degToNmeaCoord, nmeaTime, nmeaDate,
    decodeNmea, buildNmea, mergeNmea, snrToUere,
    // 星历
    satPosition, satClock, glonassPosition, gravityAccel,
    // 大气
    troposphereZenith, troposphereMapping, ionoShell, ionoFreeRange, normalGravity, standardAtmosphere,
    // 解算
    solvePosition, raimCheck, excludeAndResolve, horizProtectionLevel,
    // 精密服务
    decodeL6Frame, decodePppB2b, applyOrbitCorrection, correctPseudorange, cross3,
    // 融合与质量
    fuseSolutions, qualityReport, geometryFromAzEl, losEnu, skyPlot, relativeFix,
    // 演示场景
    demoScene, azElFromEcef, REF_EPH,
    // 数学
    invertSym, matVec, transform3, ellipseFromCov2, erf, NORM, gammaincLower, gammaincUpper, logGamma,
    chiSquareCdf, chiSquareSurvival, chiSquareCritical, cepFromSigma,
    selfTest
  };
  global.GEOGNSS = API;
  globalThis.GEOGNSS = API;

  /* ================================================================ 14. 自检 */
  // 纪律：每条断言都必须是「可独立推导的恒等式」或「量级闸门」。
  // 不允许出现「我记得标准答案是 XXX」式的期望值；抓错的能力在 detail 里如实写出。
  function selfTest() {
    const out = [];
    // 只认严格 true：写成返回对象/数字的「顺手真值」会被静默放过，闸门就失去意义了。
    const push = (name, pass, detail) => out.push({ name, pass: pass === true, detail: String(detail) });
    const near = (a, b, tol) => isNum(a) && isNum(b) && Math.abs(a - b) < tol;
    const hasNaN = (o, depth) => {
      if (depth == null) depth = 0;
      if (depth > 4) return false;
      if (typeof o === 'number') return !isFinite(o);
      if (Array.isArray(o)) return o.some((x) => hasNaN(x, depth + 1));
      if (o && typeof o === 'object') return Object.keys(o).some((k) => hasNaN(o[k], depth + 1));
      return false;
    };

    /* ---------- 1. 日历 / 儒略日 ---------- */
    const daySeq = [[2024, 2, 27], [2024, 2, 28], [2024, 2, 29], [2024, 3, 1]];
    const daySeq2 = [[2023, 12, 29], [2023, 12, 30], [2023, 12, 31], [2024, 1, 1], [2024, 1, 2]];
    let jdDiffOk = true;
    for (const seq of [daySeq, daySeq2]) {                 // 两条各自连续的序列：拼在一起会造出「3-1 → 12-30」这种假相邻
      for (let i = 1; i < seq.length; i++) {
        const a = jdFromCalendar(seq[i - 1][0], seq[i - 1][1], seq[i - 1][2]);
        const b = jdFromCalendar(seq[i][0], seq[i][1], seq[i][2]);
        if (Math.abs(b - a - 1) > 1e-12) jdDiffOk = false;
      }
    }
    push('儒略日逐日差分恒等于 1（含闰日与跨年）', jdDiffOk, daySeq.concat(daySeq2).map((d) => d.join('-')).join(' → '));
    // 绝对锚点：下面是公开的天文/时间常数（不是本实现算出来的），
    // 只有它们能抓住「常数项写错但差分正确」这一类错误（比如格里历 B 项）。
    const JD_ANCHORS = [
      [2000, 1, 1, 12.0, 2451545.0, 'J2000.0 历元'],
      [1970, 1, 1, 0.0, 2440587.5, 'UNIX 纪元'],
      [1980, 1, 6, 0.0, 2444244.5, 'GPS 纪元'],
      [1582, 10, 15, 0.0, 2299160.5, '格里历首日'],
      [1582, 10, 4, 0.0, 2299159.5, '格里历切换前一天（儒略历）'],
      [2024, 2, 29, 0.0, 2460369.5, '闰日'],
      [2017, 1, 1, 0.0, 2457754.5, '近年元旦']
    ];
    const anchorBad = JD_ANCHORS.filter((a) => Math.abs(jdFromCalendar(a[0], a[1], a[2] + a[3] / 24) - a[4]) > 1e-9);
    push('儒略日绝对锚点：J2000/UNIX/GPS 纪元与历法切换日逐一命中', anchorBad.length === 0,
      anchorBad.length ? anchorBad.map((a) => a[5] + ' 得 ' + jdFromCalendar(a[0], a[1], a[2] + a[3] / 24) + ' 应为 ' + a[4]).join('；') : JD_ANCHORS.map((a) => a[4]).join(' '));
    push('JD→日历 对同一批锚点反向精确还原', (() => {
      return JD_ANCHORS.every((a) => {
        const c = jdToCalendar(a[4]);
        return !c.error && c.year === a[0] && c.month === a[1] && c.day === a[2] && Math.abs(c.fractional_day * 24 - a[3]) < 1e-6;
      });
    })(), '锚点反解（含 12:00 的 J2000 与 .5 的零点约定）');
    push('GPS 纪元 JD 常量与日历函数一致（闰秒除外）', Math.abs(jdFromCalendar(1980, 1, 6) - GPS_EPOCH_JD) < 1e-12,
      jdFromCalendar(1980, 1, 6) + ' vs ' + GPS_EPOCH_JD);
    push('1900 非闰年 / 2000 是闰年（月份表按格里历规则）', monthLen(1900, 2) === 28 && monthLen(2000, 2) === 29 && monthLen(2100, 2) === 28 && monthLen(2024, 2) === 29,
      '1900-02=' + monthLen(1900, 2) + ' 天, 2000-02=' + monthLen(2000, 2) + ' 天');
    push('1900-02-28 的次日是 03-01（闰年规则真被走到）', (() => {
      const c = jdToCalendar(jdFromCalendar(1900, 2, 28) + 1);
      return c.year === 1900 && c.month === 3 && c.day === 1;
    })(), JSON.stringify(jdToCalendar(jdFromCalendar(1900, 2, 28) + 1)));
    let rtOk = true, rtBad = '';
    for (let i = 0; i < 60; i++) {
      const y = 1901 + (i * 37) % 320, mo = 1 + (i * 7) % 12, d = 1 + (i * 13) % 28;
      const c = jdToCalendar(jdFromCalendar(y, mo, d));
      if (c.year !== y || c.month !== mo || c.day !== d) { rtOk = false; rtBad = y + '-' + mo + '-' + d + ' → ' + c.date; }
    }
    push('日历↔JD 60 组随机日期往返一致', rtOk, rtBad || '全部闭合');
    // 这条是上面那条的「针对性版本」：年内日序 > 31 的日期曾经被年份判据
    // （误用 12 月长度 31 当上界）推倒成「下一年的负日序」，专门盯住它。
    let lateOk = true, lateBad = '';
    for (const t of [[2026, 11, 1], [2024, 2, 29], [2023, 12, 31], [1582, 10, 15], [1582, 10, 4], [1900, 3, 1], [2000, 2, 29], [1583, 1, 1]]) {
      const c = jdToCalendar(jdFromCalendar(t[0], t[1], t[2]));
      if (c.error || c.year !== t[0] || c.month !== t[1] || c.day !== t[2]) { lateOk = false; lateBad = t.join('-') + ' → ' + (c.error || c.date); }
    }
    push('年内日序大于 31 的日期（含儒略/格里切换边界）仍精确往返', lateOk, lateBad || '含 1582-10-04→10-15 缺口两侧');
    push('dayOfYear 拒绝越界月份/天数而不是死循环或 NaN', dayOfYear(2020, 13, 1) === null && dayOfYear(2020, Infinity, 1) === null && dayOfYear(2020, 2, 31) === null && dayOfYear(2020, 3, 1) === 61 && dayOfYear(2021, 3, 1) === 60,
      '2020-03-01 积日 ' + dayOfYear(2020, 3, 1) + '（闰年），2021-03-01 ' + dayOfYear(2021, 3, 1) + '，2020-02-31 → ' + dayOfYear(2020, 2, 31));
    push('parseUtc 拒绝「数字合法但不是日历」的输入', (() => {
      const a = parseUtc('2026-99-01T00:00:00Z'), b = parseUtc('2026-02-30T00:00:00Z'), c = parseUtc('2026-01-01T25:00:00Z'), d = parseUtc('20269990000');
      return a.error != null && b.error != null && c.error != null && d.error != null;
    })(), '99 月 / 2 月 30 / 25 时 / 年第 999 天');
    push('jdToCalendar 对离谱 JD 明确报错（不返回看似正常的日期）', jdToCalendar(1e18).error != null && jdToCalendar(-1e18).error != null && jdToCalendar(NaN).error != null,
      jdToCalendar(1e18).error);
    // 与实现无关的独立路径：把 1980-01-06 → 2000-01-01 12:00 逐年累加天数
    const days1980to2000 = (() => {
      let s = 0;
      for (let y = 1980; y < 2000; y++) {
        s += isLeap(y) ? 366 : 365;
      }
      s -= 5;                     // 1980-01-06 起算，减掉 1 月的前 6 天里多算的 6−1=5
      s += dayOfYear(2000, 1, 1) - 1;   // 2000-01-01 的年内偏移（=0）
      return s;
    })();
    const jdSpan = jdFromCalendar(2000, 1, 1.5) - jdFromCalendar(1980, 1, 6);
    push('GPS 纪元→J2000 中午的天数用逐年累加独立核对', Math.abs(jdSpan - (days1980to2000 + 0.5)) < 1e-9,
      'JD 差 ' + jdSpan.toFixed(4) + '，独立累加 ' + (days1980to2000 + 0.5));
    const ws = gpsWeekSecond(jdFromCalendar(2026, 11, 1.5), 18);
    push('GPS 周秒自洽：week·604800+tow− leap 秒 = 相对纪元的总秒数', Math.abs(ws.week * 604800 + ws.tow - ws.total_seconds) < 1e-6 && ws.tow >= 0 && ws.tow < 604800,
      'W' + ws.week + ' TOW ' + ws.tow.toFixed(3) + '（含 18 s 闰秒修正，闰秒值由调用方给定，本引擎不内置）');
    push('JD↔周秒往返（不丢整周）', (() => {
      const jd = jdFromCalendar(2026, 11, 1.5);
      const b = jdFromGpsWeekSecond(gpsWeekSecond(jd, 18).week, gpsWeekSecond(jd, 18).tow, 18);
      return Math.abs(b.jd_utc - jd) < 1e-9;
    })(), '往返残差 <1e-9 天');
    const isoZ = parseUtc('2026-11-01T12:00:00Z'), iso8 = parseUtc('2026-11-01T20:00:00+08:00');
    push('同一瞬间的不同时区写法必须给出相同 JD', Math.abs(isoZ.jd - iso8.jd) < 1e-9, isoZ.jd + ' vs ' + iso8.jd);
    const doyForm = parseUtc('2026305 120000');
    push('YYYYDDDHHMMSS 与 ISO 等价', Math.abs(doyForm.jd - isoZ.jd) < 1e-6, doyForm.kind + ' → ' + doyForm.jd);
    push('时间解析对垃圾输入返回 error 而不是 NaN', [parseUtc(''), parseUtc(null), parseUtc('abc'), parseUtc('2026-13-45T00:00:00Z')].every((x) => x.error || isNum(x.jd)),
      [parseUtc(''), parseUtc(null), parseUtc('abc')].map((x) => x.error).join(' | '));

    /* ---------- 2. NMEA ---------- */
    let ckRt = true;
    for (let i = 0; i < 20; i++) {
      const body = 'GPGGA,' + Math.random().toString(36).slice(2, 8) + ',' + i;
      const d = splitSentence(nmeaWrap(body));
      if (d.checksum_ok !== true) ckRt = false;
    }
    push('NMEA 校验和：自造语句 20 条必须全部通过', ckRt, 'XOR($ 与 * 之间) 与十六进制编码往返');
    push('篡改一个字符必须被校验和抓到', (() => {
      const s = nmeaWrap('GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W');
      const bad = s.slice(0, 10) + (s.charAt(10) === 'X' ? 'Y' : 'X') + s.slice(11);
      return splitSentence(bad).checksum_ok === false;
    })(), '改一个字节 → checksum_ok=false（该断言能抓「忘算校验和/包含 * 之后的字节」）');
    push('缺校验和时明确返回 null（不当作通过）', splitSentence('$GPGGA,123519,,,,').checksum_ok === null, '三态：true/false/null');
    push('度分→十进制度用独立算式核对（DDMM.mmmm）', (() => {
      const v = '3751.6512', d = nmeaCoordToDeg(v, 'N');
      const expect = 37 + 51.6512 / 60;
      return Math.abs(d.value - expect) < 1e-12 && d.degrees === 37 && Math.abs(d.minutes - 51.6512) < 1e-9;
    })(), '3751.6512 → ' + nmeaCoordToDeg('3751.6512', 'N').value + '（手算 37+51.6512/60）');
    push('南/西半球必须取负且绝对值与北/东相同', (() => {
      const n = nmeaCoordToDeg('3751.6512', 'N').value, s = nmeaCoordToDeg('3751.6512', 'S').value;
      const e = nmeaCoordToDeg('12130.000', 'E').value, w = nmeaCoordToDeg('12130.000', 'W').value;
      return Math.abs(s + n) < 1e-12 && Math.abs(w + e) < 1e-12;
    })(), 'S/W 反号');
    let coordRt = true, coordBad = '', worstRt = 0;
    // NMEA 的度分字段只有 4 位小数（1 LSB = 1e-4 分 = 1.6667e-6°），所以往返误差的物理下界是半个 LSB。
    //   闸门按这个可推导的量化限来判，而不是凭手感写 1e-8。
    for (let i = 0; i < 40; i++) {
      const lat = i === 0 ? 0 : (i === 1 ? 90 : (i === 2 ? -90 : -90 + Math.random() * 180));
      const lon = i === 1 ? 180 : (i === 2 ? -180 : -180 + Math.random() * 360);
      const t = degToNmeaCoord(lat, lon);
      const back = nmeaCoordToDeg(t.lat, t.hemiLat), backL = nmeaCoordToDeg(t.lon, t.hemiLon);
      const e = Math.max(Math.abs(back.value - lat), Math.abs(backL.value - lon));
      worstRt = Math.max(worstRt, e);
      if (!(e <= 8.4e-7) || back.value * lat < 0 || backL.value * lon < 0) { coordRt = false; coordBad = lat + ',' + lon; }
    }
    push('十进制度↔NMEA 度分 40 组随机往返 ≤ 半个 LSB（1e-4 分）', coordRt, '最大误差 ' + worstRt.toExponential(2) + '°（格式量化下限 8.33e-7°，含 0/±90/±180 边界）' + (coordBad ? ' 失败样本 ' + coordBad : ''));
    const ggaMade = buildNmea({ type: 'GGA', lat: 31.2304, lon: 121.4737, alt: 12.5, geoid_sep: -8.4, sats: 11, hdop: 1.2, fix_quality: 4, time: '041230.00' });
    const ggaBack = decodeNmea(ggaMade.sentence);
    push('GGA 生成→解析回到原值，且正高=椭球高−N', Math.abs(ggaBack.lat - 31.2304) < 1e-6 && Math.abs(ggaBack.lon - 121.4737) < 1e-6 &&
      Math.abs(ggaBack.alt - 12.5) < 1e-6 && Math.abs(ggaBack.height_msl - (12.5 - (-8.4))) < 1e-9 && ggaBack.checksum_ok !== false,
      ggaMade.sentence + ' → ' + ggaBack.lat + ',' + ggaBack.lon + ' 正高 ' + ggaBack.height_msl);
    const rmc = decodeNmea(buildNmea({ type: 'RMC', lat: -33.8688, lon: 151.2093, sog_knots: 10, cog_deg: 90, date: '230394', time: '123519', status: 'A' }).sentence);
    push('RMC 速度换算用「1 节 = 1852 m/h」精确定义核对', Math.abs(rmc.sog_mps - 10 * 1852 / 3600) < 1e-9, '10 kn → ' + rmc.sog_mps + ' m/s');
    push('RMC 日期+时刻合成 JD 必须等于各自 JD 之和', isNum(rmc.jd) && Math.abs(rmc.jd - (nmeaDate('230394').jd + (12 * 3600 + 35 * 60 + 19) / 86400)) < 1e-9, rmc.jd);
    push('日期字段按 80 为界解释世纪（0→2000、79→2079、80→1980）', nmeaDate('010100').year === 2000 && nmeaDate('010179').year === 2079 && nmeaDate('010180').year === 1980,
      nmeaDate('010180').iso + ' / ' + nmeaDate('010179').iso);
    push('不存在的日期必须报错（2 月 30 日）', nmeaDate('300223').error != null, nmeaDate('300223').error);
    const gsaRaw = '$GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,3.6*39';
    const gsa = decodeNmea(gsaRaw);
    // 期望值不靠记忆：从原始字符串自己切字段（标准 GSA = mode,fix,12×PRN,PDOP,HDOP,VDOP 共 17 项）
    const gsaFields = gsaRaw.replace(/^\$/, '').split('*')[0].split(',').slice(1);
    const gsaExpect = gsaFields.slice(2, 14).filter((x) => x.trim() !== '').length;
    push('GSA 使用星数与 DOP 字段位置正确', gsa.satellites_used === gsaExpect && gsaFields.length === 17 &&
      Math.abs(gsa.pdop - Number(gsaFields[14])) < 1e-12 && Math.abs(gsa.hdop - Number(gsaFields[15])) < 1e-12 && Math.abs(gsa.vdop - Number(gsaFields[16])) < 1e-12,
      'used=' + gsa.satellites_used + '（原句第 3~14 项非空个数 = ' + gsaExpect + '），PDOP ' + gsa.pdop + '/HDOP ' + gsa.hdop + '/VDOP ' + gsa.vdop + ' 取自末三字段');
    const gsaMade = buildNmea({ type: 'GSA', mode: 'A', fix_type: 3, prns: [4, 5, null, 9, 12, null, null, 24], pdop: 2.5, hdop: 1.3, vdop: 3.6 });
    const gsa2 = decodeNmea(gsaMade.sentence);
    push('GSA 生成→解析回到原值，卫星号顺序与空位保持（不做隐式压缩）', (() => {
      if (gsa2.satellite_prns.length !== 12) return false;
      const want = [4, 5, null, 9, 12, null, null, 24, null, null, null, null];
      for (let i = 0; i < 12; i++) if ((gsa2.satellite_prns[i] == null ? null : gsa2.satellite_prns[i]) !== want[i]) return false;
      return gsa2.satellites_used === 5 && Math.abs(gsa2.pdop - 2.5) < 1e-12 && gsa2.checksum_ok !== false;
    })(), gsaMade.sentence + ' → ' + JSON.stringify(gsa2.satellite_prns) + ' used=' + gsa2.satellites_used);
    const gsv41 = decodeNmea(nmeaWrap('GPGSV,2,1,08,01,40,083,46,2,42,072,46'));
    push('NMEA-4.1 五字段 GSV 不会把 signal id 当 SNR', (() => {
      const s = nmeaWrap('GPGSV,1,1,02,01,40,083,46,L1,02,42,072,45,L5');
      const d = decodeNmea(s);
      return d.field_stride === 5 && d.satellites.length === 2 && d.satellites[0].snr_db === 46 && d.satellites[1].snr_db === 45 && d.satellites[1].signal_id === 'L5';
    })(), '步长判定 ' + gsv41.field_stride);
    const gsvMany = [];
    const sats11 = [];
    for (let i = 0; i < 11; i++) sats11.push({ prn: 3 + i, elevation_deg: 10 + i * 7, azimuth_deg: (i * 33) % 360, snr_db: 30 + (i % 9) });
    const built = buildNmea({ type: 'GSV', satellites: sats11, sats_in_view_total: 11, talker: 'GP' });
    (built.sentences || []).forEach((x) => gsvMany.push(x));
    const merged = mergeNmea(gsvMany);
    push('GSV 分片合并 11 颗星不丢不重', merged.satellites_in_view.length === 11 && merged.count === built.sentences.length,
      built.sentences.length + ' 条分片 → ' + merged.satellites_in_view.length + ' 颗');
    push('VTG 节/公里两种速度必须互洽', (() => {
      const d = decodeNmea(nmeaWrap('GPVTG,084.4,T,,M,022.4,N,041.5,K'));
      return Math.abs(d.sog_mps - 41.5 / 3.6) < 0.05 || Math.abs(d.sog_mps - 22.4 * 1852 / 3600) < 0.02;
    })(), decodeNmea(nmeaWrap('GPVTG,084.4,T,,M,022.4,N,041.5,K')).sog_mps);
    push('GST 给出的是标准差不是一次性偏差', (() => {
      const d = decodeNmea(nmeaWrap('GPGST,123519.00,2.10,5.00,3.00,60.0,4.00,3.00,2.00'));
      return Math.abs(d.semi_major_m - 5) < 1e-9 && Math.abs(d.orientation_deg - 60) < 1e-9 && d.lat_err_m === 4;
    })(), '长半轴/方位/NEU σ 分列');
    push('ZDA 带时区的 JD 必须与 UTC 写法一致', (() => {
      const d = decodeNmea(nmeaWrap('GPZDA,201530.00,13,10,2016,08,00'));
      const utc = parseUtc('2016-10-13T12:15:30Z');
      return Math.abs(d.jd - utc.jd) < 1e-5;
    })(), '北京 +08 的 ZDA 与 UTC 中午对齐');
    push('磁北/真北语句分别落在 heading 字段', (() => {
      const a = decodeNmea(nmeaWrap('HEHDT,275.05,T')), b = decodeNmea(nmeaWrap('HEHDG,279.12,,8.07,E'));
      return Math.abs(a.heading_true_deg - 275.05) < 1e-9 && Math.abs(b.declination_deg - 8.07) < 1e-9 && b.declination_dir === 'E' &&
        b.deviation_deg === null && Math.abs(b.heading_mag_deg - 279.12) < 1e-9 &&
        Math.abs(b.heading_true_deg - wrap360(279.12 + 8.07)) < 1e-9;
    })(), 'HDT/HDG 与磁偏：真航向 = 磁航向 ' + decodeNmea(nmeaWrap('HEHDG,279.12,,8.07,E')).heading_mag_deg + ' + 东偏 ' + decodeNmea(nmeaWrap('HEHDG,279.12,,8.07,E')).declination_deg +
      ' = ' + decodeNmea(nmeaWrap('HEHDG,279.12,,8.07,E')).heading_true_deg);
    let junkOk = true, junkMsg = '';
    const junkInputs = ['', '$', '$GPGGA', '!AIVDM,1,1,,A,13HOI:0P0000VOHLCnHQKwvL05,@,0', 'x'.repeat(500), null, undefined, NaN, 12345,
      '$GPGGA,123519,4807.038,N,*00', '$GPRMC,235960,A', '$GPGSV,0,5,99,,,-5,400,999', '$GPZDA,240000,32,13,2016,99,99'];
    for (const j of junkInputs) {
      const d = decodeNmea(j);
      if (d && hasNaN(d)) { junkOk = false; junkMsg += JSON.stringify(j).slice(0, 20) + '→NaN '; }
    }
    push('15 类畸形 NMEA 不崩溃、不泄漏 NaN/Infinity', junkOk, junkMsg || '全部返回 error 或有限值');
    push('校验和不符时给出 warning 但仍解析数值（不静默丢弃）', (() => {
      const s = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.0,M,47.0,M,,,*00';
      const d = decodeNmea(s);
      const good = decodeNmea(nmeaWrap('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.0,M,47.0,M,,,'));
      const bare = decodeNmea('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.0,M,47.0,M,,,');
      return d.checksum_ok === false && !!d.warning && isNum(d.lat) && Math.abs(d.lat - 48 - 7.038 / 60) < 1e-12 &&
        good.checksum_ok === true && bare.checksum_ok === null && !bare.warning;
    })(), '错误校验和 → warning + 数值可用；正确 → true；无校验和 → null（不谎报已验证）');

    /* ---------- 3. 开普勒与星历 ---------- */
    let kepOk = true, kepWorst = 0;
    for (const e of [0, 0.01, 0.2, 0.5, 0.9, 0.99]) {
      for (let i = 0; i < 30; i++) {
        const M = -PI + (i / 29) * 2 * PI;
        const k = keplerEccentricAnomaly(M, e);
        kepWorst = Math.max(kepWorst, Math.abs(k.residual));
        if (Math.abs(k.residual) > 1e-11) kepOk = false;
      }
    }
    push('开普勒方程残差 <1e-11（e 从 0 到 0.99）', kepOk, '最大残差 ' + kepWorst.toExponential(2) + ' rad');
    push('开普勒解随 M 单调增（牛顿迭代没有跳到别的分支）', (() => {
      let mono = true, prev = -Infinity;
      for (let i = 0; i <= 240; i++) {
        const k = keplerEccentricAnomaly(-PI + i * (2 * PI / 240), 0.99);
        if (k.error || !(k.E > prev)) { mono = false; break; }
        prev = k.E;
      }
      return mono;
    })(), 'e=0.99 时逐 0.75° 扫一圈：E 必须严格递增（近地点附近最陡，最容易跳枝）');
    push('非折回的多圈 M 也能解（残差 <1e-11 且 E−M 与 M 同余）', (() => {
      const big = 2 * PI * 3 + 1.2345678;
      const k = keplerEccentricAnomaly(big, 0.6);
      const small = keplerEccentricAnomaly(1.2345678, 0.6);
      return !k.error && Math.abs(k.residual) < 1e-11 && Math.abs((k.E - small.E) - 2 * PI * 3) < 1e-9;
    })(), 'M 超出一圈时按 2π 折回求解再还原，解必须一致');
    push('e=0 时 E≡M（圆轨道退化为恒等）', (() => {
      for (const M of [0, 0.7, 1.9, -2.4, PI - 1e-3]) if (Math.abs(keplerEccentricAnomaly(M, 0).E - M) > 1e-12) return false;
      return true;
    })(), '圆轨道不需迭代');
    push('M 加 2π ⇒ E 加 2π（周期性）', (() => {
      const e = 0.35, M = 1.1;
      const a = keplerEccentricAnomaly(M, e).E, b = keplerEccentricAnomaly(M + 2 * PI, e).E;
      return Math.abs(wrap2pi(b - a) - 0) < 1e-9 || Math.abs((b - a) - 2 * PI) < 1e-9;
    })(), '周期映射不破坏解');
    push('真近点角↔偏近点角：ν(0)=0、ν(π)=π', Math.abs(trueAnomalyFromE(0, 0.4)) < 1e-12 && Math.abs(trueAnomalyFromE(PI, 0.4) - PI) < 1e-12, '端点值');
    const EPH = {
      sys: 'GPS', prn: 5, sqrtA: 5153.689, e: 0.0215, M0: 0.732, deltaN: 4.8e-9,
      Omega0: 1.234, omegaDot: -8.3e-11, i0: 0.965, iDot: 4.2e-11, omega: 0.317,
      toe: 200000, toc: 200000, af0: 4.2e-4, af1: 2.1e-12, af2: 0, TGD: -5.3e-9,
      Cuc: 1.1e-6, Cus: 8.4e-7, Crc: 122.5, Crs: 54.3, Cic: 2.4e-6, Cis: 1.8e-6
    };
    const p1 = satPosition(EPH, 200000), p2 = satPosition(EPH, 236000), p3 = satPosition(EPH, 164000);
    push('卫星位置有限且半径在 GPS 轨道量级（约 2.6 万 km）', [p1, p2, p3].every((p) => isNum(p.radius_m) && p.radius_m > 2.5e7 && p.radius_m < 2.8e7),
      'r = ' + p1.radius_m.toFixed(1) + ' m，a = ' + p1.semi_major_A.toFixed(1) + ' m，高度 ' + (p1.altitude_m / 1000).toFixed(1) + ' km');
    // 角动量/倾角/升交点/圆锥曲线这类恒等式，只在「无摄动项 + 惯性系」下严格成立。
    // 拿带 Crc/Crs/Cic/Cis/iDot/Ω̇ 的完整星历去核对它们，测的是模型的物理性而不是代码的自洽性；
    // 拿 ECEF 输出去核对 ECI 的守恒律，则会把地球自转当成「轨道面漂移」。两者都必须先归位。
    const EPH0 = Object.assign({}, EPH, { Cuc: 0, Cus: 0, Crc: 0, Crs: 0, Cic: 0, Cis: 0, iDot: 0, omegaDot: 0 });
    const e1 = satPosition(EPH0, 200000, { frame: 'eci' });
    const e2 = satPosition(EPH0, 236000, { frame: 'eci' });
    const e3 = satPosition(EPH0, 164000, { frame: 'eci' });
    push('ECI 三点共面且过地心（混合积=0，只用位置，不含速度差分误差）', (() => {
      const det = e1.x * (e2.y * e3.z - e2.z * e3.y) - e1.y * (e2.x * e3.z - e2.z * e3.x) + e1.z * (e2.x * e3.y - e2.y * e3.x);
      return Math.abs(det) / (e1.radius_m * e2.radius_m * e3.radius_m) < 1e-12;
    })(), '开普勒轨道是过地心的平面曲线');
    push('ECI 角动量方向在相隔 ±36000 s 仍一致（抓 x/y/z 组装错误）', (() => {
      const hv = (p) => cross3([p.x, p.y, p.z], [p.vx, p.vy, p.vz]);
      const nrm = (v) => Math.hypot(v[0], v[1], v[2]);
      const ang = (u, v) => Math.abs(Math.abs((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nrm(u) * nrm(v))) - 1);
      return ang(hv(e1), hv(e2)) < 1e-7 && ang(hv(e1), hv(e3)) < 1e-7;
    })(), '速度取 1 s 中心差分，截断误差约 1e-9，阈值 1e-7 仍远小于「组装写错」的量级');
    push('倾角自洽：ECI 下 arccos(h_z/|h|) 等于模型给的 inclination', (() => {
      const h = cross3([e1.x, e1.y, e1.z], [e1.vx, e1.vy, e1.vz]);
      const n = Math.hypot(h[0], h[1], h[2]);
      return Math.abs(Math.acos(clamp(h[2] / n, -1, 1)) - e1.inclination_rad) < 1e-6;
    })(), 'i = ' + (e1.inclination_rad * R2D).toFixed(5) + '°（平面摄动归零后 i ≡ i0）');
    push('升交点经度自洽：ECI 下 atan2(h_x, −h_y) 等于模型给的 Ω', (() => {
      const h = cross3([e1.x, e1.y, e1.z], [e1.vx, e1.vy, e1.vz]);
      const OmModel = EPH0.Omega0 + EPH0.omegaDot * (200000 - EPH0.toe);
      const OmFromH = Math.atan2(h[0], -h[1]);
      return Math.abs(wrap180(wrap180(OmFromH * R2D) - wrap180(OmModel * R2D))) < 0.001;
    })(), 'Ω 由角动量反解，与坐标组装约定互为独立校验');
    push('圆锥曲线恒等式 r = a(1−e²)/(1+e·cosν)（干净星历、ECI）', (() => {
      return [e1, e2, e3].every((p) => {
        const conic = p.semi_major_A * (1 - p.eccentricity * p.eccentricity) / (1 + p.eccentricity * Math.cos(p.true_anomaly));
        return Math.abs(p.radius_m - conic) / conic < 1e-12;
      });
    })(), '带 Crc/Crs 的完整模型本来就不满足该式，测它必须先把径向摄动归零');
    push('ECEF 与 ECI 恰好差 Ω_e·(t_k+t_oe) 的绕 Z 旋转（抓 −Ω̇_e·t_oe 那一项）', (() => {
      const tow = 236000;
      const eci = satPosition(EPH, tow, { frame: 'eci' }), ecef = satPosition(EPH, tow);
      const th = OMEGA_E_DOT * (tow - EPH.toe + EPH.toe);
      const xe = eci.x * Math.cos(th) + eci.y * Math.sin(th);
      const ye = -eci.x * Math.sin(th) + eci.y * Math.cos(th);
      const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
      return rel(xe, ecef.x) < 1e-11 && rel(ye, ecef.y) < 1e-11 && Math.abs(ecef.z - eci.z) < 1e-4 && ecef.earth_rotation_angle_rad > 0;
    })(), '广播星历的「随地球旋转」只体现在 Ω 里减 Ω̇_e·(t_k+t_oe)：漏掉 t_oe 会让星座整体转约 1.5 rad');
    push('圆轨道（e=0, 无摄动）半径恒定且 r·v≈0', (() => {
      const c = Object.assign({}, EPH, { e: 0, Cuc: 0, Cus: 0, Crc: 0, Crs: 0, Cic: 0, Cis: 0, deltaN: 0, iDot: 0, omegaDot: 0 });
      const a = satPosition(c, 200000), b = satPosition(c, 210000);
      const rv = (a.x * a.vx + a.y * a.vy + a.z * a.vz) / (a.radius_m * Math.hypot(a.vx, a.vy, a.vz));
      return Math.abs(a.radius_m - b.radius_m) < 1 && Math.abs(rv) < 1e-6;
    })(), '圆轨道是位置/速度一致性最强的判据');
    push('赤道轨道（i=0）的 z 恒为 0', (() => {
      const c = Object.assign({}, EPH, { i0: 0, iDot: 0, Cic: 0, Cis: 0 });
      return [0, 12000, 24000].every((dt) => Math.abs(satPosition(c, 200000 + dt).z) < 1e-3);
    })(), 'z = r·sin u·sin i 的直接推论');
    push('周期随 √A 单调增（开普勒第三定律方向正确）', (() => {
      const small = satPosition(Object.assign({}, EPH, { sqrtA: 4900 }), 200000);
      const big = satPosition(Object.assign({}, EPH, { sqrtA: 5400 }), 200000);
      return big.period_s > small.period_s && small.period_s > 30000 && big.period_s < 60000;
    })(), 'T(√A=4900)=' + satPosition(Object.assign({}, EPH, { sqrtA: 4900 }), 200000).period_s.toFixed(1) +
      ' s, T(√A=5153.689)=' + p1.period_s.toFixed(1) + ' s');
    push('星历龄期用周内秒回绕（跨 00:00 不出现 60 万秒跳变）', (() => {
      const near = satPosition(EPH, 604790), far = satPosition(EPH, 10 + EPH.toe - 604790 + 604790);
      return Math.abs(near.orbit_age_s) <= 302400 && Math.abs(satPosition(EPH, EPH.toe - 300000).orbit_age_s) <= 302400 && isNum(far.x);
    })(), 'tk 始终在 ±302400 s 内');
    push('BDS GEO 的 −5° 旋转不改变地心距（只做坐标旋转）', (() => {
      const meo = satPosition(Object.assign({}, EPH, { sys: 'BDS', prn: 2, orbit: 'GEO' }), 200000);
      const plain = satPosition(Object.assign({}, EPH, { sys: 'BDS', prn: 2 }), 200000);
      return meo.geo_rotated === true && Math.abs(meo.radius_m - plain.radius_m) < 1e-3;
    })(), 'GEO 分支启用但半径不变');
    push('相对论修正 e=0 时必须严格为 0', (() => {
      const c = Object.assign({}, EPH, { e: 0 });
      const k = satClock(c, 200000);
      return Math.abs(k.relativistic_s) < 1e-18 && Math.abs(k.dt_s - c.af0) < 1e-12;
    })(), 'Δtr = F·e·√A·sinE：抓住「把 e 当 1」或「用 M 代替 E」');
    push('钟差随 af1 线性、随 (t−toc) 线性', (() => {
      const a = satClock(Object.assign({}, EPH, { af0: 0, af2: 0 }), EPH.toc), b = satClock(Object.assign({}, EPH, { af0: 0, af2: 0 }), EPH.toc + 10000);
      const perSec = (b.drift_s) / 10000;
      return Math.abs(perSec - EPH.af1) < 1e-18;
    })(), '每秒漂移 = af1');
    push('TGD 折算成距离要乘光速', Math.abs(tgdToMeters(-5e-9) + 5e-9 * C_LIGHT) < 1e-6, tgdToMeters(-5e-9).toFixed(4) + ' m');
    push('星历缺字段/非法 TOW 返回 error', satPosition({ prn: 1 }, 100).error != null && satPosition(EPH, NaN).error != null && keplerEccentricAnomaly(0.1, 1.5).error != null,
      satPosition({ prn: 1 }, 100).error);

    /* ---------- 4. GLONASS 积分与守恒律 ---------- */
    // 圆轨道的速度与周期由闸门自己算出（v=√(μ/r)，T=2π√(r³/μ)）。μ 与积分器共用，
    // 所以这几条检验的是「RK4 是否真把 ODE 积对了、时间轴有没有对齐」，而不是物理常数。
    const gR = 25505000;                                  // 标称轨道半径（PZ-90）
    const vCirc = Math.sqrt(MU_GLN / gR);
    const gPeriod = 2 * Math.PI * Math.sqrt(Math.pow(gR, 3) / MU_GLN);
    const glEph = { prn: 24, x: gR, y: 0, z: 0, vx: 0, vy: vCirc, vz: 0, tau: 0 };
    const twoBody = (eph, ms, opt) => glonassPosition(eph, ms, Object.assign({ unit: 'm', includeJ2: false, step: 10 }, opt || {}));
    const g0 = twoBody(glEph, 0), gHalf = twoBody(glEph, gPeriod * 500), gFull = twoBody(glEph, gPeriod * 1000);
    const energy = (q) => (q.vx * q.vx + q.vy * q.vy + q.vz * q.vz) / 2 - MU_GLN / Math.hypot(q.x, q.y, q.z);
    const hVec = (q) => cross3([q.x, q.y, q.z], [q.vx, q.vy, q.vz]);
    push('二体（J2=0）能量守恒（RK4 积分半圈与整圈）', (() => {
      const e0 = energy(g0.inertial), e1 = energy(gHalf.inertial), e2 = energy(gFull.inertial);
      return Math.abs((e1 - e0) / e0) < 1e-6 && Math.abs((e2 - e0) / e0) < 1e-6;
    })(), 'E: ' + energy(g0.inertial).toExponential(3) + ' → ' + energy(gFull.inertial).toExponential(3));
    push('圆轨道半径恒定（整圈 |r| 偏差 < 1 m）', (() => {
      const r1 = Math.hypot(gHalf.inertial.x, gHalf.inertial.y, gHalf.inertial.z);
      const r2 = Math.hypot(gFull.inertial.x, gFull.inertial.y, gFull.inertial.z);
      return Math.abs(r1 - gR) < 1 && Math.abs(r2 - gR) < 1;
    })(), 'r = ' + gR.toFixed(0) + ' m，v = ' + vCirc.toFixed(1) + ' m/s，T = ' + gPeriod.toFixed(0) + ' s');
    push('二体轨道闭合：一个周期后回到起点（惯性系，<50 m）', (() => {
      const a = g0.inertial, b = gFull.inertial;
      return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 50;
    })(), '闭合差 ' + Math.hypot(gFull.inertial.x - g0.inertial.x, gFull.inertial.y - g0.inertial.y, gFull.inertial.z - g0.inertial.z).toFixed(2) + ' m');
    push('二体角动量矢量守恒（三轴都守恒）', (() => {
      const a = hVec(g0.inertial), b = hVec(gHalf.inertial);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.hypot(a[0], a[1], a[2]) < 1e-6;
    })(), '二体中心力 ⇒ h 矢量整体不变');
    push('末步只走剩余时间：扫过的角度严格等于 ω·t', (() => {
      const t = gPeriod / 5;
      const p = twoBody(glEph, t * 1000).inertial;
      const dth = Math.atan2(p.y, p.x) - Math.atan2(g0.inertial.y, g0.inertial.x) - (2 * Math.PI / gPeriod) * t;
      return Math.abs(dth) < 2e-4;
    })(), '若末步多走一整个 step，角度会偏 ω·t_超前的整数倍（本例约 6e-4 rad）');
    const glJ2 = (eph, ms) => glonassPosition(eph, ms, { unit: 'm', includeJ2: true, step: 10 });
    const inc = 64.8 * Math.PI / 180;   // GLONASS 标称倾角：赤道圆轨道上 J2 的力恰好与位置共线，进动=0，测不出东西
    const glEphI = { prn: 24, x: gR, y: 0, z: 0, vx: 0, vy: vCirc * Math.cos(inc), vz: vCirc * Math.sin(inc), tau: 0 };
    const jc0 = glJ2(glEphI, 0), jc1 = glJ2(glEphI, gPeriod * 500);
    push('J2 轴对称 ⇒ L_z 严格守恒（但 L_x/L_y 必须变化）', (() => {
      const a = hVec(jc0.inertial), b = hVec(jc1.inertial);
      const lzRel = Math.abs((b[2] - a[2]) / a[2]);
      const hn = Math.hypot(a[0], a[1], a[2]);
      return lzRel < 1e-6 && Math.abs(b[0] - a[0]) / hn > 1e-5;
    })(), 'L_z 漂移 <1e-6 而 L_x 明显变化 ⇒ 轨道面在绕地轴进动（抓「z 行写成 (1−5z²/r²)」这类破坏轴对称的错误）');
    push('交点进动方向随 cos i 反号（顺行退行 / 逆行前行）', (() => {
      const az = (v) => Math.atan2(v[1], v[0]);
      const drift = (i) => {
        const e = { prn: 1, x: gR, y: 0, z: 0, vx: 0, vy: vCirc * Math.cos(i), vz: vCirc * Math.sin(i), tau: 0 };
        return az(hVec(glJ2(e, gPeriod * 500).inertial)) - az(hVec(glJ2(e, 0).inertial));
      };
      const pro = drift(inc), retro = drift(Math.PI - inc);
      return pro * retro < 0 && Math.abs(pro) > 1e-5 && Math.abs(retro) > 1e-5;
    })(), 'Ω̇ ∝ −cos i：倾角逐符号，进动向必须翻转');
    push('随地系变换是纯旋转：半径与 z 轴速度不变，且与惯性系相差恰为 Ω_e·Δt', (() => {
      const p = twoBody(glEph, gPeriod * 250);
      const th = Math.atan2(p.inertial.y, p.inertial.x) - Math.atan2(p.y, p.x);
      const expect = OMEGA_E_DOT * (gPeriod / 4);
      const d = Math.abs(th) - expect;
      return Math.abs(d) < 1e-6 && Math.abs(Math.hypot(p.x, p.y, p.z) - Math.hypot(p.inertial.x, p.inertial.y, p.inertial.z)) < 1e-6 && p.vz === p.inertial.vz;
    })(), 'θ_ef = θ_in − Ω_e·Δt（这就是「按传播时长转回随地系」的定义式）');
    push('随地系速度含 Ω_e ẑ×r 项：惯性系静止的粒子在随地系必须以 Ω_e·r 绕轴运动', (() => {
      const rest = { prn: 1, x: gR, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tau: 0 };
      // 「惯性系静止」必须是 μ=0 且无摄动；留着引力粒子会自由落体，惯性系速度不再为零，判据前提就错了
      const p = twoBody(rest, 3600000, { mu: 0 });
      if (p.error) return false;
      const vIn = Math.hypot(p.inertial.vx, p.inertial.vy, p.inertial.vz);
      const drift = Math.hypot(p.inertial.x - gR, p.inertial.y, p.inertial.z);
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      const radial = Math.hypot(p.x, p.y, p.z);
      const dot = p.x * p.vx + p.y * p.vy + p.z * p.vz;
      const wantX = OMEGA_E_DOT * p.y, wantY = -OMEGA_E_DOT * p.x;   // v_随地 = −Ω_e ẑ×r_随地
      return vIn === 0 && drift === 0 && p.vz === 0 &&
        Math.abs(speed - OMEGA_E_DOT * gR) < 1e-9 * OMEGA_E_DOT * gR &&
        Math.abs(dot) / (radial * speed) < 1e-12 &&
        Math.hypot(p.vx - wantX, p.vy - wantY) < 1e-9 * speed;
    })(), '|v_随地| 恰为 Ω_e·r = ' + (OMEGA_E_DOT * gR).toFixed(2) + ' m/s、⊥r、且等于 −Ω_e ẑ×r（漏掉该项，多普勒与速度产品会整批错）');
    push('随地系速度 = 随地系位置的时间导数（真实轨道中心差分独立复核）', (() => {
      const h = 1.0, t0 = 600;
      const pm = twoBody(glEph, (t0 - h) * 1000, { step: 1 });
      const pp = twoBody(glEph, (t0 + h) * 1000, { step: 1 });
      const pc = twoBody(glEph, t0 * 1000, { step: 1 });
      if (pm.error || pp.error || pc.error) return false;
      const dNum = [(pp.x - pm.x) / (2 * h), (pp.y - pm.y) / (2 * h), (pp.z - pm.z) / (2 * h)];
      const rel = Math.hypot(pc.vx - dNum[0], pc.vy - dNum[1], pc.vz - dNum[2]) / Math.hypot(pc.vx, pc.vy, pc.vz);
      // 只有把 Ω_e ẑ×r 项一起转，差分结果才会吻合；只转位置不转速度时误差量级 ~ Ω_e·ρ ≈ 1800 m/s
      const vInSpd = Math.hypot(pc.inertial.vx, pc.inertial.vy, pc.inertial.vz);
      return rel < 1e-6 && Math.abs(vInSpd - Math.hypot(pc.vx, pc.vy, pc.vz)) > 1;
    })(), '数值微分与解析转换之差 = 相对误差级别；两种微分步长（±1 s）给出同一结果');
    push('J2 加速度场无旋（位势场恒等式 ∂a_x/∂z = ∂a_z/∂x）', (() => {
      const d = 1000;
      const P = [1.2e7, 5.0e6, 7.0e6];
      const axz = (gravityAccel(P[0], P[1], P[2] + d, MU_GLN, GLONASS_J2, GLONASS_RE).ax - gravityAccel(P[0], P[1], P[2] - d, MU_GLN, GLONASS_J2, GLONASS_RE).ax) / (2 * d);
      const azx = (gravityAccel(P[0] + d, P[1], P[2], MU_GLN, GLONASS_J2, GLONASS_RE).az - gravityAccel(P[0] - d, P[1], P[2], MU_GLN, GLONASS_J2, GLONASS_RE).az) / (2 * d);
      return Math.abs(axz - azx) / Math.abs(axz) < 1e-6;
    })(), '旋度为零 ⇒ 摄动函数存在，结构没写反');
    push('赤道隆起必须「额外向内吸」（J2 符号的物理判据）', (() => {
      const withJ2 = gravityAccel(25505000, 0, 0, MU_GLN, GLONASS_J2, GLONASS_RE);
      const only = gravityAccel(25505000, 0, 0, MU_GLN, 0, GLONASS_RE);
      return Math.abs(withJ2.ax) > Math.abs(only.ax) && withJ2.ax < 0;
    })(), '赤道处 |a| 增大且指向地心');
    push('J2 在赤道的附加加速度 = 1.5·J2·μ·Re²/r⁴（解析对照）', (() => {
      const r = 25505000;
      const withJ2 = gravityAccel(r, 0, 0, MU_GLN, GLONASS_J2, GLONASS_RE).ax;
      const only = gravityAccel(r, 0, 0, MU_GLN, 0, GLONASS_RE).ax;
      const expect = -1.5 * GLONASS_J2 * MU_GLN * GLONASS_RE * GLONASS_RE / Math.pow(r, 4);
      return Math.abs((withJ2 - only) - expect) / Math.abs(expect) < 1e-9;
    })(), '数值 − 二体 = ' + ((-2.7431e-3) || 0).toPrecision(4) + ' 级别校核');
    push('GLONASS 单位约定：km 输入与 m 输入解出同一位置', (() => {
      const km = { prn: 1, x: 25505, y: 0, z: 0, vx: 0, vy: 3.035, vz: 0, tau: 0 };
      const mm = { prn: 1, x: 25505000, y: 0, z: 0, vx: 0, vy: 3035, vz: 0, tau: 0 };
      const a = glonassPosition(km, 600000, { step: 10 }), b = glonassPosition(mm, 600000, { unit: 'm', step: 10 });
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 50;
    })(), '默认按 km 解释，可用 {unit:"m"} 覆盖');
    push('GLONASS 电文缺字段/零位置返回 error', glonassPosition({ x: 1 }, 0).error != null && glonassPosition(glEph, NaN).error != null && gravityAccel(0, 0, 0, 1, 0, 1).error != null,
      glonassPosition({ x: 1 }, 0).error);
    const h1 = (p) => cross3([p.x, p.y, p.z], [p.vx, p.vy, p.vz]);

    /* ---------- 5. 频率与波长 ---------- */
    push('频点表的波长全部落在 L/S 波段物理区间', SIGNALS.every((s) => { const l = wavelengthM(s.f_mhz); return l > 0.11 && l < 0.30; }),
      SIGNALS.length + ' 个频点，λ∈[' + Math.min.apply(null, SIGNALS.map((s) => wavelengthM(s.f_mhz))).toFixed(3) + ',' + Math.max.apply(null, SIGNALS.map((s) => wavelengthM(s.f_mhz))).toFixed(3) + '] m');
    push('同频标注必须给出同波长（L1/E1/B1C/L5 交叉一致）', (() => {
      const g = SIGNALS.filter((s) => s.f_mhz === 1575.42), l5 = SIGNALS.filter((s) => s.f_mhz === 1176.45);
      return g.length >= 3 && new Set(g.map((s) => wavelengthM(s.f_mhz).toFixed(9))).size === 1 &&
        new Set(l5.map((s) => wavelengthM(s.f_mhz).toFixed(9))).size === 1;
    })(), 'λ=c/f 的自洽，不是查表');
    push('GLONASS 频道→频率用等差关系独立核对', (() => {
      const a = glonassChannelFreq(0), b = glonassChannelFreq(1), c = glonassChannelFreq(-7);
      return Math.abs(a.f1_mhz - 1602) < 1e-12 && Math.abs(b.f1_mhz - a.f1_mhz - 0.5625) < 1e-12 && Math.abs(a.f2_mhz - b.f2_mhz + 0.4375) < 1e-12 && Math.abs(c.f1_mhz - (1602 - 7 * 0.5625)) < 1e-12;
    })(), 'k=0→1602.000 MHz，步长 0.5625 MHz');
    push('越界频道号返回 error', glonassChannelFreq(20).error != null && glonassChannelFreq('x').error != null, glonassChannelFreq(20).error);

    /* ---------- 6. 大气模型 ---------- */
    push('对流层干延迟对气压严格线性', (() => {
      const a = troposphereZenith(1013.25, 35, 0), b = troposphereZenith(2026.5, 35, 0);
      return Math.abs(b.zhd_m / a.zhd_m - 2) < 1e-12;
    })(), 'P×2 ⇒ ZHD×2');
    push('正常重力：极点 > 赤道，且 45° 海平面 ≈ 标准重力 9.80665', (() => {
      const eq = normalGravity(0, 0).g_mps2, po = normalGravity(90, 0).g_mps2, mid = normalGravity(45, 0).g_mps2;
      return po > mid && mid > eq && Math.abs(mid / 9.80665 - 1) < 1.5e-4 && Math.abs(po / eq - 1) > 0.004 && Math.abs(po / eq - 1) < 0.006;
    })(), 'g(0)=' + normalGravity(0, 0).g_mps2.toFixed(5) + '，g(45)=' + normalGravity(45, 0).g_mps2.toFixed(5) + '，g(90)=' + normalGravity(90, 0).g_mps2.toFixed(5) + ' m/s²（极点比赤道重约 0.53%：离心项 + 赤道隆起）');
    push('重力对自转轴的离心项 = ω²ρ（解析对照）', (() => {
      const a = normalGravity(0, 0), b = normalGravity(45, 0), c = normalGravity(90, 0);
      return Math.abs(a.centrifugal_mps2 - OMEGA_E_DOT * OMEGA_E_DOT * WGS84.a) < 1e-12 &&
        Math.abs(b.centrifugal_mps2 - OMEGA_E_DOT * OMEGA_E_DOT * b.distance_from_axis_m) < 1e-12 &&
        Math.abs(c.centrifugal_mps2) < 1e-14;
    })(), '离心项在极地为 0、赤道最大，抓「忘了加离心」或「加在 z 方向」');
    push('自由空气梯度：数值差分对照 −2g/R（球形一级近似）与 0.3086 mGal/m（大地测量值）', (() => {
      const g0 = normalGravity(45, 0).g_mps2, g1 = normalGravity(45, 1000).g_mps2;
      const numeric = (g1 - g0) / 1000 * 1e5;                     // mGal/m
      const analytic = -2 * g0 / WGS84.a * 1e5;                   // 球形：∂g/∂h = −2GM/R³ = −2g/R
      return Math.abs(numeric / analytic - 1) < 0.01 && Math.abs(numeric + 0.3086) / 0.3086 < 5e-3;
    })(), '实测 ' + ((normalGravity(45, 1000).g_mps2 - normalGravity(45, 0).g_mps2) / 1000 * 1e5).toFixed(4) +
      ' mGal/m，−2g/R = ' + (-2 * normalGravity(45, 0).g_mps2 / WGS84.a * 1e5).toFixed(4) + '（差 0.3% 来自扁率与 J2），教科书 0.3086');
    push('同气压下：纬度越低、站点越高 ⇒ 干延迟越大（ZHD∝P/g 的物理符号）', (() => {
      const eq = troposphereZenith(1013.25, 0, 0).zhd_m, po = troposphereZenith(1013.25, 90, 0).zhd_m;
      const h0 = troposphereZenith(1013.25, 45, 0).zhd_m, h3 = troposphereZenith(1013.25, 45, 3).zhd_m;
      return eq > h0 && h0 > po && h3 > h0 && (eq / po - 1) < 0.006;
    })(), '旧实现把符号写反（45° 最小、海拔越高越小）——那是把「气压随高度下降」混进了「同气压的重力改正」');
    push('实际大气的总效果仍是海拔越高延迟越小（因为气压降得比重力改正快）', (() => {
      const s0 = standardAtmosphere(0), s5 = standardAtmosphere(5);
      const z0 = troposphereZenith(s0.pressure_hPa, 45, 0).zhd_m, z5 = troposphereZenith(s5.pressure_hPa, 45, 5).zhd_m;
      return s5.pressure_hPa < s0.pressure_hPa && z5 < z0 && Math.abs(s0.pressure_hPa - 1013.25) < 1e-9;
    })(), '标准大气 0 km=' + standardAtmosphere(0).pressure_hPa.toFixed(2) + ' hPa，5 km=' + standardAtmosphere(5).pressure_hPa.toFixed(2) + ' hPa');
    push('重力纬向/高程改正与 Saastamoinen 的 0.00266cos2φ、0.00028h 双路线对照', (() => {
      for (const lat of [0, 15, 30, 45, 60, 90]) {
        const phys = troposphereZenith(1013.25, lat, 0).gravity_factor;
        const lit = 1 / (1 - 0.00266 * Math.cos(2 * lat * D2R));
        if (Math.abs(phys / lit - 1) > 2e-4) return false;
      }
      for (const h of [0, 1, 3, 5]) {
        const phys = troposphereZenith(1013.25, 45, h).gravity_factor;
        const lit = 1 / (1 - 0.00028 * h);
        if (phys < 1 || Math.abs(phys - 1) > 1.6 * Math.abs(lit - 1) || Math.abs(phys / lit - 1) > 3e-4) return false;
      }
      return true;
    })(), '两条独立路线（J2+离心 与 经验系数）同时错到同一符号/量级的概率极低 ⇒ 符号与量级都钉死');
    push('标准大气海平面 ZHD 落在 2.2~2.5 m 的物理区间', (() => {
      const z = troposphereZenith(1013.25, 35, 0).zhd_m;
      return z > 2.2 && z < 2.5;
    })(), 'ZHD = ' + troposphereZenith(1013.25, 35, 0).zhd_m.toFixed(4) + ' m（量级闸门，抓 0.0022768 的小数点错位）');
    push('ZHD 的 0.0022768 用「折射率∝密度 + 静力平衡」独立重算', (() => {
      // 等温大气：(n−1)=1e-6·k1·P/T，k1=77.6 hPa⁻¹·K；ζ_h = 1e-6·k1·(R/M)·P_s/g
      const k1 = 77.6e-6, Rgas = 8.31446, Mdry = 0.0289644;
      const derived = k1 * (Rgas / Mdry) / 9.806246;             // 45° 海平面重力
      return Math.abs(derived / ZHD_CONST - 1) < 0.005;
    })(), '推导 ' + (77.6e-6 * (8.31446 / 0.0289644) / 9.806246).toExponential(5) + ' vs 采用 ' + ZHD_CONST.toExponential(5) +
      ' m/hPa（差 ' + ((77.6e-6 * (8.31446 / 0.0289644) / 9.806246) / ZHD_CONST - 1).toFixed(4) + '，来自剖面温度精化）');
    push('湿延迟量级：e=15 hPa、T=288 K ⇒ 0.10~0.30 m，且随 e 线性、随 T 单调下降', (() => {
      const a = troposphereZenith(1013.25, 35, 0, 15, 288), b = troposphereZenith(1013.25, 35, 0, 30, 288);
      const c = troposphereZenith(1013.25, 35, 0, 15, 310);
      return a.zwd_m > 0.10 && a.zwd_m < 0.30 && Math.abs(b.zwd_m / a.zwd_m - 2) < 1e-12 && c.zwd_m < a.zwd_m;
    })(), 'ZWD = ' + troposphereZenith(1013.25, 35, 0, 15, 288).zwd_m.toFixed(4) + ' m（旧实现给 3e-4 m，量级闸门抓常数错位）');
    push('负水汽压返回 error，0 水汽给 0 湿延迟', (() => {
      const n = troposphereZenith(1013.25, 35, 0, -1, 288), z = troposphereZenith(1013.25, 35, 0, 0, 288);
      return n.error != null && z.zwd_m === 0;
    })(), 'e<0 不允许（会给出负的延迟）');
    push('缺气压返回 error（不猜一个标准值）', troposphereZenith(0, 35, 0).error != null && troposphereZenith('abc', 35, 0).error != null, troposphereZenith(0, 35, 0).error);
    push('天顶方向映射因子必须严格等于 1', Math.abs(troposphereMapping(90).mapping - 1) < 1e-12, 'M(90°)=' + troposphereMapping(90).mapping);
    push('映射因子随高度角单调递减', (() => {
      const v = [80, 60, 40, 20, 10, 5].map((e) => troposphereMapping(e).mapping);
      return v.every((x, i) => i === 0 || x >= v[i - 1]);
    })(), '1/sinE 单调性');
    push('5° 截断值就是 1/sin5°（三角恒等式）', Math.abs(troposphereMapping(2).mapping - 1 / Math.sin(5 * D2R)) < 1e-12 && Math.abs(troposphereMapping(1).at_true_elevation - 1 / Math.sin(1 * D2R)) < 1e-12,
      troposphereMapping(2).mapping.toFixed(6) + ' = csc 5°');
    push('非法高度角的映射返回 error', troposphereMapping(0).error != null && troposphereMapping(-5).error != null && troposphereMapping('x').error != null, troposphereMapping(0).error);
    push('单层壳：天顶方向映射严格 = 1、IPP 地心角 = 0', (() => {
      const a = ionoShell(90, 350), b = ionoShell(45, 350);
      return Math.abs(a.mapping_factor - 1) < 1e-9 && Math.abs(a.ipp_central_angle_deg) < 1e-9 && b.mapping_factor > 1;
    })(), 'F(90°)=' + ionoShell(90, 350).mapping_factor);
    push('电离层延迟对频率是严格的平方反比', (() => {
      const a = ionoShell(30, 350, 1575.42, 10).group_delay_m, b = ionoShell(30, 350, 2 * 1575.42, 10).group_delay_m;
      return Math.abs(a / b - 4) < 1e-9;
    })(), 'f×2 ⇒ Δρ/4（抓 40.3/f 与 40.3/f²）');
    push('电离层延迟对 VTEC 严格线性、对高度角单调', (() => {
      const l = ionoShell(20, 350, 1575.42, 20).group_delay_m, h = ionoShell(20, 350, 1575.42, 10).group_delay_m;
      const s = [80, 60, 40, 20, 10].map((e) => ionoShell(e, 350, 1575.42, 10).group_delay_m);
      return Math.abs(l / h - 2) < 1e-9 && s.every((x, i) => i === 0 || x > s[i - 1]);
    })(), 'TEC×2 ⇒ 延迟×2；低高度角延迟更大');
    push('天顶延迟 = 垂直延迟（F=1），且 vertical_delay 与高度角无关', (() => {
      const zen = ionoShell(90, 350, 1575.42, 10);
      const inv = [80, 45, 20, 10].every((e) => Math.abs(ionoShell(e, 350, 1575.42, 10).vertical_delay_m - zen.vertical_delay_m) < 1e-12);
      const rel = ionoShell(20, 350, 1575.42, 10);
      return Math.abs(zen.group_delay_m - zen.vertical_delay_m) < 1e-12 && inv &&
        Math.abs(rel.group_delay_m / rel.vertical_delay_m - rel.mapping_factor) < 1e-12;
    })(), '斜延迟/垂直延迟 必须恰为映射因子 F');
    push('低高度角的 IPP 距离在 1000~2500 km 的物理区间', (() => {
      const a = ionoShell(10, 350), b = ionoShell(2, 350);
      return a.ipp_distance_km > 1000 && a.ipp_distance_km < 2500 && b.ipp_distance_km > 1000 && b.ipp_distance_km < 2600;
    })(), 'IPP 距离 ' + ionoShell(10, 350).ipp_distance_km.toFixed(1) + ' km（E=10°）');
    push('无电离层组合对一阶延迟严格抵消（用合成延迟验证）', (() => {
      const rho = 21000000, k = 40.3e16 * 12;
      const r1 = rho + k / Math.pow(1575.42e6, 2), r2 = rho + k / Math.pow(1227.6e6, 2);
      const c = ionoFreeRange(r1, 1575.42, r2, 1227.6);
      return Math.abs(c.range_m - rho) < 1e-6;
    })(), '结构证明：构造 Δρ∝1/f² 后组合残差 <1 µm');
    push('组合噪声放大系数 = √(f1⁴+f2⁴)/|f1²−f2²|', (() => {
      const c = ionoFreeRange(1, 1575.42, 1, 1227.6);
      const a = 1575.42 * 1575.42, b = 1227.6 * 1227.6;
      return Math.abs(c.noise_amplification - Math.sqrt(a * a + b * b) / Math.abs(a - b)) < 1e-12 && c.noise_amplification > 2.5 && c.noise_amplification < 3.5;
    })(), 'GPS L1/L2 放大约 3 倍');

    /* ---------- 7. 线性代数与统计 ---------- */
    push('对称求逆 A·A⁻¹ = I（4×4 随机正定）', (() => {
      const A = [[4, 1, 0, 2], [1, 3, 1, 0], [0, 1, 5, 1], [2, 0, 1, 6]];
      const inv = invertSym(A);
      if (inv.error) return false;
      let worst = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const s = A[i].reduce((a, v, k) => a + v * inv[k][j], 0);
        worst = Math.max(worst, Math.abs(s - (i === j ? 1 : 0)));
      }
      return worst < 1e-12;
    })(), '最大偏离 ' + (() => {
      const A = [[4, 1, 0, 2], [1, 3, 1, 0], [0, 1, 5, 1], [2, 0, 1, 6]], inv = invertSym(A);
      let w = 0; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const s = A[i].reduce((a, v, k) => a + v * inv[k][j], 0); w = Math.max(w, Math.abs(s - (i === j ? 1 : 0))); } return w.toExponential(2);
    })());
    push('奇异矩阵返回 error 而不是抛异常/Inf', invertSym([[1, 2], [2, 4]]).error != null && invertSym([[0, 0], [0, 0]]).error != null, invertSym([[1, 2], [2, 4]]).error);
    push('旋转变换保持协方差迹与特征值', (() => {
      const C = [[4, 0.5, 0], [0.5, 2, 0.3], [0, 0.3, 9]];
      const R = enuMatrix(31.2, 121.4);
      const T = transform3(R, C);
      const tr = (M) => M[0][0] + M[1][1] + M[2][2];
      return Math.abs(tr(T) - tr(C)) < 1e-9;
    })(), 'tr(RCRᵀ)=tr(C) ⇒ 旋转矩阵正交（抓 ENU/ECEF 混淆）');
    push('enuMatrix 是正交阵（R·Rᵀ=I）', (() => {
      const R = enuMatrix(-45.5, 170.2), T = transform3(R, R.map((r) => r.slice()));
      // R·Rᵀ：transform3(R, Rᵀ) 不好直接凑，这里显式算
      let ok = true;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const s = R[i].reduce((a, v, k) => a + v * R[j][k], 0);
        if (Math.abs(s - (i === j ? 1 : 0)) > 1e-12) ok = false;
      }
      void T;
      return ok;
    })(), '行内积 = δij');
    push('误差椭圆保持迹与行列式（a²+b²=tr, a²b²=det）', (() => {
      const q = { nn: 4.2, ee: 2.1, ne: 0.7 };
      const el = ellipseFromCov2(q.nn, q.ee, q.ne);
      const det = q.nn * q.ee - q.ne * q.ne;
      return Math.abs(el.a2 + el.b2 - (q.nn + q.ee)) < 1e-12 && Math.abs(el.a2 * el.b2 - det) < 1e-12 && el.a >= el.b;
    })(), '特征值恒等式，能抓「ψ 与轴」相关的构造错误');
    push('lnΓ(n) 必须严格等于 Σln k（整数阶乘，精确可推）', (() => {
      const sumLn = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
      for (const n of [1, 2, 3, 7, 13, 20, 40]) if (Math.abs(logGamma(n) - sumLn(n - 1)) > 1e-11) return false;
      return true;
    })(), '抓 Lanczos/Stirling 系数错位（旧 NR 表实测偏 4.3e-8，会把卡方尾概率整体带偏）');
    push('lnΓ 的递推恒等式 Γ(z+1)=z·Γ(z)', (() => {
      for (const z of [0.3, 1.5, 2.7, 9.4, 33.3]) if (Math.abs(logGamma(z + 1) - logGamma(z) - Math.log(z)) > 1e-11) return false;
      return true;
    })(), '跨越「抬升递推」的分支边界');
    push('Γ(½) = √π（高斯积分的解析结果）', Math.abs(Math.exp(logGamma(0.5)) - Math.sqrt(Math.PI)) < 1e-12,
      'Γ(½) = ' + Math.exp(logGamma(0.5)).toFixed(15) + '，√π = ' + Math.sqrt(Math.PI).toFixed(15));
    push('erf(1) 用数值积分独立重算 ∫₀¹e^{−t²}dt', (() => {
      const n = 2000, h = 1 / n; let s = 1;
      for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * Math.exp(-Math.pow(i * h, 2));
      s += Math.exp(-1); s *= h / 3;
      const ref = 2 / Math.sqrt(Math.PI) * s;          // Simpson：∫₀¹ 2/√π·e^{−t²} dt = erf(1)
      return Math.abs(erf(1) - ref) < 1e-11 && Math.abs(erf(-1) + erf(1)) < 1e-15;
    })(), 'erf(1) = ' + erf(1).toFixed(15) + '，积分参考 ' + (() => {
      const n = 2000, h = 1 / n; let s = 1;
      for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * Math.exp(-Math.pow(i * h, 2));
      return (2 / Math.sqrt(Math.PI) * (s + Math.exp(-1)) * h / 3).toFixed(15);
    })() + '（旧 A&S 7.1.26 只有 1.5e-7）');
    push('Φ′(z) 必须等于正态密度（中心差分核对）', (() => {
      for (const z of [-2, -0.5, 0, 1, 2.5]) {
        const h = 1e-5, d = (NORM.cdf(z + h) - NORM.cdf(z - h)) / (2 * h);
        const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
        if (Math.abs(d / pdf - 1) > 1e-6) return false;
      }
      return Math.abs(NORM.cdf(0) - 0.5) < 1e-15 && NORM.cdf(-8) < 1e-14 && NORM.cdf(8) > 1 - 1e-14;
    })(), 'Φ(2) = ' + NORM.cdf(2).toFixed(12));
    push('卡方 dof=1 是 Z²：生存函数 = 2(1−Φ(√x))', (() => {
      for (const x of [0.5, 1, 2, 3.84, 10]) {
        const ref = 2 * (1 - NORM.cdf(Math.sqrt(x)));
        if (Math.abs(chiSquareSurvival(x, 1) - ref) > 1e-9) return false;
      }
      return true;
    })(), '把 gammainc 与 erf 两条独立路线钉在一起（χ²₁ 的定义就是标准正态平方）');
    push('卡方生存函数对 dof=2 等于闭式 e^{−x/2}', (() => {
      for (const x of [0.1, 1, 2.3, 5, 12, 30, 60]) if (Math.abs(chiSquareSurvival(x, 2) / Math.exp(-x / 2) - 1) > 1e-9) return false;
      return true;
    })(), 'dof=2 是精确闭式，可抓 gammainc 级数/连分式的分支切换与「1−P 的抵消」');
    push('偶数自由度卡方对照有限求和公式 e^{−x/2}Σ(x/2)^k/k!', (() => {
      const fact = (n) => { let v = 1; for (let i = 2; i <= n; i++) v *= i; return v; };
      const surv = (x, d) => { const h = d / 2; let s = 0; for (let k = 0; k < h; k++) s += Math.pow(x / 2, k) / fact(k); return Math.exp(-x / 2) * s; };
      let worst = 0;
      for (const d of [4, 6, 8, 12]) for (const x of [0.5, 3, 7, 15, 25, 40]) worst = Math.max(worst, Math.abs(chiSquareSurvival(x, d) / surv(x, d) - 1));
      return worst < 1e-9;
    })(), '最大相对偏差 ' + (() => {
      const fact = (n) => { let v = 1; for (let i = 2; i <= n; i++) v *= i; return v; };
      const surv = (x, d) => { const h = d / 2; let s = 0; for (let k = 0; k < h; k++) s += Math.pow(x / 2, k) / fact(k); return Math.exp(-x / 2) * s; };
      let w = 0; for (const d of [4, 6, 8, 12]) for (const x of [0.5, 3, 7, 15, 25, 40]) w = Math.max(w, Math.abs(chiSquareSurvival(x, d) / surv(x, d) - 1)); return w.toExponential(2);
    })());
    push('奇数自由度：Simpson 数值积分 pdf 必须复现 CDF', (() => {
      for (const d of [3, 5]) {
        const norm = Math.pow(2, d / 2) * Math.exp(logGamma(d / 2));
        for (const X of [1.5, 4, 9]) {
          // 换元 x=t² 消掉 x^{d/2−1} 在原点的奇性，Simpson 才能收敛到 1e-9 以下
          const n = 1000, h = Math.sqrt(X) / n;
          const fg = (t) => 2 * t * Math.exp((d / 2 - 1) * Math.log(t * t) - t * t / 2) / norm;
          let s = fg(1e-14) + fg(Math.sqrt(X));
          for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * fg(i * h);
          s *= h / 3;
          if (Math.abs(s - chiSquareCdf(X, d)) > 1e-9) return false;
        }
      }
      return true;
    })(), '与 Γ 归一化对照，独立于级数/连分式');
    push('CDF + 生存函数 = 1 且随 x 单调', (() => {
      for (const d of [1, 3, 7]) for (const x of [0.3, 2, 9]) if (Math.abs(chiSquareCdf(x, d) + chiSquareSurvival(x, d) - 1) > 1e-9) return false;
      const s = [1, 2, 4, 8, 16].map((x) => chiSquareSurvival(x, 5));
      return s.every((v, i) => i === 0 || v <= s[i - 1] + 1e-12);
    })(), '含奇数自由度（走级数/连分式两条路径）');
    push('临界值与 p 值互逆（chiSquareCritical 反解）', (() => {
      for (const d of [3, 6, 11]) for (const a of [0.05, 0.01, 0.001]) {
        const c = chiSquareCritical(d, a);
        if (Math.abs(chiSquareSurvival(c, d) - a) / a > 1e-4) return false;
      }
      return true;
    })(), '二分反解自洽，不依赖任何记忆的分位数表');
    push('CEP 在圆情形等于瑞利分位数 σ·√(−2ln(1−p))', (() => {
      for (const p of [0.5, 0.68, 0.95]) {
        const v = cepFromSigma(3, 3, p);
        if (Math.abs(v - 3 * Math.sqrt(-2 * Math.log(1 - p))) > 1e-12) return false;
      }
      return true;
    })(), 'p 单调 + 圆极限解析');
    push('CEP 在椭圆情形落在两端 CEP 之间', (() => {
      const lo = cepFromSigma(1, 1, 0.95), hi = cepFromSigma(5, 5, 0.95), mid = cepFromSigma(1, 5, 0.95);
      return mid > lo && mid < hi;
    })(), '近似不会跑到物理区间外');
    push('NORM.inv 与 NORM.cdf 互逆（含尾部与对称性）', (() => {
      const ps = [1e-6, 1e-4, 0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999, 1 - 1e-4, 1 - 1e-6];
      for (const p of ps) {
        const x = NORM.inv(p);
        if (!isFinite(x)) return false;
        if (Math.abs(NORM.cdf(x) - p) > 1e-12) return false;
      }
      if (Math.abs(NORM.inv(0.5)) > 1e-15) return false;
      for (const p of [0.01, 0.1, 0.25]) if (Math.abs(NORM.inv(1 - p) + NORM.inv(p)) > 1e-12) return false;
      return NORM.inv(0) !== NORM.inv(0) && NORM.inv(1) !== NORM.inv(1) && Number.isNaN(NORM.inv(1.5));
    })(), '分位表系数一错就整体偏 0.2（旧实现在 p=0.25 给 −0.476，真值 −0.674）；现在用二分求根');

    /* ---------- 8. 单点定位 / DOP / RAIM ---------- */
    const truth = { lat: 31.2304, lon: 121.4737, h: 12 };
    const rcvE = geodeticToEcef(truth.lat, truth.lon, truth.h);
    const tows = [200000, 200600, 201200, 201800, 202400, 203000, 203600, 204200];
    const sats = tows.map((t, i) => {
      const e = Object.assign({}, EPH, { prn: 10 + i, Omega0: EPH.Omega0 + i * 0.78, M0: EPH.M0 + i * 0.79, i0: EPH.i0 + i * 0.07 });
      const p = satPosition(e, t);
      return { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, prn: 10 + i };
    });
    const cdt = 1734567.8901;
    const ranges = sats.map((s) => {
      const rho = Math.hypot(s.x - rcvE.x, s.y - rcvE.y, s.z - rcvE.z);
      const sagnac = OMEGA_E_DOT / C_LIGHT * (s.x * rcvE.y - s.y * rcvE.x);
      return rho + sagnac + cdt;
    });
    const fix = solvePosition(sats, ranges, { lat: truth.lat + 0.08, lon: truth.lon - 0.08, h: truth.h - 60 }, { sigma_m: null, tol: 1e-9 });
    push('8 星无噪声最小二乘复原真值（起点故意偏 8 km）', !fix.error && fix.converged &&
      Math.abs(fix.lat - truth.lat) < 1e-10 && Math.abs(fix.lon - truth.lon) < 1e-10 && Math.abs(fix.h - truth.h) < 1e-4,
      'Δlat=' + ((fix.lat - truth.lat) * 111320).toExponential(2) + ' m，Δh=' + (fix.h - truth.h).toFixed(6) + ' m，钟差复原 ' + (Math.abs(fix.clock_bias_m - cdt) < 1e-3 ? 'OK' : 'FAIL'));
    push('DOP 恒等式 GDOP²=PDOP²+TDOP²、PDOP²=HDOP²+VDOP²', (() => {
      const d = fix.dop;
      return Math.abs(d.gdop * d.gdop - (d.pdop * d.pdop + d.tdop * d.tdop)) < 1e-9 * d.gdop * d.gdop &&
        Math.abs(d.pdop * d.pdop - (d.hdop * d.hdop + d.vdop * d.vdop)) < 1e-9 * d.pdop * d.pdop;
    })(), fix.dop ? 'GDOP ' + fix.dop.gdop.toFixed(4) + ' / HDOP ' + fix.dop.hdop.toFixed(4) + ' / VDOP ' + fix.dop.vdop.toFixed(4) : 'no dop');
    push('demoScene 无噪声 → solvePosition 复原真值与钟差（UI 演示页的正确性底座）', (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 0 });
      if (sc.error) return false;
      const f = solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: null, tol: 1e-9 });
      if (f.error) return false;
      const dr = Math.hypot(f.x - sc.truth.x, f.y - sc.truth.y, f.z - sc.truth.z);
      // 独立口径：钟差直接和注入值比，而不是让求解器自己「说的」
      return dr < 1e-3 && Math.abs(f.clock_bias_m - sc.clock_bias_m) < 1e-3 && sc.satellites.length >= 4;
    })(), (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 0 });
      const f = sc.error ? null : solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: null, tol: 1e-9 });
      return sc.error ? sc.error : (f && f.error ? f.error : sc.satellites.length + ' 星，位置残差 ' +
        (f ? Math.hypot(f.x - sc.truth.x, f.y - sc.truth.y, f.z - sc.truth.z).toExponential(2) : '?') + ' m，钟差回收 ' +
        (f ? Math.abs(f.clock_bias_m - sc.clock_bias_m).toExponential(2) : '?') + ' m');
    })());
    push('demoScene 同 seed 必同场景（自检与演示可复现的前提）', (() => {
      const a = demoScene({}, { n: 8, noise_m: 4, seed: 12345 });
      const b = demoScene({}, { n: 8, noise_m: 4, seed: 12345 });
      const c = demoScene({}, { n: 8, noise_m: 4, seed: 12346 });
      if (a.error || b.error || c.error) return false;
      const same = a.ranges_m.every((v, i) => v === b.ranges_m[i]);
      const diff = a.ranges_m.some((v, i) => v !== c.ranges_m[i]);
      return same && diff;
    })(), 'seed=12345 两次逐元素相等，seed=12346 至少一处不同');
    push('demoScene 注入粗差 + RAIM 剔的就是那颗（不是随机剔一颗凑数）', (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 2, seed: 777, outlier_m: 180 });
      if (sc.error || !sc.outlier) return false;
      const f = solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: 4, raim: true });
      if (f.error) return false;
      const dr = Math.hypot(f.x - sc.truth.x, f.y - sc.truth.y, f.z - sc.truth.z);
      return (f.excluded_prns || []).indexOf(sc.outlier.prn) >= 0 && dr < 15;
    })(), (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 2, seed: 777, outlier_m: 180 });
      const f = sc.error ? null : solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: 4, raim: true });
      return sc.error || !f || f.error ? '场景或解算失败' : '注入 PRN ' + sc.outlier.prn + ' +180 m → 剔除 [' +
        (f.excluded_prns || []).join(',') + ']，位置偏差 ' + (f ? Math.hypot(f.x - sc.truth.x, f.y - sc.truth.y, f.z - sc.truth.z).toFixed(2) : '?') + ' m';
    })());
    // FDE 的多颗剔除记账：excluded_prns 点名谁，就必须真的从观测方程里丢掉谁。
    // 单颗剔除时「缩减序列下标」与「原始下标」相等，写错也看不出来；第二颗起才会分叉，
    // 所以这里必须注入 2 颗粗差，并核对被剔的 PRN 集合、剩余星数与真值偏差。
    push('连续剔除两颗粗差：excluded_prns 点名的就是被丢掉的，且解回到真值', (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 10, noise_m: 1.5, seed: 60061 });
      if (sc.error) return false;
      const idx = [1, 4];
      const ranges = sc.ranges_m.slice();
      const badPrns = [];
      idx.forEach((i) => { ranges[i] += i === 1 ? 240 : -190; badPrns.push(sc.satellites[i].prn); });
      const f = solvePosition(sc.satellites, ranges, { lat: 31.31, lon: 121.39, h: 12 }, { sigma_m: 4, raim: true, maxExclude: 6 });
      if (f.error) return false;
      const got = (f.excluded_prns || []).slice().sort((a, b) => a - b).join('|');
      const want = badPrns.slice().sort((a, b) => a - b).join('|');
      const dr = Math.hypot(f.x - sc.truth.x, f.y - sc.truth.y, f.z - sc.truth.z);
      return got === want && new Set(f.excluded_prns).size === f.excluded_prns.length &&
        f.sats_used === sc.satellites.length - 2 && f.residuals_m.length === f.sats_used && dr < 20;
    })(), (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 10, noise_m: 1.5, seed: 60061 });
      if (sc.error) return '场景失败';
      const idx = [1, 4];
      const ranges = sc.ranges_m.slice();
      const badPrns = [];
      idx.forEach((i) => { ranges[i] += i === 1 ? 240 : -190; badPrns.push(sc.satellites[i].prn); });
      const f = solvePosition(sc.satellites, ranges, { lat: 31.31, lon: 121.39, h: 12 }, { sigma_m: 4, raim: true, maxExclude: 6 });
      if (f.error) return '解算失败：' + f.error;
      return '注入 ' + badPrns.join('/') + ' → 剔除 [' + (f.excluded_prns || []).join('/') + ']，' +
        f.sats_used + '/' + sc.satellites.length + ' 颗保留，残差 ' + (f.residuals_m || []).length + ' 条，位置偏差 ' +
        Math.hypot(f.x - sc.truth.x, f.y - sc.truth.y, f.z - sc.truth.z).toFixed(2) + ' m';
    })());
    // 一颗卫星在同一个制式里只能出现一次。demoScene 的 prn=5+(k%20) 在 k 与 k+20 上重号，
    // 于是 12 颗的池子里能塞进两颗 GPS PRN6；剔除记录会显示成 [22,12,6,6,6,6]，
    // 星空图与逐星剔除试验也都靠 sys+prn 认星，重号之后这些输出全都对不上号。
    push('demoScene 同制式内 PRN 不重号（剔除记录与星空图按 sys+PRN 认星）', (() => {
      let groups = 0, full12 = 0, dup = 0;
      for (let seed = 700; seed < 712; seed++) {
        const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 12, noise_m: 0, seed: seed });
        if (sc.error) continue;
        groups++;
        const key = sc.satellites.map((s) => s.sys + '/' + s.prn);
        if (new Set(key).size !== key.length) dup++;
        if (key.length === 12) full12++;
      }
      return groups === 12 && full12 === 12 && dup === 0;
    })(), (() => {
      let full = 0, keys = 0;
      for (let seed = 700; seed < 712; seed++) {
        const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 12, noise_m: 0, seed: seed });
        if (sc.error) continue;
        const key = sc.satellites.map((s) => s.sys + '/' + s.prn);
        keys += key.length;
        if (key.length === 12) full++;
      }
      return full + ' 组场景取满 12 颗（候选池扫 k=0..39 仍能凑够），共 ' + keys + ' 个 sys+PRN 组合且互不相同';
    })());
    // 剔除统计量分母里的 h（该观测的杠杆）用线性代数的守恒律独立复核：
    // H = A(AᵀWA)⁻¹AᵀW 的迹恒等于设计矩阵的秩，也就是未知数个数 4，
    // 且与定权方式、卫星颗数、高度角全都无关——算错 h 就不可能把这个等式凑到 1e-9。
    push('杠杆恒等式 trace(H) ≡ 未知数个数 4（残差方差 σ²(1−h) 里的 h 算对了）', (() => {
      const seeds = [777, 12345, 60061, 991];
      let worst = 0, checked = 0;
      seeds.forEach((sd) => {
        const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 2, seed: sd });
        if (sc.error) return;
        const f = solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: 4 });
        if (f.error || !f.leverage) return;
        checked++;
        worst = Math.max(worst, Math.abs(f.leverage.reduce((a, b) => a + b, 0) - 4));
      });
      return checked === 4 && worst < 1e-9;
    })(), (() => {
      let worst = 0, tr = [];
      [777, 12345, 60061, 991].forEach((sd) => {
        const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 2, seed: sd });
        if (sc.error) return;
        const f = solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: 4 });
        if (f.error || !f.leverage) return;
        const t = f.leverage.reduce((a, b) => a + b, 0);
        tr.push(t.toFixed(9));
        worst = Math.max(worst, Math.abs(t - 4));
      });
      return '9 颗星 × 4 个未知数，trace(H) = [' + tr.join(', ') + ']，与 4 的最大偏差 ' +
        worst.toExponential(2) + '（该恒等式与颗数、定权、高度角都无关）';
    })());
    // 掩蔽效应：粗差星越主导解，它的残差被吸收得越多，|r|/σ 反而把它排到健康星后面，
    // FDE 第一次就剔错、之后一路发散。这里拿一片场景同时核对两件事：
    // 杠杆修正后的 z 必须颗颗点中注入星；而修复前的 |r|/σ 排序必须存在点错的情形——
    // 若两者结果一致，说明这个门在测的只是运气，不能证明修正在起作用。
    push('掩蔽效应：剔除必须按 |r|/(σ√(1−h)) 排序，只看 |r|/σ 会把粗差判给健康星', (() => {
      const argmax = (arr) => arr.map((v) => Math.abs(v)).reduce((bi, v, i, a2) => (v > a2[bi] ? i : bi), 0);
      let scenes = 0, zHit = 0, naiveMiss = 0;
      for (let seed = 770; seed < 786; seed++) {
        [8, 10, 12].forEach((nn) => {
          const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: nn, noise_m: 2, seed: seed, outlier_m: 180 });
          if (sc.error || !sc.outlier) return;
          const f = solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: 4 });
          if (f.error || !f.residual_z || !f.leverage) return;
          const prns = sc.satellites.map((s) => s.prn);
          const oi = prns.indexOf(sc.outlier.prn);
          if (oi < 0) return;
          scenes++;
          if (argmax(f.residual_z) === oi) zHit++;
          // 修复前那个量的复现：σ 只含高度角项（引擎同款模型），不除 √(1−h)
          const naive = f.residuals_m.map((r, i) => r / (4 / Math.max(Math.sin(
            Math.max(sc.satellites[i].elevation_deg, 5) * Math.PI / 180), 0.087)));
          if (argmax(naive) !== oi) naiveMiss++;
        });
      }
      return scenes >= 40 && zHit === scenes && naiveMiss > 0;
    })(), (() => {
      const argmax = (arr) => arr.map((v) => Math.abs(v)).reduce((bi, v, i, a2) => (v > a2[bi] ? i : bi), 0);
      let scenes = 0, naiveMiss = 0;
      for (let seed = 770; seed < 786; seed++) {
        [8, 10, 12].forEach((nn) => {
          const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: nn, noise_m: 2, seed: seed, outlier_m: 180 });
          if (sc.error || !sc.outlier) return;
          const f = solvePosition(sc.satellites, sc.ranges_m, { lat: 31.30, lon: 121.40, h: 20 }, { sigma_m: 4 });
          if (f.error || !f.residual_z || !f.leverage) return;
          const prns = sc.satellites.map((s) => s.prn);
          const oi = prns.indexOf(sc.outlier.prn);
          if (oi < 0) return;
          scenes++;
          const naive = f.residuals_m.map((r, i) => r / (4 / Math.max(Math.sin(
            Math.max(sc.satellites[i].elevation_deg, 5) * Math.PI / 180), 0.087)));
          if (argmax(naive) !== oi) naiveMiss++;
        });
      }
      return scenes + ' 组注入 +180 m 的场景：z 统计量全部点中粗差星，其中 ' + naiveMiss + ' 组（' +
        (naiveMiss / scenes * 100).toFixed(0) + '%）只看 |r|/σ 会指向别的星';
    })());
    push('demoScene 跨纬度可见性：赤道/南半球/高纬都能凑够 4 颗（截止 5°）', (() => {
      const pts = [[0, 0], [-33.86, 151.21], [60.2, 24.94], [-80, 40]];
      return pts.every((p) => {
        const sc = demoScene({ lat: p[0], lon: p[1], h: 10 }, { n: 8, noise_m: 0 });
        return !sc.error && sc.satellites.length >= 4 &&
          sc.satellites.every((s) => isNum(s.azimuth_deg) && s.elevation_deg > 5);
      });
    })(), '四组接收点均给出 ≥4 颗且高度角都过截止');
    // elevation_min_deg 的独立复核：不查实现，直接拿 demoScene 自己写进卫星对象的 elevation_deg 求最小值。
    // 字段别名一旦读错（只认 elev），这里会得到 null 或 90°，而 90° 恰好是「全部不可用」的假象。
    push('elevation_min_deg == 参与解算卫星 elevation_deg 的最小值（字段别名不静默退化成 90°）', (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 0, seed: 991 });
      if (sc.error) return false;
      const f = solvePosition(sc.satellites, sc.ranges_m, { lat: sc.truth.lat, lon: sc.truth.lon, h: sc.truth.h }, {});
      if (f.error) return false;
      const want = Math.min.apply(null, sc.satellites.map((s) => s.elevation_deg));
      return isNum(f.elevation_min_deg) && Math.abs(f.elevation_min_deg - want) < 1e-9;
    })(), (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 0, seed: 991 });
      const f = sc.error ? null : solvePosition(sc.satellites, sc.ranges_m, { lat: 31.31, lon: 121.39, h: 12 }, {});
      if (!f || f.error) return '场景或解算失败';
      return '星面最小 ' + Math.min.apply(null, sc.satellites.map((s) => s.elevation_deg)).toFixed(3) +
        '° vs 解算报出 ' + (f.elevation_min_deg == null ? 'null' : f.elevation_min_deg.toFixed(3) + '°') +
        '（无高度角字段时必须是 null，不能是 90）';
    })());
    push('无高度角字段的卫星 → elevation_min_deg 为 null 而不是伪 90°', (() => {
      const bare = solvePosition(sats, ranges, { lat: truth.lat, lon: truth.lon, h: truth.h }, {});
      return !bare.error && bare.elevation_min_deg === null;
    })(), (() => {
      const bare = solvePosition(sats, ranges, { lat: truth.lat, lon: truth.lon, h: truth.h }, {});
      return bare.error ? '解算失败' : 'elevation_min_deg = ' + JSON.stringify(bare.elevation_min_deg);
    })());
    // 高度角不只是拿来做报表：它进 lsStep 的定权。字段名一旦读不到，加权会静默退化成等权，
    // 而界面看不出任何区别——所以用「抹掉别名后的同一批观测」做对照，两者必须给出不同的解。
    push('高度角别名同时进定权：带噪声时「读到 elevation_deg」的解 ≠ 「读不到（等权）」的解', (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 6, seed: 5150 });
      if (sc.error) return false;
      const g = { lat: 31.31, lon: 121.39, h: 12 };
      const weighted = solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4 });
      const stripped = sc.satellites.map((s) => ({ x: s.x, y: s.y, z: s.z, prn: s.prn, sys: s.sys }));
      const equal = solvePosition(stripped, sc.ranges_m, g, { sigma_m: 4 });
      if (weighted.error || equal.error) return false;
      const dPos = Math.hypot(weighted.x - equal.x, weighted.y - equal.y, weighted.z - equal.z);
      return dPos > 1e-3 && dPos < 300 && Math.abs(weighted.dop.hdop - equal.dop.hdop) > 1e-6;
    })(), (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 6, seed: 5150 });
      const g = { lat: 31.31, lon: 121.39, h: 12 };
      const weighted = sc.error ? null : solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4 });
      const stripped = sc.error ? null : sc.satellites.map((s) => ({ x: s.x, y: s.y, z: s.z, prn: s.prn, sys: s.sys }));
      const equal = stripped ? solvePosition(stripped, sc.ranges_m, g, { sigma_m: 4 }) : null;
      if (!weighted || !equal || weighted.error || equal.error) return '场景或解算失败';
      return '两解相差 ' + Math.hypot(weighted.x - equal.x, weighted.y - equal.y, weighted.z - equal.z).toFixed(2) +
        ' m，HDOP ' + weighted.dop.hdop.toFixed(4) + ' vs ' + equal.dop.hdop.toFixed(4);
    })());
    // weight:'none' 是文件头承诺的三档之一。它必须真的等价于「拿不到高度角」那条等权路径：
    // 两条完全不同的入口（显式选项 vs 字段缺失）解到同一个数，才说明选项不是摆设。
    push("weight:'none' 与「抹掉高度角的等权解」逐位相同，weight:'snr' 则是第三种解", (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 6, seed: 5150 });
      if (sc.error) return false;
      const g = { lat: 31.31, lon: 121.39, h: 12 };
      const stripped = sc.satellites.map((s) => ({ x: s.x, y: s.y, z: s.z, prn: s.prn, sys: s.sys }));
      const none = solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4, weight: 'none' });
      const equal = solvePosition(stripped, sc.ranges_m, g, { sigma_m: 4 });
      const snr = solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4, weight: 'snr' });
      const elev = solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4 });
      if (none.error || equal.error || snr.error || elev.error) return false;
      const d1 = Math.hypot(none.x - equal.x, none.y - equal.y, none.z - equal.z);
      const d2 = Math.hypot(snr.x - none.x, snr.y - none.y, snr.z - none.z);
      const d3 = Math.hypot(elev.x - none.x, elev.y - none.y, elev.z - none.z);
      return d1 < 1e-9 && d2 > 1e-3 && d3 > 1e-3;
    })(), (() => {
      const sc = demoScene({ lat: 31.31, lon: 121.39, h: 12 }, { n: 9, noise_m: 6, seed: 5150 });
      const g = { lat: 31.31, lon: 121.39, h: 12 };
      const stripped = sc.satellites.map((s) => ({ x: s.x, y: s.y, z: s.z, prn: s.prn, sys: s.sys }));
      const none = solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4, weight: 'none' });
      const equal = solvePosition(stripped, sc.ranges_m, g, { sigma_m: 4 });
      const snr = solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4, weight: 'snr' });
      const elev = solvePosition(sc.satellites, sc.ranges_m, g, { sigma_m: 4 });
      return 'none vs 缺字段等权相差 ' + Math.hypot(none.x - equal.x, none.y - equal.y, none.z - equal.z).toExponential(2) +
        ' m；snr 档相差 ' + Math.hypot(snr.x - none.x, snr.y - none.y, snr.z - none.z).toFixed(2) +
        ' m，高度角档相差 ' + Math.hypot(elev.x - none.x, elev.y - none.y, elev.z - none.z).toFixed(2) + ' m';
    })());
    push('σ 缩放：先验 σ0 只放大协方差、不改 DOP', (() => {
      const a = solvePosition(sats, ranges, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 1 });
      const b = solvePosition(sats, ranges, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 10 });
      return a.dop && b.dop && Math.abs(a.dop.hdop - b.dop.hdop) < 1e-9 && Math.abs(b.sigma_e_m / a.sigma_e_m - 10) < 1e-6;
    })(), 'DOP 是纯几何量，误差 = DOP×σ');
    push('3 星 + 已知钟差可解（3 未知数），3 星 + 钟差未知必须报错', (() => {
      const g = { lat: truth.lat, lon: truth.lon, h: truth.h };
      const three = solvePosition(sats.slice(0, 3), ranges.slice(0, 3), g, { clock_bias_m: cdt });
      const threeBad = solvePosition(sats.slice(0, 3), ranges.slice(0, 3), g, {});
      const noValue = solvePosition(sats.slice(0, 3), ranges.slice(0, 3), g, { fixClock: true });
      return three.error == null && three.sats_used === 3 &&
        Math.hypot(three.x - rcvE.x, three.y - rcvE.y, three.z - rcvE.z) < 1e-3 &&
        threeBad.error != null && noValue.error != null;
    })(), '未知量个数决定最少星数：钟差已知 3 颗、未知 4 颗；fixClock 不给数值就报错，绝不把钟差当成 0');
    push('4 星少一颗就报错，且 error 里说清缺几颗', (() => {
      const g = { lat: truth.lat, lon: truth.lon, h: truth.h };
      const e4 = solvePosition(sats.slice(0, 4), ranges.slice(0, 4), g, {});
      const e3 = solvePosition(sats.slice(0, 3), ranges.slice(0, 3), g, {});
      return e4.error == null && e4.sats_used === 4 && e3.error != null && /4 颗/.test(e3.error);
    })(), '错误信息必须能直接给 UI 显示');
    push('卫星数与伪距数不等必须报错', solvePosition(sats, ranges.slice(0, 5), null, {}).error != null, solvePosition(sats, ranges.slice(0, 5), null, {}).error);
    push('粗差注入后：不给 σ0 时无法判、给 σ0 时卡方报警', (() => {
      const bad = ranges.slice(); bad[3] += 90;
      const noSigma = solvePosition(sats, bad, { lat: truth.lat, lon: truth.lon, h: truth.h }, {});
      const withSigma = solvePosition(sats, bad, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 4 });
      return withSigma.integrity.alarm === true && withSigma.chi2 > chiSquareCritical(withSigma.chi2_dof, 0.01) && noSigma.integrity.alarm === null;
    })(), '未给先验 σ0 → alarm=null（诚实标注检测失效）');
    push('RAIM 自动剔除命中被注入粗差的那颗星（PRN 13）', (() => {
      const bad = ranges.slice(); bad[3] += 90;
      const fde = solvePosition(sats, bad, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 4, raim: true });
      return fde.excluded_prns.indexOf(13) >= 0 && Math.hypot(fde.x - rcvE.x, fde.y - rcvE.y, fde.z - rcvE.z) < 3 && fde.rms_residual_m < 1e-3;
    })(), '剔除 ' + (() => { const bad = ranges.slice(); bad[3] += 90; const f = solvePosition(sats, bad, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 4, raim: true }); return JSON.stringify(f.excluded_prns) + '，剩余位置偏差 ' + (f.error ? 'n/a' : Math.hypot(f.x - rcvE.x, f.y - rcvE.y, f.z - rcvE.z).toFixed(3) + ' m，RMS ' + f.rms_residual_m.toExponential(2)); })());
    push('剔除后残差必须显著小于不剔除', (() => {
      const bad = ranges.slice(); bad[3] += 90;
      const plain = solvePosition(sats, bad, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 4, raim: false });
      const fde = solvePosition(sats, bad, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 4, raim: true });
      return fde.rms_residual_m < plain.rms_residual_m / 20;
    })(), excludeAndResolve(sats, (() => { const b = ranges.slice(); b[3] += 90; return b; })(), { lat: truth.lat, lon: truth.lon }, { sigma_m: 4 }).best_exclusion ?
      '逐星剔除首选 PRN ' + excludeAndResolve(sats, (() => { const b = ranges.slice(); b[3] += 90; return b; })(), { lat: truth.lat, lon: truth.lon }, { sigma_m: 4 }).best_exclusion.excluded_prn : 'no trial');
    push('逐星剔除接口给出偏移量排序且最优项即粗差星', (() => {
      const bad = ranges.slice(); bad[3] += 90;
      const er = excludeAndResolve(sats, bad, { lat: truth.lat, lon: truth.lon, h: truth.h }, { sigma_m: 4 });
      return er.best_exclusion && er.best_exclusion.excluded_prn === 13 && er.trials.length === 8;
    })(), 'trials=' + (excludeAndResolve(sats, ranges, { lat: truth.lat, lon: truth.lon, h: truth.h }, {}).trials || []).length);
    push('HPL 随 σ0、HDOP 单调上升；卫星数只通过 K(n) 与几何起作用', (() => {
      const a = horizProtectionLevel(1.2, 2, 8, 0.01), b = horizProtectionLevel(1.2, 4, 8, 0.01), c = horizProtectionLevel(2.4, 2, 8, 0.01);
      const k8 = horizProtectionLevel(1, 1, 8, 0.01), k16 = horizProtectionLevel(1, 1, 16, 0.01);
      // K = 分位(1−α/2n)：守住同一个虚警率，卫星越多需要越大的分位（Bonferroni/Sidak 一侧）。
      // 所以「星多 ⇒ HPL 低」只有在「多出来的星把 HDOP 一起压低」时才成立，不能当成普适单调。
      const net16 = horizProtectionLevel(1.0, 2, 16, 0.01);
      return b > a && c > a && k16 > k8 && net16 < a &&
        Math.abs(a - k8 * 2 * 1.2) < 1e-12 && horizProtectionLevel(1.2, 0, 8, 0.01) === null;
    })(), 'HPL(σ=2,HDOP=1.2,n=8)=' + horizProtectionLevel(1.2, 2, 8, 0.01).toFixed(2) + ' m，K(n=8)=' +
      horizProtectionLevel(1, 1, 8, 0.01).toFixed(4) + '，K(n=16)=' + horizProtectionLevel(1, 1, 16, 0.01).toFixed(4));
    push('退化几何（所有星同方向）返回 error 而不是巨大的 DOP', (() => {
      const same = sats.map((s) => Object.assign({}, s, { x: sats[0].x + 1000, y: sats[0].y + 1000, z: sats[0].z + 1000 }));
      const r = solvePosition(same, same.map((s) => Math.hypot(s.x - rcvE.x, s.y - rcvE.y, s.z - rcvE.z) + cdt), { lat: truth.lat, lon: truth.lon, h: truth.h }, {});
      return r.error != null || (r.dop && r.dop.gdop > 1e3);
    })(), '矩阵奇异或 DOP 爆炸都要能被 UI 抓到');
    push('ECEF↔大地坐标往返（含极点半径与赤道长半轴）', (() => {
      const pts = [[0, 0, 0], [90, 0, 1000], [-90, 0, 1000], [45, 90, 500], [-33.8688, 151.2093, 40], [89.99999, -179.9999, 0]];
      return pts.every(([la, lo, hh]) => {
        const e = geodeticToEcef(la, lo, hh), b = ecefToGeodetic(e.x, e.y, e.z);
        return Math.abs(b.lat - la) < 1e-9 && Math.abs(b.h - hh) < 1e-4;
      });
    })(), '极点 z = b + h 的显式检验：' + geodeticToEcef(90, 0, 0).z.toFixed(3) + ' vs b=' + WGS84.b.toFixed(3));
    push('赤道点上 |r| = a + h、极点上 |r| = b + h', (() => {
      const eq = geodeticToEcef(0, 123.4, 100), po = geodeticToEcef(90, 0, 100);
      return Math.abs(Math.hypot(eq.x, eq.y, eq.z) - (WGS84.a + 100)) < 1e-6 && Math.abs(Math.abs(po.z) - (WGS84.b + 100)) < 1e-6;
    })(), '椭球两个轴的解析半径，抓 ν 公式');

    /* ---------- 9. 由方位/高度角的几何 ---------- */
    push('losEnu 的三个极端方向精确', (() => {
      const a = losEnu(0, 0), b = losEnu(90, 0), c = losEnu(0, 90);
      return Math.abs(a.n - 1) < 1e-12 && Math.abs(a.e) < 1e-12 && Math.abs(b.e - 1) < 1e-12 && Math.abs(c.u - 1) < 1e-12;
    })(), 'az 自北顺时针、el 为仰角');
    push('单位视线矢量模长恒为 1', sats.every((s) => { const l = losEnu(Math.random() * 360, Math.random() * 90); return Math.abs(Math.hypot(l.e, l.n, l.u) - 1) < 1e-12; }), '30 个随机方向');
    push('GSV 几何 DOP 与 ECEF 解算 DOP 必须一致（跨实现互验）', (() => {
      const az = [], list = sats.map((s, i) => {
        const M = enuMatrix(truth.lat, truth.lon);
        const d = [s.x - rcvE.x, s.y - rcvE.y, s.z - rcvE.z], n = Math.hypot(d[0], d[1], d[2]);
        const u = d.map((v, k) => v / n);
        const e = M[0].reduce((a2, v, k) => a2 + v * u[k], 0), nn = M[1].reduce((a2, v, k) => a2 + v * u[k], 0), uu = M[2].reduce((a2, v, k) => a2 + v * u[k], 0);
        const el = Math.asin(uu) * R2D, a2 = Math.atan2(e, nn) * R2D;
        az.push(a2);
        return { azimuth_deg: wrap360(a2), elevation_deg: el };
      });
      const g = geometryFromAzEl(list);
      return g.hdop != null && fix.dop && Math.abs(g.hdop - fix.dop.hdop) / fix.dop.hdop < 1e-6;
    })(), '两条独立路径给出同一个 HDOP（' + (geometryFromAzEl(sats.map((s) => ({ azimuth_deg: 0, elevation_deg: 45 }))).hdop ? '实现存在' : '?') + '）');
    // 方位角均匀铺满 8 个方向，只改高度角：这样对比的纯粹是「仰角」这一个变量。
    const azEl = (els) => els.map((e, i) => ({ azimuth_deg: i * 45, elevation_deg: e }));
    const hdGood = azEl([20, 28, 36, 44, 52, 60, 68, 76]);
    const hdSameEl = azEl([4, 4, 4, 4, 4, 4, 4, 4]);
    const hdLow = azEl([3, 4.5, 6, 7.5, 9, 10.5, 12, 13.5]);
    const hdCluster = hdGood.map((s, i) => Object.assign({}, s, { azimuth_deg: 10 + i * 4 }));
    const hg = geometryFromAzEl(hdGood), hs = geometryFromAzEl(hdSameEl), hl = geometryFromAzEl(hdLow), hc = geometryFromAzEl(hdCluster);
    // 「把星压到 4°」的正确结论：水平几何其实变好（星几乎铺满地平圈），
    // 变坏的是天顶方向与钟差——所以这里断言的是 VDOP/PDOP 上升，而不是 HDOP 上升。
    push('同一组星压到 3°~13.5°：HDOP 反而下降，但 VDOP/PDOP/GDOP 必须显著上升',
      hg.hdop != null && hl.hdop != null && hl.hdop < hg.hdop && hl.vdop > hg.vdop * 2 && hl.pdop > hg.pdop * 2 && hl.gdop > hg.gdop * 2,
      'HDOP(良)=' + hg.hdop.toFixed(3) + ' vs HDOP(低)=' + hl.hdop.toFixed(3) + '；VDOP ' + hg.vdop.toFixed(3) + ' → ' + hl.vdop.toFixed(3) +
      '，PDOP ' + hg.pdop.toFixed(3) + ' → ' + hl.pdop.toFixed(3) + '，GDOP ' + hg.gdop.toFixed(3) + ' → ' + hl.gdop.toFixed(3));
    push('全部星同一高度角：天顶列与钟差列严格相关 ⇒ 必须报退化，不许吐 VDOP=0',
      hs.error != null, hs.error != null ? hs.error : '没报错，返回 VDOP=' + hs.vdop + '（sqrt(max(0,负对角元)) 会把奇异伪装成 0）');
    push('方位角挤进 30° 扇区（真正变差的水平几何）：HDOP 必须成倍上升',
      hc.hdop != null && hc.hdop > hg.hdop * 20 && hc.hdop > 20, 'HDOP(聚簇)=' + hc.hdop.toFixed(1) + ' vs ' + hg.hdop.toFixed(3) + '（×' + (hc.hdop / hg.hdop).toFixed(1) + '）');
    push('钟差已知（不占未知数）时 DOP 必然变小', (() => {
      const nc = geometryFromAzEl(hdGood, { fixClock: true });
      return nc.error == null && nc.tdop === 0 && nc.hdop < hg.hdop && nc.pdop < hg.pdop &&
        Math.abs(nc.gdop - nc.pdop) < 1e-12;
    })(), '去掉常数列后正规方程更“硬”，这是 4 星 vs 3 星差异的根源');
    push('卫星不足 4 颗返回 error', geometryFromAzEl([{ azimuth_deg: 0, elevation_deg: 40 }, { azimuth_deg: 90, elevation_deg: 40 }, { azimuth_deg: 180, elevation_deg: 40 }]).error != null,
      geometryFromAzEl([{ azimuth_deg: 0, elevation_deg: 40 }]).error);
    push('单差线性解能从合成残差精确恢复位移（3 未知数）', (() => {
      const list = [{ azimuth_deg: 0, elevation_deg: 45 }, { azimuth_deg: 120, elevation_deg: 45 }, { azimuth_deg: 240, elevation_deg: 45 }, { azimuth_deg: 60, elevation_deg: 20 }, { azimuth_deg: 200, elevation_deg: 70 }];
      const dtrue = { dE: 12.5, dN: -7.25, dU: 3.1 };
      const res = list.map((x) => { const l = losEnu(x.azimuth_deg, x.elevation_deg); return -(l.e * dtrue.dE + l.n * dtrue.dN + l.u * dtrue.dU); });
      const r = relativeFix(list, res, { lat: 30, lon: 120 });
      if (r.error) return false;
      return Math.abs(r.dE_m - dtrue.dE) < 1e-6 && Math.abs(r.dN_m - dtrue.dN) < 1e-6 && Math.abs(r.dU_m - dtrue.dU) < 1e-6;
    })(), '残差模型 res = −los·δ，反解必须回到 δ');
    push('天空图按截止角划分可见星', (() => {
      const sp = skyPlot([{ prn: 1, azimuth_deg: 10, elevation_deg: 5, snr_db: 40 }, { prn: 2, azimuth_deg: 200, elevation_deg: 45, snr_db: 48 }], 10);
      return sp.used === 1 && sp.total === 2 && sp.items[0].visible === false;
    })(), 'mask=10°');

    /* ---------- 10. 融合 / 质量 ---------- */
    push('两条等精度解融合落在中点（解析可验证）', (() => {
      const f = fuseSolutions([{ source: 'gnss', lat: 30, lon: 120, sigma_m: 2 }, { source: 'cell', lat: 30.001, lon: 120, sigma_m: 2 }]);
      return Math.abs(f.lat - 30.0005) < 1e-9 && Math.abs(f.sigma_n_m - 2 / Math.SQRT2) < 1e-9;
    })(), '等权平均 + σ/√2 的方差合成');
    push('权 = 1/σ² 的融合：σ=1 与 σ=10 的解各偏 100 m 时，结果按 100:1 偏向精度高的', (() => {
      const a = { source: 'gnss', lat: 30, lon: 120, sigma_m: 1 };
      const b = { source: 'ip', lat: 30 + 100 / mPerDegLat(), lon: 120, sigma_m: 10 };
      const f = fuseSolutions([a, b]);
      const wA = (1 / 1) / (1 / 1 + 1 / 100);
      return Math.abs((f.lat - 30) / (100 / mPerDegLat()) - (1 - wA)) < 1e-6;
    })(), 'BLUE 权重 1/σ² 的直接检验');
    push('融合一致性检验能区分「互相吻合」与「明显矛盾」', (() => {
      // σ0=2 m 时，「吻合」必须是米级差异；原来用 0.00005°（≈5.6 m）当吻合样本，
      // 那本身就是 2.8σ 的偏差，χ² 报不一致才是对的——判据前提错了。
      const ok = fuseSolutions([{ lat: 30, lon: 120, sigma_m: 2, source: 'a' }, { lat: 30.00001, lon: 120, sigma_m: 2, source: 'b' }, { lat: 29.99999, lon: 120.00001, sigma_m: 2, source: 'c' }]);
      const bad = fuseSolutions([{ lat: 30, lon: 120, sigma_m: 2, source: 'a' }, { lat: 30.05, lon: 120, sigma_m: 2, source: 'b' }, { lat: 29.95, lon: 120.05, sigma_m: 2, source: 'c' }]);
      return ok.consistency.inconsistent === false && ok.consistency.dof === 4 && ok.consistency.p_value > 0.001 &&
        bad.consistency.inconsistent === true && bad.consistency.p_value < 1e-6;
    })(), 'χ² 检验（离线/联网偏差判定就靠它）：吻合样本 p=' + (() => { const f = fuseSolutions([{ lat: 30, lon: 120, sigma_m: 2 }, { lat: 30.00001, lon: 120, sigma_m: 2 }, { lat: 29.99999, lon: 120.00001, sigma_m: 2 }]); return f.consistency.chi2.toFixed(3) + '（p=' + f.consistency.p_value.toFixed(3) + '）'; })());
    push('两解 χ² 有解析值可对照：相距 d、各 σ ⇒ χ² = d²/(2σ²)，dof=2', (() => {
      const sig = 2, d = 1e5;                       // 用百米级间距，避开 (120 + 1e-5) − 120 的浮点抵消
      const dl = d / mPerDegLon(30);
      const f = fuseSolutions([{ lat: 30, lon: 120, sigma_e_m: sig, sigma_n_m: sig }, { lat: 30, lon: 120 + dl, sigma_e_m: sig, sigma_n_m: sig }]);
      const expect = d * d / (2 * sig * sig);
      return Math.abs(f.consistency.chi2 - expect) / expect < 1e-12 && f.consistency.dof === 2 &&
        f.consistency.inconsistent === true &&
        Math.abs(f.lon - (120 + dl / 2)) < 1e-12 && Math.abs(f.sigma_e_m - sig / Math.SQRT2) < 1e-12 &&
        Math.abs(f.sigma_n_m - sig / Math.SQRT2) < 1e-12;
    })(), '等权两点残差各 ±d/2 ⇒ Σ(d/2)²/σ² = d²/(2σ²)：与代码另一条路数独立（d=100 km、σ=2 m 时 χ²=1.25e9）');
    push('缺不确定度的解被跳过并在 warnings 里说明', (() => {
      const f = fuseSolutions([{ lat: 30, lon: 120, source: 'no-sigma' }, { lat: 31, lon: 121, sigma_m: 3, source: 'ok' }]);
      return f.warnings.length === 1 && Math.abs(f.lat - 31) < 1e-9;
    })(), '不会把「没有 σ」当成 σ=0 而霸占权重');
    push('全部解都不可用时返回 error', fuseSolutions([]).error != null && fuseSolutions([{}]).error != null, fuseSolutions([{}]).error);
    push('SNR→UERE 单调：信号越强伪距越准', (() => {
      const a = snrToUere(30), b = snrToUere(45);
      return b.sigma_m < a.sigma_m && a.sigma_m > 0 && isNum(b.multipath_m);
    })(), 'σ(30 dB)=' + snrToUere(30).sigma_m.toFixed(2) + ' m, σ(45 dB)=' + snrToUere(45).sigma_m.toFixed(2) + ' m');
    push('质量报告：好构型得分高于差构型', (() => {
      const good = qualityReport({ lat: 30, lon: 120, sats_used: 11, dop: { hdop: 0.9, pdop: 1.2, gdop: 1.4 }, rms_residual_m: 0.4, elevation_min_deg: 35 });
      const bad = qualityReport({ lat: 30, lon: 120, sats_used: 4, dop: { hdop: 6.5, pdop: 9.2, gdop: 11 }, rms_residual_m: 8, elevation_min_deg: 3 });
      return good.grade.score > bad.grade.score && good.usable === true && bad.grade.label.length > 0;
    })(), '优=' + qualityReport({ lat: 30, lon: 120, sats_used: 11, dop: { hdop: 0.9, pdop: 1.2, gdop: 1.4 }, rms_residual_m: 0.4, elevation_min_deg: 35 }).grade.label +
      ' 差=' + qualityReport({ lat: 30, lon: 120, sats_used: 4, dop: { hdop: 6.5, pdop: 9.2, gdop: 11 }, rms_residual_m: 8, elevation_min_deg: 3 }).grade.label);
    push('质量报告缺字段不抛异常', qualityReport(null).error != null && qualityReport({}).error != null, '需要定位解');

    /* ---------- 11. 精密服务电文与改正 ---------- */
    push('L6 帧头：手工构造 CLAS 类型(63) 的比特必须被识别', (() => {
      const bits = '00000000' + (63).toString(2).padStart(6, '0') + '0' + '000' + '01' + '10' + '00';
      const d = decodeL6Frame(bits);
      return d.is_clas === true && d.message_type === 63 && d.layers && d.layers.length === 3;
    })(), '位段 (0-7 PRN, 8-13 MT) 与 ARIB STD-T147 一致的部分才解，其余不猜');
    push('L6 非 CLAS 类型明确标注不解包', decodeL6Frame('00000000' + (5).toString(2).padStart(6, '0') + '000000000000').is_clas === false, 'MT=5');
    push('PPP-B2b：未知消息类型返回 error 且列出支持类型', (() => {
      const d = decodePppB2b('000000' + '0'.repeat(30));
      return d.error != null && d.supported_types != null && Object.keys(d.supported_types).length === 4;
    })(), decodePppB2b('000000' + '0'.repeat(30)).error);
    push('PPP-B2b：给 scale 才能解出径向改正，否则返回 null（不臆造）', (() => {
      const bits = (3).toString(2).padStart(6, '0') + '000001' + '0001' + '111111111111';
      const noScale = decodePppB2b(bits);
      const withScale = decodePppB2b(bits, { radial_scale: 0.25 / 1024 });
      return noScale.radial_m === null && Math.abs(withScale.radial_m + 1 * 0.25 / 1024) < 1e-12;
    })(), '12 位补码全 1 → −1');
    push('补码解析：0111→7、1000→−8、1111→−1', signed('0111', 0, 4) === 7 && signed('1000', 0, 4) === -8 && signed('1111', 0, 4) === -1, 'signed() 的位宽与符号位');
    push('RTN 径向改正严格改变地心距（正交基恒等式）', (() => {
      const s = sats[0];
      const r = applyOrbitCorrection(s, s, { radial_m: 12.5, tangential_m: 3, normal_m: -2 });
      const got = Math.hypot(r.position.x, r.position.y, r.position.z);
      const A = r.rtn_axes, dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const nrm = (u) => Math.hypot(u[0], u[1], u[2]);
      const vhat = [s.vx, s.vy, s.vz].map((v) => v / Math.hypot(s.vx, s.vy, s.vz));
      // eT 是「沿迹」方向：它与速度同向（≈1）、与径向正交（≈0）。旧判据把这两个性质搞混了，
      // 断言 t̂·v̂≈0 永远不可能成立。
      return r.degraded === false &&
        Math.abs(got - (Math.hypot(s.x, s.y, s.z) + 12.5)) < 1e-4 &&
        Math.abs(dot(A.r, A.t)) < 1e-9 && Math.abs(dot(A.r, A.n)) < 1e-9 && Math.abs(dot(A.t, A.n)) < 1e-9 &&
        [A.r, A.t, A.n].every((u) => Math.abs(nrm(u) - 1) < 1e-12) && dot(A.t, vhat) > 0.999;
    })(), 'Δ半径 = ' + (() => { const s = sats[0]; const r = applyOrbitCorrection(s, s, { radial_m: 12.5, tangential_m: 3, normal_m: -2 }); return (Math.hypot(r.position.x, r.position.y, r.position.z) - Math.hypot(s.x, s.y, s.z)).toFixed(6); })() +
      ' m（切向只贡献 9/(2r)≈1e-7 的二阶项），且 r̂·t̂ = t̂·n̂ = 0、t̂‖速度');
    push('RTN 三轴改正量满足 shift = √(r²+t²+n²)（正交基）', (() => {
      const s = sats[1];
      const r = applyOrbitCorrection(s, s, { radial_m: 4, tangential_m: -6, normal_m: 9 });
      return Math.abs(r.shift_m - Math.sqrt(16 + 36 + 81)) < 1e-9;
    })(), '勾股恒等式，抓 eT/eN 不正交');
    push('没有速度时只加径向并标记 degraded', (() => {
      const r = applyOrbitCorrection(sats[2], null, { radial_m: 5, tangential_m: 7, normal_m: 8 });
      return r.degraded === true && Math.abs(Math.hypot(r.position.x, r.position.y, r.position.z) - (Math.hypot(sats[2].x, sats[2].y, sats[2].z) + 5)) < 1e-6;
    })(), '宁可降级，不臆造切向方向');
    push('applyOrbitCorrection 缺字段返回 error', applyOrbitCorrection(null, null, {}).error != null && applyOrbitCorrection(sats[0], sats[0], { radial_m: 1 }).error != null,
      applyOrbitCorrection(sats[0], sats[0], { radial_m: 1 }).error);
    push('伪距改正各项按符号累加且可逐项复现', (() => {
      const c = correctPseudorange(21000000, { sat_clock_s: 1e-4, iono_m: 4.5, tropo_m: 2.3, sagnac_m: 30, service_m: 0.4 });
      const expect = 21000000 - 1e-4 * C_LIGHT - 4.5 - 2.3 - 30 - 0.4;
      return Math.abs(c.range_m - expect) < 1e-9 && Object.keys(c.terms).length === 8;
    })(), '卫星钟 + 电离层 + 对流层 + Sagnac + 服务改正');
    push('correctPseudorange 全空时返回原值', Math.abs(correctPseudorange(12345.6, {}).range_m - 12345.6) < 1e-12, '恒等');

    /* ---------- 12. 全 API 垃圾输入健壮性 ---------- */
    const junkArgs = [null, undefined, NaN, Infinity, '', 'abc', -1e18, 1e18, {}, [], true];
    let crash = 0, leaked = 0, calls = 0;
    const leakMsg = [];
    // 约定（写清楚，别靠猜）：
    //   · 任何函数都不得抛异常，也不得静默返回 undefined；
    //   · 返回「报表对象/数组」时，任何字段都不许出现 NaN 或 ±Infinity——UI 会原样打印；
    //   · 返回「单个数值」时，定义域外用 NaN 或 null（JS 惯例，算下去还是 NaN，看得见，调用方必须先判空），
    //     但 ±Infinity 不允许：那会被读成「无穷大」而不是「算不了」。
    const badInside = (o, depth) => {
      if (depth > 4) return false;
      if (typeof o === 'number') return !isFinite(o);
      if (Array.isArray(o)) return o.some((x) => badInside(x, depth + 1));
      if (o && typeof o === 'object') return Object.keys(o).some((k) => badInside(o[k], depth + 1));
      return false;
    };
    const names = Object.keys(API).filter((k) => typeof API[k] === 'function' && k !== 'selfTest');
    for (const name of names) {
      const fn = API[name];
      for (const a of junkArgs) {
        for (const b of junkArgs.slice(0, 5)) {
          calls++;
          try {
            const r = fn(a, b, a);
            const bad = r === undefined ||
              (typeof r === 'number' ? (r === r && !isFinite(r)) : (typeof r !== 'string' && r !== null && badInside(r, 0)));
            if (bad) {
              leaked++;
              if (leakMsg.length < 3) leakMsg.push(name + '(' + String(a) + ',' + String(b) + ')→' + String(typeof r === 'number' ? r : JSON.stringify(r)).slice(0, 60));
            }
          } catch (e) { crash++; }
        }
      }
    }
    push('全部 API 函数 × 垃圾参数不抛异常', crash === 0, names.length + ' 个函数 × ' + calls + ' 次调用，异常 ' + crash);
    push('垃圾输入：对象结果无 NaN/Inf，数值结果只用 NaN 表达定义域外（禁 ±Inf、禁 undefined）', leaked === 0,
      leaked === 0 ? calls + ' 次调用全部合规（NaN 只作为纯数值返回，±Infinity 与对象内 NaN 全清零）' : '违规 ' + leaked + ' 处：' + leakMsg.join(' | '));

    /* ---------- 13. 导出面 ---------- */
    const required = ['decodeNmea', 'buildNmea', 'mergeNmea', 'satPosition', 'satClock', 'glonassPosition', 'solvePosition',
      'raimCheck', 'excludeAndResolve', 'fuseSolutions', 'qualityReport', 'ionoShell', 'troposphereZenith', 'geometryFromAzEl',
      'decodeL6Frame', 'decodePppB2b', 'applyOrbitCorrection', 'correctPseudorange', 'gpsWeekSecond', 'parseUtc', 'selfTest'];
    push('必需导出项齐备且为函数', required.every((k) => typeof API[k] === 'function'), '缺失：' + required.filter((k) => typeof API[k] !== 'function').join(','));
    push('全局挂载成功', (typeof global.GEOGNSS === 'object' ? global : globalThis).GEOGNSS === API || global.GEOGNSS === API, 'GEOGNSS');
    return out;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
