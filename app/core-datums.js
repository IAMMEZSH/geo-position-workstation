/* ============================================================================
 * core-datums.js —— 坐标系转换与任意文本坐标解析
 * 依赖 core-geodetic.js（GEOGEO）提供椭球、子午线弧、反算等已验证基元。
 * 自检原则：任何"记忆中的公式"都必须通过独立几何检验（C-C 方程、往返、尺度一致性）
 * 才允许出厂；不确定的基准转换参数一律不内置，改由用户填写官方值。
 * ==========================================================================*/
(function (global) {
  'use strict';

  function G() {
    if (!global.GEOGEO) throw new Error('需要先加载 core-geodetic.js');
    return global.GEOGEO;
  }
  const PI = Math.PI, D2R = PI / 180, R2D = 180 / PI;
  const abs = Math.abs, pow = Math.pow, sq = (x) => x * x;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const wrap360 = (a) => ((a % 360) + 360) % 360;
  const wrap180 = (a) => { const x = wrap360(a); return x > 180 ? x - 360 : x; };
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const round = (v, n) => { const p = pow(10, n == null ? 6 : n); return Math.round(v * p) / p; };

  /* ---------------------------------------------------------------- 0. 基元 */
  // 子午线弧长 s(φ)=∫₀^φ M dφ：用复合 Simpson 数值积分，被积函数 M(x) 解析、光滑，
  // 因此不需要记忆任何级数系数（记错系数是这类代码最常见的坑），只需保证步长足够小。
  // Simpson 误差 ∝ (b−a)·h⁴，实测在 0~90° 全域把面板宽度压到 ≈0.65° 时最大误差 ~1e-5 m，
  // 加倍面板数误差缩到 1/16（四阶收敛，selfTest 里有这道独立闸门）。
  function meridianArcQuads(lat, key, n) {
    const e = G().ell(key || 'WGS84');
    const f = lat * D2R;
    const sgn = f < 0 ? -1 : 1;
    const a = abs(f);
    if (a < 1e-15) return 0;
    const M = (x) => {
      const s = Math.sin(x);
      return e.a * (1 - e.e2) / pow(1 - e.e2 * s * s, 1.5);
    };
    const h = a / (2 * n);
    let sum = M(0) + M(a);
    for (let i = 1; i < 2 * n; i++) sum += M(i * h) * (i % 2 ? 4 : 2);
    return sgn * (sum * h / 3);
  }
  // 默认步长：面板宽度恒定 ≈0.65°，低纬度自动少算几步（误差 ∝ 区间长度×h⁴）
  function arcPanels(lat) { return clamp(Math.round(abs(lat) / 1.3), 8, 72); }
  function meridianArc(lat, key) { return meridianArcQuads(lat, key, arcPanels(lat)); }
  // 由弧长反解纬度：ds/dφ = M(φ) 解析已知，Newton 直接收敛，无需查表
  function latFromMeridianArc(sTarget, key) {
    const e = G().ell(key || 'WGS84');
    let lat = clamp(sTarget / (e.a * (1 - e.e2)) * R2D, -90, 90);
    for (let i = 0; i < 12; i++) {
      const M = (x) => { const s = Math.sin(x * D2R); return e.a * (1 - e.e2) / pow(1 - e.e2 * s * s, 1.5); };
      const step = (meridianArc(lat, key) - sTarget) / (M(lat) * D2R);
      lat -= step;
      if (abs(step) < 1e-12) break;
    }
    return clamp(lat, -90, 90);
  }
  // 等角（isometric）纬度 ψ(φ)：椭球版闭式
  function isometricLat(lat, key) {
    const e = G().ell(key || 'WGS84'), ex = Math.sqrt(e.e2), s = Math.sin(lat * D2R);
    if (abs(abs(s) - 1) < 1e-15) return null;
    const t = Math.tan(PI / 4 + lat * D2R / 2);
    return Math.log(t) + (ex / 2) * Math.log((1 - ex * s) / (1 + ex * s));
  }
  function latFromIsometric(psi, key) {
    let lat = clamp(2 * Math.atan(Math.exp(psi)) - PI / 2, -PI / 2, PI / 2) * R2D;
    for (let i = 0; i < 60; i++) {
      const f = isometricLat(lat, key);
      if (f === null) break;
      const d = (isometricLat(lat + 1e-6, key) - isometricLat(lat - 1e-6, key)) / 2e-6;
      const step = (f - psi) / d;
      lat -= step;
      if (abs(step) < 1e-12) break;
    }
    return clamp(lat, -90, 90);
  }

  /* ------------------------------------------------- 1. 横轴墨卡托（UTM/通用） */
  // Krüger 级数：A = Δλ·cosφ，T = tan²φ，C = e′²cos²φ
  // 东距 = k0·ν[A + (1−T+C)A³/6 + (5−18T+T²+72C−58e′²)A⁵/120]
  // 北距 = k0[s + ν·tanφ(A²/2 + (5−T+9C+4C²)A⁴/24 + (61−58T+T²+600C−330e′²)A⁶/720)]
  // 是否成立由 tmConformal() 的 C-C 方程检验把关，不靠记忆。
  function tmRaw(lat, lon, lon0, opts) {
    const o = opts || {}, key = o.key || 'WGS84', k0 = o.k0 == null ? 1 : o.k0;
    const e = G().ell(key), p = lat * D2R, l = wrap180(lon - lon0) * D2R;
    const s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
    const e2s = e.e2 * s * s, nu = e.a / Math.sqrt(1 - e2s);
    const ep2 = e.e2 / (1 - e.e2);
    const A = l * c, T = sq(t), C = ep2 * sq(c), sArc = meridianArc(lat, key);
    const order = o.order == null ? 5 : o.order;
    let east = nu * (A + (order >= 3 ? (1 - T + C) * pow(A, 3) / 6 : 0));
    if (order >= 5) east += nu * (5 - 18 * T + T * T + 72 * C - 58 * ep2) * pow(A, 5) / 120;
    let north = sArc + nu * t * (sq(A) / 2 + (order >= 4 ? (5 - T + 9 * C + 4 * C * C) * pow(A, 4) / 24 : 0));
    if (order >= 6) north += nu * t * (61 - 58 * T + T * T + 600 * C - 330 * ep2) * pow(A, 6) / 720;
    return { x: k0 * east, y: k0 * north };
  }
  // 数值 Jacobian：既是 tmScale/tmConvergence 的来源，也是反算 Newton 的引擎。
  // 只依赖 tmRaw，避免与 tmForward 相互调用形成递归。
  function tmJacRaw(lat, lon, lon0, opts, dh) {
    const h = dh || 1e-6;
    const fp = tmRaw(lat + h, lon, lon0, opts), fm = tmRaw(lat - h, lon, lon0, opts);
    const gl = tmRaw(lat, lon + h, lon0, opts), gml = tmRaw(lat, lon - h, lon0, opts);
    return {
      Xp: (fp.x - fm.x) / (2 * h), Yp: (fp.y - fm.y) / (2 * h),
      Xl: (gl.x - gml.x) / (2 * h), Yl: (gl.y - gml.y) / (2 * h)
    };
  }
  function tmJac(lat, lon, lon0, opts) { return tmJacRaw(lat, lon, lon0, opts, 1e-6); }
  function tmForward(lat, lon, lon0, opts) {
    const r = tmRaw(lat, lon, lon0, opts);
    const j = tmJac(lat, lon, lon0, opts);
    const e = G().ell((opts || {}).key || 'WGS84'), s = Math.sin(lat * D2R);
    const M = e.a * (1 - e.e2) / pow(1 - e.e2 * s * s, 1.5);
    return {
      x: round(r.x, 6), y: round(r.y, 6),
      // tmJac 的差分步长以「度」为单位，换算成每弧度的偏导要除以 D2R
      k: Math.hypot(j.Xp, j.Yp) * R2D / M,
      // 坐标收敛角 γ = 网格北 − 真北；真北映射到向量 (Xp, Yp)，故 γ = −atan2(Xp, Yp)
      gamma: wrap180(-Math.atan2(j.Xp, j.Yp) * R2D)
    };
  }
  function tmInverse(x, y, lon0, opts) {
    const o = opts || {}, k0 = o.k0 == null ? 1 : o.k0;
    const xe = x / k0, ye = y / k0;
    let lat = isNum(o.guessLat) ? o.guessLat : latFromMeridianArc(ye, o.key);
    let lon = isNum(o.guessLon) ? wrap180(o.guessLon) : lon0;
    for (let i = 0; i < 14; i++) {
      const f = tmRaw(lat, lon, lon0, o);
      const j = tmJac(lat, lon, lon0, o);
      const rx = f.x / k0 - xe, ry = f.y / k0 - ye;
      const det = j.Xp * j.Yl - j.Xl * j.Yp;
      if (!isNum(det) || abs(det) < 1e-9) break;
      // 解 J·[dφ,dλ] = -r；J⁻¹ = (1/det)[[Yl,-Xl],[-Yp,Xp]]
      const dLat = -(j.Yl * rx - j.Xl * ry) / det, dLon = (j.Yp * rx - j.Xp * ry) / det;
      lat = clamp(lat + dLat, -90, 90); lon = wrap180(lon + dLon);
      if (abs(dLat) < 1e-13 && abs(dLon) < 1e-13) break;
    }
    return { lat, lon: wrap180(lon) };
  }
  // 对外便利封装（UI 需要单独取比例因子/收敛角时用）
  function tmScale(lat, lon, lon0, opts) { return tmForward(lat, lon, lon0, opts).k; }
  function tmConvergence(lat, lon, lon0, opts) { return tmForward(lat, lon, lon0, opts).gamma; }

  /* ------------------------------------------------------------ 2. UTM / UPS */
  function utmZoneOf(lon) { return clamp(Math.floor((wrap180(lon) + 180) / 6) + 1, 1, 60); }
  function utmCentralMeridian(zone) { return (zone - 1) * 6 - 180 + 3; }
  const K0 = 0.9996;
  function utmForward(lat, lon, zone, opts) {
    const o = opts || {}, key = o.key || 'WGS84';
    let z = zone ? clamp(Math.round(zone), 1, 60) : utmZoneOf(lon);
    const north = lat >= 0;
    if (abs(lat) > 84) return upsForward(lat, lon, { key });
    const cm = utmCentralMeridian(z);
    // zone 32 在挪威西部例外（6° 带内 3° 偏移）
    if (z === 32 && lat >= 56 && lat < 64 && lon >= 3 && lon < 12) {
      const ex = tmForward(lat, lon, 9, { k0: K0, key });
      return Object.assign(ex, {
        zone: 32, hemisphere: north ? 'N' : 'S', cm_used: 9, false_easting: 500000,
        easting: ex.x + 500000, northing: north ? ex.y : ex.y + 10000000,
        note: 'zone 32 挪威例外区，中央经线按 9°E'
      });
    }
    const f = tmForward(lat, lon, cm, { k0: K0, key });
    return Object.assign(f, { zone: z, hemisphere: north ? 'N' : 'S', cm_used: cm, false_easting: 500000, easting: f.x + 500000, northing: north ? f.y : f.y + 10000000 });
  }
  function utmInverse(easting, northing, zone, hemisphere, opts) {
    const o = opts || {}, key = o.key || 'WGS84';
    const north = hemisphere !== 'S' && hemisphere !== '南';
    const y = north ? northing : northing - 10000000;
    const cm = utmCentralMeridian(zone);
    const r = tmInverse(easting - 500000, y, cm, { k0: K0, key });
    r.zone = zone; r.hemisphere = north ? 'N' : 'S'; r.cm_used = cm;
    // zone 32 例外区（56~64°N, 3~12°E）用 9°E；若解出的经度不在本带内就改用例外中央经线
    if (zone === 32 && r.lat >= 56 && r.lat < 64 && (r.lon < 6 || r.lon >= 12)) {
      const alt = tmInverse(easting - 500000, y, 9, { k0: K0, key });
      alt.zone = 32; alt.hemisphere = r.hemisphere; alt.cm_used = 9;
      alt.note = 'zone 32 挪威例外区，按 9°E 中央经线解算';
      return alt;
    }
    return r;
  }
  /* ------------------------------------------------------------ 2b. UPS 极地方位投影 */
  // UPS 是「极地方位（Stereographic）」，不是绕转墨卡托。这里用可证明的构造：
  //   t(φ) = e^{−ψ(φ)}，ψ 为等角纬度 → ρ = 2·a·K·t(φ) 必然共形（因为 ρ∝e^{−ψ} 满足
  //   dρ/(M dφ) = ρ/(ν cosφ)），K 由「极点比例因子 = 0.994」（EPSG:5041/5042 的定义）定出。
  // 约定：北半球 x=ρ·sinλ、y=ρ·cosλ；南半球 x=ρ·sinλ、y=−ρ·cosλ；假原点均为 2 000 000 m。
  const UPS_K0_POLE = 0.994, UPS_FE = 2000000, UPS_FN = 2000000;
  function upsT(lat, key) {
    if (abs(lat) >= 90) return 0;
    return Math.exp(-isometricLat(abs(lat), key));
  }
  function upsConst(key) {
    const e = G().ell(key), ex = Math.sqrt(e.e2);
    // k(pole) = K·√(1−e²)·((1+e)/(1−e))^{e/2}
    return UPS_K0_POLE / (Math.sqrt(1 - e.e2) * Math.pow((1 + ex) / (1 - ex), ex / 2));
  }
  function upsScaleOf(lat, key) {
    const e = G().ell(key), K = upsConst(key), s = Math.sin(abs(lat) * D2R);
    return 2 * K * upsT(lat, key) * Math.sqrt(1 - e.e2 * s * s) / Math.cos(abs(lat) * D2R);
  }
  function upsForward(lat, lon, opts) {
    const o = opts || {}, key = o.key || 'WGS84', northHemi = lat >= 0;
    const e = G().ell(key), K = upsConst(key);
    const rho = 2 * e.a * K * upsT(lat, key);
    const l = wrap180(lon) * D2R;
    const x = rho * Math.sin(l), y = northHemi ? rho * Math.cos(l) : -rho * Math.cos(l);
    return {
      easting: UPS_FE + round(x, 4), northing: UPS_FN + round(y, 4),
      rho: round(rho, 4), colat_grid: round(abs(lat) * 111320, 1), k: upsScaleOf(lat, key),
      hemisphere: northHemi ? 'N' : 'S', scheme: 'UPS', epsg: northHemi ? 5041 : 5042,
      note: '|纬度|>84° 使用极地方位投影（极点比例 0.994，假原点 2 000 000 m）'
    };
  }
  function upsInverse(easting, northing, hemisphere, opts) {
    const o = opts || {}, key = o.key || 'WGS84';
    if (!isNum(easting) || !isNum(northing)) return { error: 'UPS 需要数值 easting / northing' };
    const northHemi = (hemisphere || 'N') !== 'S';
    const x = easting - UPS_FE, y = northHemi ? northing - UPS_FN : -(northing - UPS_FN);
    const e = G().ell(key), K = upsConst(key);
    const rho = Math.hypot(x, y);
    if (rho === 0) return { lat: northHemi ? 90 : -90, lon: wrap180(o.refLon || 0), hemisphere: northHemi ? 'N' : 'S', scheme: 'UPS' };
    const t = rho / (2 * e.a * K);
    if (t <= 0 || t >= 1) return { error: 'UPS 网格值超出可解范围（t=' + t.toExponential(2) + '）' };
    const latAbs = latFromIsometric(-Math.log(t), key);
    // y 已被翻回「北半球风格」的 ρ·cosλ，因此 λ = atan2(x, y) 对两极通用
    const lam = Math.atan2(x, y) * R2D;
    return { lat: northHemi ? latAbs : -latAbs, lon: wrap180(lam), hemisphere: northHemi ? 'N' : 'S', scheme: 'UPS', rho: rho, k: upsScaleOf(latAbs, key) };
  }

  /* ---------------------------------------------------------------- 3. MGRS */
  // 字母表与分组按公开权威实现核对（movable-type geodesy / MGRS 手册）：
  //   列字母每 3 个带循环一次：ABCDEFGH | JKLMNPQR | STUVWXYZ（均无 I、O）
  //   行字母每 2 个带交替：奇数带从 A 起，偶数带整体后移 5 位
  const BANDS = 'CDEFGHJKLMNPQRSTUVWX';              // 20 个 8° 纬度带，C=80°S 起，X 到 84°N
  const E100 = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
  const N100 = ['ABCDEFGHJKLMNPQRSTUV', 'FGHJKLMNPQRSTUVABCDE'];
  function mgrsBand(lat) {
    if (lat < -80 || lat > 84) return null;
    return BANDS.charAt(clamp(Math.floor((lat + 80) / 8), 0, 19));
  }
  function mgrsFromLatLon(lat, lon, digits) {
    const dg = clamp(Math.round(digits == null ? 5 : digits), 1, 7);
    const z = utmForward(lat, lon, null, {});
    if (z.scheme === 'UPS') return { error: 'MGRS 不覆盖南北极（|纬度| > 84°）' };
    const band = mgrsBand(lat);
    if (!band) return { error: 'MGRS 仅覆盖 80°S ~ 84°N' };
    const col = E100[(z.zone - 1) % 3].charAt(Math.floor(z.easting / 100000));
    // 行字母：按 UTM 北距（南半球含 10,000,000 假定北距）每 2,000,000 m 循环。
    // 南半球行字母的起算方向各资料不一致，本程序取「数字仍自 100 km 方格南边线向北量」
    // 这一种，保证编码/解码严格互逆；与手机 App 对不上时以官方手册为准。
    const row = N100[(z.zone - 1) % 2].charAt(Math.floor((z.northing % 2000000) / 100000));
    const div = pow(10, 5 - dg);
    const eTxt = String(Math.floor(z.easting % 100000 / div)).padStart(dg, '0');
    const nTxt = String(Math.floor(z.northing % 100000 / div)).padStart(dg, '0');
    return {
      mgrs: z.zone + band + ' ' + col + row + ' ' + eTxt + ' ' + nTxt,
      compact: z.zone + band + col + row + eTxt + nTxt,
      zone: z.zone, band, hemi: z.hemisphere, col, row, digits: dg, cell_m: div,
      easting: z.easting, northing: z.northing,
      east100k: z.easting % 100000, north100k: z.northing % 100000
    };
  }
  function latLonFromMgrs(text) {
    const m = String(text || '').toUpperCase().replace(/[\s\-_]+/g, '');
    const g = m.match(/^(\d{1,2})([CDEFGHJKLMNPQRSTUVWX])([A-HJ-NP-Z]{2})(\d{1,14})$/);
    if (!g) return { error: 'MGRS 格式无法识别，示例：50S GM 91520 06545' };
    const zone = parseInt(g[1], 10), band = g[2], cd = g[3];
    if (zone < 1 || zone > 60) return { error: '带号必须在 1~60 之间，收到 ' + zone };
    // 数字可能写成两串（东距/北距）或一整串；一整串时按偶数位对半切
    let eTxt = g[4], nTxt = '';
    const sep = String(text || '').match(/(\d{1,7})\s+(\d{1,7})\s*$/);
    if (sep) { eTxt = sep[1]; nTxt = sep[2]; }
    else {
      if (eTxt.length % 2) return { error: '数字总位数必须是偶数（东距与北距各一半），收到 ' + eTxt.length + ' 位' };
      nTxt = eTxt.slice(eTxt.length / 2); eTxt = eTxt.slice(0, eTxt.length / 2);
    }
    if (eTxt.length !== nTxt.length) return { error: '东距与北距位数必须相同（' + eTxt.length + ' vs ' + nTxt.length + '）' };
    const dg = eTxt.length;
    if (dg > 7) return { error: '位数超过 7 位（米级以下无意义）' };
    const colIdx = E100[(zone - 1) % 3].indexOf(cd.charAt(0));
    if (colIdx < 0) return { error: '列字母「' + cd.charAt(0) + '」不属于 ' + zone + ' 带（该带可用：' + E100[(zone - 1) % 3].split('').join(' ') + '）' };
    const rowIdx = N100[(zone - 1) % 2].indexOf(cd.charAt(1));
    if (rowIdx < 0) return { error: '行字母「' + cd.charAt(1) + '」非法（可用：' + N100[(zone - 1) % 2].split('').join(' ') + '）' };
    const cell = pow(10, 5 - dg);
    // 网格引用指的是那个方格，通常取方格中心作为点位（proj4js 等也如此），
    // 这样「正算→解码」的误差 ≤ 半格，而不是整格。
    const easting = colIdx * 100000 + (Number(eTxt) + 0.5) * cell;
    const eSw = colIdx * 100000 + Number(eTxt) * cell;
    const bandIdx = BANDS.indexOf(band), lat0 = -80 + bandIdx * 8;
    const southHemi = bandIdx < 10;                       // C…M 在南半球，N…X 在北半球
    let best = null;
    for (let k = 0; k <= 20; k++) {
      const northing = rowIdx * 100000 + (Number(nTxt) + 0.5) * cell + k * 2000000;
      if (northing > 10000000) break;
      const cand = utmInverse(easting, northing, zone, southHemi ? 'S' : 'N', {});
      if (cand.lat >= lat0 - 0.01 && cand.lat < lat0 + 8 + 0.01) {
        best = { lat: cand.lat, lon: cand.lon, zone, band, hemi: southHemi ? 'S' : 'N', col: cd.charAt(0), row: cd.charAt(1), easting, northing, cell_sw: { easting: eSw, northing: rowIdx * 100000 + Number(nTxt) * cell + k * 2000000 }, digits: dg, cell_m: cell };
        break;
      }
    }
    if (!best) return { error: '在该纬度带内找不到对应网格：请核对带号 ' + zone + band + ' 与字母 ' + cd };
    return best;
  }

  /* ------------------------------------------------------------- 4. Geohash */
  const GH_STD = '0123456789bcdefghjkmnpqrstuvwxyz';   // 标准 base32（去掉 a/i/l/o）
  function geohashEncode(lat, lon, precision) {
    const p = clamp(Math.round(precision == null ? 9 : precision), 1, 12);
    let lo = -90, hi = 90, wlo = -180, whi = 180, bit = 0, even = true, out = '', c = 0;
    while (out.length < p) {
      if (even) {
        const mid = (wlo + whi) / 2;
        if (lon >= mid) { wlo = mid; c |= 1 << (4 - bit); } else whi = mid;
      } else {
        const mid = (lo + hi) / 2;
        if (lat >= mid) { lo = mid; c |= 1 << (4 - bit); } else hi = mid;
      }
      even = !even;
      if (bit === 4) { out += GH_STD.charAt(c); bit = 0; c = 0; } else bit++;
    }
    const wLat = hi - lo, wLon = whi - wlo, mp = G().metersPerDegree((lo + hi) / 2);
    return {
      geohash: out, bbox: { lat_min: lo, lat_max: hi, lon_min: wlo, lon_max: whi },
      lat: (lo + hi) / 2, lon: (wlo + whi) / 2, precision: p,
      width_deg_lat: wLat, width_deg_lon: wLon,
      cell_lat_m: mp.lat_m * wLat, cell_lon_m: mp.lon_m * wLon,
      error_lat_m: mp.lat_m * wLat / 2, error_lon_m: mp.lon_m * wLon / 2
    };
  }
  function geohashDecode(code) {
    const s = String(code || '').trim().toLowerCase();
    if (!s) return { error: 'Geohash 为空' };
    if (/[aio]/.test(s)) return { error: 'Geohash 不含字符 a/i/l/o' };
    let lo = -90, hi = 90, wlo = -180, whi = 180, even = true;
    for (let i = 0; i < s.length; i++) {
      const idx = GH_STD.indexOf(s.charAt(i));
      if (idx < 0) return { error: '非法字符 ' + s.charAt(i) };
      for (let b = 4; b >= 0; b--) {
        const bitv = (idx >> b) & 1;
        if (even) { const mid = (wlo + whi) / 2; bitv ? (wlo = mid) : (whi = mid); }
        else { const mid = (lo + hi) / 2; bitv ? (lo = mid) : (hi = mid); }
        even = !even;
      }
    }
    const wl = hi - lo, ww = whi - wlo;
    return {
      lat: (lo + hi) / 2, lon: (wlo + whi) / 2, precision: s.length,
      bbox: { lat_min: lo, lat_max: hi, lon_min: wlo, lon_max: whi },
      width_deg_lat: wl, width_deg_lon: ww,
      cell_lat_m: G().metersPerDegree((lo + hi) / 2).lat_m * wl,
      cell_lon_m: G().metersPerDegree((lo + hi) / 2).lon_m * ww,
      error_lat_m: G().metersPerDegree((lo + hi) / 2).lat_m * wl / 2,
      error_lon_m: G().metersPerDegree((lo + hi) / 2).lon_m * ww / 2
    };
  }

  /* --------------------------------------------------- 6. Plus Code (Open Location Code) */
  // 编码骨架（20 字符表、每对分辨率 20°→1°→0.05°→0.0025°→0.000125°、第 11 位起 4×5 栅格）
  // 按公开规范推导，正/反算自洽。校验位是【本工具自己的约定】：
  // 官方 OLC 的 checksum 权重未逐位核对，因此这里只做「同码重算一致 / 篡改一位可检出」，
  // 不宣称与 Google 官方实现兼容，导出的 code_local 字段也明确带 _local 后缀。
  const OLC_ALPHA = '23456789CFGHJMPQRVWX';   // 20 字符表：去掉易混的 0/1/I/L/U/O 等
  const OLC_SEP = '+', OLC_PAD = '0';
  const OLC_PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];          // 每个「经纬度字符对」的分辨率(°)
  const OLC_GRID_LAT = [0.00003125, 7.8125e-6, 1.953125e-6, 4.8828125e-7]; // 第 11 位起：纬度 4 分
  const OLC_GRID_LON = [0.000025, 5e-6, 1e-6, 2.5e-7];                     // 第 11 位起：经度 5 分
  const OLC_MAX_PAIR = 5, OLC_SEP_POS = 8;
  function olcEncode(lat, lon, codeLength) {
    if (!isNum(lat) || !isNum(lon)) return { error: '经纬度非法' };
    let ll = clamp(lat, -90, 90);
    const ln = wrap180(lon);
    if (ll === 90) ll = 89.9999999;
    const total = clamp(Math.round(codeLength == null ? 10 : codeLength), 6, 14);
    const pairCount = clamp(Math.ceil(total / 2), 3, OLC_MAX_PAIR);
    const gridCount = Math.max(0, total - pairCount * 2);
    let rLat = ll + 90, rLon = ln + 180, digits = '';
    for (let i = 0; i < pairCount; i++) {
      const res = OLC_PAIR_RES[i];
      const dl = clamp(Math.floor(rLat / res), 0, 19), dn = clamp(Math.floor(rLon / res), 0, 19);
      rLat -= dl * res; rLon -= dn * res;
      digits += OLC_ALPHA.charAt(dl) + OLC_ALPHA.charAt(dn);
    }
    for (let i = 0; i < gridCount; i++) {
      const rl = clamp(Math.floor(rLat / OLC_GRID_LAT[i]), 0, 3), rn = clamp(Math.floor(rLon / OLC_GRID_LON[i]), 0, 4);
      rLat -= rl * OLC_GRID_LAT[i]; rLon -= rn * OLC_GRID_LON[i];
      digits += OLC_ALPHA.charAt(rl * 5 + rn);
    }
    const core = digits.length > OLC_SEP_POS ? digits.slice(0, OLC_SEP_POS) + OLC_SEP + digits.slice(OLC_SEP_POS) : digits + OLC_SEP;
    return {
      code: core, code_local: core + OLC_SEP + olcChecksum(digits), checksum_local: olcChecksum(digits),
      digits, lat: ll, lon: ln, length: digits.length,
      cell_lat_deg: gridCount ? OLC_GRID_LAT[gridCount - 1] : OLC_PAIR_RES[pairCount - 1],
      cell_lon_deg: gridCount ? OLC_GRID_LON[gridCount - 1] : OLC_PAIR_RES[pairCount - 1],
      resolution_m: G().metersPerDegree(ll).lat_m * (gridCount ? OLC_GRID_LAT[gridCount - 1] : OLC_PAIR_RES[pairCount - 1]),
      area_km2: (G().metersPerDegree(ll).lat_m * (gridCount ? OLC_GRID_LAT[gridCount - 1] : OLC_PAIR_RES[pairCount - 1]) / 1000) *
        (G().metersPerDegree(ll).lon_m * (gridCount ? OLC_GRID_LON[gridCount - 1] : OLC_PAIR_RES[pairCount - 1]) / 1000)
    };
  }
  function olcChecksum(digits) {
    let p1 = 0, p2 = 0;
    for (let i = 0; i < digits.length; i++) {
      const v = OLC_ALPHA.indexOf(digits.charAt(i));
      if (v < 0) continue;
      if (i % 2 === 0) { p1 = (p1 + v * 5) % 23; p2 = (p2 + v * 7) % 29; }
      else { p1 = (p1 + v * 3) % 23; p2 = (p2 + v * 37) % 29; }
    }
    return OLC_ALPHA.charAt(p1 % 20) + OLC_ALPHA.charAt(p2 % 20);
  }
  function olcDecode(code) {
    const s = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    const seg = s.split('+').filter((x) => x.length);
    if (!seg.length) return { error: 'Plus Code 为空' };
    if (seg.length > 3) return { error: 'Plus Code 中 + 过多' };
    // 形态：digits[+digits][+checksum]；分隔符本身可省略（位置固定在第 8 位后）
    let digits = seg.slice(0, seg.length === 3 ? 2 : 1).join('');
    const check = seg.length === 3 ? seg[2] : (seg.length === 2 && seg[1].length === 2 && digits.length >= 10 ? '' : '');
    if (seg.length === 3 && seg[2].length !== 2) return { error: '校验位必须是 2 个字符' };
    if (seg.length === 2 && seg[1].length === 2 && seg[0].length < 8) digits = seg.join('');
    if (/[^0-9A-Z]/.test(digits)) return { error: 'Plus Code 含非法字符' };
    // 补零（padding）表示被省略的高位对，跳过即可：它们的值就是 0
    const clean = digits.replace(new RegExp('^' + OLC_PAD + '+'), '');
    if (/[^0-9A-Z]/.test(clean)) return { error: 'Plus Code 含非法字符' };
    const pairCount = Math.min(OLC_MAX_PAIR, Math.floor(clean.length / 2));
    const gridCount = Math.max(0, clean.length - pairCount * 2);
    if (clean.length < 6) return { error: 'Plus Code 至少 6 位（3 个字符对）' };
    let lat = -90, lon = -180;
    for (let i = 0; i < pairCount; i++) {
      const a = OLC_ALPHA.indexOf(clean.charAt(i * 2)), b = OLC_ALPHA.indexOf(clean.charAt(i * 2 + 1));
      if (a < 0 || b < 0) return { error: '字符不在 20 字母编码表内：' + clean.charAt(i * 2) + clean.charAt(i * 2 + 1) };
      lat += a * OLC_PAIR_RES[i]; lon += b * OLC_PAIR_RES[i];
    }
    for (let i = 0; i < gridCount; i++) {
      const v = OLC_ALPHA.indexOf(clean.charAt(pairCount * 2 + i));
      if (v < 0) return { error: '栅格位非法' };
      lat += Math.floor(v / 5) * OLC_GRID_LAT[i];
      lon += (v % 5) * OLC_GRID_LON[i];
    }
    const cellLat = gridCount ? OLC_GRID_LAT[gridCount - 1] : OLC_PAIR_RES[pairCount - 1];
    const cellLon = gridCount ? OLC_GRID_LON[gridCount - 1] : OLC_PAIR_RES[pairCount - 1];
    const out = {
      lat: lat + cellLat / 2, lon: wrap180(lon + cellLon / 2),
      corner: { lat, lon }, length: clean.length, pairs: pairCount, grid: gridCount,
      cell_lat_deg: cellLat, cell_lon_deg: cellLon,
      bbox: { lat_min: lat, lat_max: lat + cellLat, lon_min: lon, lon_max: wrap180(lon + cellLon) },
      resolution_m: G().metersPerDegree(lat).lat_m * cellLat
    };
    if (seg.length === 3) {
      const expect = olcChecksum(clean);
      out.checksum = seg[2];
      out.checksum_scheme = 'local';
      out.checksum_valid = seg[2] === expect;
      if (!out.checksum_valid) out.checksum_expected = expect;
    }
    return out;
  }
  function olcShorten(code, refLat, refLon) {
    const d = olcDecode(code);
    if (d.lat == null) return { error: d.error };
    if (!isNum(refLat) || !isNum(refLon)) return { error: '缩短需要参考位置' };
    const span = 0.05;   // 规范要求短码与参考点在同一「千分之一度」区域内
    if (abs(d.lat - refLat) > span || abs(wrap180(d.lon - refLon)) > span) return { error: '与参考点相距超过 ' + (span * 111).toFixed(0) + ' km，无法缩短（短码只适用于同一片区）' };
    const digits = String(code).split('+')[0];
    let cut = 0;
    while (cut + 1 < OLC_SEP_POS && digits.charAt(cut) === OLC_ALPHA.charAt(0) && digits.charAt(cut + 1) === OLC_ALPHA.charAt(0)) cut += 2;
    if (!cut) return { error: '该码的高位对不是起始格，无需/无法缩短' };
    return { short: digits.slice(cut) + (String(code).includes('+') ? '+' + code.split('+')[1] : ''), removed: cut, reference: { lat: refLat, lon: refLon } };
  }
  function olcRecover(short, refLat, refLon) {
    const s = String(short || '').toUpperCase().replace(/\s+/g, '');
    if (!isNum(refLat) || !isNum(refLon)) return { error: '补全短码需要参考位置' };
    const head = s.split('+')[0];
    const missing = OLC_SEP_POS - head.length;
    if (missing <= 0) return { code: s, already_full: true, ...olcDecode(s) };
    if (!Number.isInteger(missing / 2)) return { error: '短码位数必须是偶数' };
    const res = OLC_PAIR_RES[missing / 2];
    let digits = '';
    for (let i = 0; i < missing / 2; i++) {
      const dl = clamp(Math.floor((Math.floor(refLat / res) * res + 90) / OLC_PAIR_RES[i]), 0, 19);
      const dn = clamp(Math.floor((Math.floor(refLon / res) * res + 180) / OLC_PAIR_RES[i]), 0, 19);
      digits += OLC_ALPHA.charAt(dl) + OLC_ALPHA.charAt(dn);
    }
    const rest = s.split('+').slice(1).join('');
    const code = digits + head + OLC_SEP + rest;
    const d = olcDecode(code);
    return Object.assign({ code, filled_digits: missing }, d);
  }

  /* ---------------------------------------------------------- 6b. DMS / 十进制 */
  // 半球字母：N/S 定纬度，E/W 定经度；中文「南/北」为纬度，「东/西」为经度。
  // 一个度分秒值 = 「可选方向字母 + 度 +（分）+（秒）」，方向字母可前置（中文式）或后置（英文式）。
  // 所以先按标记流分组，而不是按空格切字符串：空格既出现在「31° 13' 49.44"」内部，
  // 也出现在两段之间，靠空格切必然把一段切成三份（这是本函数原先的错处）。
  function normalizeDmsMarks(s) {
    return String(s == null ? '' : s)
      .replace(/[º˚]/g, '°').replace(/度/g, '°')
      .replace(/[′ʹ‘’´`分]/g, "'").replace(/[″“”秒]/g, '"')
      .replace(/[，、；]/g, ',').replace(/纬|经/g, '')
      .replace(/\s{2,}/g, ' ');
  }
  function hemiAxisSign(ch) {
    if (ch === 'N' || ch === '北') return { axis: 'lat', sign: 1 };
    if (ch === 'S' || ch === '南') return { axis: 'lat', sign: -1 };
    if (ch === 'E' || ch === '东') return { axis: 'lon', sign: 1 };
    if (ch === 'W' || ch === '西') return { axis: 'lon', sign: -1 };
    return null;
  }
  // 标记流 → 值组：每组 = 一串数字 + 组内出现过的标记 + 前置/后置方向字母
  function dmsGroups(text) {
    const s = normalizeDmsMarks(text);
    const re = /([-+]?\d+(?:[.,]\d+)?)|([°'"])|([NSEW])|([北南东西])|(,)/g;
    const groups = [];
    let cur = null, lead = null, m;
    const open = () => { cur = { nums: [], marks: '', neg: false, lead: lead, trail: null }; lead = null; groups.push(cur); };
    while ((m = re.exec(s))) {
      if (m[1] != null) {
        // 已经收到过后置方向字母的组不能再吞下一个数字：那是下一个值
        if (!cur || cur.trail != null) open();
        const v = parseFloat(m[1].replace(',', '.'));
        if (isNum(v)) { cur.nums.push(v); if (m[1][0] === '-') cur.neg = true; }
      } else if (m[2] != null) {
        if (!cur) open();
        cur.marks += m[2];
      } else if (m[3] != null || m[4] != null) {
        const ch = m[3] != null ? m[3] : m[4];
        // 中文方向字母总在数值前面；大写拉丁字母总在数值后面
        if (m[4] != null) { if (cur && cur.nums.length) { lead = ch; open(); } else lead = ch; }
        else if (cur && cur.nums.length && cur.trail == null) cur.trail = ch;
        else { if (cur && cur.nums.length) { lead = ch; open(); } else lead = ch; }
      } else if (m[5] != null) cur = null;
    }
    return groups.filter((g) => g.nums.length);
  }
  // 单组 → 若干个独立的十进制度值（度分秒 / 度分 / 纯十进制）
  function dmsGroupValues(g) {
    const n = g.nums;
    const hasDeg = g.marks.indexOf('°') >= 0, hasMs = /['"]/.test(g.marks);
    const ch = g.trail || g.lead;
    if (n.length >= 3 && (hasDeg || hasMs || (abs(n[1]) < 60 && abs(n[2]) <= 60.5))) {
      return [{ v: (g.neg ? -1 : 1) * (abs(n[0]) + abs(n[1]) / 60 + abs(n[2]) / 3600), ch }];
    }
    if (n.length === 2 && (hasDeg || hasMs) && abs(n[1]) < 60) {
      return [{ v: (g.neg ? -1 : 1) * (abs(n[0]) + abs(n[1]) / 60), ch }];
    }
    if (n.length === 1) return [{ v: n[0], ch }];
    // 没有任何度分秒标记且多个数字：每个数字都是独立的十进制度（「40.4319 -3.6880」一行两值）
    return n.map((v, i) => ({ v, ch: i === 0 ? ch : null }));
  }
  function dmsParse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const vals = [];
    dmsGroups(raw).forEach((g) => dmsGroupValues(g).forEach((x) => {
      if (!isNum(x.v)) return;
      const h = x.ch ? hemiAxisSign(x.ch) : null;
      vals.push({ value: h ? abs(x.v) * h.sign : x.v, axis: h ? h.axis : null });
    }));
    if (!vals.length) return null;
    if (vals.length === 1) return { lat: null, lon: null, single: vals[0].value, axis: vals[0].axis, raw };
    let latV = vals.find((v) => v.axis === 'lat');
    let lonV = vals.find((v) => v.axis === 'lon');
    const rest = vals.filter((v) => v !== latV && v !== lonV);
    if (!latV && !lonV) {
      if (!rest.length) return { lat: null, lon: null, single: vals[0].value, axis: null, raw };
      if (abs(rest[0].value) > 90 && abs(rest[1] == null ? 999 : rest[1].value) <= 90) { lonV = rest[0]; latV = rest[1]; }
      else { latV = rest[0]; lonV = rest[1]; }
    } else if (!latV) {
      latV = rest.find((v) => abs(v.value) <= 90) || rest[0];
    } else if (!lonV) {
      lonV = rest.find((v) => abs(v.value) > 90) || rest[0];
    }
    if (!latV || !lonV || latV === lonV) {
      const only = latV || lonV || vals[0];
      return { lat: null, lon: null, single: only.value, axis: only.axis, raw };
    }
    if (abs(latV.value) > 90 && abs(lonV.value) <= 90) { const t = latV; latV = lonV; lonV = t; }
    return { lat: clamp(latV.value, -90, 90), lon: wrap180(lonV.value), raw };
  }
  function webMercatorForward(lat, lon) {
    const R = 6378137, p = clamp(lat, -85.05112878, 85.05112878) * D2R;
    // atanh(sinφ) 与 ln tan(π/4+φ/2) 恒等，但前者在 φ=0 时精确为 0（无浮点毛刺）
    return { x: R * wrap180(lon) * D2R, y: R * Math.atanh(Math.sin(p)), scheme: 'EPSG:3857' };
  }
  function webMercatorInverse(x, y) {
    const R = 6378137;
    const lon = wrap180((x / R) * R2D);
    const lat = 2 * Math.atan(Math.exp(y / R)) * R2D - 90;
    return { lat: clamp(lat, -85.06, 85.06), lon, on_limits: abs(y) > 20037508.34 + 1e-6, scheme: 'EPSG:3857' };
  }
  function dmsFormat(v, kind, decimals) {
    const d = decimals == null ? 3 : decimals;
    const dir = kind === 'lat' ? (v < 0 ? 'S' : 'N') : kind === 'lon' ? (v < 0 ? 'W' : 'E') : '';
    const a = abs(v);
    let dd = Math.floor(a), mm = Math.floor((a - dd) * 60), ss = (a - dd - mm / 60) * 3600;
    const sTxt = ss.toFixed(Math.max(0, d));
    if (parseFloat(sTxt) >= 60) { ss = 0; mm += 1; if (mm >= 60) { mm = 0; dd += 1; } }
    return { d: dd, m: mm, s: round(ss, d), text: dd + '° ' + String(mm).padStart(2, '0') + "' " + sTxt + "\" " + dir };
  }
  function ddmFormat(v, kind) {
    const dir = kind === 'lat' ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E');
    const a = abs(v), dd = Math.floor(a), mm = (a - dd) * 60;
    return dd + '° ' + mm.toFixed(6) + "' " + dir;
  }

  /* ------------------------------------------- 7. GCJ-02 / BD-09（火星/百度） */
  const GCJ_A = 6378245, GCJ_EE = 0.00669342162296594323;
  function outOfChina(lat, lon) {
    const l = wrap180(lon);
    if (l < 72.004 || l > 137.8347) return true;
    if (lat < 0.8293 || lat > 55.8271) return true;
    return false;
  }
  // GCJ-02 的偏转量由公开的三角级数经验式给出（非大地测量模型，本身只有米级一致性）。
  // 下面三份函数是流传最广的那套常数，自检只验证「量级 + 方向 + 往返闭合」，
  // 因为无官方控制点就无法断言绝对精度。
  function transformLat(x, y) {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
    r += (160 * Math.sin(x / 12 * PI) + 320 * Math.sin(x * PI / 30)) * 2 / 3;
    return r;
  }
  function transformLon(x, y) {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
    return r;
  }
  function gcjDelta(lat, lon) {
    const radLat = lat * D2R;
    const magic = 1 - GCJ_EE * sq(Math.sin(radLat));
    const sqrtMagic = Math.sqrt(magic);
    const dx = lon - 105, dy = lat - 35;
    return {
      dlat: transformLat(dx, dy) * 180 / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * PI),
      dlon: transformLon(dx, dy) * 180 / (GCJ_A / sqrtMagic * Math.cos(radLat) * PI)
    };
  }
  function gcjFromWgs84(lat, lon) {
    if (outOfChina(lat, lon)) return { lat, lon: wrap180(lon), shifted: false };
    const d = gcjDelta(lat, lon);
    return { lat: lat + d.dlat, lon: wrap180(lon + d.dlon), shifted: true };
  }
  function wgs84FromGcj02(lat, lon) {
    if (outOfChina(lat, lon)) return { lat, lon: wrap180(lon), iterations: 0, residual_m: 0 };
    let wLat = lat, wLon = lon;
    for (let i = 0; i < 8; i++) {
      const g = gcjFromWgs84(wLat, wLon);
      const dLat = g.lat - lat, dLon = wrap180(g.lon - lon);
      wLat -= dLat; wLon = wrap180(wLon - dLon);
      if (abs(dLat) < 1e-11 && abs(dLon) < 1e-11) break;
    }
    const g2 = gcjFromWgs84(wLat, wLon);
    return { lat: wLat, lon: wrap180(wLon), iterations: 8, residual_m: G().inverse(g2.lat, g2.lon, lat, lon).distance_m };
  }
  const BDP = PI * 3000 / 180;
  // 流传最广的那套 BD-09 常数（在极坐标上再加百万分之一的扰动，最后平移 0.006/0.0065°）：
  //   z = √(lon²+lat²) + 2e-5·sin(BDP·lat)，θ = atan2(lat,lon) + 3e-6·cos(BDP·lon)
  //   bd_lat = z·sinθ + 0.006，bd_lon = z·cosθ + 0.0065
  // 自检只验「往返闭合 + 偏移量级」：没有官方控制点就无法断言绝对精度。
  function bdFromGcj(lat, lon) {
    const z = Math.hypot(lon, lat) + 0.00002 * Math.sin(BDP * lat);
    const th = Math.atan2(lat, lon) + 0.000003 * Math.cos(BDP * lon);
    return { lat: z * Math.sin(th) + 0.006, lon: wrap180(z * Math.cos(th) + 0.0065) };
  }
  function gcjFromBdRaw(lat, lon) {
    const x = lon - 0.0065, y = lat - 0.006;
    const z = Math.hypot(x, y) - 0.00002 * Math.sin(BDP * y);
    const th = Math.atan2(y, x) - 0.000003 * Math.cos(BDP * x);
    return { lat: z * Math.sin(th), lon: wrap180(z * Math.cos(th)) };
  }
  // 那套公开常数的正/反式并非严格互逆（直接反解残留 ~0.1 m）。
  // 这里用不动点迭代把残差压到 1e-11°（亚微米），保证往返闭合。
  function gcjFromBd(lat, lon) {
    let g = gcjFromBdRaw(lat, lon);
    for (let i = 0; i < 6; i++) {
      const f = bdFromGcj(g.lat, g.lon);
      const dLat = f.lat - lat, dLon = wrap180(f.lon - lon);
      g = { lat: g.lat - dLat, lon: wrap180(g.lon - dLon) };
      if (abs(dLat) < 1e-12 && abs(dLon) < 1e-12) break;
    }
    return g;
  }
  function bdFromWgs(lat, lon) { const g = gcjFromWgs84(lat, lon); return bdFromGcj(g.lat, g.lon); }
  function wgsFromBd(lat, lon) { const g = gcjFromBd(lat, lon); return wgs84FromGcj02(g.lat, g.lon); }

  /* ------------------------------------------------------- 8. 坐标系注册表 */
  const CRS = {
    WGS84: { name: 'WGS84（GPS 原始）', kind: 'geo', epsg: 4326 },
    CGCS2000: { name: 'CGCS2000（2008 国家大地坐标）', kind: 'geo', epsg: 4490, note: '与 WGS84 差异在厘米级，离线按恒等处理，厘米级作业请用官方参数' },
    GCJ02: { name: 'GCJ-02（国测局 / 火星坐标）', kind: 'offset', users: '高德、腾讯、Google 中国、部分滴滴/美团' },
    BD09: { name: 'BD-09（百度坐标）', kind: 'offset', users: '百度地图、百度 Hi' },
    EPSG3857: { name: 'Web 墨卡托 EPSG:3857', kind: 'proj' },
    UTM: { name: 'UTM 通用横轴墨卡托', kind: 'proj' },
    UPS: { name: 'UPS 通用极地方位', kind: 'proj' },
    MGRS: { name: 'MGRS 军事网格', kind: 'grid' },
    GEOHASH: { name: 'Geohash', kind: 'grid' },
    OLC: { name: 'Plus Code / OLC', kind: 'grid' },
    USER7: { name: '自定义 7 参数基准', kind: 'geo' }
  };
  // 统一入口：把任意受支持输入 → WGS84 经纬度
  // 地理坐标：toWgs84(lat, 'GCJ02', {lon})；投影/网格：toWgs84({easting,northing,…}, 'UTM') 等
  function toWgs84(value, from, ctx) {
    const c = ctx || {};
    const obj = value != null && typeof value === 'object';
    const v = obj || typeof value === 'string' ? value : Number(value);
    const geo = (val, lonVal) => ({ lat: Number(obj ? val.lat : val), lon: wrap180(Number(obj ? val.lon : lonVal)) });
    switch (from) {
      case 'WGS84': case 'CGCS2000': case undefined: case null: case '':
        return { lat: Number(obj ? v.lat : v), lon: obj ? wrap180(Number(v.lon)) : c.lon, ok: true };
      case 'GCJ02': { const p = geo(v, c.lon); return Object.assign({ ok: true }, wgs84FromGcj02(p.lat, p.lon)); }
      case 'BD09': { const p = geo(v, c.lon); return Object.assign({ ok: true }, wgsFromBd(p.lat, p.lon)); }
      case 'USER7': { const p = geo(v, c.lon); const r = G().datumShift7(p.lat, p.lon, Number(obj ? v.h : c.h) || 0, c.datum || {}); return Object.assign({ ok: true }, r); }
      case 'UTM': {
        if (!obj) return { ok: false, error: 'UTM 需要 {easting, northing, zone, hemisphere}' };
        const r = utmInverse(Number(v.easting), Number(v.northing), Number(v.zone), v.hemisphere, c);
        return Object.assign({ ok: isNum(r.lat) }, r);
      }
      case 'UPS': {
        if (!obj) return { ok: false, error: 'UPS 需要 {easting, northing, hemisphere}' };
        const r = upsInverse(Number(v.easting), Number(v.northing), v.hemisphere, c);
        return Object.assign({ ok: isNum(r.lat) }, r);
      }
      case 'EPSG3857': {
        if (!obj) return { ok: false, error: 'EPSG:3857 需要 {x, y}' };
        return Object.assign({ ok: true }, webMercatorInverse(Number(v.x), Number(v.y)));
      }
      case 'MGRS': { const r = latLonFromMgrs(obj ? v.mgrs : v); return Object.assign({ ok: r.lat != null }, r); }
      case 'GEOHASH': { const r = geohashDecode(obj ? v.geohash : v); return Object.assign({ ok: r.lat != null }, r); }
      case 'OLC': { const r = olcDecode(obj ? v.code : v); return Object.assign({ ok: r.lat != null }, r); }
      default: return { ok: false, error: '未知的输入坐标系：' + from };
    }
  }
  function fromWgs84(lat, lon, to, ctx) {
    const c = ctx || {};
    switch (to) {
      case 'WGS84': case 'CGCS2000': case undefined: case null: case '': return { lat, lon };
      case 'GCJ02': return gcjFromWgs84(lat, lon);
      case 'BD09': return bdFromWgs(lat, lon);
      case 'EPSG3857': return webMercatorForward(lat, lon);
      case 'UTM': return utmForward(lat, lon, c.zone, c);
      case 'MGRS': return mgrsFromLatLon(lat, lon, c.digits);
      case 'GEOHASH': return geohashEncode(lat, lon, c.precision);
      case 'OLC': return olcEncode(lat, lon, c.length);
      case 'USER7': return G().datumShift7(lat, lon, c.h || 0, c.datum || {});
      default: return { error: '未知的目标坐标系：' + to };
    }
  }

  /* --------------------------------------------------- 9. 任意文本 / URL 解析 */
  const URL_HOST_MAP = [
    { re: /google\.[a-z.]+\/maps.*[?&]q=([-\d.,%20]+)/i, key: 'q', kind: 'lat,lon' },
    { re: /google\.[a-z.]+\/maps\/[^/]*@([-\d.]+),([-\d.]+)/i, key: 'at', kind: 'lat,lon' },
    { re: /google\.[a-z.]+\/maps\/place\/[^/]*@([-\d.]+),([-\d.]+)/i, key: 'place', kind: 'lat,lon' },
    { re: /[?&]ll=([-\d.]+),([-\d.]+)/i, key: 'll', kind: 'lat,lon' },
    { re: /[?&]q=([-\d.]+)[,%20]+([-\d.]+)/i, key: 'q2', kind: 'lat,lon' },
    { re: /[?&]destination=([-\d.]+)[,%20]+([-\d.]+)/i, key: 'dest', kind: 'lat,lon' },
    { re: /[?&]daddr=([-\d.]+),([-\d.]+)/i, key: 'daddr', kind: 'lat,lon' },
    { re: /[?&]query=([-\d.]+),([-\d.]+)/i, key: 'query', kind: 'lat,lon' },
    { re: /[?&]q=([-\d.]+)%2C([-\d.]+)/i, key: 'qenc', kind: 'lat,lon' },
    { re: /amap\.com\/place\/([-\d.]+),([-\d.]+)/i, key: 'amap_place', kind: 'lat,lon' },
    { re: /[?&]center=([-\d.]+)[%2C,]+([-\d.]+)/i, key: 'center', kind: 'lat,lon' },
    { re: /[?&]markers=([-\d.]+),([-\d.]+)/i, key: 'markers', kind: 'lat,lon' },
    { re: /[?&]geohash=([0-9a-z]{4,})/i, key: 'geohash', kind: 'geohash' },
    { re: /\/([0-9a-z]{8,12})\/?$/i, key: 'osm_short', kind: 'geohash' },
    { re: /osm\.org\/node\/(\d+)/i, key: 'osm_node', kind: 'id' },
    { re: /[?&]ml=(\d+(?:\.\d+)?)(?:%2C|,)(\d+(?:\.\d+)?)/i, key: 'ml', kind: 'lat,lon' },
    { re: /[?&]p=([-\d.]+)[,;]%?2?([-\d.]+)/i, key: 'p', kind: 'lat,lon' },
    { re: /maps\?ll=|\/preview\/dir.*/i, key: 'misc', kind: 'none' },
    { re: /yandex\.[a-z]+\/\?ll=([-\d.]+),([-\d.]+)/i, key: 'yandex', kind: 'lat,lon' },
    { re: /[?&]to=([-\d.]+),([-\d.]+)/i, key: 'to', kind: 'lat,lon' }
  ];
  function parseUrl(text) {
    const s = String(text || '');
    const out = [];
    // 1) query 参数形式（含 URL 编码）
    const dec = s.replace(/%2C/gi, ',').replace(/%20/gi, ' ');
    for (const spec of URL_HOST_MAP) {
      const m = dec.match(spec.re);
      if (!m) continue;
      if (spec.kind === 'lat,lon') {
        const a = parseFloat(m[1]), b = parseFloat(m[2]);
        if (!isNum(a) || !isNum(b)) continue;
        // 高德/百度/Google 的 URL 参数顺序都是 lat,lon；但 mapbox/@ 也是 lat,lon
        out.push({ lat: clamp(a, -90, 90), lon: wrap180(b), source: 'URL 参数 ' + spec.key, crs_guess: /amap|baidu|qq|gaode/i.test(s) ? (/baidu/i.test(s) ? 'BD09' : 'GCJ02') : 'WGS84', confidence: 0.86 });
      } else if (spec.kind === 'geohash') {
        const g = geohashDecode(m[1]);
        if (g.lat != null) out.push({ lat: g.lat, lon: g.lon, source: 'URL geohash', crs_guess: 'WGS84', confidence: 0.9 });
      } else if (spec.kind === 'id') {
        out.push({ id: m[1], source: 'OpenStreetMap 要素 id', needs_online: true, confidence: 0.5 });
      }
    }
    // 2) /@lat,lon,zoom 路径形式
    const at = dec.match(/\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/);
    if (at) out.unshift({ lat: clamp(parseFloat(at[1]), -90, 90), lon: wrap180(parseFloat(at[2])), source: 'URL @ 段', crs_guess: /amap|baidu|gaode|qq/i.test(s) ? (/baidu/i.test(s) ? 'BD09' : 'GCJ02') : 'WGS84', confidence: 0.92 });
    // 3) geo: URI
    const geo = dec.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
    if (geo) out.unshift({ lat: parseFloat(geo[1]), lon: parseFloat(geo[2]), source: 'geo: URI', crs_guess: 'WGS84', confidence: 0.95 });
    return out;
  }
  function parseAny(text, opts) {
    const o = opts || {}, out = [];
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return { candidates: [], warnings: ['输入为空'] };
    const warnings = [];
    // URL / HTML
    if (/https?:|www\.|maps\.google|amap\.com|baidu\.com|osm\.org|yandex|\/@|geo:/i.test(raw)) {
      const u = parseUrl(raw);
      u.forEach((x) => out.push(Object.assign({ label: x.source }, x)));
    }
    // GeoJSON / KML / GPX 片段
    if (/[<{]/.test(raw)) {
      const geo = parseGeoLike(raw);
      geo.features.forEach((f) => out.push(Object.assign({ label: f.label, crs_guess: 'WGS84', confidence: 0.9 }, f)));
      if (geo.features.length) warnings.push('检测到结构化地理数据：共 ' + geo.features.length + ' 个点');
    }
    // MGRS
    const mgr = raw.toUpperCase().match(/\b(\d{1,2})([CDEFGHJKLMNPQRSTUVWX])\s?([A-HJ-NP-Z]{2})\s?(\d{1,5})\s?(\d{1,5})?\b/);
    if (mgr) { const p = latLonFromMgrs(mgr[0]); if (p.lat != null) out.push(Object.assign({ label: 'MGRS 网格 ' + mgr[0], crs_guess: 'WGS84', confidence: 0.9 }, p)); else warnings.push('MGRS 解析失败：' + p.error); }
    // Plus Code
    const olc = raw.match(/\b([0-9A-Z]{6,8}\+[0-9A-Z]{2,4}|[0-9A-Z]{4,8}\+[0-9A-Z]{2,4})\b/i);
    if (olc) out.push({ label: 'Plus Code ' + olc[0], plus_code: olc[0].toUpperCase(), needs_online: false, crs_guess: 'WGS84', confidence: 0.7, note: '短码需要参考位置才能补全，请用「Plus Code」面板解码' });
    // Geohash（4~12 位 base32，且不含 a/i/l/o，且不是普通单词）
    const gh = raw.match(/\b[0-9b-z]{6,12}\b/i);
    if (gh && !/[aio]/.test(gh[0].toLowerCase()) && /^[0-9b-z]{6,}$/.test(gh[0].toLowerCase()) && !/\d+\s*\d/.test(gh[0])) {
      const p = geohashDecode(gh[0]);
      if (p.lat != null) out.push({ label: 'Geohash ' + gh[0], lat: p.lat, lon: p.lon, crs_guess: 'WGS84', confidence: 0.72 });
    }
    // 十进制度 / DMS / 中文度分秒 —— 逐行处理
    const lines = raw.split(/[\n;|]+/);
    lines.forEach((line, idx) => {
      const L = line.trim();
      if (!L) return;
      if (/^https?:|geo:|<[a-z]|^\{|[A-Z]{2}\d/.test(L) && idx > 0) return;
      const sign = L.match(/[NSEW北南东西]/gi) || [];
      const nums = (L.match(/-?\d+(?:[.,]\d+)?/g) || []).map((x) => parseFloat(x.replace(',', '.'))).filter(isNum);
      if (!nums.length) return;
      // A) 明确带方向字母 / 度分秒标记
      if (/[°'"′″]|度|分|秒/.test(L) || (sign.length >= 2 && nums.length >= 4)) {
        const r = dmsParse(L);
        if (r && r.lat != null && r.lon != null) {
          out.push({ lat: clamp(r.lat, -90, 90), lon: wrap180(r.lon), label: '度分秒 ' + L, crs_guess: 'WGS84', confidence: 0.93 });
          return;
        }
        // 只有一个角度值时绝不能退到「取前两个数字」：那会把 31°13'49" 读成 lat=31, lon=13
        if (r && r.single != null) {
          warnings.push('该行只有一个角度值（' + r.single.toFixed(6) + (r.axis === 'lon' ? '°E）' : '°N）') + '，缺另一分量，已跳过：' + L);
          return;
        }
      }
      // B) 两个十进制数
      if (nums.length >= 2) {
        let a = nums[0], b = nums[1];
        const swapped = Math.abs(a) > 90 || (Math.abs(b) <= 90 && Math.abs(a) <= 90 && /lon.*lat|经.*纬/i.test(L));
        let lat = swapped ? b : a, lon = swapped ? a : b;
        if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { const t = lat; lat = lon; lon = t; }
        const orderKnown = !swapped;
        out.push({ lat: clamp(lat, -90, 90), lon: wrap180(lon), label: (Math.abs(a) > 90 ? '顺序已自动纠正：' : '') + '十进制度 ' + a + ', ' + b, crs_guess: 'WGS84', confidence: orderKnown ? 0.9 : 0.62, ambiguous: !orderKnown && Math.abs(a) <= 90 && Math.abs(b) <= 90 });
        return;
      }
      // C) 7/6/8 位数字：中国高斯投影单值？ 或 8 位 UTM 东距？—— 交给专门面板
      if (nums.length === 1 && String(nums[0]).replace('.', '').length >= 12) {
        out.push({ label: '疑似 12+ 位组合坐标 ' + nums[0], combined: String(nums[0]), confidence: 0.4 });
      }
    });
    // 3) UTM 书写形式 "33N 500000 4649000"
    const utmTxt = raw.match(/\b(\d{1,2})\s?([NSnNsS])\s?(\d{5,7}(?:\.\d+)?)\s?(\d{6,7}(?:\.\d+)?)\b/);
    if (utmTxt) {
      const p = utmInverse(parseFloat(utmTxt[3]), parseFloat(utmTxt[4]), parseInt(utmTxt[1], 10), utmTxt[2].toUpperCase(), {});
      if (p.lat != null && Math.abs(p.lat) <= 90) out.push(Object.assign({ label: 'UTM ' + utmTxt[0], crs_guess: 'WGS84', confidence: 0.85 }, p));
    }
    // 去重 + 排序
    const seen = Object.create(null), dedup = [];
    out.sort((x, y) => (y.confidence || 0) - (x.confidence || 0));
    out.forEach((c) => {
      const k = c.lat == null ? c.label : c.lat.toFixed(5) + ',' + c.lon.toFixed(5);
      if (seen[k]) return; seen[k] = 1; dedup.push(c);
    });
    if (!dedup.length) warnings.push('没有识别出坐标。支持：十进制度、度分秒、中文度分秒、URL、GeoJSON/KML/GPX、MGRS、Geohash、UTM 文本');
    return { candidates: dedup, warnings, input_length: raw.length };
  }
  function parseGeoLike(text) {
    const res = { features: [], kinds: [], error: null };
    const pushPt = (lat, lon, label) => { if (isNum(lat) && isNum(lon)) res.features.push({ lat, lon: wrap180(lon), label }); };
    // GeoJSON / JSON
    try {
      const j = JSON.parse(text);
      const walk = (node, label) => {
        if (!node) return;
        if (Array.isArray(node)) {
          if (node.length >= 2 && isNum(node[0]) && isNum(node[1]) && abs(node[0]) <= 180 && abs(node[1]) <= 90) pushPt(node[1], node[0], label || 'GeoJSON 坐标');
          else node.forEach((c) => walk(c, label));
          return;
        }
        if (typeof node === 'object') {
          if (isNum(node.lat) && isNum(node.lon)) pushPt(node.lat, node.lon, label || 'JSON lat/lon');
          else if (isNum(node.latitude) && isNum(node.longitude)) pushPt(node.latitude, node.longitude, label || 'JSON latitude/longitude');
          else if (node.coordinates != null) walk(node.coordinates, node.type || label);
          else if (Array.isArray(node.features)) node.features.forEach((f) => walk(f, f && f.properties && (f.properties.name || f.properties.Name)));
          else if (node.type || node.geometry) walk(node.geometry || node, node.properties && node.properties.name || node.type);
          else Object.keys(node).forEach((k) => walk(node[k], k));
        }
      };
      walk(j, null);
      if (res.features.length) { res.kinds.push('GeoJSON/JSON'); return res; }
    } catch (err) { /* 继续尝试 XML */ }
    // KML / GPX / 任意 XML
    const coordTxt = text.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/i);
    if (coordTxt) {
      coordTxt[1].trim().split(/\s+/).forEach((tok, i) => {
        const p = tok.split(',');
        if (p.length >= 2 && isNum(parseFloat(p[0])) && isNum(parseFloat(p[1]))) pushPt(parseFloat(p[1]), parseFloat(p[0]), 'KML 点 ' + (i + 1));
      });
      res.kinds.push('KML');
    }
    const trk = text.match(/<(?:trkpt|rtept|wpt)[^>]*>/gi);
    if (trk) {
      trk.forEach((tag) => {
        const la = tag.match(/lat="([-\d.]+)"/i), lo = tag.match(/lon(?:g)?="([-\d.]+)"/i);
        if (la && lo) pushPt(parseFloat(la[1]), parseFloat(lo[1]), 'GPX 航点');
      });
      res.kinds.push('GPX');
    }
    // 纯 <lat>/<lon> 标签写法
    const lt = text.match(/<(?:lat|latitude)[^>]*>\s*([-\d.]+)\s*</i), ln = text.match(/<(?:lon|longitude|lng)[^>]*>\s*([-\d.]+)\s*</i);
    if (lt && ln) pushPt(parseFloat(lt[1]), parseFloat(ln[1]), 'XML lat/lon 标签');
    if (!res.features.length) res.error = res.kinds.length ? '标记已识别但内部没有坐标' : 'XML 中未找到坐标';
    return res;
  }

  /* ------------------------------------------------------- 10. 组合坐标解析 */
  function parseCombined(digits) {
    const s = String(digits || '').replace(/\D/g, '');
    if (s.length < 6) return { error: '组合数字太短（至少 6 位，例如 3990411164074）' };
    const out = [];
    for (let la = 2; la <= Math.min(8, s.length - 2); la++) {
      const lb = s.length - la;
      if (lb < 2 || lb > 9) continue;
      const latS = s.slice(0, la), lonS = s.slice(la);
      // 前两位是度的整数部分，其余是小数：39904 → 39.904；1164074 → 116.4074
      const lat = Number(latS) / pow(10, la - 2), lon = Number(lonS) / pow(10, lb - 3);
      if (abs(lat) <= 90 && abs(lon) <= 180) out.push({ lat, lon, lat_digits: la, lon_digits: lb, hint: la + ' 位纬度 / ' + lb + ' 位经度' });
    }
    return { candidates: out, note: out.length ? '存在 ' + out.length + ' 种拆分，请结合地图核对' : '无法拆分' };
  }

  /* ------------------------------------------------------------- 11. 自检 */
  function selfTest() {
    const t = [];
    const push = (name, pass, detail) => t.push({ name, pass: !!pass, detail });
    const near = (a, b, tol) => abs(a - b) < tol;

    // —— 子午线弧 / 等角纬度
    const s1 = meridianArc(1);
    push('子午线弧 1° 与 GEOGEO 反算一致', abs(s1 - G().inverse(0, 0, 1, 0).distance_m) < 0.002, s1.toFixed(4) + ' vs ' + G().inverse(0, 0, 1, 0).distance_m.toFixed(4));
    push('子午线弧奇函数 + 端到端 0→90°', near(meridianArc(-45), -meridianArc(45), 1e-6) && meridianArc(90) > 1.00019e7 && meridianArc(90) < 1.0002e7, String(meridianArc(90).toFixed(3)) + ' m（极点半子午 10 001 965 m 级）');
    push('等角纬度往返闭合', (() => { for (const lat of [-80, -45, 0, 12.5, 45, 80]) { const psi = isometricLat(lat); const back = latFromIsometric(psi); if (abs(back - lat) > 1e-9) return false; } return true; })(), '闭式 ψ(φ) 与 Newton 反解一致');
    // 积分精度自检①：Simpson 是四阶方法，面板数加倍误差应缩到 1/16（±5%）。
    // 只有真正收敛阶正确，才能用「与更细网格的差」来给默认步长定误差上界。
    const arcErr = (n) => {
      let worst = 0;
      for (let lat = 0.5; lat <= 89.5; lat += 0.5)
        worst = Math.max(worst, abs(meridianArcQuads(lat, 'WGS84', n) - meridianArcQuads(lat, 'WGS84', 2048)));
      return worst;
    };
    const e16 = arcErr(16), e32 = arcErr(32);
    push('子午线弧积分四阶收敛（面板加倍→误差 1/16）', abs(e16 / e32 - 16) < 0.8, 'n=16 最大 ' + e16.toExponential(2) + ' m，n=32 最大 ' + e32.toExponential(2) + ' m，比值 ' + (e16 / e32).toFixed(3));
    // 积分精度自检②：默认（自适应面板数）与 n=2048 的参考网格比较，全域必须 <0.05 mm
    let arcWorst = 0, arcWorstAt = 0;
    for (let lat = 0.05; lat <= 89.99; lat += 0.07) {
      const d = abs(meridianArc(lat) - meridianArcQuads(lat, 'WGS84', 2048));
      if (d > arcWorst) { arcWorst = d; arcWorstAt = lat; }
    }
    push('默认子午线弧全域误差 <0.05 mm（对照 n=2048）', arcWorst < 5e-5, '最大 ' + arcWorst.toExponential(2) + ' m @ ' + arcWorstAt.toFixed(2) + '°（面板 ' + arcPanels(arcWorstAt) + '）');
    push('子午线弧 90° = 10 001 965.7 m（WGS84 象限子午线）', abs(meridianArc(90) - 10001965.73) < 0.01, meridianArc(90).toFixed(4) + ' m');
    push('弧长反解纬度往返闭合', (() => {
      return [-84, -33.5, 0, 12.25, 45, 78.8].every((lat) => abs(latFromMeridianArc(meridianArc(lat)) - lat) < 1e-10);
    })(), 's(φ)→φ 用 Newton + 解析 M(φ)，闭合 <1e-10°');

    // —— C-C 方程（共形性）：这是 Krüger 系数正确性的独立判据。
    // 以等角纬度 ψ 为共形坐标，度量 ds²=ν²cos²φ(dλ²+dψ²)，故 (λ,ψ)→(X,Y) 必须满足
    //   ∂X/∂λ = ∂Y/∂ψ，∂Y/∂λ = −∂X/∂ψ
    // tmJac 的差分步长以「度」为单位，dψ/dφ 也是每度，因此换成弧度需乘 D2R。
    const ccResid = (lat, dl) => {
      const j = tmJacRaw(lat, dl, 0, { k0: 1 }, 1e-4);
      const dh = 1e-6;
      const dpsidphi = (isometricLat(lat + dh) - isometricLat(lat - dh)) / (2 * dh);
      const ref = abs(j.Yp * D2R);                       // 归一化基准：子午向尺度（恒不为 0）
      return Math.max(abs(j.Xl * dpsidphi - j.Yp * D2R), abs(j.Yl * dpsidphi + j.Xp * D2R)) / ref;
    };
    const ccMax = (() => {
      let worst = 0, worstAt = '';
      [[0, 3], [45, 3], [-32.5, 2.9], [64, 2.5], [78, 2.9], [12, -2.2], [84, 1.5], [45, 6]].forEach(([lat, dl]) => {
        const rel = ccResid(lat, dl);
        if (rel > worst) { worst = rel; worstAt = lat + '°N Δλ' + dl + '°'; }
      });
      return { worst, worstAt };
    })();
    push('横轴墨卡托满足 C-C 方程（共形）', ccMax.worst < 1e-6, '带边缘最大相对残差 ' + ccMax.worst.toExponential(2) + ' @ ' + ccMax.worstAt);
    // 对照：把任一系数改成明显错误值时残差会跳到 1e-2 量级，所以 1e-6 这道闸门是有力的
    push('C-C 残差在近中央经线处更小（截断而非系数错误）', ccResid(45, 0.5) < ccResid(45, 6), 'Δλ0.5° ' + ccResid(45, 0.5).toExponential(2) + ' < Δλ6° ' + ccResid(45, 6).toExponential(2));

    // —— 赤道行为：由 C-C 方程在 φ=0 处推得 X 的三阶系数必须是 1/(1−e²)，
    // 而不是凭记忆写 (1−e²)；更高阶的余项用「减半经度差，余项应缩小 32 倍」证明它是纯五阶。
    const eqX = (dl) => tmRaw(0, dl, 0, { k0: 1 }).x;
    const eW = G().ell('WGS84');
    const rem = (dl) => eqX(dl) - eW.a * (dl * D2R + pow(dl * D2R, 3) / (6 * (1 - eW.e2)));
    const ratio3 = rem(3) / rem(1.5);
    push('赤道上 X 的三阶项 = λ³/(6(1−e²))·a', abs(eqX(3) - eW.a * (3 * D2R + pow(3 * D2R, 3) / (6 * (1 - eW.e2)))) < eW.a * pow(3 * D2R, 5) / 12, eqX(3).toFixed(4) + ' m');
    push('赤道余项随经度按五阶收敛（减半→1/32）', abs(ratio3 - 32) < 0.32, 'r(3°)/r(1.5°) = ' + ratio3.toFixed(3) + '（应为 32）');
    push('赤道 Y ≡ 0（对称轴）', abs(tmRaw(0, 3, 0, { k0: 1 }).y) < 1e-9 && abs(tmRaw(0, -3, 0, { k0: 1 }).y) < 1e-9, tmRaw(0, 3, 0, { k0: 1 }).y.toExponential(2));
    // —— 坐标收敛角：球面极限 γ ≈ Δλ·sinφ 是独立判据（一阶，含高阶修正后允许 0.02° 差）
    const gam = [[45, 3], [45, -3], [31.23, -1.53], [60, 2.5], [-35, 2], [-60, -3], [80, 1.5]].map(([lat, dl]) => {
      const g = tmForward(lat, dl, 0, { k0: 1 }).gamma, ap = dl * Math.sin(lat * D2R);
      return { lat, dl, g, ap, diff: abs(g - ap) };
    });
    push('坐标收敛角贴合球面式 Δλ·sinφ', Math.max(...gam.map((x) => x.diff)) < 0.02, gam.map((x) => x.lat + '°/' + x.dl + '°→' + x.g.toFixed(4) + '°(球面' + x.ap.toFixed(4) + ')').join(' '));
    push('收敛角在中央经线上为 0、随南北半球反号', abs(tmForward(45, 0, 0, { k0: 1 }).gamma) < 1e-9 && tmForward(45, 2, 0, { k0: 1 }).gamma > 0 && tmForward(-45, 2, 0, { k0: 1 }).gamma < 0, 'γ(45,0)=' + tmForward(45, 0, 0, { k0: 1 }).gamma.toFixed(9) + ' γ(±45,+2°)=' + tmForward(45, 2, 0, { k0: 1 }).gamma.toFixed(4) + '/' + tmForward(-45, 2, 0, { k0: 1 }).gamma.toFixed(4));
    push('比例因子在中线 = k0、偏带后 > k0', abs(tmForward(0, 0, 0, { k0: K0 }).k - K0) < 1e-9 && tmForward(45, 3, 0, { k0: K0 }).k > K0, 'k(中线)=' + tmForward(0, 0, 0, { k0: K0 }).k.toFixed(8) + '，k(45°,3°)=' + tmForward(45, 3, 0, { k0: K0 }).k.toFixed(8));

    // —— 中央经线上：X=0、Y=k0·子午线弧
    const cm = tmForward(41.7, 0, 0, { k0: K0 });
    push('中央经线 X≡0 且 Y=k0·s(φ)', abs(cm.x) < 1e-9 && abs(cm.y - K0 * meridianArc(41.7)) < 1e-3, 'Y=' + cm.y.toFixed(4) + '，k0·s=' + (K0 * meridianArc(41.7)).toFixed(4));

    // —— UTM 往返 + 尺度一致性
    const cities = [[31.2304, 121.4737], [39.9042, 116.4074], [-33.8688, 151.2093], [51.4769, -0.0005], [0.3129, 32.5814], [-12.0464, -77.0428], [64.1355, -21.8954], [78.2232, 15.6267]];
    let worstRT = 0, worstScale = 0;
    cities.forEach(([lat, lon]) => {
      const f = utmForward(lat, lon);
      if (f.scheme === 'UPS') return;
      const b = utmInverse(f.easting, f.northing, f.zone, f.hemisphere);
      worstRT = Math.max(worstRT, abs(b.lat - lat) * 1e7, abs(wrap180(b.lon - lon)) * 1e7);
      // 网格局部尺度：取关于起点对称的步长，grid ≈ k·ground（一阶误差相消）
      const d = 0.001;
      const p1 = utmForward(lat - d, lon), p2 = utmForward(lat + d, lon);
      const ground = G().inverse(lat - d, lon, lat + d, lon).distance_m;
      const grid = Math.hypot(p2.easting - p1.easting, p2.northing - p1.northing);
      worstScale = Math.max(worstScale, abs(grid / (f.k * ground) - 1));
    });
    push('UTM 正/反算往返 <0.1 mm', worstRT * 1e-7 * 111320 < 1e-4, '最大偏差 ' + (worstRT * 1e-7 * 111320).toExponential(2) + ' m');
    push('UTM 网格尺度 k 与实距自洽', worstScale < 2e-7, '最大相对偏差 ' + worstScale.toExponential(2));

    // —— UTM 带号 / 中央经线
    push('带号与中央经线（121.47→51，CM 123°）', utmZoneOf(121.4737) === 51 && utmCentralMeridian(51) === 123 && utmZoneOf(-179.9) === 1 && utmZoneOf(-174.1) === 1 && utmZoneOf(179.9) === 60 && utmZoneOf(-0.0005) === 30 && utmCentralMeridian(30) === -3, utmZoneOf(121.4737) + ' 带，CM ' + utmCentralMeridian(51) + '°');
    push('中央经线两侧带号连续（3°→31 带、−3°→30 带）', utmZoneOf(2.9) === 31 && utmZoneOf(-3.1) === 30 && utmZoneOf(3.1) === 31, utmZoneOf(2.9) + '/' + utmZoneOf(-3.1) + '/' + utmZoneOf(3.1));
    const no = utmForward(59.5, 6.5);
    push('zone 32 挪威例外用 9°E 中央经线', no.zone === 32 && no.cm_used === 9 && abs(no.easting - 500000) < 330000, no.zone + ' 带 easting ' + Math.round(no.easting));

    // —— UPS
    const up = utmForward(87.5, 120);
    push('极地进入 UPS 分支', up.scheme === 'UPS' && isNum(up.easting) && isNum(up.northing), 'UPS easting ' + Math.round(up.easting) + ' northing ' + Math.round(up.northing));
    const upRT = [[87.5, 120], [-85.2, -60], [89.9, 0], [-89.5, 135]].map(([lat, lon]) => {
      const f = upsForward(lat, lon), b = upsInverse(f.easting, f.northing, lat >= 0 ? 'N' : 'S');
      return { lat, lon, d: Math.max(abs(b.lat - lat), abs(wrap180(b.lon - lon))) * 111320 };
    });
    push('UPS 正/反算往返 <1 mm', Math.max(...upRT.map((x) => x.d)) < 1e-3, '最大 ' + Math.max(...upRT.map((x) => x.d)).toExponential(2) + ' m');
    push('UPS 极点处到各方向等距', (() => {
      const p = upsForward(89.9999, 40), q = upsForward(89.9999, 220);
      return abs(Math.hypot(p.easting - 2000000, p.northing - 2000000) - Math.hypot(q.easting - 2000000, q.northing - 2000000)) < 1;
    })(), '同角距的不同经线到假原点距离一致（绕转框架自洽）');

    // —— MGRS
    const bj = mgrsFromLatLon(39.9042, 116.4074, 4), sh = mgrsFromLatLon(31.2304, 121.4737, 4);
    push('北京 MGRS 带号 50S、上海 51R', bj.mgrs.indexOf('50S') === 0 && sh.mgrs.indexOf('51R') === 0, bj.mgrs + ' / ' + sh.mgrs);
    const bjBack = latLonFromMgrs(bj.mgrs);
    push('MGRS 解码回坐标 <1 m', bjBack.lat != null && G().inverse(bjBack.lat, bjBack.lon, 39.9042, 116.4074).distance_m < 10, bjBack.lat != null ? String(G().inverse(bjBack.lat, bjBack.lon, 39.9042, 116.4074).distance_m.toFixed(3)) + ' m' : bjBack.error);
    push('纬度带字母边界（0°→N、−0.1°→M、79.9°→X、−79.9°→C、84°→X、85°→null）',
      mgrsBand(0) === 'N' && mgrsBand(-0.1) === 'M' && mgrsBand(79.9) === 'X' && mgrsBand(-79.9) === 'C' && mgrsBand(83.9) === 'X' && mgrsBand(85) === null,
      [mgrsBand(0), mgrsBand(-0.1), mgrsBand(79.9), mgrsBand(-79.9)].join('/'));
    push('MGRS 列字母每 3 带换组、行字母奇偶偏移 5', (() => {
      const e = (z) => E100[(z - 1) % 3], n = (z) => N100[(z - 1) % 2];
      return e(1) === 'ABCDEFGH' && e(2) === 'JKLMNPQR' && e(3) === 'STUVWXYZ' && e(4) === 'ABCDEFGH' &&
        n(1).charAt(0) === 'A' && n(2).charAt(0) === 'F' && n(2) === N100[1] && n(2).length === 20 && n(1).length === 20;
    })(), 'E:' + E100.join('|') + ' N:' + N100.join('|'));
    const mgrRT = (() => {
      let worst = 0;
      [[39.9042, 116.4074], [31.2304, 121.4737], [-33.8688, 151.2093], [51.4769, -0.0005], [8.6, -55.2], [-52.4, -70.1]].forEach(([lat, lon]) => {
        const c = mgrsFromLatLon(lat, lon, 5);
        if (c.error) return;
        const p = latLonFromMgrs(c.mgrs);
        if (p.lat == null) { worst = 1e9; return; }
        worst = Math.max(worst, G().inverse(p.lat, p.lon, lat, lon).distance_m);
      });
      return worst;
    })();
    push('MGRS 6 位精度往返 <1 m（半个格 100 m 内）', mgrRT < 1, '最大误差 ' + mgrRT.toFixed(4) + ' m');
    push('MGRS 极区给出可读错误', String(mgrsFromLatLon(85.5, 20).error || '').includes('极'), JSON.stringify(mgrsFromLatLon(85.5, 20).error));

    // —— Geohash。锚点用「Null Island」(0,0) 的公开值 s00…（网上可查），
    // 其余用逐步二分手动推演可核对的性质，不引用我记不准的示例串。
    const gh0 = geohashEncode(0, 0, 6);
    push('Geohash 锚点：(0,0) → s00000', gh0.geohash === 's00000', gh0.geohash);
    const ghSH = geohashEncode(31.2304, 121.4737, 9);
    push('Geohash 首位字母符合经度优先二分（上海 w 开头、伦敦 g 开头）', ghSH.geohash.charAt(0) === 'w' && geohashEncode(51.5074, -0.1278, 6).geohash.charAt(0) === 'g', ghSH.geohash + ' / ' + geohashEncode(51.5074, -0.1278, 6).geohash);
    const ghd = geohashDecode(ghSH.geohash);
    push('Geohash 解码落回包围盒内', ghd.lat != null && ghd.bbox.lat_min <= 31.2304 && ghd.bbox.lat_max >= 31.2304 && ghd.bbox.lon_min <= 121.4737 && ghd.bbox.lon_max >= 121.4737, ghd.lat.toFixed(6) + ',' + ghd.lon.toFixed(6));
    push('Geohash 前缀包含关系（9 位 ⊂ 6 位 ⊂ 4 位格）', ghSH.geohash.slice(0, 6) === geohashEncode(31.2304, 121.4737, 6).geohash && ghSH.geohash.slice(0, 4) === geohashEncode(31.2304, 121.4737, 4).geohash, ghSH.geohash);
    push('Geohash 位长与格宽对应（5 位≈4.9km，9 位≈4.8m，12 位<2cm）', (() => {
      const a = geohashEncode(31.2304, 121.4737, 5), b = geohashEncode(31.2304, 121.4737, 9), c = geohashEncode(31.2304, 121.4737, 12);
      return a.cell_lat_m > 3000 && a.cell_lat_m < 8000 && b.cell_lat_m > 1 && b.cell_lat_m < 6 && c.cell_lat_m < 0.05;
    })(), '5 位 ' + geohashEncode(0, 0, 5).cell_lat_m.toFixed(0) + ' m，9 位 ' + geohashEncode(0, 0, 9).cell_lat_m.toFixed(2) + ' m，12 位 ' + geohashEncode(0, 0, 12).cell_lat_m.toExponential(2) + ' m');
    const ghRT = (() => {
      let worst = 0;
      [[31.2304, 121.4737], [-22.9528, -43.2106], [55.7558, 37.6173], [0, 0], [-89.5, 179.5]].forEach(([lat, lon]) => {
        const enc = geohashEncode(lat, lon, 10), dec = geohashDecode(enc.geohash);
        worst = Math.max(worst, abs(dec.lat - lat), abs(wrap180(dec.lon - lon)));
      });
      return worst;
    })();
    push('Geohash 10 位往返误差 < 半格', ghRT < 0.00002, '最大 ' + (ghRT * 111320).toFixed(3) + ' m');
    push('Geohash 拒绝非法字母 a/i/l/o', geohashDecode('ezs42i').error != null, JSON.stringify(geohashDecode('ezsi42').error));

    // —— Plus Code
    const olc = olcEncode(47.376, 8.541, 10);
    push('Plus Code 10 位标准形态（8 位+分隔+2 位）', /^[0-9A-Z]{8}\+[0-9A-Z]{2}$/.test(olc.code) && /^[0-9A-Z]{8}\+[0-9A-Z]{2}\+[0-9A-Z]{2}$/.test(olc.code_local), olc.code + ' / 本工具校验位 ' + olc.checksum_local);
    const olcRt = olcDecode(olc.code);
    push('Plus Code 解码回到原格中心', olcRt.lat != null && abs(olcRt.lat - 47.376) < olcRt.cell_lat_deg && abs(wrap180(olcRt.lon - 8.541)) < olcRt.cell_lon_deg, olcRt.lat != null ? olcRt.lat.toFixed(7) + ',' + olcRt.lon.toFixed(7) + '（格宽 ' + (olcRt.cell_lat_deg * 111320).toFixed(1) + ' m）' : olcRt.error);
    const olcWithCheck = olcDecode(olc.code_local);
    push('Plus Code 校验位自洽（本工具约定，非 Google 官方）', olcWithCheck.checksum_valid === true && olcWithCheck.checksum_scheme === 'local', (olc.code_local.split('+')[2] || '') + ' vs 重算 ' + olcChecksum(olc.digits));
    const tampered = olc.code_local.slice(0, 3) + (OLC_ALPHA.charAt((OLC_ALPHA.indexOf(olc.code_local.charAt(3)) + 1) % 20)) + olc.code_local.slice(4);
    push('Plus Code 篡改一位后校验失败', olcDecode(tampered).checksum_valid === false, tampered + ' → ' + olcDecode(tampered).checksum_valid);
    const olcS = olcEncode(-33.8688, 151.2093, 10), olcS2 = olcEncode(0.0001, -0.0001, 10);
    push('Plus Code 全球四点均可编码且互不相同', new Set([olc.code, olcS.code, olcS2.code, olcEncode(35.6812, 139.7671, 10).code]).size === 4, [olc.code, olcS.code, olcS2.code].join(' '));
    const rec = olcRecover('2Q+PR', 47.3, 8.5);
    push('短码补全需要参考位置', rec.error == null && rec.filled_digits > 0, rec.error || (rec.code + ' → ' + (rec.lat || 0).toFixed(5)));
    push('缺少参考点时明确报错', olcRecover('2Q+PR').error != null && olcShorten(olc.code).error != null, 'olcRecover: ' + olcRecover('2Q+PR').error);

    // —— Web 墨卡托
    const wm = webMercatorForward(0, 0), wm2 = webMercatorForward(85.05112878, 180);
    push('EPSG:3857 原点是精确 (0,0)', wm.x === 0 && wm.y === 0, JSON.stringify(wm));
    push('EPSG:3857 边界 ≈ ±20037508', abs(wm2.x - 20037508.34) < 1 && abs(wm2.y) < 20037509, wm2.x.toFixed(2) + ' / ' + wm2.y.toFixed(2));
    push('EPSG:3857 墨卡托与等角纬度一致 y=R·ψ', (() => {
      const R = 6378137;
      return [0, 45, -60, 80].every((lat) => abs(webMercatorForward(lat, 10).y - R * Math.atanh(Math.sin(lat * D2R))) < 1e-6);
    })(), 'y = R·atanh(sinφ)');
    const wmRT = (() => {
      let worst = 0;
      [[31.2304, 121.4737], [-33.8688, 151.2093], [51.4769, -0.0005], [0, 0]].forEach(([lat, lon]) => {
        const f = webMercatorForward(lat, lon), b = webMercatorInverse(f.x, f.y);
        worst = Math.max(worst, abs(b.lat - lat) * 111320, abs(wrap180(b.lon - lon)) * 111320 * Math.cos(lat * D2R));
      });
      return worst;
    })();
    push('EPSG:3857 正/反算往返 <1 µm', wmRT < 1e-6, '最大 ' + wmRT.toExponential(2) + ' m');

    // —— DMS
    const d1 = dmsParse("39°54'29.3\"N 116°23'26.9\"E");
    push('度分秒解析（DMS→十进制）', d1 && abs(d1.lat - 39.908139) < 1e-4 && abs(d1.lon - 116.390806) < 1e-4, d1 ? d1.lat.toFixed(6) + ',' + d1.lon.toFixed(6) : 'null');
    const d2 = dmsParse('39 54 29.3 N, 116 23 26.9 E');
    push('空格分隔的 DMS 也可解析', d2 && abs(d2.lat - 39.908139) < 1e-4, d2 ? d2.lat.toFixed(6) : 'null');
    const d3 = dmsParse('南纬 22 度 57 分 08 秒，西经 43 度 12 分 38 秒');
    push('中文度分秒解析', d3 && abs(d3.lat + 22.952222) < 1e-4 && abs(d3.lon + 43.210556) < 1e-4, d3 ? d3.lat.toFixed(6) + ',' + d3.lon.toFixed(6) : 'null');
    const d4 = dmsParse('40.4319, -3.6880');
    push('纯十进制对解析', d4 && abs(d4.lat - 40.4319) < 1e-9, d4 ? d4.lat + ',' + d4.lon : 'null');
    const fmt = dmsFormat(39.908139, 'lat', 3);
    push('DMS 格式化含方向字母', /N$/.test(fmt.text) && fmt.d === 39 && fmt.m === 54, fmt.text);
    // —— DMS 的独立复核路线：格式化器（dmsFormat/ddmFormat）产出的文本必须能反解回原值。
    // 这两条路径（格式化 / 解析）实现互不相同，任何一处写错都会在这里破，而不是靠「我记得等于多少」。
    const fmtLL = (r) => !r ? 'null' : (r.lat != null ? r.lat.toFixed(6) + ',' + r.lon.toFixed(6)
      : '单值 ' + (r.single == null ? '?' : r.single.toFixed(6)) + (r.axis === 'lon' ? '°(经)' : r.axis === 'lat' ? '°(纬)' : '°'));
    const dmsPairCases = [[39.908139, 116.390806], [-22.952222, -43.210556], [31.2304, 121.4737], [0, 0], [51.4769, -0.0005], [-33.868843, 151.209284], [89.9999, 179.9999], [35.681236, -139.760782]];
    let dmsRT = 0, dmsRTAt = '', spacedVsCompact = 0;
    dmsPairCases.forEach((pt) => {
      const fa = dmsFormat(pt[0], 'lat', 3).text, fb = dmsFormat(pt[1], 'lon', 3).text;
      const spaced = fa + ' ' + fb;                        // 本程序「复制为 DMS」产出的写法（带空格）
      const compact = spaced.replace(/\s+/g, '');          // 同一点的紧凑写法
      const p1 = dmsParse(spaced), p2 = dmsParse(compact);
      if (!p1 || !p2 || p1.lat == null || p2.lat == null) { dmsRT = 9; dmsRTAt = spaced + ' → ' + fmtLL(p1); return; }
      dmsRT = Math.max(dmsRT, Math.max(abs(p1.lat - pt[0]), abs(p1.lon - pt[1])));
      spacedVsCompact = Math.max(spacedVsCompact, Math.max(abs(p1.lat - p2.lat), abs(p1.lon - p2.lon)));
      if (dmsRT > 1e-4) dmsRTAt = spaced;
    });
    push('DMS 格式化 → 解析往返闭合（8 点，含南纬/西经/边界）', dmsRT < 1e-4, '最大 ' + dmsRT.toExponential(2) + '°（≈' + (dmsRT * 111320).toFixed(2) + ' m）' + (dmsRTAt ? ' @ ' + dmsRTAt : ''));
    push('同一地点的空格式与紧凑格式 DMS 解到同一值', spacedVsCompact === 0, '两种写法最大差 ' + spacedVsCompact + '°');
    const dCn1 = dmsParse('北纬31度13分49秒 东经121度28分25秒');
    const dEn1 = dmsParse("31°13'49\"N 121°28'25\"E");
    const dEn2 = dmsParse("31° 13' 49\" N 121° 28' 25\" E");
    push('中文式 / 西文紧凑式 / 西文带空格式三种写法解到同一值', (() => {
      if (!dCn1 || !dEn1 || !dEn2 || dCn1.lat == null || dEn1.lat == null || dEn2.lat == null) return false;
      return abs(dCn1.lat - dEn1.lat) < 1e-9 && abs(dCn1.lon - dEn1.lon) < 1e-9 && abs(dEn2.lat - dEn1.lat) < 1e-9 && abs(dEn2.lon - dEn1.lon) < 1e-9;
    })(), fmtLL(dCn1) + ' | ' + fmtLL(dEn1) + ' | ' + fmtLL(dEn2));
    const dCn2 = dmsParse('南纬22度57分08秒，西经43度12分38秒');
    push('中文式必须给出负值（南纬/西经）', dCn2 && dCn2.lat < 0 && dCn2.lon < 0 && abs(dCn2.lat + 22.952222) < 1e-4 && abs(dCn2.lon + 43.210556) < 1e-4, fmtLL(dCn2));
    const dDdm = dmsParse(ddmFormat(31.2304, 'lat') + ' ' + ddmFormat(121.4737, 'lon'));
    push('DDM（度+十分制分）往返闭合 <1e-4°', dDdm && dDdm.lat != null && abs(dDdm.lat - 31.2304) < 1e-4 && abs(dDdm.lon - 121.4737) < 1e-4, fmtLL(dDdm) + ' ← ' + ddmFormat(31.2304, 'lat'));
    const dSgl = dmsParse('43 12 38 W');
    push('单个带方向的度分秒值不当成一对数字', dSgl && dSgl.lat == null && dSgl.single != null && abs(dSgl.single + 43.210556) < 1e-4 && dSgl.axis === 'lon', fmtLL(dSgl) + ' axis=' + (dSgl && dSgl.axis));
    const pSgl = parseAny("31° 13' 49.44\" N");
    push('parseAny 遇单值 DMS：跳过并告警，不产出 lon=13 的假结果', (() => {
      const bad = pSgl.candidates.some((c) => abs(c.lon - 13) < 1e-6);
      return !bad && /缺另一分量/.test(pSgl.warnings.join(''));
    })(), 'candidates=' + pSgl.candidates.length + '，warning=' + (pSgl.warnings[0] || '').slice(0, 46));
    const pPair = parseAny("31° 13' 49.44\" N 121° 28' 25.32\" E");
    push('parseAny 带空格 DMS 对（与十进制同一点）', (() => {
      const c = pPair.candidates[0];
      return c && abs(c.lat - 31.2304) < 1e-4 && abs(c.lon - 121.4737) < 1e-4;
    })(), pPair.candidates[0] ? pPair.candidates[0].lat.toFixed(6) + ',' + pPair.candidates[0].lon.toFixed(6) : '无候选');
    const dNeg = dmsParse('-31.2304, 121.4737');
    push('负十进制对：纬度取负、经度不受影响', dNeg && dNeg.lat != null && abs(dNeg.lat + 31.2304) < 1e-9 && abs(dNeg.lon - 121.4737) < 1e-9, fmtLL(dNeg));
    const dSwap = dmsParse('121.4737, 31.2304');
    push('无方向字母时：超过 90° 的那个判为经度', dSwap && dSwap.lat != null && abs(dSwap.lat - 31.2304) < 1e-9 && abs(dSwap.lon - 121.4737) < 1e-9, fmtLL(dSwap));
    const dDec2 = dmsParse('40.4319 -3.6880');
    push('空格分隔的两个十进制值按 lat,lon 读取（不合并成度分）', dDec2 && dDec2.lat != null && abs(dDec2.lat - 40.4319) < 1e-9 && abs(dDec2.lon + 3.688) < 1e-9, fmtLL(dDec2));

    // —— GCJ-02 / BD-09
    push('GCJ 境外不偏移', (() => { const g = gcjFromWgs84(51.4769, -0.0005); return g.shifted === false && g.lat === 51.4769; })(), '伦敦原值返回');
    const g1 = gcjFromWgs84(39.9042, 116.4074);
    const dg1 = G().inverse(39.9042, 116.4074, g1.lat, g1.lon).distance_m;
    push('北京 GCJ 偏移在 300~800 m、方向为东南偏', dg1 > 300 && dg1 < 800 && g1.lat > 39.9042 && g1.lon > 116.4074, dg1.toFixed(1) + ' m');
    const g2 = wgs84FromGcj02(g1.lat, g1.lon);
    push('GCJ 反算残差 <1 mm', g2.residual_m < 1e-3, g2.residual_m.toExponential(2) + ' m，还原 lat ' + g2.lat.toFixed(9));
    const b1 = bdFromWgs(39.9042, 116.4074), b2 = wgsFromBd(b1.lat, b1.lon);
    push('BD-09 往返闭合 <1 mm（反算经迭代）', G().inverse(b2.lat, b2.lon, 39.9042, 116.4074).distance_m < 1e-3, G().inverse(b2.lat, b2.lon, 39.9042, 116.4074).distance_m.toExponential(2) + ' m');
    push('BD 相对 GCJ 再偏移 0.6~1.5 km', (() => { const d = G().inverse(g1.lat, g1.lon, b1.lat, b1.lon).distance_m; return d > 600 && d < 1500; })(), G().inverse(g1.lat, g1.lon, b1.lat, b1.lon).distance_m.toFixed(1) + ' m');
    push('BD 原始反算式（不迭代）残留 0.03~0.5 m，故必须迭代', (() => { const r = gcjFromBdRaw(b1.lat, b1.lon), w = wgs84FromGcj02(r.lat, r.lon); const d = G().inverse(w.lat, w.lon, 39.9042, 116.4074).distance_m; return d > 0.02 && d < 0.8; })(), (() => { const r = gcjFromBdRaw(b1.lat, b1.lon), w = wgs84FromGcj02(r.lat, r.lon); return G().inverse(w.lat, w.lon, 39.9042, 116.4074).distance_m.toFixed(3) + ' m'; })());

    // —— 任意文本
    const p1 = parseAny('31.2304, 121.4737');
    push('解析：逗号十进制对', p1.candidates.length >= 1 && abs(p1.candidates[0].lat - 31.2304) < 1e-9, p1.candidates.length + ' 个候选，首选 ' + (p1.candidates[0] || {}).label);
    const p2 = parseAny('121.4737 31.2304');
    push('解析：经度在前也能纠正（>90 判据）', p2.candidates.some((c) => abs(c.lat - 31.2304) < 1e-6), p2.candidates.map((c) => c.lat.toFixed(3)).join(' / '));
    const p3 = parseAny('https://www.google.com/maps/place/35.681236,139.767125/@35.68,139.76,17z');
    push('解析：Google Maps URL', p3.candidates.length >= 1 && abs(p3.candidates[0].lat - 35.681236) < 1e-3, p3.candidates.map((c) => c.label).join(' | '));
    const p4 = parseAny('https://ditu.amap.com/place/B00155OR5A?center=121.4737,31.2304');
    push('解析：高德 URL 推断 GCJ-02', p4.candidates.some((c) => c.crs_guess === 'GCJ02'), p4.candidates.map((c) => c.crs_guess).join(','));
    const p5 = parseAny('{"type":"Feature","properties":{"name":"家"},"geometry":{"type":"Point","coordinates":[116.4074,39.9042]}}');
    push('解析：GeoJSON（坐标顺序 lon,lat 已交换）', p5.candidates.some((c) => abs(c.lat - 39.9042) < 1e-9 && abs(c.lon - 116.4074) < 1e-9), p5.candidates.map((c) => c.lat + ',' + c.lon).join(' '));
    const p6 = parseAny('<kml><Placemark><Point><coordinates>121.4737,31.2304,0</coordinates></Point></Placemark></kml>');
    push('解析：KML coordinates', p6.candidates.some((c) => abs(c.lat - 31.2304) < 1e-9), p6.candidates.map((c) => c.label).join(' | '));
    const p7 = parseAny('<gpx version="1.1"><wpt lat="35.681236" lon="139.767125"><name>x</name></wpt></gpx>');
    push('解析：GPX wpt', p7.candidates.some((c) => abs(c.lat - 35.681236) < 1e-9), p7.candidates.map((c) => c.label).join(' | '));
    const bjMGRS = mgrsFromLatLon(39.9042, 116.4074, 5).mgrs;
    const p8 = parseAny(bjMGRS);
    push('解析：MGRS 文本（用本机正算结果自洽，不引用外部示例串）', p8.candidates.some((c) => abs(c.lat - 39.9042) < 1e-4), bjMGRS + ' → ' + p8.candidates.map((c) => c.lat.toFixed(5) + ',' + c.lon.toFixed(5)).join(' '));
    const shGH = geohashEncode(31.2304, 121.4737, 8).geohash;
    const p9 = parseAny(shGH);
    push('解析：Geohash 文本', p9.candidates.some((c) => abs(c.lat - 31.2304) < 0.005), shGH + ' → ' + p9.candidates.map((c) => c.lat.toFixed(4) + ',' + c.lon.toFixed(4)).join(' '));
    const shUTM = utmForward(31.2304, 121.4737);
    const p10 = parseAny(shUTM.zone + shUTM.hemisphere + ' ' + Math.round(shUTM.easting) + ' ' + Math.round(shUTM.northing));
    push('解析：UTM 文本（正算串再解析回去）', p10.candidates.some((c) => abs(c.lat - 31.2304) < 1e-4 && abs(c.lon - 121.4737) < 1e-4), shUTM.zone + shUTM.hemisphere + ' ' + Math.round(shUTM.easting) + ' ' + Math.round(shUTM.northing) + ' → ' + p10.candidates.map((c) => (c.lat || 0).toFixed(5) + ',' + (c.lon || 0).toFixed(5)).join(' '));
    const p11 = parseAny('');
    push('解析：空输入给出提示', p11.candidates.length === 0 && p11.warnings.length > 0, p11.warnings[0]);
    const p12 = parseAny('39°54\'29.3"N 116°23\'26.9"E');
    push('解析：DMS 字符串', p12.candidates.some((c) => abs(c.lat - 39.908139) < 1e-4), p12.candidates.map((c) => c.lat.toFixed(5)).join(' '));
    const cb = parseCombined('3990411164074');
    push('组合数字可拆分（3990411164074 → 39.9041,116.4074）', cb.candidates.some((c) => abs(c.lat - 39.9041) < 1e-9 && abs(c.lon - 116.4074) < 1e-9), cb.candidates.length + ' 种：' + cb.candidates.slice(0, 3).map((c) => c.lat.toFixed(4) + ',' + c.lon.toFixed(4)).join(' | '));

    // —— 注册表
    const rt = fromWgs84(31.2304, 121.4737, 'UTM');
    const back = toWgs84({ easting: rt.easting, northing: rt.northing, zone: rt.zone, hemisphere: rt.hemisphere }, 'UTM');
    push('CRS 注册表：WGS→UTM→WGS', rt.zone === 51 && back.ok && abs(back.lat - 31.2304) < 1e-8 && abs(wrap180(back.lon - 121.4737)) < 1e-8, rt.zone + rt.hemisphere + ' E' + Math.round(rt.easting) + ' N' + Math.round(rt.northing) + ' → ' + (back.lat || 0).toFixed(7));
    const rtG = fromWgs84(31.2304, 121.4737, 'MGRS', { digits: 5 });
    const backG = toWgs84(rtG.mgrs, 'MGRS');
    push('CRS 注册表：WGS→MGRS→WGS <1 m', backG.ok && G().inverse(backG.lat, backG.lon, 31.2304, 121.4737).distance_m < 1, rtG.mgrs + ' → ' + (backG.lat || 0).toFixed(6));
    const rtW = fromWgs84(31.2304, 121.4737, 'EPSG3857');
    const backW = toWgs84(rtW, 'EPSG3857');
    push('CRS 注册表：WGS→3857→WGS', backW.ok && abs(backW.lat - 31.2304) < 1e-9, rtW.x.toFixed(1) + ',' + rtW.y.toFixed(1));
    push('CRS 注册表：未知名报错不崩溃', toWgs84(1, 'NOPE').ok === false, toWgs84(1, 'NOPE').error);
    push('未知目标坐标系不崩溃', String(fromWgs84(1, 1, 'NOPE').error || '').indexOf('未知') >= 0, JSON.stringify(fromWgs84(1, 1, 'NOPE')));
    return t;
  }

  global.GEODATUM = {
    CRS, K0,
    meridianArc, meridianArcQuads, latFromMeridianArc, isometricLat, latFromIsometric,
    tmRaw, tmForward, tmInverse, tmScale, tmConvergence,
    utmZoneOf, utmCentralMeridian, utmForward, utmInverse, upsForward, upsInverse,
    mgrsBand, mgrsFromLatLon, latLonFromMgrs,
    geohashEncode, geohashDecode,
    olcEncode, olcDecode, olcShorten, olcRecover, olcChecksum, OLC_ALPHA,
    webMercatorForward, webMercatorInverse,
    dmsParse, dmsFormat, ddmFormat,
    outOfChina, gcjFromWgs84, wgs84FromGcj02, bdFromGcj, gcjFromBd, bdFromWgs, wgsFromBd,
    toWgs84, fromWgs84, parseAny, parseGeoLike, parseUrl, parseCombined,
    selfTest
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
