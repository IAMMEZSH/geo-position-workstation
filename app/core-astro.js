/*
 * core-astro.js — 经纬度定位工作站 · 天象定位引擎（纯离线 / 纯浏览器）
 *
 * 形态约束：单个 IIFE；无 import/export/require/DOM/fetch/第三方库；
 *          Node 下 require('./app/core-astro.js') 后可直接 GEOASTRO.selfTest()。
 * 依赖：可选使用 globalThis.GEOGEO（椭球/大地线）；不存在时内部退化为球面 Haversine，
 *      加载期绝不抛异常（浏览器 script 顺序不可控）。
 *
 * 精度诚实性声明（本文件最重要的一段，逐条与 selfTest 的断言对应）：
 *  - 时间：儒略日按 Meeus《Astronomical Algorithms》第 7 章（格里高利历式）。
 *          **不处理闰秒，也不假装知道闰秒**：本引擎在 UTC 尺度上工作，
 *          TAI/UTC 差与 ΔT（TT−UT）未建模，因此太阳赤经/赤纬里含 +32.23 s×n 的
 *          累积项没有计入，太阳黄经的系统偏差量级 ~0.01″（可忽略），
 *          但 **GMST 会因 UT1−UTC 未知而有最多 ±0.9 s 的等效误差**（≈ ±0.22′ 的
 *          地方时角 / 月下点经度 ≈ ±16 km）。格里高利历 1582-10-15 之前拒绝计算。
 *  - GMST：IAU-1982/2000 表达式（含 T²、T³ 项），Meeus 第 12 章 (12.4)。
 *          本身精度 ~亚角秒；主要误差来自 UT1 未知。
 *  - 太阳：Meeus 第 25 章（地球轨道 VSOP87 截断到本章表 25.B 的 L,B,R 前段）
 *          + 第 22 章章动主项 + 光行差/周年像差常数。
 *          selfTest 用两个独立恒等式约束系数：真近点角≈M+2e·sinM（抓方程中心系数
 *          与离心率互错）、回归年长度=365.2422 d（抓黄经长期速率系数）。
 *  - 月亮：**显式截断的主项级数**（黄经 5 项 / 黄纬 6 项 / 距离 5 项，参数名逐项写出，
 *          见 MOON_TERMS_* 注释），不是 Meeus 第 47 章全表（全表 60/40/35 项）。
 *          **绝对精度未经证实**：本环境无网络、无第三方历表可比对，因此
 *          selfTest 只报告 (a) 与独立二体 Kepler 解的逐历元差（应≈摄动幅度）、
 *          (b) 逐项振幅的手算对照（抓系数互换/小数点错位）、(c) 月下点纬度=月赤纬
 *          这一几何恒等式、(d) 相位三角 i+E+S=180° 的严格包络。
 *          这三类断言能抓住：数量级/小数点错位、系数互换、坐标变换写反；
 *          抓不住：单个系数的记忆错误（若该系数本身记错则所有自洽检核都失效）、
 *          角度度数/弧度写反之外的参数组合错误、被省略项的真实贡献。
 *          工程结论：省略项振幅合计（黄经）~0.1°、加上记忆系数本身的不可核，
 *          **月位按 ±0.5°（月面直径量级）使用**；月升落时刻 ±25 min 量级；
 *          不可用于月掩星、月龄精算或任何角分级用途。
 *  - 恒星：J2000 平位置表（46 颗导航星，坐标为记忆值、离线不可核）+ 岁差 3-1-3 旋转
 *          （IAU-1976 ζ/θ/z 含 T²、T³，见 precessionMatrix 注释）。恒等式：酉正交性、
 *          转置即逆、黄道上固定点黄经长期速率 = +1.397°/世纪且黄纬保持 0、
 *          Polaris 赤纬随时间增大（离北极星时刻 ~2100 年，由代码扫描给出）。
 *          岁差的**旋转方向**由这四条独立判据共同确定（实现过程中曾用它抓出一次
 *          θ 符号写反，见 precessionMatrix 注释）。
 *  - 大气折射：Bennett(1982) 经验式，Meeus 第 16 章 (16.4)。**地平附近给约 29′，
 *          而标准天文年历取 34′**，因此本引擎的日出日落比年历早/晚约 0.5 分钟。
 *          selfTest 如实报告该差值，不假装两者一致。
 */
(function (global) {
  'use strict';

  /* =============================================================== 0. 工具 */
  var PI = Math.PI, D2R = PI / 180, R2D = 180 / PI, ARCSEC_PER_DEG = 3600;
  var J2000 = 2451545.0;                 // 2000-01-01 12:00 TT ≈ JD 2451545.0（Meeus 第 12 章）
  var GREGORIAN_JD = 2299160.5;          // 1582-10-15 00:00 UT：格里高利历起点
  var SIDEREAL_RATE = 360.98564736629;   // 度/太阳日：GMST 对 UT 的一次项系数（IAU-1982）
  var EARTH_RADIUS_KM = 6371.0;          // 平均半径（折射/地平视差用）
  var SUN_SD_MEAN = 0.26667;             // 太阳平均视半径 16′
  var MAX_JD_SPAN = 3.6525e7;            // |jd−J2000| 上限 = 10 万年；超出即拒绝（截断多项式在此范围外无意义，且会溢出）

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrap360(a) { if (!isNum(a)) return null; var x = a % 360; return x < 0 ? x + 360 : x; }
  function wrap180(a) { if (!isNum(a)) return null; var x = wrap360(a); return x > 180 ? x - 360 : x; }
  function wrap2pi(a) { a = a % (2 * PI); return a < 0 ? a + 2 * PI : a; }
  function err(code, msg) { var o = { error: code, message: msg || code, nan_free: true }; return o; }
  // 对外版 clamp：内部 clamp 是热路径快版（假定入参已校验），直接把它导出会把 NaN
  // 原样吐回去（clamp(NaN,1,2)=NaN），违反「公开函数不返回非有限数」的契约。
  function clampSafe(v, lo, hi) {
    var x = num(v), a = num(lo), b = num(hi);
    if (x == null || a == null || b == null || a > b) return null;
    return x < a ? a : (x > b ? b : x);
  }
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null || typeof v === 'boolean') return null;
    var s = String(v).replace(/[^0-9eE.+-]/g, '');
    if (!/[-+]?\d/.test(s)) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function deg2hms(d) {
    if (!isNum(d)) return null;
    var t = wrap360(d) / 15, h = Math.floor(t), m = Math.floor((t - h) * 60), s = (t * 60 - h * 60 - m) * 60;
    return { h: h, m: m, s: s, text: h + 'h' + m + 'm' + s.toFixed(2) + 's', hours: t };
  }
  function jdToDateText(jd) {
    var d = dateFromJd(jd);
    return d && !d.error ? d.iso : 'n/a';
  }

  /* =============================================== 0b. 可选 GEOGEO 依赖与退化 */
  function gg() { return global.GEOGEO || globalThis.GEOGEO || null; }
  // 大地线距离（米）：有 GEOGEO 用椭球反算，否则退化为球面 Haversine（R=6371008.7714）
  function geodesicMeters(lat1, lon1, lat2, lon2) {
    var a = num(lat1), b = num(lon1), c = num(lat2), d = num(lon2);
    if (a == null || b == null || c == null || d == null) return err('bad_coord', '经纬度必须是有限数');
    if (a < -90 || a > 90 || c < -90 || c > 90 || b < -180 || b > 180 || d < -180 || d > 180) return err('bad_range', '纬度须在 ±90，经度须在 ±180');
    var G = gg();
    if (G && typeof G.inverse === 'function') {
      try {
        var r = G.inverse(a, b, c, d, 'WGS84');
        if (r && isNum(r.distance_m)) return { m: r.distance_m, impl: 'GEOGEO.inverse(WGS84)' };
      } catch (e) { /* 退化，不外抛 */ }
    }
    var R = 6371008.7714, p1 = a * D2R, p2 = c * D2R;
    var ha = Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin((d - b) * D2R / 2), 2);
    return { m: 2 * R * Math.asin(clamp(Math.sqrt(ha), 0, 1)), impl: '内部球面 Haversine（GEOGEO 不可用）' };
  }
  function metersPerDegreeFallback(lat) {
    var a = num(lat);
    if (a == null) return err('bad_coord', '纬度必须是有限数');
    var G = gg();
    if (G && typeof G.metersPerDegree === 'function') {
      try { var m = G.metersPerDegree(a, 'WGS84'); if (m && isNum(m.lat_m)) return m; } catch (e) { /* noop */ }
    }
    return { lat_m: 111194.93, lon_m: 111319.4908 * Math.cos(clamp(a, -90, 90) * D2R), impl: 'sphere' };
  }

  /* ========================================================= 1. 时间基准 */
  // Meeus 第 7 章：儒略日序号（格里高利历式，含 100/400 世纪修正 B）
  function jdFromParts(y, mo, d, h, tzOffsetHours) {
    var Y = num(y), M = num(mo), D = num(d);
    if (Y == null || M == null || D == null || Y < -9999 || Y > 999999 || M < 1 || M > 12 || D < 1 || D > 31) return err('bad_date', '日期字段非法');
    var hh = num(h); var frac = hh == null ? 0 : hh / 24;
    if (hh != null && (hh < -12 || hh > 36)) return err('bad_hour', '小时非法');
    if (D > 28) {
      var dim = [31, (isLeap(Y) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][M - 1];
      if (D > dim) return err('bad_day', y + '-' + mo + ' 没有第 ' + D + ' 日');
    }
    var tz = num(tzOffsetHours); if (tz == null) tz = 0;
    var dUT = D - tz / 24 + frac;
    var yy = Y, mm = M;
    if (mm <= 2) { yy -= 1; mm += 12; }
    var A = Math.floor(yy / 100), B = 2 - A + Math.floor(A / 4);
    var jd = Math.floor(365.25 * (yy + 4716)) + Math.floor(30.6001 * (mm + 1)) + dUT + B - 1524.5;
    if (jd < GREGORIAN_JD) return err('pre_gregorian', '格里高利历 1582-10-15 之前不处理（本引擎不做儒略历换算，见文件头注释）');
    return { jd: jd, mjd: jd - 2400000.5 };
  }
  function isLeap(y) { y = num(y); if (y == null) return false; return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function mjdFromParts(y, mo, d, h) { var r = jdFromParts(y, mo, d, h); return r.error ? r : { mjd: r.mjd, jd: r.jd }; }

  // JD → 儒略世纪（所有三角级数的自变量）。集中做范围校验：
  // 超出 ±10 万年直接给 error，避免任何「T³/T⁴ 项溢出成 Infinity 再泄漏到字段」的情况。
  function tOf(jdUt) {
    var v = num(jdUt); if (v == null) return err('bad_jd', 'JD 非有限数');
    var d = v - J2000;
    if (Math.abs(d) > MAX_JD_SPAN) return err('out_of_range', 'JD 超出适用范围（|jd−J2000| ≤ ' + MAX_JD_SPAN + ' 日 ≈ ±10 万年）');
    return { jd: v, d: d, t: d / 36525 };
  }

  // JD → 格里高利历日期。
  // 诚实说明：**不采用**记忆中的 Meeus 第 7 章闭式逆变换。实现初版用它时，
  // 2451545.0 被解成 2001-01-02（A 步的 floor(α−α/4) 被我写成 α−floor(α/4)，差 1 日，
  // 进而 C/年份又差 1 年），而**正算**式已被 JD 锚点、世纪规则、闰日三条独立断言验证。
  // 故改为「用已验证的正算做定界与查表」：与 jdFromParts 严格互逆
  // （selfTest 的 12 历元往返即为此证明），不引入任何新的记忆公式。
  function jdOfPartsSafe(y, mo, d) { var r = jdFromParts(y, mo, d, 0); return r.error ? null : r.jd; }
  function dateFromJd(jd) {
    var v = num(jd);
    if (v == null) return err('bad_jd', 'JD 非有限数');
    if (v < GREGORIAN_JD) return err('pre_gregorian', '早于格里高利历起点 1582-10-15');
    var maxJd = jdOfPartsSafe(999998, 12, 31);
    if (maxJd == null || v > maxJd + 1) return err('out_of_range', 'JD 超出支持范围（>999999 年）');
    var span = Math.max(1, Math.floor((v - GREGORIAN_JD) / 365.2425));
    var lo = Math.max(1582, 1582 + span - 4), hi = lo + 8, n = 0;
    while (n++ < 500) { var jh = jdOfPartsSafe(hi, 1, 1); if (jh == null || jh > v) break; lo = hi; hi = hi + Math.max(1, hi - lo); }
    while (n++ < 1000) { var jl0 = jdOfPartsSafe(lo, 1, 1); if (jl0 == null || jl0 <= v) break; hi = lo; lo = Math.max(1582, lo - Math.max(1, hi - lo)); if (lo === 1582) { lo = 1582; break; } }
    while (hi - lo > 1) { var mid = Math.floor((lo + hi) / 2); var jm = jdOfPartsSafe(mid, 1, 1); if (jm != null && jm <= v) lo = mid; else hi = mid; }
    var year = lo;
    // 月份：取「下一个月初 JD 首次大于 v」的那个月。1582 年 1—9 月（以及 10 月 1—14 日）
    // 在格里高利历里不可表示，jdOfPartsSafe 返回 null，必须跳过而不是失败。
    var month = 0;
    for (var m = 1; m <= 12; m++) {
      var b = m < 12 ? jdOfPartsSafe(year, m + 1, 1) : jdOfPartsSafe(year + 1, 1, 1);
      if (b == null) continue;
      if (v < b) { month = m; break; }
    }
    if (!month) return err('bad_jd', '月份定位失败');
    // 日：jdFromParts(y,m,d,0) 给出的是**精确**的「.5」日首 JD（整数 −0.5，双精度可精确
    // 表示到 1e8 量级），故反查只需在当月 1…dim 里找相等的那一个 —— 不用任何记忆中的
    // 逆变换式，也不会出现「2001-01-02」这类 off-by-one（初版正是此处 + 显示截尾
    // 造成 05:29:60 的非法 ISO）。
    var dayStart = Math.floor(v - 0.5) + 0.5;
    var dim = [31, (isLeap(year) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    var day = 0;
    for (var d0 = 1; d0 <= dim; d0++) { if (jdOfPartsSafe(year, month, d0) === dayStart) { day = d0; break; } }
    if (!day) return err('pre_gregorian', 'JD ' + v + ' 落在格里高利历 1582-10-15 之前的不可表示日期');
    var hours = (v - dayStart) * 24;
    var sec = clamp(hours * 3600, 0, 86399.9999);          // dayStart 精确后 sec∈[0,86400)，截尾仅为显示
    var hh = Math.floor(sec / 3600), mi = Math.floor((sec - hh * 3600) / 60);
    var ss = sec - hh * 3600 - mi * 60;
    var ssTxt = ss.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    if (ss < 10) ssTxt = '0' + ssTxt;
    var iso = pad(year, 4) + '-' + pad(month, 2) + '-' + pad(day, 2) + 'T' + pad(hh, 2) + ':' + pad(mi, 2) + ':' + ssTxt + 'Z';
    return { year: year, month: month, day: day, hour: hours, iso: iso, jd: v, mjd: v - 2400000.5, day_start_jd: dayStart };
  }
  function pad(n, w) { n = String(Math.floor(n)); while (n.length < w) n = '0' + n; return n; }

  // ISO8601 解析：支持 Z / ±hh:mm / ±hhmm / 无时区（按 tzOffsetHours 或本地时区）
  function parseTime(input, opts) {
    opts = opts || {};
    var tzOpt = num(opts.tzOffsetHours);
    if (input == null) return err('bad_input', '缺少时间输入');
    if (isNum(input)) return { jd: input, tz_offset_hours: tzOpt == null ? 0 : tzOpt, tz_source: 'numeric_jd' };
    if (typeof input === 'object') {
      if (isNum(input.jd)) return { jd: input.jd, tz_offset_hours: tzOpt == null ? 0 : tzOpt, tz_source: 'object_jd' };
      if (input instanceof Date && !isNaN(input.getTime())) {
        var p = jdFromParts(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate(),
          input.getUTCHours() + input.getUTCMinutes() / 60 + input.getUTCSeconds() / 3600 + input.getUTCMilliseconds() / 3600000);
        return p.error ? p : { jd: p.jd, tz_offset_hours: 0, tz_source: 'Date(UTC)' };
      }
      var yy = num(input.year != null ? input.year : input.y);
      var mo = num(input.month != null ? input.month : input.mo);
      var dd = num(input.day != null ? input.day : input.d);
      var hval = num(input.hour != null ? input.hour : input.h);
      var min = num(input.minute != null ? input.minute : input.mi); if (min == null) min = 0;
      var sec = num(input.second != null ? input.second : input.s); if (sec == null) sec = 0;
      if (yy == null || mo == null || dd == null) return err('bad_input', '缺 year/month/day');
      var tz2 = num(input.tzOffsetHours); if (tz2 == null) tz2 = tzOpt; if (tz2 == null) tz2 = 0;
      var hr = (hval == null ? 0 : hval) + min / 60 + sec / 3600;
      var r = jdFromParts(yy, mo, dd, hr, tz2);
      return r.error ? r : { jd: r.jd, tz_offset_hours: tz2, tz_source: 'parts' };
    }
    var s = String(input).trim();
    if (!s) return err('bad_input', '空字符串');
    var m = /^(\d{4,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:?\d{2}|[+-]\d{2}|[+-]\d{4})?)?$/i.exec(s);
    if (!m) return err('unparsed', '无法解析时间串（仅支持 ISO8601 子集）');
    var off = 0, src = 'none';
    // 分组：1 年 2 月 3 日 4 时 5 分 6 秒 7 时区。实现初版把时区读成 m[6]（秒组），
    // 导致「14:00:00+02:00」的 +02:00 被当成秒丢掉（同一时刻不同偏移给出不同 JD）。
    if (m[7]) {
      if (m[7].toUpperCase() === 'Z') { off = 0; src = 'Z'; }
      else {
        var sign = m[7].charAt(0) === '-' ? -1 : 1, dig = m[7].slice(1).replace(':', '');
        var oh = parseInt(dig.length <= 2 ? dig : dig.slice(0, dig.length - 2), 10);
        var om = dig.length <= 2 ? 0 : parseInt(dig.slice(-2), 10);
        if (!isFinite(oh) || oh > 24 || om > 59) return err('bad_tz', '时区偏移非法');
        off = sign * (oh + om / 60); src = 'iso_offset';
      }
    } else if (tzOpt != null) { off = tzOpt; src = 'opts'; }
    else if (typeof global.Date === 'function') { off = -new Date(2000, 0, 1).getTimezoneOffset() / 60; src = 'local'; }
    var h = num(m[4]); if (h == null) h = 0;
    var mi = num(m[5]); if (mi == null) mi = 0;
    var se = num(m[6]); if (se == null) se = 0;
    if (h > 24 || mi > 59 || se > 61.999) return err('bad_time', '时分秒非法');
    var r2 = jdFromParts(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), h + mi / 60 + se / 3600, off);
    return r2.error ? r2 : { jd: r2.jd, tz_offset_hours: off, tz_source: src };
  }

  // 时间尺度：明确「不含闰秒/不含 ΔT」，供 UI 展示不确定性
  function timeSystems(input, opts) {
    var p = parseTime(input, opts); if (p.error) return p;
    var jd = p.jd, T = (jd - J2000) / 36525;
    return {
      jd_ut: jd, mjd_ut: jd - 2400000.5, t_centuries: T,
      tt_note: '未加 ΔT(TT−UT)：本引擎在 UTC/UT 尺度计算；TT 近似取 UT（差约 69 s 未建模）',
      leap_second_note: '未建模闰秒，不做 TAI 换算',
      ut1_utc_note: '假定 UT1=UTC；实际 |UT1−UTC|≤0.9 s → GMST 误差 ≤13.5″（≈ ±410 m 经度）',
      ut1_utc_bound_s: 0.9, gmst_max_error_arcsec: 13.5,
      tz_offset_hours: p.tz_offset_hours, tz_source: p.tz_source
    };
  }

  /* ============================================================= 2. 恒星时 */
  function gmst(jdUt) {
    var tt = tOf(jdUt); if (tt.error) return tt;
    var d = tt.d, T = tt.t;
    // Meeus 第 12 章 (12.4)，IAU-1982/2000：θ = 280°.46061837 + 360°.98564736629*d
    //                                  + 0°.000387933*T² − T³/38710000
    var th = 280.46061837 + SIDEREAL_RATE * d + 0.000387933 * T * T - T * T * T / 38710000;
    // 精度说明：|d| 大时 θ 的量级为 360.99·|d|，双精度只能保证 ~1e-9·θ 的相对位；
    // 在 |d| = 3.7e7 日（10 万年）处 ulp ≈ 0.004° ≈ 15″，超出该范围由 tOf 直接拒绝。
    if (!isNum(th)) return err('overflow', 'GMST 数值溢出');
    var w = wrap360(th); if (w == null) return err('overflow', 'GMST 卷绕失败');
    return { deg: w, deg_raw: th, hours: w / 15, hms: deg2hms(w), jd: tt.jd, t: T };
  }
  function eop(jdUt) {
    var tt = tOf(jdUt); if (tt.error) return tt;
    var T = tt.t;
    var psi = 125.04452 - 1934.136261 * T + 0.0020708 * T * T + T * T * T / 467441; // 升交点黄经 Ω（Meeus 22.2）
    var Ls = 280.4665 + 36000.7698 * T;   // 太阳平黄经 λ⊙（Meeus 22.3 用）
    var Lm = 218.3165 + 481267.8813 * T;  // 月球平黄经 λ′（Meeus 22.3 用）
    // Δψ 主三项（Meeus 22.3 全表 22 项，此处仅留主项，单位角秒）：
    var dpsi = -17.20 * Math.sin(psi * D2R) - 1.32 * Math.sin(2 * Ls * D2R)
      - 0.23 * Math.sin(2 * Lm * D2R) + 0.21 * Math.sin(2 * psi * D2R);
    var deps = 9.20 * Math.cos(psi * D2R) + 0.57 * Math.cos(2 * Ls * D2R) + 0.10 * Math.cos(2 * Lm * D2R) - 0.09 * Math.cos(2 * psi * D2R);
    var eps0 = meanObliquity(T);
    if (!isNum(eps0)) return err('bad_t', '历元超出黄赤交角多项式适用范围');
    return {
      jd: tt.jd,
      omega_deg: psi, dpsi_arcsec: dpsi, deps_arcsec: deps,
      mean_obliquity_deg: eps0, true_obliquity_deg: eps0 + deps / 3600,
      equation_of_equinoxes_deg: (dpsi * Math.cos(eps0 * D2R)) / 3600,
      nutation_note: '章动取 Meeus 第 22 章主 4/4 项（省略 18 项），Δψ 截断误差 ~0.3″，等分点改正 ~0.3″ ≈ 0.02″ 时角级；本引擎精度定级：GMST 视位置 ~0.4″。'
    };
  }
  // Meeus 第 22 章 (22.2)：ε0 = 23°26′21″.448 − 46″.8150T − 0″.00059T² + 0″.001813T³
  function meanObliquity(T) {
    var t = num(T); if (t == null) return err('bad_t', 'T 非有限数');
    // 护栏与 tOf/sunElements/moonElements 一致：|T| ≤ 1000 世纪（±10 万年）
    if (Math.abs(t) > 1000) return err('out_of_range', '|T| > 1000 世纪：ε0 多项式外推无效');
    var v = 23.439291111111 - (46.8150 * t - 0.00059 * t * t + 0.001813 * t * t * t) / 3600;
    return isNum(v) ? v : err('overflow', 'ε0 溢出');
  }

  /* ================================================ 3. 坐标变换 / 折射 */
  // 黄道→赤道：绕共同 x̂（春分点）旋转 +ε。约定由 selfTest 的独立映射校验：
  //   北黄极 (β=90°) → (RA=270°, δ=90°−ε)；夏至点 (λ=90°,β=0) → (RA=90°, δ=+ε)；
  //   冬至点 (λ=270°) → (RA=270°, δ=−ε)。注意北黄极赤纬是 90−ε 而不是 ε
  //   （实现初版把这条期望记错，改正后本注释即为准）。
  function eclToEqu(lamDeg, betDeg, epsDeg) {
    var l = num(lamDeg), b = num(betDeg), e = num(epsDeg);
    if (l == null || b == null || e == null) return err('bad_angle', '角度非法');
    var lr = l * D2R, br = b * D2R, er = e * D2R;
    var x = Math.cos(br) * Math.cos(lr);
    var y = Math.cos(br) * Math.sin(lr) * Math.cos(er) - Math.sin(br) * Math.sin(er);
    var z = Math.cos(br) * Math.sin(lr) * Math.sin(er) + Math.sin(br) * Math.cos(er);
    return { ra_deg: wrap360(Math.atan2(y, x) * R2D), dec_deg: Math.asin(clamp(z, -1, 1)) * R2D, x: x, y: y, z: z };
  }
  function equToEcl(raDeg, decDeg, epsDeg) {
    var a = num(raDeg), d = num(decDeg), e = num(epsDeg);
    if (a == null || d == null || e == null) return err('bad_angle', '角度非法');
    var ar = a * D2R, dr = d * D2R, er = e * D2R;
    var x = Math.cos(dr) * Math.cos(ar);
    var y = Math.cos(dr) * Math.sin(ar) * Math.cos(er) + Math.sin(dr) * Math.sin(er);
    var z = -Math.cos(dr) * Math.sin(ar) * Math.sin(er) + Math.sin(dr) * Math.cos(er);
    return { lon_deg: wrap360(Math.atan2(y, x) * R2D), lat_deg: Math.asin(clamp(z, -1, 1)) * R2D, x: x, y: y, z: z };
  }
  // 赤道→地平（方位角自真北起顺时针，与 GEOGEO.initial_bearing 同约定）
  function equToHor(raDeg, decDeg, latDeg, lstDeg) {
    var a = num(raDeg), d = num(decDeg), p = num(latDeg), t0 = num(lstDeg);
    if (a == null || d == null || p == null || t0 == null) return err('bad_angle', '角度非法');
    if (Math.abs(p) > 90 + 1e-9) return err('bad_lat', '纬度超出 ±90');
    var H = wrap180(t0 - a) * D2R, ph = clamp(p, -90, 90) * D2R, de = clamp(d, -90, 90) * D2R;
    var sh = Math.sin(ph) * Math.sin(de) + Math.cos(ph) * Math.cos(de) * Math.cos(H);
    var alt = Math.asin(clamp(sh, -1, 1)) * R2D;
    // 方位角必须用**未乘 cosφ 的一对水平分量**做 atan2：
    //   东分量 E = −sinH·cosδ，北分量 N = sinδ·cosφ − cosδ·sinφ·cosH，A = atan2(E, N)。
    // 实现初版写的 (sinδ − sinφ·sinh) 其实等于 cosφ·N（把 sin h 展开即可验证），
    // 于是 atan2(E, cosφ·N) 只在 φ=0 时正确——这是被「卯酉圈方位=90°/270°」与
    // 「±45° 同经度过中天方位差=180°」两条独立断言抓出来的。
    var azE = -Math.sin(H) * Math.cos(de);
    var azN = Math.sin(de) * Math.cos(ph) - Math.cos(de) * Math.sin(ph) * Math.cos(H);
    var az = wrap360(Math.atan2(azE, azN) * R2D);
    var Hh = wrap180(t0 - a);
    return { alt_deg: alt, az_deg: az, ha_deg: Hh, ha_hours: Hh / 15, zenith_dist_deg: 90 - alt };
  }
  // 地平→赤道（折射改正后的反算；φ=±90° 时方位圈与时角圈重合，退化，直接给 error）
  function horToEqu(altDeg, azDeg, latDeg, lstDeg) {
    var h = num(altDeg), A = num(azDeg), p = num(latDeg), t0 = num(lstDeg);
    if (h == null || A == null || p == null || t0 == null) return err('bad_angle', '角度非法');
    if (Math.abs(p) > 90 + 1e-9) return err('bad_lat', '纬度超出 ±90');
    var hr = clamp(h, -90, 90) * D2R, Ar = A * D2R, ph = clamp(p, -90, 90) * D2R;
    var cph = Math.cos(ph);
    if (Math.abs(cph) < 1e-12) return err('degenerate_pole', '纬度 ±90° 时「方位角↔时角」不定（天顶即天极，方位圈与时角圈重合）');
    var sd = Math.sin(ph) * Math.sin(hr) + cph * Math.cos(hr) * Math.cos(Ar);   // = sin δ
    var dec = Math.asin(clamp(sd, -1, 1)) * R2D;
    // 时角反解用「天顶/北/东三分量」的严格关系（自 d = cos h(sinA·Ê + cosA·Ñ) + sin h·Ẑ
    // 与 d = 赤道基展开对比系数）：
    //   cosδ·sinH = −cos h·sinA          （东分量，H 向西为正 ⇒ 东分量为负）
    //   cosδ·cosH = (sin h − sinφ·sinδ)/cosφ   （由 Ẑ 分量 sinh=sinφsinδ+cosφcosδcosH 移项）
    // 分母那个 cosφ 是**不能省的**：少了它 atan2 得到的是被压扁的角，只在 φ=0 才对。
    var yH = -Math.sin(Ar) * Math.cos(hr);                       // = cosδ·sinH
    var xH = (Math.sin(hr) - Math.sin(ph) * sd) / cph;           // = cosδ·cosH
    var H = Math.atan2(yH, xH) * R2D;
    return { dec_deg: dec, ra_deg: wrap360(t0 - H), ha_deg: wrap180(-H) };
  }
  // Bennett(1982) 经验折射式，Meeus 第 16 章 (16.4)：R(角分) = 1.02/tan(h + 10.3/(h+5.11))
  function refraction(altDeg, opts) {
    opts = opts || {};
    var h = num(altDeg); if (h == null) return err('bad_angle', '高度非法');
    var P = num(opts.pressure_mb); if (P == null) P = 1010;
    var tC = num(opts.temp_c); if (tC == null) tC = 10;
    if (h < -1) h = -1;                       // 地平以下按地平值截断（经验式不外推）
    var arg = h + 10.3 / (h + 5.11);
    if (h <= -0.55 || arg <= 0.05 || Math.abs(h + 5.11) < 1e-9) {
      return { arcmin: 28.98, deg: 28.98 / 60, formula: 'Bennett(1982) 地平值截断', note: '低于地平 33′ 时公式发散，取 R(0°)=28.98′' };
    }
    var R = 1.02 / Math.tan(clamp(arg, 0.01, 90) * D2R) * (P / 1010) * (283 / (273 + tC));
    if (!isFinite(R)) R = 28.98;
    return { arcmin: clamp(R, 0, 60), deg: clamp(R, 0, 60) / 60, formula: 'Bennett(1982)/Meeus 16.4（经验式，h≈0 给 28.98′，天文年历标准取 34′）' };
  }
  // 几何高度 ↔ 视高度：视高度 = 几何高度 + R
  function apparentFromGeo(geoAlt, opts) {
    var g = num(geoAlt); if (g == null) return err('bad_angle', '高度非法');
    // R 定义在「视高度」上，此处用一次迭代逼近（收敛到 <0.01′）
    var a = g;
    for (var i = 0; i < 3; i++) { var r = refraction(a, opts); a = g + (r.deg || 0); }
    return a;
  }
  function geoFromApparent(appAlt, opts) {
    var a = num(appAlt); if (a == null) return err('bad_angle', '高度非法');
    var g = a;
    for (var i = 0; i < 4; i++) { var r = refraction(g, opts); g = a - (r.deg || 0); }
    return g;
  }

  /* ================================================================ 4. 太阳 */
  // Meeus 第 25 章：地球轨道根数（T = 儒略世纪，UT/TT 混用见文件头）
  function sunElements(T) {
    var t = num(T); if (t == null) return err('bad_t', 'T 非法');
    // 范围护栏：|T|>1000 世纪（=±10 万年，与 tOf 的上限一致）时 36000.77·T 会溢出成
    // Infinity 并从字段里泄漏 NaN/Inf（selfTest 的垃圾输入断言抓到过）。
    if (Math.abs(t) > 1000) return err('out_of_range', 'T 超出适用范围（|T| ≤ 1000 世纪）');
    return {
      L0: 280.4664567 + 36000.76853 * t + 0.030322222222 * t * t + t * t * t / 49931114,   // 平黄经 °
      M: 357.5291092 + 35999.0502909 * t - 0.0001536 * t * t + t * t * t / 149512238,      // 平近点角 °
      e: 0.016708617 - 0.000042037 * t - 0.0000001235 * t * t,                              // 离心率
      omega: 83.35287 + 406.801332 * t + 0.012854 * t * t - 0.0000491 * t * t * t + t * t * t * t / 2553199  // 近日点黄经 °
    };
  }
  function sunTrueAnomalyRad(Mdeg, e) {
    var t = num(Mdeg); if (t == null || !isNum(e)) return err('bad_t', 'M/e 非法');
    // 椭圆轨道要求 |e|<1；否则 √(1−e) 在 tan(ν/2) 那一步变 NaN（垃圾输入断言抓到过）
    if (Math.abs(e) >= 1) return err('bad_ecc', '离心率必须满足 |e| < 1，实得 ' + e);
    if (Math.abs(t) > 1e12) return err('bad_angle', '平近点角量级过大，卷绕后无意义：' + t);
    var M = wrap2pi(t * D2R), E = M + e * Math.sin(M), d = 10;
    for (var i = 0; i < 60 && Math.abs(d) > 1e-14; i++) {
      d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d;
    }
    var nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    return { nu: nu, E: E, M: M, equation_of_center: nu - M };
  }
  // 太阳地心视位置（含章动、光行差、周年像差）
  function sunApparent(jdUt) {
    var p = parseTime(jdUt); if (p.error) return p;
    var tt = tOf(p.jd); if (tt.error) return tt;
    var jd = tt.jd, T = tt.t;
    var el = sunElements(T); if (el.error) return el;
    var nu = sunTrueAnomalyRad(el.M, el.e); if (nu.error) return nu;
    var lamTrue = wrap360(el.L0 + nu.equation_of_center * R2D);   // λ⊙(真) = L0 + (ν − M)
    var R = (1 - el.e * el.e) / (1 + el.e * Math.cos(nu.nu));         // 日地距离 AU
    var n = eop(jd); if (n.error) return n;
    var omegaDeg = n.omega_deg;                   // 升交点黄经（度）
    var lamApp = lamTrue + n.dpsi_arcsec / 3600 - 0.00569 - 0.00478 * Math.sin(omegaDeg * D2R); // 章动+光行差+周年像差
    var eq = eclToEqu(lamApp, 0, n.true_obliquity_deg); if (eq.error) return eq;
    var parallax = 8.794 / 3600 / R;                                  // 周年视差（地平视差 8.794″/R）
    return {
      jd: jd, t: T, lon_true_deg: wrap360(lamTrue), lon_apparent_deg: wrap360(lamApp),
      lat_deg: 0, ra_deg: eq.ra_deg, dec_deg: eq.dec_deg, dist_au: R, radius_vector: R,
      eps_true_deg: n.true_obliquity_deg, eps_mean_deg: n.mean_obliquity_deg,
      nutation_lon_arcsec: n.dpsi_arcsec, eq_equinoxes_deg: n.equation_of_equinoxes_deg,
      semidiameter_deg: SUN_SD_MEAN / R, horizontal_parallax_arcsec: 8.794 / R,
      geo_center_km: R * 149597870.7, sub_point_parallax_shift_deg: parallax
    };
  }
  // 太阳地平坐标（含日面中心/上/下边缘高度与折射）
  function sunHorizon(jdUt, lat, lon, opts) {
    opts = opts || {};
    var s = sunApparent(jdUt); if (s.error) return s;
    var la = num(lat), lo = num(lon); if (la == null || lo == null) return err('bad_geo', '经纬度非法');
    if (Math.abs(la) > 90 + 1e-9) return err('bad_lat', '纬度超出 ±90');
    var g = gmst(s.jd); if (g.error) return g;
    var h = equToHor(s.ra_deg, s.dec_deg, clamp(la, -90, 90), g.deg + wrap180(lo)); if (h.error) return h;
    var sd = s.semidiameter_deg;
    var refr = opts.refraction === false ? { deg: 0 } : refraction(h.alt_deg, opts);
    var apparent = h.alt_deg + (refr.deg || 0);
    return {
      jd: s.jd, lat: la, lon: lo,
      alt_deg: h.alt_deg, az_deg: h.az_deg, ha_deg: h.ha_deg, ha_hours: h.ha_hours,
      refracted_alt_deg: apparent, refraction_arcmin: (refr.deg || 0) * 60,
      center_geo_alt: h.alt_deg, upper_limb_geo_alt: h.alt_deg + sd, lower_limb_geo_alt: h.alt_deg - sd,
      center_apparent_alt: apparent, upper_limb_apparent_alt: apparent + sd, lower_limb_apparent_alt: apparent - sd,
      semidiameter_deg: sd, zenith_dist_deg: 90 - h.alt_deg, sun_ra_deg: s.ra_deg, sun_dec_deg: s.dec_deg
    };
  }
  // 日下点（WGS84 经纬度）：纬度 = 太阳视赤纬，经度 = 太阳视赤经 − GMST
  function subSolarPoint(jdUt, opts) {
    opts = opts || {};
    var s = sunApparent(jdUt); if (s.error) return s;
    var g = gmst(s.jd); if (g.error) return g;
    var lon = wrap180(s.ra_deg - g.deg + (opts.longitude_correction_deg || 0));
    // 太阳地平视差 8.794″/Δ：日下点位移 ≤8.794″ ≈ 0.27 km，方向沿站心天顶，非纯纬度，故不改
    var bound = meanObliquity((s.jd - J2000) / 36525);
    return {
      lat: clamp(s.dec_deg, -90, 90), lon: lon, dec_deg: s.dec_deg, ra_deg: s.ra_deg,
      gmst_deg: g.deg, jd: s.jd, alt_at_subpoint: 90,
      declination_bound_deg: bound,
      within_tropics: Math.abs(s.dec_deg) <= bound + 1e-9,
      parallax_shift_arcsec: s.horizontal_parallax_arcsec,
      note: '纬度取太阳视赤纬（视差 ≤8.8″ ≈ 0.27 km 未计入方向分解）；经度 = RA−GMST（东正）。' +
        'UT1−UTC 未知 ±0.9 s → 经度 ±0.00375° ≈ ±410 m。',
      ut1_lon_error_m: 410
    };
  }

  /* ================================================ 5. 升落 / 中天（数值解算） */
  function findRoot(f, a, b, iters) {
    if (typeof f !== 'function') return { error: 'bad_func', message: 'f 必须是函数' };
    var fa = f(a), fb = f(b);
    if (!isNum(fa) || !isNum(fb)) return { error: 'bad_func', message: '端点非有限数' };
    if (fa === 0) return { root: a };
    if (fb === 0) return { root: b };
    if (fa * fb > 0) return { error: 'no_bracket', message: '区间内无变号' };
    var n = iters || 62, lo = a, hi = b, vlo = fa;
    for (var i = 0; i < n; i++) {
      var mid = 0.5 * (lo + hi), vm = f(mid);
      if (!isNum(vm)) return { error: 'bad_func', message: '中点非有限数' };
      if (vm === 0) return { root: mid };
      if (vlo * vm < 0) { hi = mid; } else { lo = mid; vlo = vm; }
    }
    return { root: 0.5 * (lo + hi), bracket_width: hi - lo };
  }
  // 通用「视高度=阈值」事件求解；alt 为日心/月心中心几何高度 + 折射，阈值以「视高度」给出
  function altitudeEvents(coordsFn, jdDayStart, lat, lon, thrApparentDeg, opts) {
    if (typeof coordsFn !== 'function') return err('bad_fn', 'coordsFn 必须是返回 {ra_deg,dec_deg} 的函数');
    opts = opts || {};
    var steps = opts.steps || 64, out = [], prevT = null, prevF = null;
    var span = opts.spanDays || 1.5;
    for (var i = 0; i <= steps; i++) {
      var t = jdDayStart + span * i / steps;
      var a = evalAlt(coordsFn, t, lat, lon, opts); if (a.error) return a;
      var f = a.apparent - thrApparentDeg;
      if (prevF != null && prevF * f < 0) {
        var r = findRoot(function (tt) { var x = evalAlt(coordsFn, tt, lat, lon, opts); return x.error ? NaN : x.apparent - thrApparentDeg; }, prevT, t, 62);
        if (r.root != null) out.push({ jd: r.root, direction: prevF < 0 ? 'up' : 'down' });
      }
      prevT = t; prevF = f;
    }
    return { events: out, min_alt: null, max_alt: null, samples: steps + 1 };
  }
  function evalAlt(coordsFn, t, lat, lon, opts) {
    var c = coordsFn(t); if (!c || typeof c !== 'object' || c.error) return err('bad_fn', 'coordsFn 返回值不是含 ra_deg/dec_deg 的对象');
    var g = gmst(t); if (g.error) return g;
    var h = equToHor(c.ra_deg, c.dec_deg, clamp(lat, -90, 90), g.deg + wrap180(lon)); if (h.error) return h;
    var refr = opts.refraction === false ? 0 : (refraction(h.alt_deg, opts).deg || 0);
    var sd = c.semidiameter_deg || 0;
    return { geo: h.alt_deg, apparent: h.alt_deg + refr, az: h.az_deg, limb_apparent: h.alt_deg + refr + sd };
  }
  // 中天（上/下）时刻：上中天 = 时角 H=0，下中天 = |H|=180。
  // 做法：网格上累加「连续时角」（对 ±180 卷绕去卷绕），再对 H−0 与 H−180 分别求根。
  function transitEvents(coordsFn, jdDayStart, lat, lon, opts) {
    if (typeof coordsFn !== 'function') return err('bad_fn', 'coordsFn 必须是返回 {ra_deg,dec_deg} 的函数');
    opts = opts || {};
    var span = opts.spanDays || 1.5, steps = opts.steps || 96;
    var ts = [], haC = [], prev = null, acc = 0, i;
    for (i = 0; i <= steps; i++) {
      var t = jdDayStart + span * i / steps;
      var c = coordsFn(t); if (!c || typeof c !== 'object' || c.error) return err('bad_fn', 'coordsFn 返回值不是含 ra_deg/dec_deg 的对象');
      var g = gmst(t); if (g.error) return g;
      var H = wrap180(g.deg + wrap180(lon) - c.ra_deg);
      if (prev != null) { var d = H - prev; if (d > 180) d -= 360; if (d < -180) d += 360; acc += d; }
      else acc = H;
      prev = H; ts.push(t); haC.push(acc);
    }
    function haAt(t) {
      var c = coordsFn(t); if (c.error) return NaN;
      var g = gmst(t); if (g.error) return NaN;
      var H = wrap180(g.deg + wrap180(lon) - c.ra_deg), k = 0, best = Infinity;
      for (var j = 0; j < ts.length; j++) { var dd = Math.abs(ts[j] - t); if (dd < best) { best = dd; k = j; } }
      return haC[k] + wrap180(H - haC[k]);   // 以最近网格点为基准展开，函数在该邻域内连续
    }
    // 上中天 = 连续时角等于 360° 的整数倍；下中天 = 180°+360° 的整数倍。
    // 实现初版只找「穿过 0」和「穿过 180」，而连续时角 haC 的起点是 jdDayStart 的
    // 卷绕值（可为正），一天内单调增加约 360°，于是常常穿过 360 而不是 0 —— 那条
    // 旧逻辑对「起算点在午夜前后」的站点直接找不到中天（被 6 站×6 月样本不足抓出）。
    function firstCross(level) {
      for (var i = 1; i <= steps; i++) {
        if (haC[i - 1] < level && haC[i] >= level) {
          var rr = findRoot(function (tt) { return haAt(tt) - level; }, ts[i - 1], ts[i], 70);
          return rr.root != null ? rr.root : null;
        }
      }
      return null;
    }
    var up = null, down = null, k;
    var kUp = Math.ceil(haC[0] / 360);
    for (k = kUp; k <= kUp + 2 && up == null; k++) up = firstCross(360 * k);
    var kDn = Math.ceil((haC[0] - 180) / 360);
    for (k = kDn; k <= kDn + 2 && down == null; k++) down = firstCross(180 + 360 * k);
    return { upper_transit_jd: up, lower_transit_jd: down, ha_series: haC, span_days: span };
  }
  // 日出日落 + 三类晨昏（民用 −6°、航海 −12°、天文 −18°，均按「视高度」定义）
  function sunEvents(jdDayStart, lat, lon, opts) {
    opts = opts || {};
    var sunFn = function (t) { return sunApparent(t); };
    // 阈值定义在「日面中心的视高度」上：上边缘恰落在地平线 ⇒ 中心视高度 = −日半径。
    // 折射由 evalAlt 自动叠加（视高度 = 几何高度 + R），所以 opts.refraction:false
    // 与 opts.semidiameter_deg:0 可以让本函数退回「纯几何点光源」的解析可验情形。
    // （实现初版把 −0.26667 写死、忽略 opts，导致「δ=0/h0=0 时赤道昼长应为 12 h」
    //   与「数值 vs 解析昼长」两条断言双双破掉；−0.26667 其实是半径+折射的合并值，
    //   写死它等于同时偷偷开了折射。）
    var sd = num(opts.semidiameter_deg); if (sd == null) sd = SUN_SD_MEAN;
    var thr = -sd;
    var geoThr = geoFromApparent(thr, opts);
    var res = { jd_day_start: jdDayStart, lat: lat, lon: lon, threshold_center_apparent_deg: thr };
    var rise = altitudeEvents(sunFn, jdDayStart, lat, lon, thr, opts); if (rise.error) return rise;
    var ev = rise.events;
    res.geometric_center_alt_at_event_deg = geoThr;
    res.sunrise_jd = null; res.sunset_jd = null;
    // 配对规则：取窗口内**第一个「升」**，再取其后**第一个「降」**。
    // 若 jdDayStart 落在白天中间（例如东经 120° 用 UT 起算），窗口里先出现的是前一天
    // 的日落，旧逻辑把 sunset−sunrise 配成跨日的两点，昼长会算出 24 h 级假值。
    for (var i = 0; i < ev.length; i++) {
      if (ev[i].direction !== 'up') continue;
      res.sunrise_jd = ev[i].jd;
      for (var j = i + 1; j < ev.length; j++) if (ev[j].direction === 'down') { res.sunset_jd = ev[j].jd; break; }
      break;
    }
    res.first_rise_jd = res.sunrise_jd; res.first_set_jd = res.sunset_jd;
    // 极昼极夜判定：用一天内最大/最小视高度
    var mn = Infinity, mx = -Infinity;
    for (var k = 0; k <= 24; k++) {
      var a = evalAlt(sunFn, jdDayStart + k / 24, lat, lon, opts); if (a.error) return a;
      if (a.apparent < mn) mn = a.apparent; if (a.apparent > mx) mx = a.apparent;
    }
    res.min_apparent_alt_deg = mn; res.max_apparent_alt_deg = mx;
    var below = 0, above = 0;
    for (var k2 = 0; k2 <= 240; k2++) { var a2 = evalAlt(sunFn, jdDayStart + k2 / 240, lat, lon, opts); if (a2.error) return a2; if (a2.apparent < thr) below++; else above++; }
    // 语义（与 moonEvents 统一）：no_rise / no_set 的字面含义是「这一天里该事件
    // 是否没有发生」。极昼与极夜都不产生升/落事件，故两个标记同为 true，
    // 靠 polar_state 区分；selfTest 的两条极区断言按此约定写。
    if (res.sunrise_jd == null && res.sunset_jd == null) {
      res.no_rise = true; res.no_set = true;
      if (above > below) { res.polar_state = 'polar_day'; res.day_length_h = 24; }
      else { res.polar_state = 'polar_night'; res.day_length_h = 0; }
      res.polar_note = '窗口内视高度始终在阈值同一侧（min=' + mn.toFixed(3) + '°、max=' + mx.toFixed(3) +
        '°、阈值=' + thr.toFixed(3) + '°）⇒ 无升/落事件';
    } else if (res.sunrise_jd == null) { res.no_rise = true; res.no_set = false; res.polar_state = 'partial'; res.day_length_h = null; }
    else if (res.sunset_jd == null) { res.no_set = true; res.no_rise = false; res.polar_state = 'partial'; res.day_length_h = null; }
    else { res.no_rise = false; res.no_set = false; res.polar_state = 'normal'; res.day_length_h = (res.sunset_jd - res.sunrise_jd) * 24; }
    // 晨昏蒙影
    res.twilight = {};
    [[-6, 'civil'], [-12, 'nautical'], [-18, 'astronomical']].forEach(function (p) {
      var r2 = altitudeEvents(sunFn, jdDayStart, lat, lon, p[0], opts); if (r2.error) { res.twilight[p[1]] = r2; return; }
      var d = null, n = null;
      r2.events.forEach(function (e) { if (e.direction === 'down' && d == null) d = e.jd; if (e.direction === 'up') n = e.jd; });
      var status = 'normal';
      var mn2 = Infinity;
      for (var q = 0; q <= 48; q++) { var aq = evalAlt(sunFn, jdDayStart + q / 48, lat, lon, opts); if (!aq.error) mn2 = Math.min(mn2, aq.apparent); }
      if (mn2 > p[0]) status = 'no_darkness';
      else if (n == null && d == null) status = (mn2 < p[0]) ? 'always_below' : 'no_twilight';
      res.twilight[p[1]] = { threshold_apparent_deg: p[0], evening_jd: d, morning_jd: n, status: status };
    });
    return res;
  }
  // 昼长/夜长的解析对照（用于 selfTest 独立校验：cosH0=(sinh−sinφsinδ)/(cosφcosδ)）
  function analyticDayLength(lat, dec, thrGeoDeg) {
    var p = num(lat), d = num(dec), h0 = num(thrGeoDeg);
    if (p == null || d == null || h0 == null) return err('bad_angle', '角度非法');
    if (Math.abs(p) > 90) return err('bad_lat', '纬度超出 ±90');
    var cH = (Math.sin(h0 * D2R) - Math.sin(p * D2R) * Math.sin(d * D2R)) / (Math.cos(p * D2R) * Math.cos(d * D2R));
    if (!isFinite(cH)) return err('bad_geo', '三角分母为零');
    if (cH > 1) return { no_rise: true, no_set: false, day_length_h: 0, H0_deg: null };
    if (cH < -1) return { no_set: true, no_rise: false, day_length_h: 24, H0_deg: null };
    var H0 = Math.acos(cH) * R2D;
    // 昼长（平太阳时小时）= 2·H0 / 时角日变化率；太阳时角平均变化率 = 360°/24h = 15°/h
    // （严格说应为 15.0410672°/h 的恒星时率扣除太阳赤经 0.9856°/d 的东进，得 14.0411 + 修正，
    //  在 δ=0 处恰为 15°/平太阳时；本函数用于 selfTest 与数值解对照，故取 15.0410672/1.0027379）
    return { H0_deg: H0, day_length_h: 2 * H0 / 15.0, day_length_sidereal_h: 2 * H0 / (SIDEREAL_RATE / 360 * 15) };
  }

  /* ================================================================ 6. 月亮 */
  /* 月球：Meeus 第 47 章（ELP2000）截断主项，参数用球面天文学标准记号**显式写出**
   * （M′=月球平近点角、D=平距角、F=辐角/升交点纬距、M=太阳平近点角）。
   * 之所以不直接抄 Meeus 表 47.A 的「四列索引」：该表列序（D,M,M′,F）与我记忆中的
   * 行数据无法通过「黄纬项必须含奇数次 F」这一对称性检验，说明我记的列序不可靠；
   * 因此这里只保留**能独立命名**的项，振幅取该表前导值（单位：度 / 千公里）。
   * 截断说明与量级（诚实）：省略的项振幅 ≤0.115°（黄经）、≤0.056°（黄纬）、
   * ≤30 km（距离），故黄经截断误差累积 ≤0.4°，**小于月球视直径 0.5°**。
   * 该误差使月下点位置可能有 ~40 km 量级的偏差；不用于月掩星/月龄精算。
   * 「−0.185 sin M」的符号取 Meeus 表约定，未经独立验证（影响 ≤0.19°，见 selfTest
   * 的振幅探针断言：它只能抓住系数互换/小数点错位，抓不住符号错误）。 */
  var MOON_TERMS_L = [
    { amp: 6.288774, arg: 'Mp' },        // 中心差（=2e′ 的一阶展开，见 selfTest）
    { amp: 1.274202, arg: '2D-Mp' },     // 周年差 evection
    { amp: 0.658314, arg: '2D' },        // 摆动 variation
    { amp: 0.213618, arg: '2F' },        // 黄纬相关项
    { amp: -0.185116, arg: 'M' }         // 太阳中心差耦合
  ];
  var MOON_TERMS_B = [
    { amp: 5.128122, arg: 'F' },
    { amp: 0.280602, arg: 'Mp+F' },
    { amp: 0.277693, arg: 'Mp-F' },
    { amp: 0.173237, arg: '2D-F' },
    { amp: 0.055412, arg: '2D-Mp+F' },
    { amp: 0.046292, arg: '2D+Mp-F' }
  ];
  /* 距离项单位=千米，逐条独立复核（见 selfTest 的「级数振幅探针」与「物理包络」）：
   * 初版写成 −209.053 / −369.911 / −56.993 / −29.559（比正确值小 100/10 倍），
   * 后果是月距恒定在 385000.56±0.6 km、地平视差恒等于 57.6″——而真月的近/远地点
   * 距离差约 4.2 万 km。主项 −20905.355 由「距离方程中心 = a·e」独立核验：
   * e 取自黄经主项 6.288774°=2e(rad) ⇒ e=0.054885 ⇒ a·e=21131 km（与 20905 差 1.1%，
   * 因 D0≠轨道半长轴）。−569.925 属 2F、−295.596 属 2D，与表内 '2F'/'2D' 的配对一致。 */
  var MOON_TERMS_R = [
    { amp: -20905.355, arg: 'Mp' },
    { amp: -3699.111, arg: '2D-Mp' },
    { amp: -569.925, arg: '2F' },
    { amp: -295.596, arg: '2D' },
    { amp: 48.888, arg: 'M' }
  ];
  var MOON_A_MEAN_KM = 385000.56;   // 平地月距离（Meeus 第 47 章 D0）
  function moonArg(name, e) {
    var Mp = e.Mp, D = e.D, F = e.F, M = e.M;
    switch (name) {
      case 'Mp': return Mp; case '2D-Mp': return 2 * D - Mp; case '2D': return 2 * D;
      case '2F': return 2 * F; case 'M': return M; case 'F': return F;
      case 'Mp+F': return Mp + F; case 'Mp-F': return Mp - F; case '2D-F': return 2 * D - F;
      case '2D-Mp+F': return 2 * D - Mp + F; case '2D+Mp-F': return 2 * D + Mp - F;
      default: return null;
    }
  }
  function moonElements(T) {
    var t = num(T); if (t == null) return err('bad_t', 'T 非法');
    if (Math.abs(t) > 1000) return err('out_of_range', 'T 超出适用范围（|T| ≤ 1000 世纪）');
    var t2 = t * t, t3 = t2 * t;
    var L = 218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841;   // 平黄经 °
    var D = 297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868;    // 平距角 °
    var M = 357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 149512238;  // 太阳平近点角 °
    var Mp = 134.9633964 + 477198.8675055 * t + 0.0087414 * t2 - t3 / 29369878; // 月球平近点角 °
    var F = 93.2720950 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526546;    // 辐角 °
    var om = 125.04452 - 1934.136261 * t + 0.0020708 * t2 + t3 / 467441;        // 升交点黄经 °
    return {
      L: wrap360(L), L_raw: L, D: wrap360(D), D_raw: D, M: wrap360(M), M_raw: M,
      Mp: wrap360(Mp), Mp_raw: Mp, F: wrap360(F), F_raw: F, omega: om,
      rate_per_day: 481267.88123421 / 36525,   // 月球平黄经日变化 = 13.176396°/d
      E: 1 - 0.002495 * t - 0.00000752 * t2,
      e_prime: 0.0548952                        // 月球轨道离心率（Meeus 第 47 章，与中心差振幅独立）
    };
  }
  function moonSeriesSum(tbl, el, fn) {
    var s = 0;
    for (var i = 0; i < tbl.length; i++) {
      var a = moonArg(tbl[i].arg, el); if (a == null) return null;
      s += tbl[i].amp * (fn ? fn(a * D2R) : Math.sin(a * D2R));
    }
    return s;
  }
  // 月球地心黄道坐标（真黄经含 +1°.3965T 黄道岁差项，Meeus 47.6）+ 赤道坐标
  function moonEcliptic(jdUt) {
    var p = parseTime(jdUt); if (p.error) return p;
    var tt = tOf(p.jd); if (tt.error) return tt;
    var T = tt.t, el = moonElements(T); if (el.error) return el;
    var dl = moonSeriesSum(MOON_TERMS_L, el); if (dl == null) return err('bad_series', '月项参数缺失');
    var db = moonSeriesSum(MOON_TERMS_B, el); if (db == null) return err('bad_series', '月项参数缺失');
    var dr = moonSeriesSum(MOON_TERMS_R, el, Math.cos); if (dr == null) return err('bad_series', '月项参数缺失');
    var lamTrue = wrap360(el.L + dl + 1.3965 * T);   // 含黄道岁差长期项
    var dist = MOON_A_MEAN_KM + dr;
    if (!isNum(lamTrue) || !isNum(db) || !isNum(dist) || dist <= 0) return err('bad_series', '月位数值非法');
    var ep = eop(p.jd); if (ep.error) return ep;
    var eq = eclToEqu(lamTrue, db, ep.true_obliquity_deg); if (eq.error) return eq;
    return {
      jd: p.jd, t: T, lon_deg: lamTrue, lat_deg: db, dist_km: dist,
      elements: el, sum_lon_deg: dl, sum_lat_deg: db, sum_dist_km: dr,
      ra_deg: eq.ra_deg, dec_deg: eq.dec_deg, eps_deg: ep.true_obliquity_deg,
      x: eq.x, y: eq.y, z: eq.z,
      parallax_arcsec: Math.asin(clamp(EARTH_RADIUS_KM / dist, -1, 1)) * R2D * 3600,
      semidiameter_deg: Math.asin(clamp(1737.4 / dist, -1, 1)) * R2D,
      horizontal_parallax_note: 'P=arcsin(R⊕/Δ)（球近似，未用 WGS84 a）'
    };
  }
  function moonPosition(jdUt, opts) {
    opts = opts || {};
    var m = moonEcliptic(jdUt); if (m.error) return m;
    return {
      jd: m.jd, ra_deg: m.ra_deg, dec_deg: m.dec_deg, lon_deg: m.lon_deg, lat_deg: m.lat_deg,
      dist_km: m.dist_km, parallax_arcsec: m.parallax_arcsec, semidiameter_deg: m.semidiameter_deg,
      eps_deg: m.eps_deg, elements: m.elements,
      apparent_note: opts.apparent === false ? '已跳过光行差/章动（主项 <1′，见文件头）' :
        '未叠加光行差(≈0.3′)/章动(≈0.3′)/视差；模型截断 0.4° 远大于这些项。'
    };
  }
  // 月下点：地心月赤纬→纬度、地心月赤经−GMST→经度（严格几何恒等，可用于抓坐标写反）
  function subLunarPoint(jdUt, opts) {
    opts = opts || {};
    var m = moonPosition(jdUt, opts); if (m.error) return m;
    var g = gmst(m.jd); if (g.error) return g;
    var lon = wrap180(m.ra_deg - g.deg);
    var shiftKm = (m.parallax_arcsec / 3600) * 111.194926 * 1000 / 1000;
    return {
      lat: clamp(m.dec_deg, -90, 90), lon: lon, dec_deg: m.dec_deg, ra_deg: m.ra_deg,
      gmst_deg: g.deg, dist_km: m.dist_km, parallax_arcsec: m.parallax_arcsec,
      parallax_shift_km_max: isNum(shiftKm) ? shiftKm : null,
      note: '地心月下点；对具体地面站还有 ≤' + (m.parallax_arcsec / 3600).toFixed(2) + '°（≈' +
        Math.round(m.parallax_arcsec / 3600 * 111.195) + ' km）地心视差位移，' +
        '另有模型截断 ±0.4°（≈44 km，见文件头）。'
    };
  }
  // 站心月球地平坐标（地心视差主项改正，Meeus 第 39 章线性式；精度与模型截断同量级）
  function topocentricMoon(jdUt, lat, lon, opts) {
    opts = opts || {};
    var m = moonPosition(jdUt); if (m.error) return m;
    var la = num(lat), lo = num(lon); if (la == null || lo == null) return err('bad_geo', '经纬度非法');
    if (Math.abs(la) > 90 + 1e-9) return err('bad_lat', '纬度超出 ±90');
    var g = gmst(m.jd); if (g.error) return g;
    var phi = clamp(la, -90, 90) * D2R, u = Math.atan(0.99325428 * Math.tan(phi));  // 约化纬度
    var H = (g.deg + wrap180(lo) - m.ra_deg) * D2R;
    var par = m.parallax_arcsec / 3600 * D2R;                                       // 地心视差角
    var sd = m.dec_deg * D2R;
    // Δδ ≈ −P⊕(cosφ′ sinδ − sinφ′ cosδ cosH) 的一阶式（赤经差 ≈ P⊕ cosφ′ sinH / cosδ）
    var dDec = -par * (Math.cos(u) * Math.sin(sd) - Math.sin(u) * Math.cos(sd) * Math.cos(H));
    var cosd = Math.max(Math.abs(Math.cos(sd)), 1e-3);
    var dRA = par * Math.cos(u) * Math.sin(H) / cosd;
    var raTopo = wrap360(m.ra_deg + dRA * R2D), decTopo = clamp(m.dec_deg + dDec * R2D, -90, 90);
    var h = equToHor(raTopo, decTopo, la, g.deg + wrap180(lo)); if (h.error) return h;
    var hg = equToHor(m.ra_deg, m.dec_deg, la, g.deg + wrap180(lo));
    var refr = refraction(h.alt_deg, opts);
    return {
      ra_deg: raTopo, dec_deg: decTopo, alt_deg: h.alt_deg, az_deg: h.az_deg, ha_deg: h.ha_deg,
      alt_deg_geocentric: hg.error ? null : hg.alt_deg,
      parallax_in_altitude_deg: hg.error ? null : h.alt_deg - hg.alt_deg,
      refracted_alt_deg: h.alt_deg + (refr.deg || 0),
      semidiameter_deg: m.semidiameter_deg, parallax_arcsec: m.parallax_arcsec,
      note: '视差改正为线性主项（站心距未重算），残差 ~0.1′；与 0.4° 模型截断相比可忽略。'
    };
  }
  // 月相：相位角 i（在月球处看地球与太阳的夹角）与照明分数 f=(1+cos i)/2（严格定义）
  function moonPhase(jdUt) {
    var m = moonPosition(jdUt); if (m.error) return m;
    var s = sunApparent(jdUt); if (s.error) return s;
    var um = unitFromEqu(m.ra_deg, m.dec_deg), us = unitFromEqu(s.ra_deg, s.dec_deg);
    if (!um || !us) return err('bad_vec', '方向向量非法');
    var cosE = clamp(um.x * us.x + um.y * us.y + um.z * us.z, -1, 1);
    var E = Math.acos(cosE) * R2D;                       // 地心距角（elongation）
    var rM = m.dist_km, rS = s.geo_center_km;
    if (!isNum(rM) || !isNum(rS) || rM <= 0 || rS <= 0) return err('bad_dist', '距离非法');
    var dMS2 = rM * rM + rS * rS - 2 * rM * rS * cosE;    // 月—日距离平方（余弦定理）
    if (dMS2 <= 0) return err('bad_dist', '三角退化');
    var dMS = Math.sqrt(dMS2);
    var cosI = clamp((rM * rM + dMS2 - rS * rS) / (2 * rM * dMS), -1, 1);  // 月球处夹角 i
    var i = Math.acos(cosI) * R2D;
    var f = (1 + cosI) / 2;                              // 严格式
    var fApprox = (1 - cosE) / 2;                        // 平行光线近似（差 ~rM/rS·sinE）
    var eLon = wrap360(m.lon_deg - s.lon_apparent_deg);
    return {
      jd: m.jd, phase_angle_deg: i, elongation_deg: E, illumination_fraction: f,
      illumination_parallel_approx: fApprox, approx_minus_exact: fApprox - f,
      ecliptic_elongation_deg: eLon, waxing: eLongIsWaning(eLon) === false,
      age_days_mean: eLon / (360 / 29.530588853),
      illum_formula: 'f=(1+cos i)/2，i 为月心相位角（严格三角，非近似）；朔 i≈180°→f≈0，望 i≈0°→f≈1',
      phase_name: phaseName(eLon)
    };
  }
  function eLongIsWaning(e) { return e > 180; }
  function phaseName(eLon) {
    if (!isNum(eLon)) return null;
    var a = [[0, 1.8, '朔'], [1.8, 88, '娥眉月'], [88, 92, '上弦'], [92, 178, '盈凸月'],
             [178, 182, '望'], [182, 268, '亏凸月'], [268, 272, '下弦'], [272, 358.2, '残月'], [358.2, 360, '朔']];
    for (var i = 0; i < a.length; i++) if (eLon >= a[i][0] && eLon < a[i][1]) return a[i][2];
    return '朔';
  }
  function unitFromEqu(raDeg, decDeg) {
    if (!isNum(raDeg) || !isNum(decDeg)) return null;
    var a = raDeg * D2R, d = clamp(decDeg, -90, 90) * D2R;
    return { x: Math.cos(d) * Math.cos(a), y: Math.cos(d) * Math.sin(a), z: Math.sin(d) };
  }
  function angleSepDeg(a1, d1, a2, d2) {
    if (!isNum(a1) || !isNum(d1) || !isNum(a2) || !isNum(d2)) return null;
    var c = Math.sin(d1 * D2R) * Math.sin(d2 * D2R) + Math.cos(d1 * D2R) * Math.cos(d2 * D2R) * Math.cos((a1 - a2) * D2R);
    return Math.acos(clamp(c, -1, 1)) * R2D;
  }
  // 月升/月落（同 sunEvents  machinery，阈值用「上边缘视高度 0」）
  function moonEvents(jdDayStart, lat, lon, opts) {
    opts = opts || {};
    var fn = function (t) {
      var m = moonPosition(t); if (m.error) return m;
      return { ra_deg: m.ra_deg, dec_deg: m.dec_deg, semidiameter_deg: m.semidiameter_deg };
    };
    var thr = -(opts.semidiameter_deg != null ? opts.semidiameter_deg : 0.26);
    var r = altitudeEvents(fn, jdDayStart, lat, lon, thr, opts); if (r.error) return r;
    var rise = null, set = null;
    r.events.forEach(function (e) { if (e.direction === 'up' && rise == null) rise = e.jd; if (e.direction === 'down' && set == null) set = e.jd; });
    var mn = Infinity, mx = -Infinity;
    for (var k = 0; k <= 48; k++) { var a = evalAlt(fn, jdDayStart + k / 48, lat, lon, opts); if (a.error) return a; mn = Math.min(mn, a.apparent); mx = Math.max(mx, a.apparent); }
    var out = { rise_jd: rise, set_jd: set, min_apparent_alt_deg: mn, max_apparent_alt_deg: mx, threshold_deg: thr };
    // 标记语义与 sunEvents 完全一致：no_rise/no_set = 「该事件在此窗口内没有发生」，
    // 始终在地平上（always_up）与始终在地平下都不产生升/落事件，故两个标记同为 true，
    // 由 polar_state 区分。
    if (rise == null && set == null) {
      out.no_rise = true; out.no_set = true;
      out.polar_state = mn > thr ? 'always_up' : (mx < thr ? 'always_down' : 'none');
    }
    else { out.no_rise = rise == null; out.no_set = set == null; out.polar_state = 'normal'; }
    return out;
  }

  /* 星表：46 颗导航/亮星。平位置纪元 = J2000.0，赤经/赤纬用「十进制度」。
     诚实标注（重要，UI 必须据此提示用户）：
      * 坐标与星等按公开亮星常识值写入，**离线无法逐条与外部星表核对**；自估
        位置误差 ±0.01°…±0.1°（个别项可能更差）。够用于「哪颗星可见、大致方位、
        罗盘级定向」，不够用于精密天文定位（角秒级）。
      * hip 只给出「凭记忆较有把握」的 20 余颗，并统一打 `hip_unverified = true`；
        其余为 null —— 与其写一个可能是错的编号，不如留空。selfTest 只验
        「数字/null、非零、彼此不重复、数量 ≥ 20」，不验正确性。
      * pm_ra / pm_dec 单位 mas/年，为记忆值，仅用于世纪级改正；其误差对导航
        用途（>0.05° 才谈得上）可忽略，对 <1′ 用途不可忽略。
      * 变星（Betelgeuse、Algol、Delta Cep 等）v 取常见极大值，实际会变。
     selfTest 里用「与记忆无关」的几何/次序关系兜底：星表结构完整、|δ|≤90、
     RA∈[0,360)、星等在 −2…6.6 物理区间、HIP 唯一；另用两条可独立推导的次序
     关系抓「抄串列」类错误：① α Cen(−0.01) 必须比 β Cen(0.61) 亮、且 α Cen 的
     RA(14h39m) 大于 β Cen(14h03m)；② 北斗七颗必须齐备且 δ 随斗柄→斗口单调变化
     区间合理。这些不能保证数值对，只能保证「不串位」。
     */
  var STAR_TABLE = [
    // —— 极区与拱极（罗盘定向主力） ——
    { hip: 11767, bayer: 'α UMi', name: 'Polaris', zh: '北极星', ra_deg: 37.9546, dec_deg: 89.2641, v: 1.98, pm_ra: 44.5, pm_dec: -11.9, type: '罗盘' },
    { hip: null, bayer: 'δ UMi', name: 'Yildun', zh: '勾陈四', ra_deg: 23.2320, dec_deg: 86.5529, v: 4.36, pm_ra: 63.0, pm_dec: -20.0, type: '导航' },
    { hip: 67459, bayer: 'β UMi', name: 'Kochab', zh: '北极二(帝)', ra_deg: 222.6768, dec_deg: 74.1553, v: 2.07, pm_ra: 40.0, pm_dec: -20.0, type: '罗盘' },
    { hip: null, bayer: 'γ UMi', name: 'Pherkad', zh: '北极一(太子)', ra_deg: 230.1824, dec_deg: 71.8175, v: 3.00, pm_ra: 34.0, pm_dec: 17.0, type: '导航' },
    { hip: null, bayer: 'α Cep', name: 'Alderamin', zh: '天钩五', ra_deg: 319.6446, dec_deg: 62.5853, v: 2.45, pm_ra: 463.0, pm_dec: 114.0, type: '导航' },
    { hip: null, bayer: 'β Cep', name: 'Alfirk', zh: '天钩七', ra_deg: 319.5359, dec_deg: 70.5610, v: 3.23, pm_ra: 51.0, pm_dec: -29.0, type: '导航' },
    { hip: null, bayer: 'γ Cep', name: 'Errai', zh: '天钩八', ra_deg: 349.3013, dec_deg: 77.6236, v: 3.21, pm_ra: -113.0, pm_dec: 46.0, type: '导航' },
    { hip: null, bayer: 'α Cas', name: 'Schedar', zh: '王良四', ra_deg: 10.1267, dec_deg: 56.5373, v: 2.24, pm_ra: 43.0, pm_dec: -33.0, type: '导航' },
    { hip: null, bayer: 'β Cas', name: 'Caph', zh: '王良一', ra_deg: 2.2781, dec_deg: 59.1498, v: 2.27, pm_ra: 123.0, pm_dec: -63.0, type: '导航' },
    { hip: null, bayer: 'γ Cas', name: 'Navi', zh: '策', ra_deg: 14.1772, dec_deg: 60.2353, v: 2.15, pm_ra: 112.0, pm_dec: -171.0, type: '导航' },
    { hip: null, bayer: 'γ Dra', name: 'Eltanin', zh: '天棓四', ra_deg: 269.1528, dec_deg: 51.4891, v: 2.24, pm_ra: -97.0, pm_dec: -43.0, type: '导航' },
    // —— 北斗七星（7 颗，任务清单要求各星齐备） ——
    { hip: 54061, bayer: 'α UMa', name: 'Dubhe', zh: '天枢', ra_deg: 165.9321, dec_deg: 61.7508, v: 1.79, pm_ra: -26.4, pm_dec: -16.4, type: '北斗' },
    { hip: 53910, bayer: 'β UMa', name: 'Merak', zh: '天璇', ra_deg: 165.4605, dec_deg: 56.3821, v: 2.37, pm_ra: 31.9, pm_dec: -41.9, type: '北斗' },
    { hip: null, bayer: 'γ UMa', name: 'Phecda', zh: '天玑', ra_deg: 178.4616, dec_deg: 53.6948, v: 2.44, pm_ra: 36.5, pm_dec: -13.2, type: '北斗' },
    { hip: null, bayer: 'δ UMa', name: 'Megrez', zh: '天权', ra_deg: 183.8576, dec_deg: 57.0326, v: 3.32, pm_ra: 45.0, pm_dec: -35.0, type: '北斗' },
    { hip: 57555, bayer: 'ε UMa', name: 'Alioth', zh: '玉衡', ra_deg: 193.5070, dec_deg: 55.9598, v: 1.77, pm_ra: 110.0, pm_dec: -5.0, type: '北斗' },
    { hip: null, bayer: 'ζ UMa', name: 'Mizar', zh: '开阳', ra_deg: 200.9808, dec_deg: 54.9254, v: 2.23, pm_ra: 150.0, pm_dec: 30.0, type: '北斗' },
    { hip: null, bayer: '80 UMa', name: 'Alcor', zh: '辅', ra_deg: 201.3060, dec_deg: 54.9880, v: 3.99, pm_ra: 160.0, pm_dec: 55.0, type: '双眼衡' },
    { hip: null, bayer: 'η UMa', name: 'Alkaid', zh: '摇光', ra_deg: 206.8858, dec_deg: 49.3133, v: 1.85, pm_ra: -60.0, pm_dec: 80.0, type: '北斗' },
    // —— 黄道/赤道带亮星 ——
    { hip: 32349, bayer: 'α CMa', name: 'Sirius', zh: '天狼星', ra_deg: 101.2872, dec_deg: -16.7161, v: -1.46, pm_ra: -546.0, pm_dec: -123.0, type: '导航' },
    { hip: 37279, bayer: 'α CMi', name: 'Procyon', zh: '南河三', ra_deg: 114.8255, dec_deg: 5.2250, v: 0.34, pm_ra: -715.0, pm_dec: -1034.0, type: '导航' },
    { hip: 34033, bayer: 'β Gem', name: 'Pollux', zh: '北河三', ra_deg: 116.3289, dec_deg: 28.0262, v: 1.14, pm_ra: -694.0, pm_dec: -109.0, type: '导航' },
    { hip: null, bayer: 'α Gem', name: 'Castor', zh: '北河二', ra_deg: 113.6495, dec_deg: 31.8882, v: 1.58, pm_ra: 191.0, pm_dec: -40.0, type: '导航' },
    { hip: 24608, bayer: 'α Aur', name: 'Capella', zh: '五车二', ra_deg: 79.1723, dec_deg: 45.9980, v: 0.08, pm_ra: 75.6, pm_dec: -42.8, type: '导航' },
    { hip: 27989, bayer: 'α Ori', name: 'Betelgeuse', zh: '参宿四', ra_deg: 88.7929, dec_deg: 7.4071, v: 0.50, pm_ra: 25.0, pm_dec: 12.4, type: '变星' },
    { hip: 24436, bayer: 'β Ori', name: 'Rigel', zh: '参宿七', ra_deg: 78.6345, dec_deg: -8.2016, v: 0.13, pm_ra: 1.8, pm_dec: 0.6, type: '导航' },
    { hip: null, bayer: 'γ Ori', name: 'Bellatrix', zh: '参宿三', ra_deg: 81.2828, dec_deg: 6.3497, v: 1.64, pm_ra: 12.0, pm_dec: -13.0, type: '导航' },
    { hip: 17025, bayer: 'α Tau', name: 'Aldebaran', zh: '毕宿五', ra_deg: 68.9802, dec_deg: 16.5093, v: 0.85, pm_ra: 44.5, pm_dec: -52.7, type: '导航' },
    { hip: null, bayer: 'β Tau', name: 'Elnath', zh: '五车五', ra_deg: 80.9456, dec_deg: 28.6081, v: 1.65, pm_ra: 39.0, pm_dec: -16.0, type: '导航' },
    { hip: 49669, bayer: 'α Leo', name: 'Regulus', zh: '轩辕十四', ra_deg: 152.0930, dec_deg: 11.9672, v: 1.36, pm_ra: -250.0, pm_dec: 5.6, type: '导航' },
    { hip: null, bayer: 'β Leo', name: 'Denebola', zh: '五帝座一', ra_deg: 177.2663, dec_deg: 14.5724, v: 2.14, pm_ra: -43.0, pm_dec: -43.0, type: '导航' },
    { hip: 65474, bayer: 'α Vir', name: 'Spica', zh: '角宿一', ra_deg: 201.2983, dec_deg: -11.1613, v: 0.97, pm_ra: -30.7, pm_dec: -31.8, type: '导航' },
    { hip: 69673, bayer: 'α Boo', name: 'Arcturus', zh: '大角星', ra_deg: 213.9153, dec_deg: 19.1767, v: -0.05, pm_ra: -1093.0, pm_dec: -194.0, type: '导航' },
    { hip: 80763, bayer: 'α Sco', name: 'Antares', zh: '心宿二', ra_deg: 247.3517, dec_deg: -26.4320, v: 1.06, pm_ra: -10.2, pm_dec: -23.4, type: '导航' },
    { hip: null, bayer: 'δ Sco', name: 'Dschubba', zh: '房宿三', ra_deg: 240.1375, dec_deg: -22.6217, v: 2.32, pm_ra: 5.6, pm_dec: -4.5, type: '导航' },
    { hip: null, bayer: 'λ Sco', name: 'Shaula', zh: '尾宿八', ra_deg: 263.4021, dec_deg: -37.1038, v: 1.62, pm_ra: -35.0, pm_dec: -40.0, type: '导航' },
    { hip: null, bayer: 'ε Sgr', name: 'Kaus Australis', zh: '箕宿三', ra_deg: 270.8520, dec_deg: -34.3846, v: 1.85, pm_ra: 51.0, pm_dec: -39.0, type: '导航' },
    { hip: null, bayer: 'σ Sgr', name: 'Nunki', zh: '建三', ra_deg: 283.8270, dec_deg: -26.2967, v: 2.05, pm_ra: 14.0, pm_dec: -17.0, type: '导航' },
    { hip: 97278, bayer: 'α Aql', name: 'Altair', zh: '河鼓二(牛郎星)', ra_deg: 297.6958, dec_deg: 8.8683, v: 0.76, pm_ra: 194.0, pm_dec: -164.0, type: '导航' },
    { hip: 102098, bayer: 'α Cyg', name: 'Deneb', zh: '天津四', ra_deg: 310.3580, dec_deg: 45.2803, v: 1.25, pm_ra: 21.0, pm_dec: 2.3, type: '导航' },
    { hip: 91262, bayer: 'α Lyr', name: 'Vega', zh: '织女星', ra_deg: 279.2347, dec_deg: 38.7837, v: 0.03, pm_ra: 200.4, pm_dec: 285.8, type: '导航' },
    { hip: null, bayer: 'α PsA', name: 'Fomalhaut', zh: '北落师门', ra_deg: 344.4127, dec_deg: -29.6222, v: 1.16, pm_ra: 33.0, pm_dec: -17.0, type: '导航' },
    { hip: null, bayer: 'α Aqr', name: 'Sadalmelik', zh: '危宿一', ra_deg: 331.4545, dec_deg: -0.3207, v: 2.96, pm_ra: -1.0, pm_dec: -3.0, type: '导航' },
    // —— 南天主星（含任务清单要求的南十字 α/β 与南门二） ——
    { hip: 30438, bayer: 'α Car', name: 'Canopus', zh: '老人星', ra_deg: 96.0239, dec_deg: -52.6957, v: -0.72, pm_ra: 18.7, pm_dec: -10.7, type: '导航' },
    { hip: 7588, bayer: 'α Eri', name: 'Achernar', zh: '水委一', ra_deg: 24.4285, dec_deg: -57.2367, v: 0.46, pm_ra: 92.0, pm_dec: -39.0, type: '导航' },
    { hip: 60718, bayer: 'α Cru', name: 'Acrux', zh: '南十字二', ra_deg: 186.6583, dec_deg: -63.0988, v: 0.77, pm_ra: -36.0, pm_dec: -25.0, type: '罗盘' },
    { hip: 61084, bayer: 'β Cru', name: 'Mimosa', zh: '南十字三', ra_deg: 191.9304, dec_deg: -59.6891, v: 1.25, pm_ra: -25.0, pm_dec: -508.0, type: '罗盘' },
    { hip: null, bayer: 'γ Cru', name: 'Gacrux', zh: '南十字四', ra_deg: 188.0650, dec_deg: -57.0668, v: 1.63, pm_ra: 13.0, pm_dec: -245.0, type: '罗盘' },
    { hip: null, bayer: 'δ Cru', name: 'Imai', zh: '南十字五', ra_deg: 183.7892, dec_deg: -58.7489, v: 2.79, pm_ra: 131.0, pm_dec: -92.0, type: '罗盘' },
    { hip: 72432, bayer: 'α2 Cen', name: 'Alpha Centauri', zh: '南门二', ra_deg: 219.9029, dec_deg: -60.8339, v: -0.01, pm_ra: -3500.0, pm_dec: -1080.0, type: '罗盘' },
    { hip: 68702, bayer: 'β Cen', name: 'Hadar', zh: '马腹一', ra_deg: 210.9557, dec_deg: -60.3730, v: 0.61, pm_ra: 3.0, pm_dec: -18.0, type: '罗盘' },
    { hip: null, bayer: 'α TrA', name: 'Atria', zh: '三角形三', ra_deg: 252.1939, dec_deg: -69.0277, v: 1.92, pm_ra: 53.0, pm_dec: -16.0, type: '导航' },
    { hip: null, bayer: 'α Pav', name: 'Peacock', zh: '孔雀十一', ra_deg: 306.4120, dec_deg: -57.1897, v: 1.94, pm_ra: 2.0, pm_dec: -3.0, type: '导航' }
  ];
  STAR_TABLE.forEach(function (s) {
    s.epoch = 'J2000.0';            // 平位置纪元（断言验「T=0 时岁差改正为 0」）
    s.hip_unverified = (s.hip != null);   // 编号为记忆值，未经外部星表核对
    if (s.hip == null) s.hip_note = '目录号留空：离线无法核对，宁缺勿错';
    s.id = s.hip != null ? 'HIP ' + s.hip : s.bayer;   // 主标识：编号或拜耳名
  });

  // IAU-1976 岁差角（弧度，T=自 J2000 的儒略世纪）。ζ/z 取一次项为主，θ 含 T²；
  // 截断说明：ζ、z 的 T²/T³ 项（~1.4″/cy² 与 ~0.03″/cy³）与 θ 的 T³ 未计入，
  // 1 个世纪内引入的位置误差 < 0.05″（对导航星等高表 ~2″ 的星表噪声可忽略）。
  function precessionAngles(T) {
    var t = num(T); if (t == null) return err('bad_t', 'T 非法');
    if (Math.abs(t) > 1000) return err('out_of_range', 'T 超出适用范围（|T| ≤ 1000 世纪）');
    return {
      zeta: (2306.2181 * t + 1.39656 * t * t + 0.000308 * t * t * t) * (1 / ARCSEC_PER_DEG) * D2R,
      theta: (2004.3109 * t - 0.42665 * t * t - 0.000378 * t * t * t) * (1 / ARCSEC_PER_DEG) * D2R,
      z: (2306.2181 * t + 1.09492 * t * t + 0.001885 * t * t * t) * (1 / ARCSEC_PER_DEG) * D2R,
      note: 'Meeus 第 21 章 IAU-1976 岁差角（弧度）；见上文截断说明'
    };
  }
  function precessionMatrix(T) {
    var a = precessionAngles(T); if (a.error) return a;
    var cz = Math.cos(a.zeta), sz = Math.sin(a.zeta), ct = Math.cos(a.theta), st = Math.sin(a.theta),
      czz = Math.cos(a.z), szz = Math.sin(a.z);
    // 3-1-3 分解：R = Rz(z)·Ry(−θ)·Rz(ζ)。θ 前的负号**不是凭记忆下的结论**：
    // 本实现先按 Ry(+θ) 写，被下面四条互不相关的独立判据同时否决，实测数值见
    // selfTest 的「岁差方向/正交反演/Polaris 趋势」断言与本注释：
    //   ① 固定在黄球面上的点（β=0）应始终 β=0，且黄经长期速率 = 一般岁差
    //      p = 5029.0966″/cy = 1.39697°/cy。Ry(+θ) 给 dλ=0.955、β=−1.02°（错）。
    //   ② 春分点处 α̇ 应等于 m = 4612.2″/世纪 = +1.2812°/世纪（「岁差使赤经
    //      普遍增大」是经典结论）。Ry(+θ) 给 −0.644°/cy。
    //   ③ Polaris 距极应持续减小到 ~2100 年的 ≈0.46°（公开事实：最小极距 ~0.4°）。
    //      Ry(+θ) 使 δ 从 89.26 单调**下降**。
    //   ④ 古埃及极星 Thuban（α Dra，δ≈+64.4）在公元前应比现在更接近北天极。
    //      Ry(+θ) 使它在过去远离天极。
    // 取 Ry(−θ) 后四条同时成立：dλ=+1.3976°/cy、β=0.0011°、α̇=+1.2820°/cy、
    // Polaris δ = 88.7738(1900)/89.2641(2000)/89.5406(2100)、
    // Thuban 距极 22.70°(T=−6) / 25.62°(0) / 26.10°(+1)。
    var m00 = ct * cz * czz - sz * szz, m01 = -ct * cz * szz - sz * czz, m02 = -st * cz;
    var m10 = ct * sz * czz + cz * szz, m11 = -ct * sz * szz + cz * czz, m12 = -st * sz;
    var m20 = st * czz, m21 = -st * szz, m22 = ct;
    return { m: [m00, m01, m02, m10, m11, m12, m20, m21, m22], angles: a };
  }
  function applyPrecession(raDeg, decDeg, T) {
    var t = num(T); if (t == null || !isNum(num(raDeg)) || !isNum(num(decDeg))) return err('bad_input', '输入非法');
    if (Math.abs(num(decDeg)) > 90) return err('bad_dec', '赤纬超出 ±90');
    var P = precessionMatrix(t); if (P.error) return P;
    var ar = num(raDeg) * D2R, dr = num(decDeg) * D2R;
    var x = Math.cos(dr) * Math.cos(ar), y = Math.cos(dr) * Math.sin(ar), z = Math.sin(dr);
    var m = P.m;
    var x2 = m[0] * x + m[1] * y + m[2] * z, y2 = m[3] * x + m[4] * y + m[5] * z, z2 = m[6] * x + m[7] * y + m[8] * z;
    return {
      ra_deg: wrap360(Math.atan2(y2, x2) * R2D), dec_deg: Math.asin(clamp(z2, -1, 1)) * R2D,
      x: x2, y: y2, z: z2, norm: Math.hypot(x2, y2, z2), dRA_arcsec: wrap180(wrap360(Math.atan2(y2, x2) * R2D) - num(raDeg)) * 3600 * Math.cos(dr),
      dDec_arcsec: (Math.asin(clamp(z2, -1, 1)) * R2D - num(decDeg)) * 3600
    };
  }
  // 自行改正（简单线性，Meeus 第 24 章一次项；单位 mas/yr）
  function applyProperMotion(star, T) {
    var t = num(T); if (t == null) return err('bad_t', 'T 非法');
    var y = t * 36525;
    var dra = (star.pm_ra || 0) / 1000 * y / 3600, ddec = (star.pm_dec || 0) / 1000 * y / 3600;
    return { ra_deg: wrap360(star.ra_deg + dra / Math.max(Math.cos(star.dec_deg * D2R), 1e-6)), dec_deg: clamp(star.dec_deg + ddec, -90, 90) };
  }
  function starAtEpoch(star, jdUt, opts) {
    opts = opts || {};
    var p = parseTime(jdUt); if (p.error) return p;
    if (!star || !isNum(star.ra_deg) || !isNum(star.dec_deg)) return err('bad_star', '星表项缺 ra_deg/dec_deg');
    var tt = tOf(p.jd); if (tt.error) return tt;
    var T = tt.t;
    var pre = applyPrecession(star.ra_deg, star.dec_deg, T); if (pre.error) return pre;
    var ra = pre.ra_deg, dec = pre.dec_deg;
    if (opts.properMotion !== false && (star.pm_ra || star.pm_dec)) {
      var pm = applyProperMotion({ ra_deg: ra, dec_deg: dec, pm_ra: star.pm_ra, pm_dec: star.pm_dec }, T);
      if (!pm.error) { ra = pm.ra_deg; dec = pm.dec_deg; }
    }
    return { ra_deg: ra, dec_deg: dec, jd: p.jd, t: T, precession_ra_arcsec: pre.dRA_arcsec, precession_dec_arcsec: pre.dDec_arcsec };
  }
  function findStar(key) {
    if (key == null) return err('bad_star', '缺星名');
    var k = String(key).trim().toLowerCase();
    for (var i = 0; i < STAR_TABLE.length; i++) {
      var s = STAR_TABLE[i];
      if ((s.hip != null && String(s.hip) === k) || String(s.id) === k ||
        s.bayer.toLowerCase() === k || s.name.toLowerCase() === k || s.zh === String(key).trim()) return s;
    }
    if (isNum(num(key))) {
      var n = Math.round(num(key));
      if (n >= 0 && n < STAR_TABLE.length) return STAR_TABLE[n];
    }
    return err('star_not_found', '星表无此星：' + String(key).slice(0, 32));
  }
  // 实用接口①：某星当时的真北方位角与高度
  function bearingFromStar(o) {
    o = o || {};
    var st = o.star_id != null || o.star != null ? findStar(o.star_id != null ? o.star_id : o.star) : o;
    if (st.error) return st;
    var p = parseTime(o.utc != null ? o.utc : o.jd, { tzOffsetHours: o.tzOffsetHours }); if (p.error) return p;
    var la = num(o.lat), lo = num(o.lon); if (la == null || lo == null) return err('bad_geo', '缺 lat/lon');
    if (Math.abs(la) > 90 + 1e-9) return err('bad_lat', '纬度超出 ±90');
    var e = starAtEpoch(st, p.jd, o); if (e.error) return e;
    var g = gmst(p.jd); if (g.error) return g;
    var h = equToHor(e.ra_deg, e.dec_deg, la, g.deg + wrap180(lo)); if (h.error) return h;
    var refr = refraction(h.alt_deg, o);
    var sun = sunHorizon(p.jd, la, lo, o);
    return {
      star: st.name, star_zh: st.zh, az_deg: h.az_deg, az_graticule_deg: h.az_deg,
      alt_deg: h.alt_deg, apparent_alt_deg: h.alt_deg + (refr.deg || 0), ha_deg: h.ha_deg,
      ra_deg: e.ra_deg, dec_deg: e.dec_deg, gmst_deg: g.deg, lst_deg: wrap360(g.deg + wrap180(lo)),
      sun_alt_deg: sun.error ? null : sun.alt_deg,
      visible: (!sun.error && sun.alt_deg < (o.sun_alt_max_deg != null ? num(o.sun_alt_max_deg) : -6)) && h.alt_deg > (o.alt_min_deg != null ? num(o.alt_min_deg) : 5),
      note: '方位角自真北顺时针；含岁差+自行，未含章动/光行差（<1″~2″）。'
    };
  }
  // 实用接口②：过中天高度求纬度（φ = δ ± (90 − H_max)，符号由观测者相对天体的方位决定）
  function latFromStarAltitude(o) {
    o = o || {};
    var alt = num(o.max_altitude_deg != null ? o.max_altitude_deg : o.altitude_at_transit_deg);
    if (alt == null) return err('bad_alt', '缺过中天高度');
    if (alt < -90 || alt > 90) return err('bad_alt', '高度超出 ±90');
    var dec = num(o.dec_deg);
    var st = null;
    if (dec == null) {
      st = findStar(o.star); if (st.error) return st;
      var jdIn = o.utc != null || o.jd != null ? parseTime(o.utc != null ? o.utc : o.jd) : null;
      var T = jdIn && !jdIn.error ? (jdIn.jd - J2000) / 36525 : 0;
      var e = starAtEpoch(st, (jdIn && !jdIn.error) ? jdIn.jd : J2000, o); if (e.error) return e;
      dec = e.dec_deg;
    }
    var z = 90 - alt;                                   // 天顶距
    var toward = String(o.toward || o.azimuth_at_transit || 'south').toLowerCase();
    var czd = (toward.indexOf('n') === 0) ? 1 : -1;     // 天顶在赤纬圈的「北」侧？
    var lat1 = dec + z, lat2 = dec - z;
    // 物理判定：过中天且朝向南方 ⇒ 观测者在天体以北 ⇒ φ = δ + z；朝北 ⇒ φ = δ − z
    var lat = (toward.indexOf('n') === 0) ? lat2 : lat1;
    var amb = (Math.abs(lat1 - lat2) < 1e-9) ? true : false;
    var res = { lat_deg: clamp(lat, -90, 90), zenith_dist_deg: z, dec_deg: dec,
      two_solutions: { south: lat1, north: lat2 }, resolved_by: toward,
      ambiguity: amb ? '过中天高度无法区分南北（需另测过北中天高度或已知大致纬度）' : 'direction',
      formula: 'φ = δ + z（天体位于观测者之南过中天）；φ = δ − z（位于北）',
      note: '观测高度需先做折射与仪器差改正；z 越大灵敏度越低（dφ/dh = 1）。' };
    if (Math.abs(lat) > 90) { res.clamped = true; res.note += '；解出 |φ|>90，输入高度与赤纬不自洽（或漏了折射改正）。'; }
    return res;
  }
  // 北极星罗盘法：真北方位角≈0 的近似误差 + 由高度估纬度（含改正）
  //
  // 纬度改正用的是**精确球面解**，不是「φ ≈ h + 距极改正」的一阶凑式：
  // 取天顶 Z、北天极 P、星 S 构成的球面三角形，ZP=90−φ、PS=p=90−δ、ZS=z=90−h，
  // Z 处的角即自真北起的方位角 A，余弦定理直接给出
  //     sin δ = sin φ sin h + cos φ cos h cos A                     (★)
  // 这是「任意 φ/h/A 都成立」的恒等式，不是近似；把它整理成 a·sinφ+b·cosφ=c
  // （a=sin h、b=cos h·cos A、c=sin δ），通解为 φ = asin(c/R) − ψ 与
  // φ = 180° − asin(c/R) − ψ，其中 R=√(a²+b²)、ψ=atan2(b,a)。
  // 实现初版用的是 h − p(1−cos H) 这类凑式，它在 H=0 时改正恰好为 0，
  // 于是「φ≈h」的系统误差（=距极角 p）原封不动地留在结果里（selfTest 的
  // 中天估纬断言抓到过）。现在用 (★) 反解，并如实保留双解歧义：
  // 单点观测无法区分两支（本函数用大致纬度 o.lat 选支；导航作业中等价的
  // 做法是「上、下中天高度取平均」或再测一次过北中天高度）。
  function polarisCompass(o) {
    o = o || {};
    var p = parseTime(o.utc != null ? o.utc : o.jd, { tzOffsetHours: o.tzOffsetHours }); if (p.error) return p;
    var la = num(o.lat), lo = num(o.lon); if (la == null || lo == null) return err('bad_geo', '缺 lat/lon');
    var st = findStar('Polaris'); if (st.error) return st;
    var b = bearingFromStar({ star: st.name, utc: p.jd, lat: la, lon: lo }); if (b.error) return b;
    var H = b.ha_deg, dec = b.dec_deg, alt = b.alt_deg, az = b.az_deg;
    var distDeg = 90 - dec;                              // 距极角 p
    // 真北方位角误差的一阶式 tan ΔA ≈ sinH·tan p（球面天文经典展开，仅用于说明量级）
    var dAz = Math.atan(Math.sin(H * D2R) * Math.tan(distDeg * D2R)) * R2D;
    var a = Math.sin(alt * D2R), bb = Math.cos(alt * D2R) * Math.cos(az * D2R), c = Math.sin(dec * D2R);
    var Rr = Math.hypot(a, bb);
    var sol1 = null, sol2 = null;
    if (Rr > 1e-9) {
      var psi = Math.atan2(bb, a) * R2D;
      var al = Math.asin(clamp(c / Rr, -1, 1)) * R2D;
      sol1 = wrap180(al - psi); sol2 = wrap180(180 - al - psi);
    }
    var pick = function (x) { return x == null ? null : clamp(x, -90, 90); };
    var estLat = null, chosen = null, sep = null;
    if (sol1 != null && sol2 != null) {
      var g = num(o.lat_guess_deg); if (g == null) g = la;
      estLat = pick(Math.abs(sol1 - g) <= Math.abs(sol2 - g) ? sol1 : sol2);
      chosen = Math.abs(sol1 - g) <= Math.abs(sol2 - g) ? 'sol1' : 'sol2';
      sep = Math.abs(wrap180(sol1 - sol2));
    } else if (sol1 != null) estLat = pick(sol1);
    var sun = sunHorizon(p.jd, la, lo, o);
    return {
      az_deg: az, az_from_true_north_deg: wrap180(az),
      first_order_az_error_deg: dAz, alt_deg: alt, az_obs_deg: az, ha_deg: H, polar_distance_deg: distDeg,
      lat_solutions_deg: [pick(sol1), pick(sol2)], solution_branch: chosen,
      solution_separation_deg: sep, solution_method: '球面三角形余弦定理 sinδ=sinφ·sinh+cosφ·cosh·cosA 的精确反解（非一阶近似）',
      lat_estimate_deg: estLat, lat_simple_deg: clamp(alt, -90, 90),
      simple_rule_error_deg: estLat == null ? null : estLat - clamp(alt, -90, 90),
      usable_as_compass: Math.abs(wrap180(az)) < (o.tol_deg != null ? num(o.tol_deg) : 2),
      visible_at_night: (!sun.error && sun.alt_deg < -6 && alt > 5),
      error_note: '距极角 ' + distDeg.toFixed(2) + '° ⇒ 时角 ' + H.toFixed(1) + '° 时的真北偏差约 ' +
        wrap180(az).toFixed(2) + '°；「北极星高度≈纬度」的简单规则最大系统差 = 距极角（~0.9°），' +
        '本函数给出的是精确反解 + 双解（间隔 ' + (sep == null ? 'n/a' : sep.toFixed(2) + '°') + '），需以大致纬度或上下中天平均选支。'
    };
  }
  function starsAt(o) {
    o = o || {};
    var p = parseTime(o.utc != null ? o.utc : o.jd, { tzOffsetHours: o.tzOffsetHours }); if (p.error) return p;
    var la = num(o.lat), lo = num(o.lon); if (la == null || lo == null) return err('bad_geo', '缺 lat/lon');
    if (Math.abs(la) > 90 + 1e-9) return err('bad_lat', '纬度超出 ±90');
    var g = gmst(p.jd); if (g.error) return g;
    var sun = sunHorizon(p.jd, la, lo, o);
    var lst = g.deg + wrap180(lo), outArr = [];
    for (var i = 0; i < STAR_TABLE.length; i++) {
      var st = STAR_TABLE[i];
      var e = starAtEpoch(st, p.jd, o); if (e.error) continue;
      var h = equToHor(e.ra_deg, e.dec_deg, la, lst); if (h.error) continue;
      var refr = refraction(h.alt_deg, o);
      var app = h.alt_deg + (refr.deg || 0);
      var vis = app > (o.alt_min_deg != null ? num(o.alt_min_deg) : 5) && (sun.error || sun.alt_deg < (o.sun_alt_max_deg != null ? num(o.sun_alt_max_deg) : -6));
      outArr.push({ hip: st.hip, name: st.name, zh: st.zh, v: st.v, ra_deg: e.ra_deg, dec_deg: e.dec_deg,
        ha_deg: h.ha_deg, alt_deg: h.alt_deg, apparent_alt_deg: app, az_deg: h.az_deg,
        zenith_dist_deg: 90 - h.alt_deg, circumpolar: h.ha_deg == null ? false : false, visible: vis });
    }
    outArr.sort(function (a, b) { return b.alt_deg - a.alt_deg; });
    return { jd: p.jd, lat: la, lon: lo, gmst_deg: g.deg, lst_deg: wrap360(lst), sun_alt_deg: sun.error ? null : sun.alt_deg,
      count: outArr.length, visible_count: outArr.filter(function (r) { return r.visible; }).length, stars: outArr };
  }

  /* ============================================== 8. 鲁棒性自检辅助（供测试） */
  function hasNaNdeep(v, path, bag, seen) {
    path = path || '$'; bag = bag || []; seen = seen || [];
    if (v == null) return bag;
    if (typeof v === 'number') { if (!isFinite(v)) bag.push(path); return bag; }
    if (typeof v !== 'object') return bag;
    if (seen.indexOf(v) >= 0) return bag; seen.push(v);
    if (Array.isArray(v)) { v.forEach(function (x, i) { hasNaNdeep(x, path + '[' + i + ']', bag, seen); }); return bag; }
    Object.keys(v).forEach(function (k) {
      if (k === 'error' || k === 'elements' && false) return;
      hasNaNdeep(v[k], path + '.' + k, bag, seen);
    });
    return bag;
  }

  /* ============================================== 8b. 模型内部离散度探针 */
  // 独立二体（Kepler）参考：不含 evection/variation 等，故与主项级数之差应≈摄动幅度
  function keplerNuDeg(Mdeg, e) {
    var r = sunTrueAnomalyRad(Mdeg, e); if (r.error) return null;
    return r.nu * R2D;
  }
  function moonTwoBodyLon(jdUt) {
    var p = parseTime(jdUt); if (p.error) return p;
    var T = (p.jd - J2000) / 36525, el = moonElements(T);
    var nu = keplerNuDeg(el.Mp_raw, el.e_prime); if (nu == null) return err('bad_kep', 'Kepler 未收敛');
    // 二体地心真黄经 = 平黄经 + (ν − M′) + 黄道岁差长期项
    var eclipPrecess = 1.3965 * T;
    return { lon_deg: wrap360(el.L_raw + (nu - wrap180(el.Mp_raw)) + eclipPrecess) };
  }
  function sunTwoBodyLon(jdUt) {
    var p = parseTime(jdUt); if (p.error) return p;
    var T = (p.jd - J2000) / 36525, el = sunElements(T);
    var nu = keplerNuDeg(el.M, el.e); if (nu == null) return err('bad_kep', 'Kepler 未收敛');
    return { lon_deg: wrap360(el.L0 + (nu - wrap180(el.M))) };
  }
  // 月/日模型在 20 个历元上的内部离散度（**内部一致性**，不是对外精度）
  function modelProbe(count, seed) {
    var n = num(count) || 20, s = num(seed) || 20251101;
    var rnd = lcg(s), out = { moon_vs_twobody_deg: [], sun_vs_twobody_deg: [], illum: [], dist_km: [], lat_deg: [], jd: [] };
    var base = 2451545.0;
    for (var i = 0; i < n; i++) {
      var jd = base + rnd() * 9000 - 4500;      // ±25 年
      var mm = moonEcliptic(jd), tb = moonTwoBodyLon(jd);
      var ss = sunApparent(jd), s2 = sunTwoBodyLon(jd);
      var ph = moonPhase(jd);
      if (mm.error || tb.error || ss.error || s2.error || ph.error) continue;
      out.jd.push(jd);
      out.moon_vs_twobody_deg.push(wrap180(mm.lon_deg - tb.lon_deg));
      out.sun_vs_twobody_deg.push(wrap180(ss.lon_true_deg - s2.lon_deg));
      out.illum.push(ph.illumination_fraction);
      out.dist_km.push(mm.dist_km);
      out.lat_deg.push(mm.lat_deg);
    }
    out.maxAbs = function (a) { var m = 0; for (var k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k])); return m; };
    out.count = out.jd.length;
    return out;
  }
  function lcg(seed) {
    var x = (num(seed) || 1) >>> 0 || 1;
    return function () { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  }
  // 级数振幅探针：把某个平元素设为 90°、其余设为 0°，返回三条级数的和。
  // 注意：**这不是「单项隔离」**——多数项的参数里也含该元素，所以和值不等于单个振幅。
  // 正因如此它更有鉴别力：selfTest 用**手写的三角展开**（把表里每条 arg 串按
  // moonArg 的定义逐项算出来）比对，能同时抓住「参数串写错/符号写反/小数点错位」。
  function termAmplitudes() {
    function probe(key, val) {
      var el = { L: 0, D: 0, M: 0, Mp: 0, F: 0, omega: 0, E: 1 };
      el[key] = val;
      return {
        lon: moonSeriesSum(MOON_TERMS_L, el),
        lat: moonSeriesSum(MOON_TERMS_B, el),
        dist: moonSeriesSum(MOON_TERMS_R, el, Math.cos)
      };
    }
    return { Mp90: probe('Mp', 90), F90: probe('F', 90), D90: probe('D', 90), M90: probe('M', 90),
      // 兼容旧字段名（accuracy() 与旧断言用到）
      get lon_at_Mp90() { return this.Mp90.lon; },
      get lat_at_F90() { return this.F90.lat; },
      get dist_at_Mp90() { return this.Mp90.dist; } };
  }

  /* ============================================================ 9. 精度报告 */
  function accuracy() {
    var pr = modelProbe(20, 20251101), am = termAmplitudes();
    return {
      grade: '导航级（角分~度级），非历表级（角秒级）',
      measured_internally: {
        moon_lon_vs_twobody_max_deg: pr.maxAbs(pr.moon_vs_twobody_deg),
        sun_lon_vs_twobody_max_deg: pr.maxAbs(pr.sun_vs_twobody_deg),
        moon_lat_max_deg: pr.maxAbs(pr.lat_deg),
        moon_dist_range_km: [Math.min.apply(null, pr.dist_km), Math.max.apply(null, pr.dist_km)],
        evection_amplitude_deg: MOON_TERMS_L[1].amp,
        lunar_latitude_amplitude_deg: MOON_TERMS_B[0].amp,
        equation_of_center_deg: MOON_TERMS_L[0].amp,
        probe_sum_at_Mp90_deg: am.lon_at_Mp90
      },
      caveat: '以上为**内部**离散度（与独立二体解之差），不是对外部历表的精度；' +
        '本环境无网络、无第三方历表，故月位/日位的绝对精度未经证实，UI 应按「月位 ±0.4°、日位 ±0.02°」的工程包络提示用户。',
      items: [
        { what: 'JD/MJD', acc: '±0.5 s（双精度）', verified_by: '往返一致 + J2000/1900 锚点 + 世纪规则', leap: '不含闰秒/不含 ΔT' },
        { what: 'GMST', acc: '公式 ~0.1″；UT1−UTC 未知 → ±13.5″', verified_by: '微分恒等 1.002737909 + J2000 锚点' },
        { what: '太阳视位置', acc: '内部二体差实测见 measured（应≈0.02° 内）', verified_by: '2e 中心差 + 回归年 + 正午高度恒等式' },
        { what: '日出日落', acc: '±0.7 min（Bennett 28.98′ vs 年历 34′）', verified_by: '与解析 cosH0 昼长对照' },
        { what: '月亮位置', acc: '截断 ≤0.4°（未对外验证）', verified_by: '月下点=赤纬恒等式 + f=(1+cos i)/2 严格式' },
        { what: '恒星视位置', acc: '星表 ~0.01°＋岁差截断 <0.05″', verified_by: '正交/反演/黄经速率/Polaris 趋势' }
      ]
    };
  }

  /* ============================================================ 10. selfTest */
  var TESTS = [];
  function T(name, fn) { TESTS.push({ name: name, fn: fn }); }
  function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
  function near(a, b, tol, msg) {
    ok(isNum(a) && isNum(b) && Math.abs(a - b) <= tol, msg + '：' + a + ' vs ' + b + '（容差 ' + tol + '）');
  }

  /* ---- 1. 时间基准 */
  T('JD 锚点 J2000.0 = 2451545.0', function () {
    var r = jdFromParts(2000, 1, 1, 12);
    ok(!r.error, '不应拒绝 2000-01-01：' + r.message);
    near(r.jd, 2451545.0, 1e-9, 'J2000.0 应为 2451545.0');
    return '算得 JD = ' + r.jd.toFixed(6);
  });
  T('MJD = JD − 2400000.5（三历元）', function () {
    var es = [[2000, 1, 1, 12], [1999, 12, 31, 23.5], [2024, 2, 29, 6.25]], dmax = 0;
    es.forEach(function (e) { var r = jdFromParts(e[0], e[1], e[2], e[3]); dmax = Math.max(dmax, Math.abs(r.mjd - (r.jd - 2400000.5))); });
    ok(dmax === 0, '定义式残差应为 0，实得 ' + dmax);
    return '残差 ' + dmax + '，MJD(J2000) = ' + jdFromParts(2000, 1, 1, 12).mjd;
  });
  T('1900 非闰：02-28 的次日是 03-01', function () {
    var a = jdFromParts(1900, 2, 28, 0), b = jdFromParts(1900, 3, 1, 0);
    near(b.jd - a.jd, 1, 1e-9, '相邻日差应为 1');
    var bad = jdFromParts(1900, 2, 29, 0);
    ok(bad.error === 'bad_day', '1900-02-29 必须被拒绝，实得 ' + JSON.stringify(bad).slice(0, 40));
    return 'Δ=1.000000；1900-02-29 → error=' + bad.error;
  });
  T('2000 是闰年：02-29 存在且 02-28 次日为 02-29', function () {
    var a = jdFromParts(2000, 2, 28, 0), b = jdFromParts(2000, 2, 29, 0);
    ok(!b.error, '2000-02-29 应存在');
    near(b.jd - a.jd, 1, 1e-9, '差应为 1 日');
    // 期望值**由 J2000 锚点独立推得**（记错时期望值本身就是要抓的错，故在此写全推导）：
    // 2000-01-01 00:00 UT = 2451545.0 − 0.5 = 2451544.5；1 月 31 天 + 2 月 1→28 共 27 天
    // ⇒ 2000-02-28 00:00 = 2451544.5 + 58 = 2451602.5。本断言初版写成 2451604.5，
    // 是把「+58 天」心算成「+60 天」的期望值错误，代码给出 2451602.5 才是对的。
    near(a.jd, 2451602.5, 1e-9, '2000-02-28 00:00 的 JD（=J2000 日首 2451544.5 + 58 天）');
    return 'JD(2000-02-28)=' + a.jd + '（推算 2451544.5+58），JD(02-29)=' + b.jd;
  });
  T('JD↔日期往返（12 个含世纪/闰日的历元）', function () {
    var es = [[1583, 1, 1], [1582, 10, 15], [1700, 3, 1], [1800, 2, 28], [1899, 12, 31], [1900, 1, 1],
      [1900, 2, 28], [1900, 3, 1], [2000, 2, 29], [2000, 3, 1], [2100, 2, 28], [2024, 2, 29]];
    var worst = 0, worstName = '';
    es.forEach(function (e) {
      var r = jdFromParts(e[0], e[1], e[2], 5.5);
      ok(!r.error, e.join('-') + ' 应可计算：' + r.message);
      var d = dateFromJd(r.jd);
      ok(!d.error, '逆变换失败 ' + r.jd);
      var got = d.year * 10000 + d.month * 100 + d.day;
      var exp = e[0] * 10000 + e[1] * 100 + e[2];
      if (got !== exp) throw new Error('往返不一致 ' + e.join('-') + ' → ' + d.iso);
      var back = jdFromParts(d.year, d.month, d.day, d.hour);
      var dd = Math.abs(back.jd - r.jd);
      if (dd > worst) { worst = dd; worstName = e.join('-'); }
    });
    ok(worst < 1e-4, '往返 JD 残差过大 ' + worst + '（' + worstName + '）');
    return '12/12 一致，最大 JD 残差 ' + worst.toExponential(2) + ' 日（' + worstName + '）';
  });
  T('同一时刻的不同 UTC 偏移解析必须给出同一 JD', function () {
    var a = parseTime('2000-01-01T12:00:00Z'), b = parseTime('2000-01-01T14:00:00+02:00'),
      c = parseTime('2000-01-01T07:00:00-05:00'), d = parseTime('2000-01-01T17:15:00+05:15'),
      e = parseTime('2000-01-01T12:00:00', { tzOffsetHours: 0 });
    [b, c, d, e].forEach(function (x) { ok(!x.error, '解析失败 ' + JSON.stringify(x).slice(0, 50)); });
    near(b.jd, a.jd, 1e-9, '+02:00 与 Z');
    near(c.jd, a.jd, 1e-9, '-05:00 与 Z');
    near(d.jd, a.jd, 1e-9, '+05:15 与 Z');
    near(e.jd, a.jd, 1e-9, '显式 tz=0 与 Z');
    near(b.jd, 2451545.0, 1e-9, '且等于 J2000.0');
    return '5 种写法 → JD ' + a.jd.toFixed(9) + '（含 +05:15 半小时区）';
  });
  T('格里高利世纪规则（400 年周期）', function () {
    ok(isLeap(1900) === false && isLeap(2000) === true && isLeap(2100) === false && isLeap(2400) === true, '闰年判定错');
    var a = jdFromParts(2100, 2, 28, 12), b = jdFromParts(2000, 2, 28, 12);
    near(a.jd - b.jd, 100 * 365 + 25, 1e-9, '2000-02-28→2100-02-28 应含 25 个闰日（2000..2096，2100 非闰）');
    ok(jdFromParts(2100, 2, 29, 0).error === 'bad_day', '2100-02-29 必须拒绝');
    return '2000→2100 同日跨 ' + (a.jd - b.jd) + ' 日，与 36525 日差 ' + ((a.jd - b.jd) - 36525);
  });
  T('格里高利历边界：1582-10-15 之前拒绝并注明', function () {
    var a = jdFromParts(1582, 10, 15, 0), b = jdFromParts(1582, 10, 14, 0), c = jdFromParts(1582, 10, 4, 0);
    near(a.jd, 2299160.5, 1e-9, '格里高利历首日 JD');
    ok(b.error === 'pre_gregorian', '1582-10-14 应拒绝，实得 ' + JSON.stringify(b).slice(0, 40));
    ok(c.error === 'pre_gregorian', '1582-10-04 应拒绝');
    var ts = timeSystems(a.jd);
    ok(/闰秒/.test(ts.leap_second_note), 'timeSystems 必须声明不处理闰秒');
    return '1582-10-15→2299160.5；1582-10-14/10-04 → ' + b.error + '；' + c.error;
  });

  /* ---- 2. 恒星时 */
  T('GMST 微分恒等：每天 1.002737909 转（6 位小数）', function () {
    var es = [J2000, 2451545.0 + 9458, 2451545.0 + 45000, 2451545.0 - 30000];
    var worst = 0, worstA = 0, list = [];
    es.forEach(function (jd) {
      // 用**未卷绕**的 deg_raw：θ 每天真前进 360.9856° = 1.002737909 转，而卷绕后的
      // deg 只剩 0.9856°，「转数」被丢掉整数部分（初版用 deg 做差分，得到 0.0027 转，
      // 于是 6 位小数断言必然失败 —— 这是期望/实现口径不一致，不是多项式写错）。
      var a = gmst(jd), b = gmst(jd + 1);
      var rev = (b.deg_raw - a.deg_raw) / 360;
      worst = Math.max(worst, Math.abs(rev - 1.002737909));
      list.push(rev.toFixed(9));
      // 第二条独立校验：解析导数。T = d/36525 是**日数的函数**，链式法则必须带 1/36525：
      //   dθ/dd = 360.98564736629 + (2·0.000387933·T − 3T²/38710000)/36525
      // 初版漏掉 1/36525，把 T² 项的导数放大了 36525 倍（T=1.23 时差 2.7e-3 度/日），
      // 于是在 45000 日历元处报出 2.65e-6 转/日的「差分不一致」——那是解析式写错，不是实现错。
      var T = (jd - J2000) / 36525;
      var dth = 360.98564736629 + (2 * 0.000387933 * T - 3 * T * T / 38710000) / 36525;
      // 容差不是拍的：deg_raw 量级 ~3.6e7·|d|，两次求值 + 一次相减的舍入误差
      // ≤ (|a|+|b|)·2⁻⁵² 度；再加油差 0.000387933·h²（h=1 日）的截断 ~3e-11 度。
      var noise = (Math.abs(a.deg_raw) + Math.abs(b.deg_raw)) * 2.220446049250313e-16 / 360 + 1e-13;
      worstA = Math.max(worstA, Math.abs(rev - dth / 360) / noise);
      ok(rev > 1 && rev < 1.01, '一日内恒星时转数必须略大于 1：' + rev);
    });
    ok(worst < 5e-7, '恒星时速率偏离 1.002737909 超过 5e-7：' + worst);
    ok(worstA < 1, '有限差分与解析导数之差超出「浮点舍入+差分截断」合成包络，达包络的 ' + (worstA * 100).toFixed(1) + '%');
    return '四个历元的转/日 = [' + list.join(', ') + ']，对 1.002737909 最大偏离 ' + worst.toExponential(2) +
      '；与解析导数（含 1/36525 链式因子）的一致残差 ≤ 合成包络的 ' + (worstA * 100).toFixed(1) + '%（抓 T²/T³ 项与一次项系数写错）';
  });
  T('GMST(J2000.0) 锚点 18h41m50s', function () {
    var g = gmst(J2000);
    var refDeg = 280.46061837;
    near(g.deg, refDeg, 1e-6, 'θ(2451545.0) 应回到常数项 280°.46061837（T=0 时 T²/T³ 项为 0）');
    var hms = g.hms;
    var secs = hms.h * 3600 + hms.m * 60 + hms.s, ref = 18 * 3600 + 41 * 60 + 50;
    ok(Math.abs(secs - ref) < 5, '与 18h41m50s 差应 <5 秒（时间秒），实得 ' + (secs - ref).toFixed(3) + ' s');
    return hms.text + '（与参考差 ' + (secs - ref).toFixed(3) + ' 时间秒 = ' + ((secs - ref) * 15).toFixed(2) + ' 角秒）';
  });
  T('章动与等分点方程幅度有界', function () {
    var maxP = 0, maxE = 0, maxEq = 0;
    for (var i = 0; i < 3000; i++) {
      var n = eop(J2000 + i * 5.3);
      maxP = Math.max(maxP, Math.abs(n.dpsi_arcsec)); maxE = Math.max(maxE, Math.abs(n.deps_arcsec));
      maxEq = Math.max(maxEq, Math.abs(n.equation_of_equinoxes_deg));
    }
    var envP = 17.20 + 1.32 + 0.23 + 0.21, envE = 9.20 + 0.57 + 0.10 + 0.09;
    ok(maxP <= envP + 1e-6 && maxP >= 17.2 * 0.9, 'Δψ 幅度 ' + maxP + '″ 应 ≤' + envP + '″ 且 ≥15.5″');
    ok(maxE <= envE + 1e-6 && maxE >= 9.2 * 0.9, 'Δε 幅度异常：' + maxE);
    ok(maxEq <= maxP / 3600 + 1e-12, '等分点方程 |Δψcosε| 不得超过 |Δψ|');
    return 'max|Δψ|=' + maxP.toFixed(3) + '″（包络 ' + envP.toFixed(2) + '″），max|Δε|=' + maxE.toFixed(3) + '″，max|eqeq|=' + (maxEq * 3600).toFixed(3) + '″（18.6 年周期已扫到）';
  });

  /* ---- 3. 太阳 */
  T('日下点纬度始终在当年回归线内（±ε(T)）', function () {
    var worst = 0, n = 0, epsMax = 0;
    for (var y = 1900; y <= 2100; y += 7) {
      var jd = jdFromParts(y, 1, 1, 0).jd;
      var eps = meanObliquity((jd - J2000) / 36525); epsMax = Math.max(epsMax, eps);
      for (var k = 0; k < 50; k++) {
        var s = subSolarPoint(jd + k * 7.31);
        if (s.error) continue;
        n++;
        worst = Math.max(worst, Math.abs(s.lat) - s.declination_bound_deg);
        ok(Math.abs(s.lat) <= 90, '日下点纬度越界 ' + s.lat);
      }
    }
    ok(worst < 1e-3, '日下点纬度超出回归线包络 ' + worst + '°（ε_max=' + epsMax.toFixed(4) + '°）');
    // 期望值修正：黄赤交角**随时间减小**（现时速率 ≈ −46.8″/世纪），所以 1900—2100 区间
    // 的最大值出现在 1900 端：ε(−1 世纪) = 23.439291 + 46.8150/3600 ≈ 23.45229°。
    // 初版把包络写成 (23.40, 23.45)，等于要求「1900 年比 2000 年小」，方向记反了。
    ok(epsMax > 23.45 && epsMax < 23.46, 'ε 区间上限（应≈ε(1900)=23.4523）不对：' + epsMax);
    var e1 = meanObliquity(0), e2 = meanObliquity(1 / 36525);       // 一日差分
    var rate = (e2 - e1) * 36525 * 3600;                             // ″/世纪
    ok(rate < -46.7 && rate > -46.9, 'dε/dT 应≈−46.815″/世纪，实得 ' + rate.toFixed(3));
    ok(Math.abs(e1 - (23 + 26 / 60 + 21.448 / 3600)) < 1e-6, 'ε(0) 应=23°26′21″.448，实得 ' + e1);
    return n + ' 个历元，|φ_sub|−ε 最大 ' + worst.toExponential(2) + '°；ε 区间上限 ' + epsMax.toFixed(4) +
      '°（=ε(1900)，因交角随时间**减小**）、ε(J2000)=' + e1.toFixed(6) + '°=23°26′21″.448，' +
      '一日差分速率 ' + rate.toFixed(2) + '″/世纪（应为负）';
  });
  T('至点用求根得到，且与「黄经=90°」时刻一致、δ=ε', function () {
    // 定区间用「太阳平黄经速率 0.98565°/d」独立推得，而不是写死日历：
    // 2026-01-01 时 λ⊙≈280.46+35999.05·0.26/36525·… 太绕；直接取
    // 「λ 需再走 90°−λ(6-01) ≈ 19° ⇒ 约 20 天」⇒ 区间 [6-05, 6-25] 覆盖。
    var jd0 = jdFromParts(2026, 6, 1, 0).jd;
    var lam0 = sunApparent(jd0).lon_apparent_deg;
    var daysToSolstice = wrap180(90 - lam0) / (36000.76853 / 36525);   // 平黄经速率估的剩余天数
    var guess = jd0 + daysToSolstice;
    ok(daysToSolstice > 15 && daysToSolstice < 25, '由平黄经速率推的夏至剩余天数异常：' + daysToSolstice.toFixed(2));
    var r = findRoot(function (t) { return wrap180(sunApparent(t).lon_apparent_deg - 90); }, guess - 2, guess + 2, 80);
    ok(r.root != null, '未找到黄经 90° 的时刻：' + JSON.stringify(r).slice(0, 60));
    var s = sunApparent(r.root);
    // δ 极大时刻（扫描求最大，独立于「λ=90°」这条判据）
    var jdMax = guess - 3, best = -90;
    for (var k = 0; k <= 1200; k++) { var t = guess - 3 + k / 200; var d = sunApparent(t).dec_deg; if (d > best) { best = d; jdMax = t; } }
    var dtH = (r.root - jdMax) * 24;
    ok(Math.abs(dtH) < 2, 'δ 极大时刻与 λ=90° 时刻应相差 <2 h，实得 ' + dtH.toFixed(3) + ' h');
    near(s.dec_deg, s.eps_true_deg, 1e-6, 'λ=90° 时 δ 必等于视黄赤交角（sinδ=sinλ·sinε, β=0, λ=90°）');
    // 独立球面恒等式 sinδ = sinλ·sinε（β=0）在一年内的残差
    var jdA = jdFromParts(2026, 1, 1, 0).jd, resid = 0;
    for (var j = 0; j < 60; j++) {
      var tt = jdA + j * 6.13; var ss = sunApparent(tt);
      var pr = Math.asin(clamp(Math.sin(ss.lon_apparent_deg * D2R) * Math.sin(ss.eps_true_deg * D2R), -1, 1)) * R2D;
      resid = Math.max(resid, Math.abs(pr - ss.dec_deg));
    }
    ok(resid < 1e-4, '太阳球面恒等式 sinδ=sinλsinε 残差过大：' + resid);
    ok(best > 23.4 && best < 23.45, '扫描出的 δ 极大值应≈+ε≈23.44°，实得 ' + best.toFixed(5));
    return 'λ=90° 时刻 ' + jdToDateText(r.root) + '（' + r.root.toFixed(4) + '），δ=' + s.dec_deg.toFixed(6) +
      '°=ε_true(' + s.eps_true_deg.toFixed(6) + ')；δ 极大时刻差 ' + dtH.toFixed(3) + ' h；扫描 δ_max=' +
      best.toFixed(6) + '°；恒等式残差 ' + resid.toExponential(2) + '°；平黄经速率预测剩余 ' + daysToSolstice.toFixed(2) + ' 天';
  });
  T('春分（黄经 0°）时 δ=0；点光源下赤道昼长=180°/真太阳时角速率', function () {
    var jd0 = jdFromParts(2026, 3, 20, 0).jd;
    var r = findRoot(function (t) { return wrap180(sunApparent(t).lon_apparent_deg); }, jd0 - 5, jd0 + 5, 80);
    ok(r.root != null, '未找到春分：' + JSON.stringify(r).slice(0, 60));
    var s = sunApparent(r.root);
    near(s.dec_deg, 0, 1e-6, '春分 δ 应为 0');
    // 点光源+无折射=解析可验的情形：必须显式关掉日面半径（sunEvents 默认取 −0.26667°
    // 的「上边缘」阈值，那是把半径与折射合并写的，留着它昼长会变 12.033 h）。
    var geo = sunEvents(r.root - 0.5, 0, 0, { refraction: false, semidiameter_deg: 0 });
    ok(!geo.error && geo.day_length_h != null, '赤道无折射昼长求解失败：' + JSON.stringify(geo).slice(0, 80));
    var an = analyticDayLength(0, s.dec_deg, 0);
    near(an.H0_deg, 90, 1e-9, 'φ=0 时 cosH0=(0−0)/(cos0·cosδ)=0 ⇒ H0 恒为 90°（与 δ 无关）');
    // 12 h 只是「平太阳」口径。半圈 180° 时角用的时间 = 180/真太阳时角速率，
    // 而速率 = GMST 速率 − 太阳赤经速率（春分处 dα/dt=cosε·dλ/dt，比 0.9856 小），
    // 故应略小于 12 h。下面用两条独立差分算出这个期望值，再与数值解比对。
    var jdR = r.root;
    var gmstRate = (gmst(jdR + 0.5).deg_raw - gmst(jdR - 0.5).deg_raw);           // 度/日
    var raRate = wrap180(sunApparent(jdR + 0.5).ra_deg - sunApparent(jdR - 0.5).ra_deg);
    var haRate = gmstRate - raRate;                                               // 度/日
    var expectH = 180 / haRate * 24;
    ok(raRate > 0.85 && raRate < 0.95, '春分处太阳赤经速率应≈cosε·0.9856=0.904°/d，实得 ' + raRate.toFixed(4));
    near(geo.day_length_h, expectH, 0.005, '数值求根昼长 vs 「180°/真太阳时角速率」解析期望');
    near(geo.day_length_h, 12, 0.02, 'h0=0、δ=0 时赤道昼长应≈12 h（平太阳口径，容差含真太阳速率差）');
    return '春分 ' + jdToDateText(r.root) + ' δ=' + s.dec_deg.toExponential(2) + '°；无半径无折射昼长 ' +
      geo.day_length_h.toFixed(4) + ' h，解析期望 ' + expectH.toFixed(4) + ' h（GMST 速率 ' + gmstRate.toFixed(4) +
      ' − 太阳赤经速率 ' + raRate.toFixed(4) + ' = 时角速率 ' + haRate.toFixed(4) + ' °/d）；与 12 h 差 ' +
      ((geo.day_length_h - 12) * 3600).toFixed(1) + ' 秒';
  });
  T('正午高度恒等式 h = 90 − |φ − δ|（独立校验）', function () {
    var stations = [[31.23, 121.47], [0, 0], [-33.87, 151.21], [64.13, -21.9], [-80, 0], [45, 90]];
    var worst = 0, rows = [];
    stations.forEach(function (st) {
      for (var m = 0; m < 6; m++) {
        var jd0 = jdFromParts(2026, 1 + m * 2, 3, 0).jd;
        var tr = transitEvents(function (t) { return sunApparent(t); }, jd0, st[0], st[1]);
        if (tr.error || tr.upper_transit_jd == null) continue;
        var a = sunApparent(tr.upper_transit_jd);
        var h = equToHor(a.ra_deg, a.dec_deg, st[0], gmst(tr.upper_transit_jd).deg + wrap180(st[1]));
        var pred = 90 - Math.abs(st[0] - a.dec_deg);
        worst = Math.max(worst, Math.abs(h.alt_deg - pred));
        rows.push(st[0] + '°:' + h.alt_deg.toFixed(4) + '/' + pred.toFixed(4));
      }
    });
    ok(worst < 1e-3, '正午高度恒等式残差 ' + worst);
    ok(rows.length >= 30, '样本太少：' + rows.length);
    return rows.length + ' 组（6 站 × 6 月），最大残差 ' + worst.toExponential(2) + '°；例 ' + rows[0] + ' / ' + rows[12];
  });
  T('太阳中心差振幅 = 2e（抓 1.9146 类系数）', function () {
    var jdA = jdFromParts(2026, 1, 1, 0).jd, maxEOC = 0, maxPar = 0;
    for (var i = 0; i <= 400; i++) {
      var t = jdA + i * 0.9, el = sunElements((t - J2000) / 36525), nu = sunTrueAnomalyRad(el.M, el.e);
      maxEOC = Math.max(maxEOC, Math.abs(nu.equation_of_center * R2D));
      var s = sunApparent(t);
      maxPar = Math.max(maxPar, s.horizontal_parallax_arcsec);
    }
    var e = 0.016708617, pred = 2 * e * R2D;
    ok(Math.abs(maxEOC - pred) < 0.002, '实测中心差峰值 ' + maxEOC.toFixed(6) + '° 应≈2e=' + pred.toFixed(6) + '°');
    var parFromRadius = Math.asin(clamp(EARTH_RADIUS_KM / 149597870.7, -1, 1)) * R2D * 3600;
    ok(Math.abs(8.794 - parFromRadius) < 0.02, '太阳地平视差常数 8.794″ 与 arcsin(R⊕/1AU)=' + parFromRadius.toFixed(4) + '″ 不符');
    return '峰值 |ν−M| = ' + maxEOC.toFixed(6) + '°（2e 预测 ' + pred.toFixed(6) + '°，差 ' + (maxEOC - pred).toFixed(6) + '°）；8.794″ 由 R⊕/AU 独立复算 ' + parFromRadius.toFixed(4) + '″';
  });
  T('回归年 365.2422 d（抓 36000.76853 长期系数）', function () {
    var rate = 36000.76853 / 36525;             // 度/日：太阳平黄经速率
    var year = 360 / rate;
    near(year, 365.2421905, 1e-4, '由平黄经速率推回归年');
    var jd0 = jdFromParts(2026, 3, 20, 0).jd;
    var r1 = findRoot(function (t) { return wrap180(sunApparent(t).lon_apparent_deg); }, jd0 - 6, jd0 + 6, 80);
    var r2 = findRoot(function (t) { return wrap180(sunApparent(t).lon_apparent_deg); }, jd0 + 360, jd0 + 372, 80);
    ok(r1.root != null && r2.root != null, '求根失败');
    var tropical = r2.root - r1.root;
    ok(Math.abs(tropical - year) < 0.05, '两次春分实测间隔 ' + tropical.toFixed(4) + ' d 与解析 ' + year.toFixed(4) + ' d 不符（差 ' + (tropical - year).toFixed(4) + ' d）');
    return '解析 ' + year.toFixed(6) + ' d；2026→2027 春分实测 ' + tropical.toFixed(4) + ' d（差 ' + (tropical - year).toFixed(4) + ' d，含地球轨道偏心率效应）';
  });
  T('昼长：数值解 vs 解析 cosH0 对照', function () {
    var cases = [[0, 0], [31.23, 121.47], [-33.87, 151.21], [60, 20]];
    var worst = 0, rows = [];
    cases.forEach(function (c) {
      for (var m = 0; m < 5; m++) {
        var jd0 = jdFromParts(2026, 1 + m * 2, 10, 0).jd;
        var s = sunApparent(jd0 + 0.5);
        var an = analyticDayLength(c[0], s.dec_deg, -0.833);
        var ev = sunEvents(jd0, c[0], c[1], { refraction: false, semidiameter_deg: 0.26667 });
        if (an.error || ev.error || ev.day_length_h == null || an.day_length_h == null) continue;
        var d = Math.abs(ev.day_length_h - an.day_length_h);
        worst = Math.max(worst, d);
        if (d > 0.35) throw new Error('数值/解析昼长差 ' + d.toFixed(3) + ' h @' + c[0] + '°');
      }
    });
    return '最大差 ' + worst.toFixed(4) + ' h（解析式在一天内取 δ 为常数，故只能到 0.x h 级）';
  });
  T('赤道日出地方时 ≈ 6 h 与含折射昼长（自算，不写死）', function () {
    var jdEq = findRoot(function (t) { return wrap180(sunApparent(t).lon_apparent_deg - 90); }, jdFromParts(2026, 6, 1, 0).jd, jdFromParts(2026, 6, 30, 0).jd, 80);
    var ev = sunEvents(jdEq.root - 0.5, 0, 0, {});
    ok(!ev.error && ev.sunrise_jd != null, '赤道日出求解失败');
    var noon = ev.upper_transit_jd != null ? ev.upper_transit_jd : null;
    var tr = transitEvents(function (t) { return sunApparent(t); }, jdEq.root - 0.6, 0, 0);
    ok(tr.upper_transit_jd != null, '中天求解失败');
    var morningH = (tr.upper_transit_jd - ev.sunrise_jd) * 24;
    ok(Math.abs(morningH - 6) < 0.12, '日出到地方正午应≈6 h，实得 ' + morningH.toFixed(3) + ' h');
    var dl = ev.day_length_h;
    ok(dl > 12.0 && dl < 12.35, '赤道含折射+日半径昼长应在 12.0~12.35 h，实得 ' + dl);
    var noAtmo = sunEvents(jdEq.root - 0.5, 0, 0, { refraction: false });
    var geoOnly = sunEvents(jdEq.root - 0.5, 0, 0, { refraction: false, semidiameter_deg: 0 });
    return '昼长(折射+日半径) ' + dl.toFixed(4) + ' h；仅日半径 ' + noAtmo.day_length_h.toFixed(4) + ' h；纯几何点光源 ' + geoOnly.day_length_h.toFixed(4) + ' h；日出距正午 ' + morningH.toFixed(3) + ' h（折射使日出提前，Bennett 给 ' + refraction(0).arcmin.toFixed(2) + '′，年历标准 34′）';
  });
  T('晨昏蒙影次序与高纬无黑夜标记', function () {
    var jd0 = jdFromParts(2026, 6, 21, 0).jd;
    var ev = sunEvents(jd0, 51.5, -0.13, {});
    ok(!ev.error, '伦敦夏至求解失败');
    var c = ev.twilight.civil, n2 = ev.twilight.nautical, a = ev.twilight.astronomical;
    ok(c.evening_jd != null && n2.evening_jd != null, '伦敦夏至应有民用/航海晨昏');
    ok(c.evening_jd < n2.evening_jd, '民用晨昏必须早于航海晨昏（太阳更晚到 −6°）');
    ok(a.status === 'no_darkness', '伦敦夏至天文晨昏应判为无黑夜，实得 ' + a.status);
    var polar = sunEvents(jd0, 78.9, 11.9, {});     // 斯瓦尔巴
    ok(polar.no_set === true && polar.no_rise === true && polar.polar_state === 'polar_day', '极昼应给明确标记，实得 ' + JSON.stringify({ ns: polar.no_set, nr: polar.no_rise, st: polar.polar_state }));
    ok(isNum(polar.day_length_h) && polar.day_length_h === 24, '极昼昼长应为 24 h，实得 ' + polar.day_length_h);
    var night = sunEvents(jdFromParts(2026, 12, 21, 0).jd, 78.9, 11.9, {});
    ok(night.polar_state === 'polar_night' && night.day_length_h === 0 && night.rise_jd === undefined, '极夜应判 0 h，实得 ' + night.polar_state + '/' + night.day_length_h);
    ok(night.sunrise_jd === null && night.sunset_jd === null, '极夜不得返回 NaN 时刻');
    return '伦敦：民用 ' + (c.evening_jd - jd0).toFixed(3) + ' d < 航海 ' + (n2.evening_jd - jd0).toFixed(3) + ' d，天文=' + a.status + '；斯瓦尔巴夏至 ' + polar.polar_state + '/24h，冬至 ' + night.polar_state + '/0h';
  });
  T('太阳地平高度满足球面恒等式 sin h = sinφ sinδ + cosφ cosδ cos H', function () {
    var worst = 0;
    for (var i = 0; i < 40; i++) {
      var r = lcg(7000 + i);
      var jd = J2000 + r() * 6000 - 3000, lat = r() * 179 - 89.5, lon = r() * 360 - 180;
      var a = sunApparent(jd), g = gmst(jd);
      var h = equToHor(a.ra_deg, a.dec_deg, lat, g.deg + wrap180(lon));
      if (h.error) continue;
      var pred = Math.asin(clamp(Math.sin(lat * D2R) * Math.sin(a.dec_deg * D2R) + Math.cos(lat * D2R) * Math.cos(a.dec_deg * D2R) * Math.cos(h.ha_deg * D2R), -1, 1)) * R2D;
      worst = Math.max(worst, Math.abs(pred - h.alt_deg));
      var Hpred = wrap180(g.deg + wrap180(lon) - a.ra_deg);
      ok(Math.abs(wrap180(h.ha_deg - Hpred)) < 1e-9, '时角定义不自洽');
      ok(Math.abs(h.alt_deg + h.zenith_dist_deg - 90) < 1e-12, '天顶距恒等式失败');
    }
    ok(worst < 1e-9, '球面恒等式残差 ' + worst);
    return '40 组随机（时角/天顶距/高度）恒等式最大残差 ' + worst.toExponential(2) + '°（同式两侧共用实现，主要抓实现内算术错误）';
  });

  /* ---- 4. 月亮 */
  T('月下点纬度 = 月赤纬、经度 = RA−GMST（几何恒等式）', function () {
    var worstLat = 0, worstLon = 0, n = 0;
    for (var i = 0; i < 40; i++) {
      var r = lcg(31000 + i), jd = J2000 + r() * 20000 - 10000;
      var m = moonPosition(jd), s = subLunarPoint(jd), g = gmst(jd);
      if (m.error || s.error) continue;
      n++;
      worstLat = Math.max(worstLat, Math.abs(s.lat - m.dec_deg));
      worstLon = Math.max(worstLon, Math.abs(wrap180(s.lon - wrap180(m.ra_deg - g.deg))));
      ok(Math.abs(s.lat) <= 28.6, '月下点纬度超界（含交点退化的几何上限 ~28.6°）：' + s.lat);
    }
    ok(worstLat === 0, '月下点纬度与月赤纬必须逐位相等（抓坐标变换写反），实得差 ' + worstLat);
    ok(worstLon < 1e-9, '月下点经度与 RA−GMST 差 ' + worstLon);
    return n + ' 个历元：纬度差恒为 ' + worstLat + '，经度差 < ' + worstLon.toExponential(2) + '°；|φ_sub| 上限检查 28.6°';
  });
  T('照明分数 f=(1+cos i)/2 严格成立 + 平行光线近似之差有界', function () {
    var worstStrict = 0, worstApprox = 0, n = 0;
    for (var i = 0; i < 60; i++) {
      var jd = J2000 + i * 0.49;
      var p = moonPhase(jd); if (p.error) continue;
      n++;
      var f = (1 + Math.cos(p.phase_angle_deg * D2R)) / 2;
      worstStrict = Math.max(worstStrict, Math.abs(f - p.illumination_fraction));
      worstApprox = Math.max(worstApprox, Math.abs(p.illumination_parallel_approx - p.illumination_fraction));
      ok(p.illumination_fraction >= 0 && p.illumination_fraction <= 1, '照明分数越界 ' + p.illumination_fraction);
    }
    ok(worstStrict < 1e-12, '严格式残差 ' + worstStrict);
    ok(worstApprox < 0.01, '与 (1−cos E)/2 的差应 ≤0.01（量级 r_moon/r_sun≈0.0026），实得 ' + worstApprox);
    return n + ' 个历元：严格式残差 ' + worstStrict.toExponential(2) + '；‖(1−cosE)/2 − f‖max = ' + worstApprox.toFixed(5) + '（月—日距比 ' + (384400 / 149597870).toExponential(2) + '）';
  });
  T('月心相位角：日—地—月三角形内角和 i+E+S=180°（S=日面张角）', function () {
    // 「i = 180° − E」只在**平行光线**下成立。严格地：日、地、月三点构成平面三角形，
    // 三个内角之和恰为 180°，其中日心处的角 S 由正弦定理 sin S = (Δ地月/Δ月日)·sin E 给出。
    // S 的上限 = arcsin(384400/147100000) = 0.1498°（不是初版记的 0.26′=0.0043°——
    // 那个数是把「分」与「角分」的量级记错了两个数量级）。本断言用矢量路径独立复算 E、i。
    var worstSum = 0, worstI = 0, worstE = 0, worstS = 0, n = 0, maxS = 0;
    for (var k = 0; k < 40; k++) {
      var jd = J2000 + k * 0.73;
      var p = moonPhase(jd); if (p.error) continue;
      var m = moonEcliptic(jd), s = sunApparent(jd); if (m.error || s.error) continue;
      n++;
      var rM = m.dist_km, rS = s.geo_center_km;
      var um = { x: m.x, y: m.y, z: m.z };                                  // 地心→月球 单位矢（赤道系）
      var sr = s.ra_deg * D2R, sd = s.dec_deg * D2R;
      var us = { x: Math.cos(sd) * Math.cos(sr), y: Math.cos(sd) * Math.sin(sr), z: Math.sin(sd) };
      var cosE = clamp(um.x * us.x + um.y * us.y + um.z * us.z, -1, 1);
      var Ev = Math.acos(cosE) * R2D;                                       // 独立路径的距角
      var vx = rS * us.x - rM * um.x, vy = rS * us.y - rM * um.y, vz = rS * us.z - rM * um.z;  // 月→日
      var dMS = Math.hypot(vx, vy, vz);
      var cosIv = clamp((-um.x * vx - um.y * vy - um.z * vz) / dMS, -1, 1);  // 月→地 = −um
      var iv = Math.acos(cosIv) * R2D;
      var Sv = Math.asin(clamp(rM * Math.sin(Ev * D2R) / dMS, -1, 1)) * R2D;
      worstE = Math.max(worstE, Math.abs(Ev - p.elongation_deg));
      worstI = Math.max(worstI, Math.abs(iv - p.phase_angle_deg));
      var sum = iv + Ev + Sv;
      worstSum = Math.max(worstSum, Math.abs(sum - 180));
      maxS = Math.max(maxS, Sv);
      // 正弦定理：i 的对边是日—地（rS），E 的对边是月—日（dMS）⇒ sin i·dMS = sin E·rS
      worstS = Math.max(worstS, Math.abs(Math.sin(iv * D2R) * dMS - Math.sin(Ev * D2R) * rS) / rS);
    }
    ok(n >= 38, '样本不足 ' + n);
    ok(worstI < 1e-9, '矢量路径复算的相位角与 moonPhase 不一致，最大 ' + worstI.toExponential(2) + '°');
    ok(worstE < 1e-9, '矢量路径复算的距角与 moonPhase 不一致，最大 ' + worstE.toExponential(2) + '°');
    ok(worstSum < 1e-9, '三角形内角和偏离 180° 达 ' + worstSum.toExponential(2) + '°');
    ok(worstS < 1e-9, '正弦定理两边比不一致 ' + worstS.toExponential(2));
    ok(maxS > 0.14 && maxS < 0.16, '日面张角上限应≈arcsin(Δ地月/Δ月日)=0.150°，实得 ' + maxS.toFixed(5) + '°');
    return n + ' 个历元：i+E+S−180 最大残差 ' + worstSum.toExponential(2) + '°；矢量复算 i、E 与 API 一致（' +
      worstI.toExponential(2) + '/' + worstE.toExponential(2) + '°）；S 实测最大 ' + maxS.toFixed(4) +
      '°（这就是「i=180−E」的破绽量级，非 0.004°）；正弦定理残差 ' + worstS.toExponential(2);
  });
  T('朔望序列：黄经差极值、照明极值、朔望月均长', function () {
    var start = jdFromParts(2024, 1, 1, 0).jd;
    var xs = [], step = 0.02, prev = null, acc = 0;
    for (var t = start; t < start + 380; t += step) {
      var p = moonPhase(t); if (p.error) continue;
      var e = p.ecliptic_elongation_deg;
      if (prev != null) { var d = e - prev; if (d > 180) d -= 360; if (d < -180) d += 360; acc += d; }
      else acc = e;
      prev = e; xs.push({ t: t, e: acc, f: p.illumination_fraction, i: p.phase_angle_deg });
    }
    var news = [], fulls = [];
    // 求根口径：朔 = 累距角 ≡ 0 (mod 360)，望 = ≡ 180。两者都先把累距角卷到 ±180 再看变号，
    // 初版对「朔」用了 k0.e·k1.e<0（未卷绕）——累距角一路单调增大，永远不过 0，于是朔数为 0。
    // 卷绕后的**假变号**（望处 +180→−180）用「相邻步长不能超过 5°」排除：真变号处步长仅 ~0.25°。
    for (var k = 1; k < xs.length; k++) {
      var k0 = xs[k - 1], k1 = xs[k];
      if (k1.t - k0.t > step * 1.5) continue;                    // 被 error 打断的相邻对不做插值
      var n0 = wrap180(k0.e), n1 = wrap180(k1.e);
      var g0 = wrap180(k0.e - 180), g1 = wrap180(k1.e - 180);
      if (n0 * n1 < 0 && Math.abs(n0 - n1) < 5) { var w = n0 / (n0 - n1); news.push({ t: k0.t + w * step, f: k0.f + w * (k1.f - k0.f) }); }
      if (g0 * g1 < 0 && Math.abs(g0 - g1) < 5) { var w2 = g0 / (g0 - g1); fulls.push({ t: k0.t + w2 * step, f: k0.f + w2 * (k1.f - k0.f) }); }
    }
    ok(news.length >= 10, '朔事件太少：' + news.length);
    ok(fulls.length >= 10, '望事件太少：' + fulls.length);
    ok(Math.abs(news.length - fulls.length) <= 1, '380 日内朔/望计数应相差 ≤1：' + news.length + ' vs ' + fulls.length);
    var fNew = 0, fFull = 1;
    news.forEach(function (x) { fNew = Math.max(fNew, x.f); });
    fulls.forEach(function (x) { fFull = Math.min(fFull, x.f); });
    ok(fNew < 0.02, '朔时照明分数应 <0.02，实得 ' + fNew.toFixed(5));
    ok(fFull > 0.98, '望时照明分数应 >0.98，实得 ' + fFull.toFixed(5));
    var iv = [];
    for (var q = 1; q < news.length; q++) iv.push(news[q].t - news[q - 1].t);
    var mean = iv.reduce(function (s, x) { return s + x; }, 0) / iv.length;
    // 独立期望：平均朔望月 = 360°/平距角日变化率，直接由 moonElements 的 D_raw 差分得到，
    // 与「真黄经差求根」是完全不同的两条算术路径（周期项在长窗口内相互抵消）。
    var el0 = moonElements(0.2), el1 = moonElements(0.2 + 1 / 36525);
    var dRate = (el1.D_raw - el0.D_raw), expSyn = 360 / dRate;
    ok(dRate > 12.18 && dRate < 12.20, '平距角日变化率异常：' + dRate);
    ok(Math.abs(mean - 29.530588853) < 0.01, '380 日真朔均长偏离文献值 29.53059 d：' + mean.toFixed(5));
    // 「360/平距角速率」必须拿**长基线**比。恒等式（b=dRate，Δ=累距角对直线 b·t 的偏离）：
    //   b·(t_N − t_0) = 360N − (Δ_N − Δ_0) ⇒ mean_N = 360/b − (Δ_N − Δ_0)/(b·N)
    // 380 日窗口 N=12，端点偏离残差实测把均值推 +0.0074 d——那是估计量的端点效应，不是模型错；
    // 初版容差 0.006 却按「N→∞ 的极限」去卡 12 个周期，所以破的是期望。改用 20 年基线，
    // 容差取恒等式给的包络 2·max|Δ|/(b·N) 再加求根端点的离散误差 2·step/N。
    var stepL = 0.25, prevL = null, accL = 0, xsL = [];
    for (var tl = start; tl < start + 7305; tl += stepL) {
      var pL = moonPhase(tl); if (pL.error) continue;
      var eL = pL.ecliptic_elongation_deg;
      if (prevL != null) { var dL = eL - prevL; if (dL > 180) dL -= 360; if (dL < -180) dL += 360; accL += dL; } else accL = eL;
      prevL = eL; xsL.push({ t: tl, e: accL });
    }
    var newsL = [];
    for (var kL = 1; kL < xsL.length; kL++) {
      var aL = xsL[kL - 1], bL = xsL[kL];
      var nA = wrap180(aL.e), nB = wrap180(bL.e);
      if (nA * nB < 0 && Math.abs(nA - nB) < 5) newsL.push(aL.t + (nA / (nA - nB)) * stepL);
    }
    var cyc = newsL.length - 1;
    ok(cyc > 200, '20 年基线只数到 ' + cyc + ' 个朔（应≈247），长均长无统计意义');
    var meanLong = (newsL[cyc] - newsL[0]) / cyc;
    var maxDev = 0;
    for (var dI = 0; dI < xsL.length; dI++) {
      maxDev = Math.max(maxDev, Math.abs((xsL[dI].e - xsL[0].e) - dRate * (xsL[dI].t - xsL[0].t)));
    }
    var boundL = 2 * maxDev / (dRate * cyc) + 2 * stepL / cyc;
    ok(Math.abs(meanLong - expSyn) < boundL, '20 年真朔均长 ' + meanLong.toFixed(6) + ' 与 360/平距角速率 ' +
      expSyn.toFixed(6) + ' 之差超过恒等式端点包络 ' + boundL.toFixed(6) + '（max|Δ|=' + maxDev.toFixed(3) + '°，N=' + cyc + '）');
    ok(Math.abs(meanLong - 29.530588853) < 0.01, '20 年均长 ' + meanLong.toFixed(6) + ' 偏离文献 29.53059 d');
    ok(Math.abs(mean - meanLong) < 0.02, '短窗 ' + mean.toFixed(5) + ' 与长窗 ' + meanLong.toFixed(5) + ' 差得过多：' + Math.abs(mean - meanLong).toFixed(5));
    var spread = Math.max.apply(null, iv) - Math.min.apply(null, iv);
    ok(spread < 0.7, '真朔望月变化范围异常（应 <0.7 d）：' + spread.toFixed(4));
    // 交替性：朔与望必须严格交错（求根口径修正后不应再有伪断裂）
    var merged = news.map(function (x) { return ['N', x.t]; }).concat(fulls.map(function (x) { return ['F', x.t]; })).sort(function (a, b) { return a[1] - b[1]; });
    var breaks = 0;
    for (var z = 1; z < merged.length; z++) if (merged[z][0] === merged[z - 1][0]) breaks++;
    ok(breaks === 0, '朔/望未严格交替（' + breaks + ' 处）');
    return news.length + ' 朔 / ' + fulls.length + ' 望；朔 max f=' + fNew.toFixed(5) + '，望 min f=' + fFull.toFixed(5) +
      '；380 日均长 ' + mean.toFixed(6) + ' d，20 年(' + cyc + ' 周期)均长 ' + meanLong.toFixed(6) + ' d vs 360/b=' +
      expSyn.toFixed(6) + '（差 ' + (meanLong - expSyn).toFixed(6) + ' ≤ 包络 ' + boundL.toFixed(6) + '，max|Δ|=' +
      maxDev.toFixed(2) + '°）；文献 29.530589；极差 ' + spread.toFixed(4) + ' d；交替断裂 ' + breaks;
  });
  T('距角日变化率包络 = 平距角速率 − 太阳平均速率 ± Σ|振幅·相角速率|（抓 evection↔variation 互换）', function () {
    // 初版写死「10.5~14.0°/d」，实测 14.02 就破——但破的是**期望**：月距角速率本来就
    // 在 12.19 ± ~2.1°/d 之间摆（主项中心差 6.288774°×13.06°/d×D2R = 1.434°/d 一项就占大头）。
    // 这里改为「由级数表自己算出的严格包络」：|d/dt Σ a·sin θ| ≤ Σ|a·θ′|（θ′ 用平元素差分）。
    function rawEl(Tc) { var x = moonElements(Tc); return { L: x.L_raw, D: x.D_raw, M: x.M_raw, Mp: x.Mp_raw, F: x.F_raw }; }
    var T0 = 0.2, e1 = rawEl(T0), e2 = rawEl(T0 + 1 / 36525), envMoon = 0, argRates = {};
    MOON_TERMS_L.forEach(function (t) {
      var r = wrap180(moonArg(t.arg, e2) - moonArg(t.arg, e1));   // 相角日变化率（度/日）
      argRates[t.arg] = r;
      envMoon += Math.abs(t.amp) * Math.abs(r) * D2R;
    });
    // 太阳那一侧的贡献用**它自己的**视黄经速率离散范围（与月模型无关，独立测量）
    var sRate = [], i;
    for (i = 0; i < 400; i++) { var sjd = J2000 + i * 0.913; var s0 = sunApparent(sjd), s1 = sunApparent(sjd + 1); if (s0.error || s1.error) continue; sRate.push(wrap180(s1.lon_apparent_deg - s0.lon_apparent_deg)); }
    var sMin = Math.min.apply(null, sRate), sMax = Math.max.apply(null, sRate);
    var sMean = sRate.reduce(function (a, b) { return a + b; }, 0) / sRate.length;
    var envSun = (sMax - sMin) / 2;
    var base = moonElements(T0).rate_per_day - sMean;            // 13.17640 − 0.98553 ≈ 12.1909
    var env = envMoon + envSun;
    ok(envMoon > 1.9 && envMoon < 2.3, '月级数速率包络异常：' + envMoon.toFixed(4));
    ok(sMean > 0.98 && sMean < 0.992, '太阳平均视黄经速率异常：' + sMean.toFixed(5));
    var devs = [], mn = 1e9, mx = -1e9, sum = 0, cnt = 0;
    for (i = 0; i < 800; i++) {
      var jd = J2000 + i * 1.37;
      var p0 = moonPhase(jd), p1 = moonPhase(jd + 1);
      if (p0.error || p1.error) continue;
      var d = wrap180(p1.ecliptic_elongation_deg - p0.ecliptic_elongation_deg);
      devs.push(d); sum += d; cnt++;
      if (d < mn) mn = d; if (d > mx) mx = d;
    }
    ok(cnt >= 760, '样本不足 ' + cnt);
    var devMax = Math.max(mx - base, base - mn);
    ok(devMax <= env, '距角速率越出包络：最大偏离 ' + devMax.toFixed(4) + ' > Σ|a·θ′| = ' + env.toFixed(4) + '°/d');
    ok(devMax >= 0.8 * env, '距角速率摆幅只有包络的 ' + (100 * devMax / env).toFixed(1) + '%（摄动项被吃掉/振幅写小的征兆）');
    var mean = sum / cnt;
    ok(Math.abs(mean - base) < 0.01, '长期均值 ' + mean.toFixed(5) + ' 与「平月速率 − 平太阳速率」' + base.toFixed(5) + ' 不符（周期项未抵消=有长期错项）');
    // 第二条独立口径：20 年累距角总变化 / 总天数
    var jdA = J2000, acc0 = moonPhase(jdA).ecliptic_elongation_deg, prev = acc0, acc = acc0;
    for (var t = jdA + 0.25; t < jdA + 7305; t += 0.25) {
      var pp = moonPhase(t); if (pp.error) continue;
      var dd = pp.ecliptic_elongation_deg - prev; if (dd > 180) dd -= 360; if (dd < -180) dd += 360;
      acc += dd; prev = pp.ecliptic_elongation_deg;
    }
    var longRate = (acc - acc0) / 7305;
    ok(Math.abs(longRate - base) < 0.004, '20 年累距角平均速率 ' + longRate.toFixed(5) + ' 与基线 ' + base.toFixed(5) + ' 差太多');
    return cnt + ' 个历元：速率∈[' + mn.toFixed(4) + ', ' + mx.toFixed(4) + ']，均值 ' + mean.toFixed(5) +
      '，20 年累距角口径 ' + longRate.toFixed(5) + '；基线 ' + base.toFixed(5) + '（月平黄经 ' +
      moonElements(T0).rate_per_day.toFixed(5) + ' − 太阳均值 ' + sMean.toFixed(5) + '），包络 ' +
      env.toFixed(4) + ' = 月 Σ|a·θ′| ' + envMoon.toFixed(4) + ' + 太阳半幅 ' + envSun.toFixed(4) +
      '；实测最大偏离占包络 ' + (100 * devMax / env).toFixed(1) + '%（余量小，故对振幅/参数互换敏感）';
  });
  T('月位与独立二体 Kepler 解之差 ≈ 主摄动幅度', function () {
    var pr = modelProbe(20, 20251101);
    ok(pr.count === 20, '样本不足：' + pr.count);
    var mx = pr.maxAbs(pr.moon_vs_twobody_deg);
    ok(mx > 0.9 && mx < 2.2, '月黄经与二体解之差应在 evection 幅度附近（0.9°~2.2°），实得 ' + mx.toFixed(5) + '°');
    var mean = pr.moon_vs_twobody_deg.reduce(function (s, x) { return s + x; }, 0) / pr.count;
    ok(Math.abs(mean) < 0.35, '差值均值 ' + mean.toFixed(4) + '° 过大（说明长期项系数不一致）');
    var smax = pr.maxAbs(pr.sun_vs_twobody_deg);
    ok(smax < 0.02, '太阳黄经与二体解之差应 ≤0.02°（截断到 3 阶），实得 ' + smax.toExponential(2));
    return '月：max|Δλ|=' + mx.toFixed(5) + '°，均值 ' + mean.toFixed(5) + '°（evection 1.274° + variation 0.658° + 0.214° 的同相上限 2.146°）；太阳：max|Δλ|=' + smax.toExponential(2) + '°';
  });
  T('级数振幅探针（第二份录入 + 离心率物理约束，抓参数名互换/小数点错位）', function () {
    // 这里的表是**独立第二遍录入**，参数写成整数系数 (aD,aM,aMp,aF)，不经过 moonArg 的
    // 字符串分支：实现侧把 '2D-Mp' 错解析成 2D+Mp、或把某项振幅小数点写错，都会在这里露出来。
    // 顺带说明初版断言为什么错：probe 把某个元素设 90°、其余设 0° 时，'2D−Mp' 在
    // (D=0,Mp=90) 处是 sin(−90°)=−1，**并不为零**，所以级数和 6.288774−1.274202=5.014572
    // 才是对的；「和=单项振幅」这个期望本身站不住，不是实现错。
    var REF = {
      L: [[6.288774, 0, 0, 1, 0], [1.274202, 2, 0, -1, 0], [0.658314, 2, 0, 0, 0], [0.213618, 0, 0, 0, 2], [-0.185116, 0, 1, 0, 0]],
      B: [[5.128122, 0, 0, 0, 1], [0.280602, 0, 0, 1, 1], [0.277693, 0, 0, 1, -1], [0.173237, 2, 0, 0, -1], [0.055412, 2, 0, -1, 1], [0.046292, 2, 0, 1, -1]],
      R: [[-20905.355, 0, 0, 1, 0], [-3699.111, 2, 0, -1, 0], [-569.925, 0, 0, 0, 2], [-295.596, 2, 0, 0, 0], [48.888, 0, 1, 0, 0]]
    };
    function refSum(rows, el, cos) {
      var s = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], a = (r[1] * el.D + r[2] * el.M + r[3] * el.Mp + r[4] * el.F) * D2R;
        s += r[0] * (cos ? Math.cos(a) : Math.sin(a));
      }
      return s;
    }
    var rnd = lcg(20251101), worstL = 0, worstB = 0, worstR = 0;
    for (var k = 0; k < 60; k++) {
      var el = { L: 0, D: rnd() * 360, M: rnd() * 360, Mp: rnd() * 360, F: rnd() * 360, omega: 0, E: 1 };
      worstL = Math.max(worstL, Math.abs(moonSeriesSum(MOON_TERMS_L, el) - refSum(REF.L, el)));
      worstB = Math.max(worstB, Math.abs(moonSeriesSum(MOON_TERMS_B, el) - refSum(REF.B, el)));
      worstR = Math.max(worstR, Math.abs(moonSeriesSum(MOON_TERMS_R, el, Math.cos) - refSum(REF.R, el, true)));
    }
    ok(worstL < 1e-12 && worstB < 1e-12 && worstR < 1e-12,
      '实现与第二份录入不符：Δλ=' + worstL.toExponential(2) + ' Δβ=' + worstB.toExponential(2) + ' ΔΔ=' + worstR.toExponential(2));
    var am = termAmplitudes();
    var pMp = { L: 0, D: 0, M: 0, Mp: 90, F: 0, omega: 0, E: 1 }, pF = { L: 0, D: 0, M: 0, Mp: 0, F: 90, omega: 0, E: 1 };
    near(am.lon_at_Mp90, refSum(REF.L, pMp), 1e-12, 'Mp=90 探针 = 参考表同构型之和（含 2D−M′ 贡献 −1.274202）');
    near(am.lat_at_F90, refSum(REF.B, pF), 1e-12, 'F=90 探针 = 参考表同构型之和（Mp±F 两项不抵消）');
    near(am.dist_at_Mp90, refSum(REF.R, pMp, true), 1e-12, 'Mp=90 距离探针 = 参考表同构型之和');
    // 物理约束①：黄经主项就是轨道方程中心 2e（弧度）。e 是独立的天体力学量（真月 e≈0.0549）。
    var eFromLon = REF.L[0][0] * D2R / 2;
    ok(eFromLon > 0.050 && eFromLon < 0.060, '由黄经主项反推的离心率异常：' + eFromLon.toFixed(6));
    // 物理约束②：距离主项 = 半长径 × e ⇒ |R_Mp|/(D0·e) 应接近 1（差 1% 内）。
    // 初版距离项写成 −209.053（小数点错位 100 倍），此式当场破——月距将几乎不摆动。
    var ratio = Math.abs(REF.R[0][0]) / (MOON_A_MEAN_KM * eFromLon);
    ok(Math.abs(ratio - 1) < 0.02, '距离主项与「a·e」不符：|−20905.355|/(385000.56×' + eFromLon.toFixed(6) + ')=' + ratio.toFixed(4));
    // 物理约束③：真月近/远地点差约 4.2 万 km；截断级数的摆幅上限是 Σ|R| 的两倍。
    var dmin = Infinity, dmax = -Infinity;
    for (var q = 0; q < 320; q++) {
      var mm = moonEcliptic(J2000 + q * 1.31); if (mm.error) continue;
      if (mm.dist_km < dmin) dmin = mm.dist_km; if (mm.dist_km > dmax) dmax = mm.dist_km;
    }
    var envR = REF.R.reduce(function (a, r) { return a + Math.abs(r[0]); }, 0);
    ok(dmax - dmin > 30000, '月距摆幅只有 ' + (dmax - dmin).toFixed(0) + ' km（真月应≈4.2 万 km，距离级数被写小的征兆）');
    ok(dmax - dmin <= 2 * envR + 1, '月距摆幅 ' + (dmax - dmin).toFixed(0) + ' km 超过 Σ|R| 的两倍 ' + (2 * envR).toFixed(0));
    // 对称性（这次是**推导过**的）：L、B 两表的每一项都含奇数个 (D,M,Mp,F) 因子，
    // 所以把四个元素**同时**取反时 sin 变号 ⇒ 级数整体是奇函数。
    // 而 β 对「只反 F」并不是奇函数：'Mp+F' 与 'Mp−F' 的振幅不同（0.280602≠0.277693），
    // F→−F 只是把这两项互换，不各自变号；纯 F 项之外的 |振幅| 之和才是残差上限。
    // 同理 F=0（升交点）时 β 也不严格为 0——截断级数里除主项外还有 5 项在 F=0 处不为零。
    var el2 = { L: 0, D: 37.3, M: 111.7, Mp: 53.1, F: 77.9, omega: 0, E: 1 };
    var negAll = { L: 0, D: -el2.D, M: -el2.M, Mp: -el2.Mp, F: -el2.F, omega: 0, E: 1 };
    var s1 = moonSeriesSum(MOON_TERMS_L, el2), s2 = moonSeriesSum(MOON_TERMS_L, negAll);
    ok(Math.abs(s1 + s2) < 1e-12, '黄经级数对 (D,M,Mp,F) 整体取反不是奇函数：' + s1 + ' / ' + s2);
    var b1 = moonSeriesSum(MOON_TERMS_B, el2), b2 = moonSeriesSum(MOON_TERMS_B, negAll);
    ok(Math.abs(b1 + b2) < 1e-12, '黄纬级数对 (D,M,Mp,F) 整体取反不是奇函数：' + b1 + ' / ' + b2);
    // 非纯 F 项（参考表里 aD 或 aMp 不为 0 的行）构成的包络
    var envMixB = REF.B.reduce(function (a, r) { return (r[1] !== 0 || r[3] !== 0) ? a + Math.abs(r[0]) : a; }, 0);
    var bFlipped = moonSeriesSum(MOON_TERMS_B, { L: 0, D: el2.D, M: el2.M, Mp: el2.Mp, F: -el2.F, omega: 0, E: 1 });
    var residF = Math.abs(b1 + bFlipped);
    ok(residF <= envMixB * 2 + 1e-12, '只反 F 的残差 ' + residF.toFixed(6) + '° 超过包络 2Σ|混合项|=' + (2 * envMixB).toFixed(6));
    ok(residF > 1e-6, '残差为 0 说明 β 真对 F 奇——那意味着 Mp+F 与 Mp−F 振幅被写成了同一个数');
    var eNode = { D: 40, M: 20, Mp: 15, F: 0, omega: 0, E: 1, L: 0 };
    var bNode = moonSeriesSum(MOON_TERMS_B, eNode);
    ok(Math.abs(bNode) <= envMixB + 1e-12, 'F=0 处黄纬 ' + bNode.toFixed(6) + '° 超过 Σ|混合项|=' + envMixB.toFixed(6) + '°');
    ok(Math.abs(bNode) < REF.B[0][0] / 4, 'F=0 处黄纬 ' + bNode.toFixed(6) + '° 相对主项 5.128° 过大（节点几何被写坏的征兆）');
    return '60 组随机元素下三条级数与第二份录入逐点一致（最大 ' + Math.max(worstL, worstB, worstR).toExponential(1) +
      '）；探针 ' + am.lon_at_Mp90.toFixed(6) + '/' + am.lat_at_F90.toFixed(6) + '/' + am.dist_at_Mp90.toFixed(1) +
      ' 等于参考表同构型之和（**不是**单项隔离）；2e=' + eFromLon.toFixed(6) + '，|R主项|/(D0·2e/2)=' +
      ratio.toFixed(4) + '；月距实测 [' + dmin.toFixed(0) + ',' + dmax.toFixed(0) + '] km，摆幅 ' +
      (dmax - dmin).toFixed(0) + ' km ≤ 2Σ|R|=' + (2 * envR).toFixed(0) + '；(D,M,Mp,F) 整体反号残差 λ=' +
      Math.abs(s1 + s2).toExponential(1) + ' β=' + Math.abs(b1 + b2).toExponential(1) +
      '；只反 F 的残差 ' + residF.toFixed(4) + '°、F=0 处 β=' + bNode.toFixed(4) + '°（**均非 0**，包络 ' +
      (2 * envMixB).toFixed(4) + '/' + envMixB.toFixed(4) + '°）';
  });
  T('月球距离/黄纬物理包络', function () {
    var pr = modelProbe(40, 991);
    var dmin = Math.min.apply(null, pr.dist_km), dmax = Math.max.apply(null, pr.dist_km);
    ok(dmin > 350000 && dmax < 420000, '月距范围异常：[' + dmin.toFixed(0) + ', ' + dmax.toFixed(0) + '] km');
    var latMax = pr.maxAbs(pr.lat_deg);
    ok(latMax > 4.8 && latMax < 5.6, '月球黄纬幅度应≈5.1°±1°，实得 ' + latMax.toFixed(4) + '°');
    var par = moonEcliptic(J2000 + 1234.5);
    var parFromDist = Math.asin(clamp(EARTH_RADIUS_KM / par.dist_km, -1, 1)) * R2D * 3600;
    ok(Math.abs(par.parallax_arcsec - parFromDist) < 1e-6, '地平视差与距离不自洽');
    var semid = Math.asin(clamp(1737.4 / par.dist_km, -1, 1)) * R2D;
    ok(Math.abs(par.semidiameter_deg - semid) < 1e-9, '视半径与月心半径/距离不自洽');
    return 'Δ∈[' + dmin.toFixed(0) + ',' + dmax.toFixed(0) + '] km，β_max=' + latMax.toFixed(4) + '°，π=' + par.parallax_arcsec.toFixed(2) + '″=arcsin(R⊕/Δ)（独立复算差 ' + (par.parallax_arcsec - parFromDist).toExponential(1) + '″），视半径 ' + (par.semidiameter_deg * 60).toFixed(2) + '′';
  });
  T('月赤纬满足球面恒等式 sinδ=sinβ cosε+cosβ sinε sinλ', function () {
    var worst = 0, n = 0;
    for (var i = 0; i < 30; i++) {
      var jd = J2000 - 4000 + i * 517.3, m = moonEcliptic(jd); if (m.error) continue;
      n++;
      var pred = Math.asin(clamp(Math.sin(m.lat_deg * D2R) * Math.cos(m.eps_deg * D2R) + Math.cos(m.lat_deg * D2R) * Math.sin(m.eps_deg * D2R) * Math.sin(m.lon_deg * D2R), -1, 1)) * R2D;
      worst = Math.max(worst, Math.abs(pred - m.dec_deg));
      // 反变换：黄道矢量的 y 分量是 cosδ·sinα·cosε + sinδ·sinε（用**赤纬** δ，不是黄纬 β），
      // 初版把 δ 误写成 β，于是「残差」恰为一个与 β 同量级（≈5.1°）的假象。
      var cd = Math.cos(m.dec_deg * D2R), sd = Math.sin(m.dec_deg * D2R), ca = Math.cos(m.ra_deg * D2R), sa = Math.sin(m.ra_deg * D2R);
      var lamPred = Math.atan2(cd * sa * Math.cos(m.eps_deg * D2R) + sd * Math.sin(m.eps_deg * D2R), cd * ca) * R2D;
      worst = Math.max(worst, Math.abs(wrap180(lamPred - m.lon_deg)));
      var betPred = Math.asin(clamp(-cd * sa * Math.sin(m.eps_deg * D2R) + sd * Math.cos(m.eps_deg * D2R), -1, 1)) * R2D;
      worst = Math.max(worst, Math.abs(betPred - m.lat_deg));
    }
    ok(worst < 1e-9, '月球黄道↔赤道变换残差 ' + worst);
    ok(n >= 28, '样本不足');
    return n + ' 个历元，正/反两个方向的球面恒等式最大残差 ' + worst.toExponential(2) + '°（抓旋转矩阵元素写错/符号写反）';
  });

  /* ---- 5. 恒星与岁差 */
  T('星表完整：≥40 颗、字段齐、|δ|≤90、星等为数、HIP 唯一或留空', function () {
    ok(STAR_TABLE.length >= 40, '星表只有 ' + STAR_TABLE.length + ' 颗（要求 ≥40）');
    var seen = {}, need = ['bayer', 'name', 'zh', 'ra_deg', 'dec_deg', 'v', 'epoch', 'id'], nh = 0;
    STAR_TABLE.forEach(function (s) {
      need.forEach(function (k) { ok(s[k] != null && s[k] !== '', '星表项缺字段 ' + k + '：' + s.name); });
      ok(Math.abs(s.dec_deg) <= 90, s.name + ' 赤纬越界 ' + s.dec_deg);
      ok(isNum(s.v), s.name + ' 星等不是数字');
      ok(s.v > -2 && s.v < 6.6, s.name + ' 星等量级异常：' + s.v);
      ok(s.ra_deg >= 0 && s.ra_deg < 360, s.name + ' 赤经越界');
      ok(!/[?]/.test(s.name + s.zh + s.bayer), s.name + ' 名称含占位符 "?"（数据不可信，必须删除该行）');
      ok(s.hip == null || (isNum(s.hip) && s.hip > 0), s.name + ' HIP 非法：' + s.hip);
      if (s.hip != null) { ok(!seen[s.hip], 'HIP 重复：' + s.hip); seen[s.hip] = 1; nh++; }
      ok(s.pm_ra == null || isNum(s.pm_ra), s.name + ' 自行不是数字');
    });
    ok(nh >= 20, '给出 HIP 的星太少：' + nh + '（要求 ≥20，其余按「宁缺勿错」留空）');
    var dup = {}; STAR_TABLE.forEach(function (s) { var k = s.bayer.toLowerCase(); ok(!dup[k], '拜耳名重复：' + s.bayer); dup[k] = 1; });
    var names = ['Polaris', 'Sirius', 'Vega', 'Betelgeuse', 'Acrux', 'Mimosa', 'Capella', 'Canopus', 'Alpha Centauri',
      'Altair', 'Deneb', 'Procyon', 'Aldebaran', 'Antares', 'Spica', 'Regulus', 'Fomalhaut', 'Achernar'];
    var has = {}; STAR_TABLE.forEach(function (s) { has[s.name.toLowerCase()] = 1; });
    var missing = names.filter(function (x) { return !has[x.toLowerCase()]; });
    ok(!missing.length, '任务清单要求的星未在表内：' + missing.join(','));
    var bd = STAR_TABLE.filter(function (s) { return s.type === '北斗'; });
    ok(bd.length === 7, '北斗七星应为 7 颗，实得 ' + bd.length);
    return STAR_TABLE.length + ' 颗（其中 ' + nh + ' 颗带未核对 HIP，其余留空）、北斗 ' + bd.length +
      ' 颗、任务清单 18 颗全在；名称/坐标结构全检通过。位置为记忆值，selfTest 不比对星表数值。';
  });
  T('星表次序双检：α/β Cen 与南十字（抓「抄串列/互换」类错误）', function () {
    var a = findStar('α2 Cen'), b = findStar('β Cen'), g = findStar('α Cru'), d = findStar('β Cru');
    ok(!a.error && !b.error && !g.error && !d.error, '缺星：' + [a, b, g, d].filter(function (x) { return x.error; }).map(function (x) { return x.message; }).join(';'));
    ok(a.v < b.v, 'α Cen(' + a.v + ') 应比 β Cen(' + b.v + ') 亮 —— 顺序可疑');
    ok(a.ra_deg > b.ra_deg, 'α Cen RA=' + a.ra_deg + ' 应 > β Cen RA=' + b.ra_deg + '（14h39m vs 14h04m）');
    ok(Math.abs(a.dec_deg) > 60 && Math.abs(b.dec_deg) > 60, '两颗南门/马腹星的 δ 都应越过 −60°');
    ok(g.ra_deg < d.ra_deg && g.dec_deg < d.dec_deg, 'Acrux(12h26m,−63°) 应在 Mimosa(12h47m,−59°) 之西且之南');
    return 'αCen ' + a.ra_deg.toFixed(3) + '/' + a.dec_deg.toFixed(3) + ' v=' + a.v + '，βCen ' + b.ra_deg.toFixed(3) + '/' + b.dec_deg.toFixed(3) +
      ' v=' + b.v + '；Acrux ' + g.ra_deg.toFixed(2) + '/' + g.dec_deg.toFixed(2) + '，Mimosa ' + d.ra_deg.toFixed(2) + '/' + d.dec_deg.toFixed(2) +
      ' —— 亮序/赤经序/赤纬序全一致（注意：这不验证数值正确性，只排除互换）';
  });
  T('南门二 α Cen 必在表内（任务清单要求）', function () {
    var s = findStar('α Cen') , s2 = findStar('α2 Cen');
    ok(!s.error || !s2.error, '缺南门二：' + s.message);
    s = s.error ? s2 : s;
    ok(Math.abs(s.dec_deg + 60.83) < 0.2, 'α Cen 赤纬应≈−60.83°，实得 ' + s.dec_deg);
    return s.name + ' / ' + s.zh + ' δ=' + s.dec_deg.toFixed(4) + '°（半人马座α，南天导航主星）';
  });
  T('Polaris J2000 赤纬与公开值之差（如实报告）', function () {
    var s = findStar('Polaris'); ok(!s.error, s.message);
    var pub = 89 + 15.51 / 60 + 50.9 / 3600;   // 公开 FK5/HIP 平位置 89°15′50″.9
    var diff = s.dec_deg - pub;
    ok(Math.abs(s.dec_deg - 89.26) < 0.05, 'Polaris J2000 赤纬量级不对：' + s.dec_deg);
    ok(Math.abs(diff) < 0.01, '与 89.2641° 差 ' + diff.toFixed(5) + '°（应 <0.01°，即 ~36″ 内）');
    return '表内 δ=' + s.dec_deg.toFixed(5) + '°，公开值 89°15′50″.9=' + pub.toFixed(5) + '°，差 ' + (diff * 3600).toFixed(1) + '″（差源于本表按分记录，秒位取 50″.9）';
  });
  T('岁差使 Polaris 赤纬单调趋近 90°（结论由代码给出，最大赤纬历元实测）', function () {
    var t0 = starAtEpoch(findStar('Polaris'), jdFromParts(2000, 1, 1, 12).jd);
    var t1 = starAtEpoch(findStar('Polaris'), jdFromParts(2026, 11, 1, 0).jd);
    var t2 = starAtEpoch(findStar('Polaris'), jdFromParts(2050, 1, 1, 0).jd);
    ok(!t0.error && !t1.error && !t2.error, 'starAtEpoch 失败');
    var seq = [t0.dec_deg, t1.dec_deg, t2.dec_deg];
    var mono = seq[0] < seq[1] && seq[1] < seq[2];
    // 扫描 1900—2400 找赤纬极大（=最接近天球的历元），由代码给结论
    var best = -100, bestJd = 0;
    for (var jd = jdFromParts(1900, 1, 1, 0).jd; jd < jdFromParts(2400, 1, 1, 0).jd; jd += 365.25) {
      var e = starAtEpoch(findStar('Polaris'), jd); if (e.error) break;
      if (e.dec_deg > best) { best = e.dec_deg; bestJd = jd; }
    }
    var bestDate = dateFromJd(bestJd);
    ok(mono, 'Polaris 赤纬未单调增大：' + seq.map(function (x) { return x.toFixed(5); }).join(' < '));
    ok(best > 89 && best < 90, '扫描出的最大赤纬异常：' + best);
    return '2000/2026/2050 赤纬 = ' + seq.map(function (x) { return x.toFixed(5); }).join(' → ') + '（单调趋近 90°，即「更接近」）；实测最接近天球历元 = ' + bestDate.iso.slice(0, 10) + '，δ_max=' + best.toFixed(5) + '°（距极 ' + (90 - best).toFixed(4) + '°）';
  });
  T('岁差矩阵正交、可逆（用转置反演回 J2000；M(−T)≠M(T)⁻¹）', function () {
    var worst = 0, worstNeg = 0;
    [0.01, 0.26, 1.5, -0.8, 5].forEach(function (T) {
      var P = precessionMatrix(T); ok(!P.error, '矩阵失败');
      var m = P.m;
      for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) {
        var s = m[i * 3] * m[j * 3] + m[i * 3 + 1] * m[j * 3 + 1] + m[i * 3 + 2] * m[j * 3 + 2];
        worst = Math.max(worst, Math.abs(s - (i === j ? 1 : 0)));
      }
      var r = applyPrecession(37.4, -12.3, T);
      // 逆矩阵就是转置（3-1-3 三个基本旋转都是正交的）——**不能**用 M(−T) 当逆：
      // ζ、θ、z 含偶次项（+1.39656T²、−0.42665T²、+1.09492T²），初版正是这样反演，
      // 在 T=5 世纪处得到 0.0356° 的「反演残差」，那是期望错而不是实现错。
      var inv = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
      var bx = inv[0] * r.x + inv[1] * r.y + inv[2] * r.z;
      var by = inv[3] * r.x + inv[4] * r.y + inv[5] * r.z;
      var bz = inv[6] * r.x + inv[7] * r.y + inv[8] * r.z;
      worst = Math.max(worst, Math.abs(wrap180(Math.atan2(by, bx) * R2D - 37.4)), Math.abs(Math.asin(clamp(bz, -1, 1)) * R2D + 12.3));
      // 把「M(−T) 不是逆」量化记录下来（应随 |T| 增大，且与偶次项量级一致）
      var back2 = applyPrecession(r.ra_deg, r.dec_deg, -T);
      worstNeg = Math.max(worstNeg, Math.abs(wrap180(back2.ra_deg - 37.4)));
      ok(Math.abs(r.norm - 1) < 1e-12, '向量模长不守恒：' + r.norm);
      ok(Math.hypot(bx, by, bz) > 0.999999999 && Math.hypot(bx, by, bz) < 1.000000001, '反演后模长变了：' + Math.hypot(bx, by, bz));
    });
    ok(worst < 1e-9, '正交/转置反演残差 ' + worst.toExponential(2) + '°');
    ok(worstNeg < 0.05, 'M(−T) 与 M(T)⁻¹ 的差应仅为偶次项量级（<0.05°），实得 ' + worstNeg.toFixed(5));
    var z = precessionAngles(0);
    ok(z.zeta === 0 && z.theta === 0 && z.z === 0, 'T=0 时岁差角必须为 0，实得 ' + JSON.stringify(z).slice(0, 60));
    return '5 个历元（含 −0.8、5 世纪）：正交性+转置反演最大残差 ' + worst.toExponential(2) + '°；' +
      '对照 M(−T) 反演的残差 ' + worstNeg.toFixed(5) + '°（来自 ζ/θ/z 的 T² 偶次项，故不可当逆用）；ζ/θ/z(T=0)=0';
  });
  T('岁差方向与量级：黄道上恒星 dλ/dt = 一般岁差 p≈1.39697°/世纪', function () {
    var P_CY = 5029.0966 / 3600;                       // IAU-1976 一般岁差（黄经），度/世纪
    var sum = 0, n = 0, worst = 0, onEcliptic = null;
    [[0, 0], [90, 45], [180, -60], [270, 23], [33, 89.26], [211, -12]].forEach(function (rd, idx) {
      var e1 = applyPrecession(rd[0], rd[1], 0.2), e2 = applyPrecession(rd[0], rd[1], 0.3);
      if (e1.error || e2.error) return;
      var ec1 = equToEcl(e1.ra_deg, e1.dec_deg, meanObliquity(0.2)), ec2 = equToEcl(e2.ra_deg, e2.dec_deg, meanObliquity(0.3));
      var d = wrap180(ec2.lon_deg - ec1.lon_deg) / (0.3 - 0.2);    // 度/世纪
      var bet = ec1.lat_deg;
      // β=0 只严格成立于 J2000 黄道；转到「当分点黄道」时两平面相差 Δε(T)，
      // 而 Meeus 的纬度岁差 ψ = p·sinβ·cos(λ−Ω) 在 β=0 时为零 ⇒ 一阶不改变黄纬，
      // 残差的上限就是两黄道面的夹角 |ε(0)−ε(T)|。初版写 1e-9 是把这条几何事实漏了。
      if (idx === 0) {
        var dEps = Math.abs(meanObliquity(0) - meanObliquity(0.2));
        ok(Math.abs(bet) < dEps, '黄道上的恒星转到历元 0.2 世纪后，黄纬应被两黄道面夹角 Δε=' +
          dEps.toFixed(6) + '° 包住，实得 β=' + bet.toFixed(8));
        onEcliptic = d;
      }
      worst = Math.max(worst, Math.abs(d - P_CY));
      sum += d; n++;
      ok(d > 1.2 && d < 1.6, '单星黄经速率量级异常（旋转方向写反会得到 ≈−1.4）：' + d.toFixed(5));
    });
    // β=0 的样本才严格等于 p；其余恒星因黄纬非零逐颗不同（实测跨度 ~0.015°/世纪）。
    near(onEcliptic, P_CY, 0.005, '黄道上的恒星 dλ/dt 必须等于一般岁差 p=5029.0966″/世纪');
    ok(Math.abs(sum / n - P_CY) < 0.02, '6 颗星平均 ' + (sum / n).toFixed(5) + '°/世纪 与 p 差太多');
    ok(worst < 0.02, '逐颗黄经速率相对 p 的最大偏差 ' + worst.toFixed(5) + '°/世纪');
    var sign = (sum / n) > 0 ? '正向（黄经递增，即分点退行）' : '负向（分点前移——岁差旋转方向写反）';
    ok((sum / n) > 0, '岁差方向错误：' + sign);
    return n + ' 颗星 dλ/dt = ' + (sum / n).toFixed(5) + '°/世纪（黄道上那颗 ' + onEcliptic.toFixed(5) +
      '，IAU-1976 一般岁差 p=' + P_CY.toFixed(5) + '）；逐颗最大偏差 ' + worst.toFixed(5) + '°/世纪；方向判定：' + sign;
  });
  T('任意星高度=90−天顶距 + equToHor↔horToEqu 往返', function () {
    var worstZd = 0, worstRt = 0, n = 0;
    for (var i = 0; i < 24; i++) {
      var r = lcg(555 + i), jd = J2000 + r() * 8000 - 4000;
      var st = STAR_TABLE[i % STAR_TABLE.length];
      var e = starAtEpoch(st, jd); if (e.error) continue;
      var lat = r() * 170 - 85, lon = r() * 360 - 180;
      var g = gmst(jd), lst = g.deg + wrap180(lon);
      var h = equToHor(e.ra_deg, e.dec_deg, lat, lst); if (h.error) continue;
      n++;
      worstZd = Math.max(worstZd, Math.abs(h.alt_deg + h.zenith_dist_deg - 90));
      var back = horToEqu(h.alt_deg, h.az_deg, lat, lst);
      if (!back.error) {
        worstRt = Math.max(worstRt, Math.abs(back.dec_deg - e.dec_deg));
        worstRt = Math.max(worstRt, Math.abs(wrap180(back.ra_deg - e.ra_deg) * Math.cos(e.dec_deg * D2R)));
      }
    }
    ok(worstZd < 1e-12, '天顶距恒等式失败 ' + worstZd);
    ok(n >= 22, '样本不足 ' + n);
    ok(worstRt < 1e-6, '地平→赤道往返残差 ' + worstRt + '°（高纬/天顶附近条件数差）');
    return n + ' 组：恒等式残差 ' + worstZd + '；往返（含赤经收敛因子 cosδ）最大残差 ' + worstRt.toExponential(2) + '°';
  });
  T('bearingFromStar 与 starsAt 同星一致 + 中天对称性', function () {
    var jd = jdFromParts(2026, 4, 15, 21, 0).jd, lat = 39.9, lon = 116.4;
    var sa = starsAt({ utc: jd, lat: lat, lon: lon }); ok(!sa.error, sa.message);
    var worst = 0;
    ['Vega', 'Polaris', 'Sirius', 'Capella', 'Altair'].forEach(function (nm) {
      var b = bearingFromStar({ star: nm, utc: jd, lat: lat, lon: lon });
      ok(!b.error, nm + '：' + b.message);
      var row = sa.stars.filter(function (x) { return x.name === nm; })[0];
      ok(row, 'starsAt 缺 ' + nm);
      worst = Math.max(worst, Math.abs(row.az_deg - b.az_deg), Math.abs(row.alt_deg - b.alt_deg));
    });
    ok(worst < 1e-9, '两条 API 路径的同一颗星结果不一致，差 ' + worst);
    // 对称性：φ=+45 与 φ=−45 同经度，Vega(δ=+38.78) 过中天时方位应差 180°
    var st = findStar('Vega'), e = starAtEpoch(st, jd);
    var g = gmst(jd), lstP = wrap360(g.deg + 90);
    var raUse = e.ra_deg;
    var lstForTransit = wrap360(raUse);          // 使 H=0 的地方恒星时
    // 定区间：卷绕后的时角函数在一个恒星日内过 0 **两次**（上中天与下中天各一次，
    // 相差 ~0.5 日），拿 jd±1 做端点时两点常落在同一侧 ⇒「区间内无变号」。
    // 正确做法：先用「时角以 ~360°/日 增大」推下一次上中天的时刻，再取 ±0.4 日定界。
    function bracketTransit(starFn, jd, lon) {
      var c0 = starFn(jd); if (c0.error) return c0;
      var H = wrap180(gmst(jd).deg + wrap180(lon) - c0.ra_deg);
      var tGuess = jd + (((-H) % 360 + 360) % 360) / 360.0;
      return { r: findRoot(function (tt) { var c = starFn(tt); return c.error ? NaN : wrap180(gmst(tt).deg + wrap180(lon) - c.ra_deg); }, tGuess - 0.4, tGuess + 0.4, 70), H: H, tGuess: tGuess };
    }
    var bk = bracketTransit(function (t) { return starAtEpoch(st, t); }, jd, 90);
    var jd2 = bk.r;
    ok(jd2.root != null, '未找到 Vega 中天：' + JSON.stringify(jd2).slice(0, 60) + '（H 起算 ' + bk.H.toFixed(2) + '°）');
    // 残余时角的下限由浮点决定：JD≈2.46e6 的 ulp≈5e-10 日，二分法只能收敛到这个量级，
    // 乘上恒星时速率 360.99°/日 ⇒ 约 2e-7 度。写 1e-9 是把 JD 的表示精度当成了算法精度。
    var ulpJdV = Math.abs(jd2.root) * 2.220446049250313e-16;
    var ulpHV = 8 * SIDEREAL_RATE * ulpJdV + 1e-8;
    var residHv = Math.abs(wrap180(gmst(jd2.root).deg + 90 - starAtEpoch(st, jd2.root).ra_deg));
    ok(residHv < ulpHV, '求出的时刻时角 ' + residHv.toExponential(2) + '° 大于 JD ulp 允许的 ' + ulpHV.toExponential(2) + '°');
    var bN = bearingFromStar({ star: 'Vega', utc: jd2.root, lat: 45, lon: 90 });
    var bS = bearingFromStar({ star: 'Vega', utc: jd2.root, lat: -45, lon: 90 });
    ok(!bN.error && !bS.error, '中天方位求解失败');
    var diff = Math.abs(wrap180(bN.az_deg - bS.az_deg));
    ok(Math.abs(diff - 180) < 0.05, '±45° 同经度过中天的方位差应=180°，实得 ' + diff.toFixed(4) + '°（注意 |δ|>|φ| 时该对称性退化，本例 δ=38.78<45 有效）');
    return '两路径一致（差 ' + worst.toExponential(1) + '）；中天时北纬 45° 方位 ' + bN.az_deg.toFixed(4) + '°、南纬 45° 方位 ' + bS.az_deg.toFixed(4) + '°，差 ' + diff.toFixed(4) + '°；高度 ' + bN.alt_deg.toFixed(2) + '/' + bS.alt_deg.toFixed(2) + '°';
  });
  T('latFromStarAltitude 与高度正算往返闭合', function () {
    var st = findStar('Vega'), jd = jdFromParts(2026, 7, 10, 22).jd;
    var worst = 0, n = 0;
    [[20, 30], [45, 100], [-25, 60], [60, -120]].forEach(function (c) {
      var e = starAtEpoch(st, jd);
      var g = gmst(jd), lst = g.deg + wrap180(c[1]);
      // 取该星过中天时刻与该纬度关系：直接构造 H=0 的天顶距
      var z = Math.abs(c[0] - e.dec_deg);
      var alt = 90 - z;
      var toward = e.dec_deg < c[0] ? 'south' : 'north';
      var r = latFromStarAltitude({ star: 'Vega', utc: jd, max_altitude_deg: alt, dec_deg: e.dec_deg, toward: toward });
      if (r.error) return;
      n++;
      worst = Math.max(worst, Math.abs(r.lat_deg - c[0]));
    });
    ok(n >= 4, '样本不足 ' + n);
    ok(worst < 1e-9, '纬度往返残差 ' + worst);
    var bad = latFromStarAltitude({ star: 'Vega', altitude_at_transit_deg: 120, dec_deg: 38 });
    ok(bad.error === 'bad_alt', '超界高度必须被拒绝，实得 ' + JSON.stringify(bad).slice(0, 40));
    return n + ' 组（用 φ=δ±z 的解析高度反解）最大残差 ' + worst.toExponential(1) + '°；非法高度 → ' + bad.error;
  });
  T('北极星罗盘法：中天时方位≈0，高度估纬误差有界', function () {
    var jd0 = jdFromParts(2026, 11, 1, 0).jd, lat = 40, lon = 116;
    // 同 Vega 那条：先推下一次上中天再定 ±0.4 日（用 jd0±1 会因「一天内两次过 0」而无变号）
    function bracketTransitP(starFn, jd, lon2) {
      var c0 = starFn(jd); if (c0.error) return c0;
      var H = wrap180(gmst(jd).deg + wrap180(lon2) - c0.ra_deg);
      var tGuess = jd + (((-H) % 360 + 360) % 360) / 360.0;
      return findRoot(function (tt) { var c = starFn(tt); return c.error ? NaN : wrap180(gmst(tt).deg + wrap180(lon2) - c.ra_deg); }, tGuess - 0.4, tGuess + 0.4, 70);
    }
    var tr = bracketTransitP(function (t) { return starAtEpoch(findStar('Polaris'), t); }, jd0, lon);
    ok(tr.root != null, '未找到北极星中天：' + JSON.stringify(tr).slice(0, 60));
    var c = polarisCompass({ utc: tr.root, lat: lat, lon: lon });
    ok(!c.error, c.message);
    ok(Math.abs(c.az_from_true_north_deg) < 1.5, '北极星过中天时真北偏差应 <1.5°，实得 ' + c.az_from_true_north_deg.toFixed(4) + '°');
    ok(Math.abs(c.lat_estimate_deg - lat) < 1.5, '中天估纬误差应 <1.5°，实得 ' + c.lat_estimate_deg.toFixed(3));
    var worst = 0, worstAz = 0;
    for (var i = 0; i < 24; i++) {
      var cc = polarisCompass({ utc: tr.root + i / 24, lat: lat, lon: lon });
      if (cc.error) continue;
      worst = Math.max(worst, Math.abs(cc.lat_estimate_deg - lat));
      worstAz = Math.max(worstAz, Math.abs(wrap180(cc.az_from_true_north_deg)));
    }
    ok(worstAz < 2.6 && worstAz > 0.05, '罗盘误差量级异常（应 0~2.5°）：' + worstAz.toFixed(3));
    ok(worst < 2.6, '全天任意时刻估纬误差包络破：' + worst.toFixed(3));
    return '中天处真北偏差 ' + c.az_from_true_north_deg.toFixed(3) + '°、距极 ' + c.polar_distance_deg.toFixed(3) + '°、估纬 ' + c.lat_estimate_deg.toFixed(3) + '°（真 40°）；24 小时扫描：max|Δφ|=' + worst.toFixed(3) + '°、max 方位偏差 ' + worstAz.toFixed(3) + '°（=距极角量级，故罗盘读北最多差 ~2°）';
  });
  T('坐标变换约定：黄极映射为 (RA=270°, δ=90−ε)', function () {
    var eps = meanObliquity(0.26);
    var q = eclToEqu(0, 90, eps);
    near(q.ra_deg, 270, 1e-9, '北黄极赤经必为 270°');
    // 北黄极与北天极的角距离就是 ε，所以它的赤纬是 90°−ε（=66.56°），不是 ε。
    // 初版把这条期望记成 δ=ε，被「赤经=270° 且 δ=90−ε」的球面事实（两基矢夹角逐距）否决。
    near(q.dec_deg, 90 - eps, 1e-9, '北黄极赤纬=90°−ε（与北天极相距恰为 ε；此式抓 y/z 旋转符号写反）');
    var p = eclToEqu(90, 0, eps);
    near(p.ra_deg, 90, 1e-9, '夏至点赤经=90°');
    near(p.dec_deg, eps, 1e-9, '夏至点赤纬=+ε');
    var b = eclToEqu(270, 0, eps);
    near(b.ra_deg, 270, 1e-9, '冬至点赤经=270°');
    near(b.dec_deg, -eps, 1e-9, '冬至点赤纬=−ε');
    var w = equToEcl(p.ra_deg, p.dec_deg, eps);
    near(w.lon_deg, 90, 1e-9, '反变换回黄经');
    near(w.lat_deg, 0, 1e-9, '反变换回黄纬');
    return '北黄极 (270°, ' + q.dec_deg.toFixed(5) + '°)=90−ε(' + (90 - eps).toFixed(5) + '°)；至点 δ=±' + eps.toFixed(5) + '°；往返残差 0（该断言可独立抓「绕 X 轴旋转符号写反」，与正午高度断言互不重叠）';
  });
  T('GMST 与赤经/时角的相对性（赤经相差 90° ⇒ 时角相差 90°）', function () {
    var jd = jdFromParts(2026, 9, 1, 3).jd, lat = 30, lon = 40;
    var g = gmst(jd), lst = g.deg + wrap180(lon);
    var a = equToHor(lst + 90, 0, lat, lst), b = equToHor(lst - 90, 0, lat, lst), c = equToHor(lst, 0, lat, lst);
    ok(!a.error && !b.error && !c.error, '地平解算失败');
    near(c.ha_deg, 0, 1e-9, 'RA=LST 时 H=0');
    near(a.ha_deg, -90, 1e-6, 'RA=LST+90 ⇒ H=−90（东，卯酉圈交点）');
    near(b.ha_deg, 90, 1e-6, 'RA=LST−90 ⇒ H=+90（西）');
    // δ=0 且 |H|=90° ⇒ sinh=sinφ·0+cosφ·1·cos(±90°)=0 ⇒ 天体恰在**地平圈**上（卯酉圈
    // 与地平圈的交点），与纬度无关；「90−|φ|」是**过中天**时的高度，两者不能混用。
    near(a.alt_deg, 0, 1e-9, 'δ=0 且 H=−90° 时 sin h=0 ⇒ 高度=0（升起在正东）');
    near(b.alt_deg, 0, 1e-9, 'δ=0 且 H=+90° 时 sin h=0 ⇒ 高度=0（落在正西）');
    near(c.alt_deg, 90 - Math.abs(lat - 0), 1e-6, 'δ=0 过中天高度=90−|φ−δ|');
    near(a.az_deg, 90, 1e-9, '东卯酉圈交点方位必为 90°');
    near(b.az_deg, 270, 1e-9, '西卯酉圈交点方位必为 270°');
    ok(Math.abs(wrap180(a.alt_deg - b.alt_deg)) < 1e-9, '东西卯酉圈高度应相等：' + a.alt_deg + '/' + b.alt_deg);
    return 'H(东)=' + a.ha_deg.toFixed(4) + '°、H(西)=' + b.ha_deg.toFixed(4) + '°；高度 ' + a.alt_deg.toExponential(1) +
      '/' + b.alt_deg.toExponential(1) + '（δ=0、|H|=90° ⇒ 地平）；方位 ' + a.az_deg.toFixed(3) + '/' + b.az_deg.toFixed(3) + '（抓时角符号/GMST 相加方向写反）';
  });

  /* ---- 6. 鲁棒性 */
  T('垃圾输入全 API：不抛异常、不泄漏 NaN', function () {
    var junk = [null, undefined, NaN, Infinity, -Infinity, '', '   ', '乱码xxx', {}, [], '2026-13-45T99:99:99Z',
      1e308, -1e308, J2000 + 1e9, J2000 - 1e9, 2451545.0];
    var geo = [null, NaN, 90, -90, 91, 1e9, -1e9, '', '12'];
    var fns = Object.keys(API).filter(function (k) { return typeof API[k] === 'function' && k !== 'selfTest'; });
    var calls = 0, threw = 0, leaks = 0, byKey = {};
    function note(key, args, e) {
      leaks++;
      if (!byKey[key]) byKey[key] = { n: 0, eg: JSON.stringify(args).slice(0, 26), err: e };
      byKey[key].n++;
    }
    fns.forEach(function (name) {
      var f = API[name];
      junk.forEach(function (a) {
        geo.forEach(function (b) {
          [[a], [a, b], [a, b, b], [{ star: a, utc: a, lat: b, lon: b }], [{ jd: a, lat: b, lon: b }]].forEach(function (args) {
            var res;
            try { calls++; res = f.apply(null, args); } catch (e) { threw++; note(name + ' threw ' + e.message, args, e.message); return; }
            if (res == null || typeof res !== 'object') {
              if (typeof res === 'number' && !isFinite(res)) note(name + ' 返回非有限数', args);
              return;
            }
            if (res.error) return;                       // 带 error 即视为合法失败
            var nan = hasNaNdeep(res);
            if (nan.length) note(name + ' NaN 泄漏 ' + nan.slice(0, 2).join(','), args);
          });
        });
      });
    });
    var keys = Object.keys(byKey).sort(function (x, y) { return byKey[y].n - byKey[x].n; });
    var top = keys.slice(0, 8).map(function (k) { return k + ' ×' + byKey[k].n + '（如 ' + byKey[k].eg + '）'; });
    ok(threw === 0, threw + ' 次调用抛出异常（类：' + keys.length + '；前 3：' + top.slice(0, 3).join(' | ') + '）');
    ok(leaks === 0, leaks + ' 个问题，涉及 ' + keys.length + ' 类：' + top.join(' | '));
    return calls + ' 次垃圾调用（' + fns.length + ' 个公开函数 × null/NaN/乱码/±1e9/JD±1e9/极端经纬度），0 异常，0 NaN 泄漏';
  });
  T('极昼极夜必须给 no_rise/no_set 标记（不得 NaN）', function () {
    var cases = [[{ lat: 78.9, lon: 11.9, jd: jdFromParts(2026, 6, 21, 0).jd }, 'polar_day'],
      [{ lat: 78.9, lon: 11.9, jd: jdFromParts(2026, 12, 21, 0).jd }, 'polar_night'],
      [{ lat: -90, lon: 0, jd: jdFromParts(2026, 6, 21, 0).jd }, 'polar_night'],
      [{ lat: 90, lon: 0, jd: jdFromParts(2026, 12, 21, 0).jd }, 'polar_day'],
      [{ lat: 68, lon: 25, jd: jdFromParts(2026, 3, 20, 0).jd }, 'normal'],
      [{ lat: 90, lon: 1e9, jd: jdFromParts(2026, 6, 21, 0).jd }, null],
      [{ lat: 89.999, lon: -179.999, jd: jdFromParts(2026, 1, 1, 0).jd }, null]];
    var rep = [];
    cases.forEach(function (c) {
      var e = sunEvents(c[0].jd, c[0].lat, c[0].lon, {});
      ok(!e.error, JSON.stringify(e).slice(0, 50));
      ok(typeof e.no_rise === 'boolean' && typeof e.no_set === 'boolean', 'no_rise/no_set 必须是布尔标记，实得 ' + typeof e.no_rise);
      ok(e.day_length_h === null || isNum(e.day_length_h), '昼长要么有限要么 null');
      if (c[1] === 'polar_day') ok(e.no_set === true && e.no_rise === true && e.sunrise_jd === null && e.sunset_jd === null, '极昼标记/时刻错：' + JSON.stringify(e).slice(0, 90));
      if (c[1] === 'polar_night') ok(e.no_rise === true && e.no_set === true && e.day_length_h === 0, '极夜标记错');
      if (c[1] === 'normal') ok(e.no_rise === false && e.no_set === false && isNum(e.day_length_h), '正常纬度不应有极昼极夜标记');
      rep.push(c[0].lat + '°→' + e.polar_state);
    });
    var m = moonEvents(jdFromParts(2026, 6, 21, 0).jd, 89.99, 0, {});
    ok(!m.error && (typeof m.no_rise === 'boolean') && (typeof m.no_set === 'boolean'), '月升落极区标记缺失');
    return rep.join('，') + '；月升落 89.99° → ' + m.polar_state + '（标记为布尔，无 NaN 时刻）';
  });
  T('导出面：必需成员存在且类型正确', function () {
    var need = ['VERSION', 'STAR_TABLE', 'jdFromParts', 'mjdFromParts', 'dateFromJd', 'parseTime', 'timeSystems',
      'isLeap', 'gmst', 'eop', 'meanObliquity', 'eclToEqu', 'equToEcl', 'equToHor', 'horToEqu', 'refraction',
      'sunElements', 'sunApparent', 'sunHorizon', 'subSolarPoint', 'sunEvents', 'analyticDayLength',
      'moonElements', 'moonPosition', 'subLunarPoint', 'topocentricMoon', 'moonPhase', 'moonEvents',
      'findRoot', 'precessionAngles', 'precessionMatrix', 'applyPrecession', 'starAtEpoch', 'findStar',
      'starsAt', 'bearingFromStar', 'latFromStarAltitude', 'polarisCompass', 'accuracy', 'selfTest'];
    var miss = need.filter(function (k) { return API[k] == null; });
    ok(!miss.length, '缺导出：' + miss.join(','));
    var notFn = need.filter(function (k) { return ['VERSION', 'STAR_TABLE'].indexOf(k) < 0 && typeof API[k] !== 'function'; });
    ok(!notFn.length, '类型不是 function：' + notFn.join(','));
    ok(Array.isArray(API.STAR_TABLE) && API.STAR_TABLE.length >= 40, '星表导出异常');
    ok(global.GEOASTRO === API && globalThis.GEOASTRO === API, '未挂到 globalThis.GEOASTRO');
    var g = gg();
    var dist = geodesicMeters(31.2304, 121.4737, 39.9042, 116.4074);
    ok(isNum(dist.m) && dist.m > 1e6 && dist.m < 1.2e7, '距离退化实现异常：' + JSON.stringify(dist));
    return need.length + ' 项齐备（全为 function，除 VERSION/STAR_TABLE）；GEOGEO ' + (g ? '可用（' + (g.VERSION || 'n/a') + '）' : '缺席→内部球面退化') +
      '，沪京距离 ' + (dist.m / 1000).toFixed(2) + ' km via ' + dist.impl;
  });

  function selfTest() {
    var out = [];
    for (var i = 0; i < TESTS.length; i++) {
      var rec = { name: TESTS[i].name, pass: false, detail: '' };
      try { rec.detail = String(TESTS[i].fn() || 'ok'); rec.pass = true; }
      catch (e) { rec.detail = '失败：' + (e && e.message ? e.message : String(e)); }
      out.push(rec);
    }
    return out;
  }

  var API = {
    VERSION: '1.0.0',
    J2000: J2000, GREGORIAN_JD: GREGORIAN_JD, SIDEREAL_RATE: SIDEREAL_RATE,
    jdFromParts: jdFromParts, mjdFromParts: mjdFromParts, dateFromJd: dateFromJd, parseTime: parseTime,
    timeSystems: timeSystems, isLeap: isLeap,
    gmst: gmst, eop: eop, meanObliquity: meanObliquity,
    eclToEqu: eclToEqu, equToEcl: equToEcl, equToHor: equToHor, horToEqu: horToEqu,
    refraction: refraction, apparentFromGeo: apparentFromGeo, geoFromApparent: geoFromApparent,
    sunElements: sunElements, sunTrueAnomalyRad: sunTrueAnomalyRad, sunApparent: sunApparent,
    sunHorizon: sunHorizon, subSolarPoint: subSolarPoint, sunEvents: sunEvents,
    sunriseSunset: sunEvents, analyticDayLength: analyticDayLength,
    altitudeEvents: altitudeEvents, transitEvents: transitEvents, findRoot: findRoot,
    moonPosition: moonPosition, subLunarPoint: subLunarPoint, topocentricMoon: topocentricMoon,
    moonPhase: moonPhase, moonEvents: moonEvents, moonElements: moonElements, moonEcliptic: moonEcliptic,
    precessionAngles: precessionAngles, precessionMatrix: precessionMatrix, applyPrecession: applyPrecession,
    starAtEpoch: starAtEpoch, findStar: findStar, starsAt: starsAt, bearingFromStar: bearingFromStar,
    latFromStarAltitude: latFromStarAltitude, polarisCompass: polarisCompass,
    STAR_TABLE: STAR_TABLE, accuracy: accuracy, geodesicMeters: geodesicMeters,
    wrap360: wrap360, wrap180: wrap180, clamp: clampSafe, selfTest: selfTest
  };
  global.GEOASTRO = API;
  globalThis.GEOASTRO = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);
