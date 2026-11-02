/* 测地线引擎：椭球参数、严格大地线（Clairaut 方程 RK4 数值积分）、面积、几何辅助、精度评估。全部离线计算。 */
(function () {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
  const wrapLon = (l) => ((l + 540) % 360) - 180;
  const wrap360 = (d) => ((d % 360) + 360) % 360;
  const SQ = (x) => Math.sqrt(Math.max(0, x));

  const ELLIPSOIDS = {
    WGS84: { id: 'WGS84', name: 'WGS 84（GPS 原生坐标系）', a: 6378137.0, rf: 298.257223563, epoch: '—' },
    GRS80: { id: 'GRS80', name: 'GRS 80（UTM / NAD83 采用）', a: 6378137.0, rf: 298.257222101, epoch: '—' },
    CGCS2000: { id: 'CGCS2000', name: 'CGCS2000（中国 2000 国家大地坐标系）', a: 6378137.0, rf: 298.257222101, epoch: '2000.0' },
    Sphere: { id: 'Sphere', name: '正球体（平均半径 6371008.7714 m）', a: 6371008.7714, rf: 0, epoch: '—' },
    Clarke1866: { id: 'Clarke1866', name: 'Clarke 1866（北美旧基准）', a: 6378206.4, rf: 294.9786982, epoch: '—' },
    International1924: { id: 'International1924', name: 'International 1924 / Hayford', a: 6378388.0, rf: 297.0, epoch: '—' },
    Bessel1841: { id: 'Bessel1841', name: 'Bessel 1841（旧地形图、日本三角网）', a: 6377397.155, rf: 299.1528128, epoch: '—' },
    Airy1830: { id: 'Airy1830', name: 'Airy 1830（英国 OSGB）', a: 6377563.396, rf: 299.3249646, epoch: '—' },
    Krassovsky1940: { id: 'Krassovsky1940', name: 'Krassovsky 1940（北京 54 坐标系采用）', a: 6378245.0, rf: 298.3, epoch: '—' },
    Everest1830: { id: 'Everest1830', name: 'Everest 1830（印度 / 东南亚旧图）', a: 6377298.55636172, rf: 300.8017, epoch: '—' },
    WGS60: { id: 'WGS60', name: 'WGS 60', a: 6378165.0, rf: 298.3, epoch: '1960' },
    WGS66: { id: 'WGS66', name: 'WGS 66', a: 6378145.0, rf: 298.25, epoch: '1966' },
    WGS72: { id: 'WGS72', name: 'WGS 72', a: 6378135.0, rf: 298.26, epoch: '1972' },
  };
  const cache = {};
  function ell(key) {
    const id = typeof key === 'string' ? key : 'WGS84';
    if (cache[id]) return cache[id];
    const src = ELLIPSOIDS[id] || ELLIPSOIDS.WGS84;
    const f = src.rf ? 1 / src.rf : 0;
    const b = src.a * (1 - f);
    const e2 = f * (2 - f);
    const e = Object.assign({}, src, {
      f, b, e2, b_axis: b, ep2: e2 / (1 - e2), first_e: Math.sqrt(e2), second_e: SQ(e2 / (1 - e2)),
      flattening_pct: f * 100, mean_radius: (2 * src.a + b) / 3,
      authalic_radius: authalicFrom(src.a, e2), surface_area_m2: 4 * Math.PI * Math.pow(authalicFrom(src.a, e2), 2),
    });
    cache[id] = e;
    return e;
  }
  // 等面积球半径：由闭式带面积积分 F(90°) 得到
  function authalicFrom(a, e2) {
    if (!e2) return a;
    return Math.sqrt(zoneIntegralRad(a, e2, Math.PI / 2));
  }
  // ∫₀^φ M·r dφ（单位 m²/球面弧度），u = sinφ 的闭式原函数
  function zoneIntegralRad(a, e2, phi) {
    const s = Math.sin(phi);
    if (Math.abs(s) < 1e-16) return 0;
    const e = Math.sqrt(e2);
    const u = clamp(s, -1, 1);
    return a * a * (1 - e2) * (u / (2 * (1 - e2 * u * u)) + (1 / (4 * e)) * Math.log((1 + e * u) / (1 - e * u)));
  }
  function radii(lat, key) {
    const e = ell(key), s = Math.sin(lat * D2R);
    const w = SQ(1 - e.e2 * s * s);
    const M = (e.a * (1 - e.e2)) / (w * w * w);
    const N = e.a / w;
    return { M, N, r: Math.sqrt(M * N), parallel_arc_m: N * Math.cos(lat * D2R) * D2R, meridian_arc_m: M * D2R, parallel_radius: N * Math.cos(lat * D2R) };
  }
  function metersPerDegree(lat, key) {
    const r = radii(lat == null ? 0 : lat, key || 'WGS84');
    return { lat_m: r.meridian_arc_m, lon_m: r.parallel_arc_m, ratio: r.meridian_arc_m / r.parallel_arc_m };
  }
  // 等面积纬度（authalic latitude）：使 (λ,β) 上的球面面积公式在椭球上精确成立
  function authalicLatitude(lat, key) {
    const e = ell(key);
    const sinB = clamp(zoneIntegralRad(e.a, e.e2, lat * D2R) / Math.pow(e.authalic_radius, 2), -1, 1);
    return Math.asin(sinB) * R2D;
  }
  function latitudeFromAuthalic(beta, key) {
    const e = ell(key);
    let lat = beta;
    for (let i = 0; i < 12; i++) {
      const diff = authalicLatitude(lat, key) - beta;
      if (Math.abs(diff) < 1e-12) break;
      lat -= diff / 1.0;
    }
    return lat;
  }

  function validate(lat, lon, opts) {
    const o = opts || {};
    lat = num(lat); lon = num(lon);
    const issues = [];
    if (!isFinite(lat) || !isFinite(lon)) return { valid: false, issues: ['坐标不是有限数值'], lat, lon, normalized: null };
    if (lat < -90 || lat > 90) issues.push('纬度超出 ±90°，地球表面不存在该点');
    const nl = wrapLon(lon);
    if (Math.abs(nl - lon) > 1e-12) issues.push('经度已归一化到 ±180°（原值 ' + lon + '）');
    if (Math.abs(lon) > 180 && Math.abs(lon) <= 540) issues.push('经度按整周取模处理');
    const fatal = !o.allow_out_of_range && (lat < -90 || lat > 90);
    return { valid: !fatal, issues, lat, lon, normalized: { lat, lon: nl }, hemisphere_lat: lat >= 0 ? '北纬 N' : '南纬 S', hemisphere_lon: nl >= 0 ? '东经 E' : '西经 W' };
  }
  function precisionLabel(m) {
    if (m >= 100000) return '国 / 大区域尺度';
    if (m >= 10000) return '城市尺度';
    if (m >= 1000) return '乡镇尺度';
    if (m >= 100) return '街区尺度';
    if (m >= 10) return '建筑尺度';
    if (m >= 1) return '门口尺度';
    if (m >= 0.1) return '亚米级（多数手持 GNSS 上限）';
    if (m >= 0.01) return '厘米级（RTK / 网络 RTK）';
    if (m >= 0.001) return '毫米级（基准站解算）';
    return '次毫米（超出 GNSS 物理能力，属伪造精度）';
  }
  function decimalsOf(v) { const s = String(v).trim(), i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }
  function precisionTable(key) {
    const mpd = metersPerDegree(0, key);
    const rows = [];
    for (let d = 0; d <= 10; d++) rows.push({ decimals: d, deg_step: Math.pow(10, -d), meters_lat: mpd.lat_m * Math.pow(10, -d), meters_lon_equator: mpd.lon_m * Math.pow(10, -d), note: precisionLabel(mpd.lat_m * Math.pow(10, -d)) });
    return rows;
  }
  function precisionOf(lat, lon, key) {
    const d = Math.min(decimalsOf(lat), decimalsOf(lon));
    const mpd = metersPerDegree(lat, key || 'WGS84');
    const step = Math.pow(10, -d);
    return { decimals: d, deg_step: step, meters_lat: mpd.lat_m * step, meters_lon: mpd.lon_m * step, worst_m: Math.max(mpd.lat_m, mpd.lon_m) * step, note: precisionLabel(mpd.lat_m * step) };
  }

  function haversine(lat1, lon1, lat2, lon2, R) {
    R = R || 6371008.7714;
    const f1 = lat1 * D2R, f2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    return 2 * R * Math.asin(clamp(SQ(Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2), 0, 1));
  }
  function centralAngle(lat1, lon1, lat2, lon2) {
    const f1 = lat1 * D2R, f2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    return 2 * Math.asin(clamp(SQ(Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2), 0, 1));
  }
  function initialBearing(lat1, lon1, lat2, lon2) {
    const f1 = lat1 * D2R, f2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    return wrap360(Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * R2D);
  }
  function finalBearing(lat1, lon1, lat2, lon2) { return wrap360(initialBearing(lat2, lon2, lat1, lon1) + 180); }

  // ==== 严格大地线：Clairaut + RK4 数值积分 ====
  function odes(phi, A, e) {
    const s = Math.sin(phi);
    const M = (e.a * (1 - e.e2)) / Math.pow(1 - e.e2 * s * s, 1.5);
    const N = e.a / SQ(1 - e.e2 * s * s);
    const r = N * Math.cos(phi);
    const dlnr = -Math.tan(phi) + (e.e2 * s * Math.cos(phi)) / (1 - e.e2 * s * s);
    return { dphi: Math.cos(A) / M, dlam: Math.sin(A) / r, dA: (-Math.sin(A) * dlnr) / M };
  }
  function integrate(lat1rad, lon1rad, A1rad, s_total, e, steps) {
    const n = Math.max(48, steps);
    const h = s_total / n;
    let phi = lat1rad, lam = lon1rad, A = A1rad;
    for (let i = 0; i < n; i++) {
      const k1 = odes(phi, A, e);
      const k2 = odes(phi + 0.5 * h * k1.dphi, A + 0.5 * h * k1.dA, e);
      const k3 = odes(phi + 0.5 * h * k2.dphi, A + 0.5 * h * k2.dA, e);
      const k4 = odes(phi + h * k3.dphi, A + h * k3.dA, e);
      phi += (h / 6) * (k1.dphi + 2 * k2.dphi + 2 * k3.dphi + k4.dphi);
      lam += (h / 6) * (k1.dlam + 2 * k2.dlam + 2 * k3.dlam + k4.dlam);
      A += (h / 6) * (k1.dA + 2 * k2.dA + 2 * k3.dA + k4.dA);
    }
    if (phi > Math.PI / 2) { phi = Math.PI - phi; lam += Math.PI; }
    else if (phi < -Math.PI / 2) { phi = -Math.PI - phi; lam += Math.PI; }
    return { lat_rad: phi, lon_rad: lam, az_rad: A };
  }
  function planSteps(dist) { return Math.round(clamp(dist / 4000, 80, 1600)); }

  function direct(lat1, lon1, bearing_deg, distance_m, key) {
    const e = ell(key || 'WGS84');
    if (e.f === 0) {
      const sig = distance_m / e.a, f1 = lat1 * D2R, br = bearing_deg * D2R;
      const f2 = Math.asin(clamp(Math.sin(f1) * Math.cos(sig) + Math.cos(f1) * Math.sin(sig) * Math.cos(br), -1, 1));
      const l2 = lon1 * D2R + Math.atan2(Math.sin(br) * Math.sin(sig) * Math.cos(f1), Math.cos(sig) - Math.sin(f1) * Math.sin(f2));
      return { lat: f2 * R2D, lon: wrapLon(l2 * R2D), back_azimuth_deg: wrap360(bearing_deg + 180), forward_azimuth_at_end: wrap360(bearing_deg), method: '球面大圆正算', iterations: 0, converged: true };
    }
    if (distance_m === 0) return { lat: lat1, lon: lon1, back_azimuth_deg: wrap360(bearing_deg + 180), forward_azimuth_at_end: wrap360(bearing_deg), method: '零距离', iterations: 0, converged: true };
    const steps = planSteps(Math.abs(distance_m));
    const p = integrate(lat1 * D2R, lon1 * D2R, bearing_deg * D2R, distance_m, e, steps);
    const azEnd = wrap360(p.az_rad * R2D);
    return {
      lat: p.lat_rad * R2D, lon: wrapLon(p.lon_rad * R2D),
      forward_azimuth_at_end: azEnd, back_azimuth_deg: wrap360(azEnd + 180),
      method: '严格大地线正算（Clairaut ODE + RK4，' + steps + ' 步）', iterations: 1, converged: true, steps,
    };
  }
  function inverse(lat1, lon1, lat2, lon2, key) {
    const e = ell(key || 'WGS84');
    if (Math.abs(lat1 - lat2) < 1e-14 && Math.abs(wrapLon(lon1 - lon2)) < 1e-14) {
      return { distance_m: 0, initial_bearing_deg: null, final_bearing_deg: null, iterations: 0, converged: true, residual_m: 0, method: e.f ? '严格大地线（同点）' : '球面（同点）' };
    }
    if (e.f === 0) {
      const d = centralAngle(lat1, lon1, lat2, lon2) * e.a;
      const az = initialBearing(lat1, lon1, lat2, lon2);
      return { distance_m: d, initial_bearing_deg: az, final_bearing_deg: finalBearing(lat1, lon1, lat2, lon2), iterations: 0, converged: true, residual_m: 0, method: '球面大圆反算' };
    }
    const az0 = initialBearing(lat1, lon1, lat2, lon2);
    const s0 = haversine(lat1, lon1, lat2, lon2, e.mean_radius);
    const steps = planSteps(s0);
    const kLat = radii(lat2, e.id).meridian_arc_m, kLon = radii(lat2, e.id).parallel_arc_m;
    const resid = (az, s) => {
      const p = direct(lat1, lon1, az, s, e.id);
      return [(numLatDiff(p.lat, lat2)) * kLat, wrapLon(p.lon - lon2) * kLon];
    };
    function numLatDiff(a2, b2) { return a2 - b2; }
    let az = az0, s = s0, r0 = resid(az, s), it = 0, best = { az, s, res: Math.hypot(r0[0], r0[1]) };
    while (best.res > 1e-6 && it < 24) {
      it++;
      const daz = 0.01, ds = Math.max(10, s * 1e-7);
      const ra = resid(az + daz, s), rs = resid(az, s + ds);
      const j00 = (ra[0] - r0[0]) / daz, j01 = (rs[0] - r0[0]) / ds;
      const j10 = (ra[1] - r0[1]) / daz, j11 = (rs[1] - r0[1]) / ds;
      const det = j00 * j11 - j01 * j10;
      if (!isFinite(det) || Math.abs(det) < 1e-18) break;
      let naz = az + (-j11 * r0[0] + j01 * r0[1]) / det;
      let ns = s + (j10 * r0[0] - j00 * r0[1]) / det;
      if (!isFinite(ns) || ns <= 0) ns = s * 0.98;
      if (!isFinite(naz)) naz = az;
      az = naz; s = ns;
      r0 = resid(az, s);
      const res = Math.hypot(r0[0], r0[1]);
      if (res < best.res) best = { az, s, res };
      else if (res > 1e7) break;
    }
    const fin = direct(lat1, lon1, best.az, best.s, e.id);
    return {
      distance_m: best.s, initial_bearing_deg: wrap360(best.az), final_bearing_deg: fin.forward_azimuth_at_end,
      iterations: it, converged: best.res < 1e-3, residual_m: best.res, steps,
      method: '严格大地线反算（Clairaut ODE + RK4 + 牛顿迭代）',
      central_angle_deg: (best.s / e.a) * R2D,
    };
  }

  function geodesic(lat1, lon1, lat2, lon2, key, method) {
    const e = ell(key || 'WGS84');
    let r;
    if (method === 'haversine') {
      const d = haversine(lat1, lon1, lat2, lon2, e.mean_radius);
      r = { distance_m: d, initial_bearing_deg: initialBearing(lat1, lon1, lat2, lon2), final_bearing_deg: finalBearing(lat1, lon1, lat2, lon2), method: 'Haversine（正球面 R=' + e.mean_radius.toFixed(0) + ' m）', iterations: 0, converged: true };
    } else if (method === 'spherical') {
      const d = centralAngle(lat1, lon1, lat2, lon2) * e.a;
      r = { distance_m: d, initial_bearing_deg: initialBearing(lat1, lon1, lat2, lon2), final_bearing_deg: finalBearing(lat1, lon1, lat2, lon2), method: '球面大圆（半径取长半轴）', iterations: 0, converged: true };
    } else {
      r = inverse(lat1, lon1, lat2, lon2, key);
    }
    const d = r.distance_m == null ? 0 : r.distance_m;
    const p1 = geodeticToEcef(lat1, lon1, 0, key), p2 = geodeticToEcef(lat2, lon2, 0, key);
    const rh = rhumbDistance(lat1, lon1, lat2, lon2, 'Sphere');
    return Object.assign({}, r, {
      ellipsoid: e.name, ellipsoid_id: e.id, m: d, km: d / 1000,
      miles: d / 1609.344, nautical_miles: d / 1852, feet: d / 0.3048, yards: d / 0.9144, chains: d / 20.1168,
      degrees_arc: d / 111194.92664455873, radian_arc: d / e.a,
      bearing_deg: r.initial_bearing_deg, bearing_compass: r.initial_bearing_deg == null ? null : compass16(r.initial_bearing_deg),
      reverse_bearing_deg: r.initial_bearing_deg == null ? null : wrap360(r.initial_bearing_deg + 180),
      convergence_deg: r.initial_bearing_deg != null && r.final_bearing_deg != null ? wrap180(r.final_bearing_deg - r.initial_bearing_deg) : null,
      rhumb_m: rh, rhumb_diff_m: rh - d, rhumb_bearing_deg: rhumbBearing(lat1, lon1, lat2, lon2),
      chord_m: Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z),
      antipodal: Math.abs(wrapLon(lon1 - lon2)) > 179.5 && Math.abs(lat1 + lat2) < 0.5,
      travel: { walk_min: d / 1.4 / 60, run_min: d / 3 / 60, bike_min: d / 5.5 / 60, car_min: d / 22.2 / 60, rail_min: d / 83.3 / 60, jet_min: d / 238 / 60, light_ms: (d / 299792458) * 1000, ping_rt_ms: (2 * d / 299792458) * 1000, fiber_rt_ms: (2 * d / (299792458 * 2 / 3)) * 1000 },
    });
  }
  const wrap180 = (x) => ((x + 540) % 360) - 180;

  function rhumbBearing(lat1, lon1, lat2, lon2) {
    const f1 = lat1 * D2R, f2 = lat2 * D2R;
    let dl = (lon2 - lon1) * D2R;
    if (Math.abs(dl) > Math.PI) dl = dl > 0 ? -(2 * Math.PI - dl) : (2 * Math.PI + dl);
    const dpsi = Math.log(Math.tan(Math.PI / 4 + f2 / 2) / Math.tan(Math.PI / 4 + f1 / 2));
    // 恒向线方位 = atan2(Δλ, Δψ)；q = Δφ/Δψ 只用于距离与正算，不能混进方位
    return wrap360(Math.atan2(dl, dpsi) * R2D);
  }
  function rhumbDistance(lat1, lon1, lat2, lon2, key) {
    const e = ell(key || 'Sphere');
    const f1 = lat1 * D2R, f2 = lat2 * D2R;
    let dl = (lon2 - lon1) * D2R;
    if (Math.abs(dl) > Math.PI) dl = dl > 0 ? -(2 * Math.PI - dl) : (2 * Math.PI + dl);
    const dphi = f2 - f1;
    const dpsi = Math.log(Math.tan(Math.PI / 4 + f2 / 2) / Math.tan(Math.PI / 4 + f1 / 2));
    const q = Math.abs(dpsi) > 1e-12 ? dphi / dpsi : Math.cos((f1 + f2) / 2);
    return Math.hypot(dphi, q * dl) * e.a;
  }
  function rhumbDestination(lat1, lon1, bearing_deg, distance_m, key) {
    const e = ell(key || 'Sphere');
    const d = distance_m / e.a, crs = bearing_deg * D2R;
    const f1 = lat1 * D2R;
    const dphi = d * Math.cos(crs);
    const f2 = clamp(f1 + dphi, -Math.PI / 2, Math.PI / 2);
    const dpsi = Math.log(Math.tan(Math.PI / 4 + f2 / 2) / Math.tan(Math.PI / 4 + f1 / 2));
    const q = Math.abs(dpsi) > 1e-12 ? dphi / dpsi : Math.cos(f1);
    return { lat: f2 * R2D, lon: wrapLon(lon1 + (d * Math.sin(crs) / q) * R2D) };
  }

  function norm(points) {
    return (points || []).map((p) => ({ lat: num(p.lat != null ? p.lat : p[0]), lon: num(p.lon != null ? p.lon : p[1]) })).filter((p) => isFinite(p.lat) && isFinite(p.lon));
  }
  // 椭球精确面积：在 (λ, 等面积纬度) 上用球面多边形公式
  function polygonArea(points, key) {
    const e = ell(key || 'WGS84');
    const P = norm(points);
    if (P.length < 3) return { m2: 0, km2: 0, hectares: 0, acres: 0, mu: 0, perimeter_m: 0, vertex_count: P.length, method: '需要至少 3 个顶点', planar_m2: 0, projection_error_pct: 0 };
    const R = e.authalic_radius;
    let sum = 0;
    for (let i = 0; i < P.length; i++) {
      const p1 = P[i], p2 = P[(i + 1) % P.length];
      const b1 = authalicLatitude(p1.lat, key) * D2R, b2 = authalicLatitude(p2.lat, key) * D2R;
      let dl = (p2.lon - p1.lon) * D2R;
      if (dl > Math.PI) dl -= 2 * Math.PI; else if (dl < -Math.PI) dl += 2 * Math.PI;
      sum += dl * (2 + Math.sin(b1) + Math.sin(b2));
    }
    const area = Math.abs(sum * R * R / 2);
    const pl = polylineLength(P.concat([P[0]]), key);
    const flat = planarArea(P);
    return {
      m2: area, km2: area / 1e6, hectares: area / 1e4, acres: area / 4046.8564224, mu: area / 666.66666667,
      square_miles: area / 2589988.110336, perimeter_m: pl.total_m, perimeter_km: pl.total_km,
      planar_m2: flat, projection_error_pct: area ? ((area - flat) / area) * 100 : 0,
      vertex_count: P.length, method: '等面积纬度球面多边形（椭球精确，R_auth=' + R.toFixed(1) + ' m）',
      centroid: centroid(P), bbox: boundingBox(P),
    };
  }
  function planarArea(points) {
    const P = norm(points);
    let s = 0;
    const n = P.length;
    for (let i = 0; i < n; i++) { const p1 = P[i], p2 = P[(i + 1) % n]; s += p1.lon * p2.lat - p2.lon * p1.lat; }
    const lat0 = P.reduce((a, p) => a + p.lat, 0) / (n || 1);
    const mpd = metersPerDegree(lat0, 'WGS84');
    return Math.abs(s / 2) * D2R * D2R * mpd.lon_m * mpd.lat_m;
  }
  function polylineLength(points, key) {
    const P = norm(points), seg = [];
    let d = 0;
    for (let i = 1; i < P.length; i++) {
      const s = inverse(P[i - 1].lat, P[i - 1].lon, P[i].lat, P[i].lon, key).distance_m;
      seg.push(s); d += s;
    }
    return { total_m: d, total_km: d / 1000, total_mi: d / 1609.344, total_nmi: d / 1852, segments: seg, count: seg.length, avg_m: seg.length ? d / seg.length : 0, max_m: seg.length ? Math.max(...seg) : 0, point_count: P.length };
  }
  function pathBearings(points, key) {
    const P = norm(points), out = [];
    for (let i = 1; i < P.length; i++) {
      const v = inverse(P[i - 1].lat, P[i - 1].lon, P[i].lat, P[i].lon, key);
      out.push({ from: P[i - 1], to: P[i], bearing_deg: v.initial_bearing_deg, distance_m: v.distance_m, compass: v.initial_bearing_deg == null ? null : compass16(v.initial_bearing_deg) });
    }
    return out;
  }
  function compass16(deg) {
    const n = ['北 N', '北偏东 NNE', '东北 NE', '东偏北 ENE', '东 E', '东偏南 ESE', '东南 SE', '南偏东 SSE', '南 S', '南偏西 SSW', '西南 SW', '西偏南 WSW', '西 W', '西偏北 WNW', '西北 NW', '北偏西 NNW'];
    return n[Math.round(wrap360(deg) / 22.5) % 16];
  }
  function compass32(deg) {
    // 32 罗经点：主点 8 + 半点 8 + 四分点 16，每点 11.25°
    const n = ['N', 'NbE', 'NNE', 'NEbN', 'NE', 'NEbE', 'ENE', 'EbN', 'E', 'EbS', 'ESE', 'SEbE', 'SE', 'SEbS', 'SSE', 'SbE',
      'S', 'SbW', 'SSW', 'SWbS', 'SW', 'SWbW', 'WSW', 'WbS', 'W', 'WbN', 'WNW', 'NWbW', 'NW', 'NWbN', 'NNW', 'NbW'];
    return n[Math.round(wrap360(deg) / 11.25) % 32];
  }
  function pointInPolygon(lat, lon, ring) {
    const P = norm(ring);
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if ((P[i].lat > lat) !== (P[j].lat > lat) && lon < ((P[j].lon - P[i].lon) * (lat - P[i].lat)) / (P[j].lat - P[i].lat) + P[i].lon) inside = !inside;
    }
    return inside;
  }
  function closestPointOnSegment(lat, lon, a, b) {
    const k = Math.cos(lat * D2R) || 1e-12;
    const ax = a.lon / k, bx = b.lon / k, px = lon / k;
    const dx = bx - ax, dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (lat - a.lat) * dy) / len2, 0, 1);
    return { lat: a.lat + t * dy, lon: wrapLon((ax + t * dx) * k) };
  }
  function distanceToPolygon(lat, lon, ring) {
    const P = norm(ring);
    let best = Infinity, nearest = null;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const p = closestPointOnSegment(lat, lon, P[j], P[i]);
      const d = inverse(lat, lon, p.lat, p.lon, 'WGS84').distance_m;
      if (d < best) { best = d; nearest = p; }
    }
    return { distance_m: best === Infinity ? null : best, inside: pointInPolygon(lat, lon, P), nearest };
  }
  function centroid(points) {
    const P = norm(points);
    if (!P.length) return null;
    let x = 0, y = 0, z = 0;
    P.forEach((p) => { const l = p.lon * D2R, f = p.lat * D2R; x += Math.cos(f) * Math.cos(l); y += Math.cos(f) * Math.sin(l); z += Math.sin(f); });
    const n = P.length;
    return { lat: Math.atan2(z / n, Math.hypot(x / n, y / n)) * R2D, lon: wrapLon(Math.atan2(y / n, x / n) * R2D), arithmetic: { lat: P.reduce((a, p) => a + p.lat, 0) / n, lon: P.reduce((a, p) => a + p.lon, 0) / n }, n };
  }
  function boundingBox(points, pad_m) {
    const P = norm(points);
    if (!P.length) return null;
    const lats = P.map((p) => p.lat), lons = P.map((p) => p.lon);
    const b = { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lons), west: Math.min(...lons) };
    b.lat_span = b.north - b.south; b.lon_span = b.east - b.west;
    b.center = { lat: (b.north + b.south) / 2, lon: wrapLon((b.east + b.west) / 2) };
    if (pad_m) { const mpd = metersPerDegree(b.center.lat, 'WGS84'); b.north += pad_m / mpd.lat_m; b.south -= pad_m / mpd.lat_m; b.east += pad_m / mpd.lon_m; b.west -= pad_m / mpd.lon_m; }
    return b;
  }
  function convexHull(points) {
    const P = norm(points);
    if (P.length < 3) return P;
    const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);
    P.sort((a, b) => a.lon - b.lon || a.lat - b.lat);
    const lower = [], upper = [];
    for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }
  function densify(points, max_gap_m, key) {
    const P = norm(points), out = [];
    for (let i = 0; i < P.length; i++) {
      out.push(P[i]);
      if (i + 1 < P.length) {
        const v = inverse(P[i].lat, P[i].lon, P[i + 1].lat, P[i + 1].lon, key);
        const n = Math.max(0, Math.floor((v.distance_m || 0) / max_gap_m) - 1);
        for (let j = 1; j <= n; j++) out.push(direct(P[i].lat, P[i].lon, v.initial_bearing_deg, (v.distance_m * j) / (n + 1), key));
      }
    }
    return out.map((p) => ({ lat: p.lat, lon: p.lon }));
  }
  function greatCirclePoints(lat1, lon1, lat2, lon2, n) {
    n = n || 64;
    const v = inverse(lat1, lon1, lat2, lon2, 'WGS84');
    const out = [{ lat: lat1, lon: lon1 }];
    for (let i = 1; i < n; i++) { const p = direct(lat1, lon1, v.initial_bearing_deg || 0, ((v.distance_m || 0) * i) / n, 'WGS84'); out.push({ lat: p.lat, lon: p.lon }); }
    out.push({ lat: lat2, lon: lon2 });
    return out;
  }
  function smallCirclePolygon(lat, lon, radius_m, segments, key) {
    segments = segments || 72;
    const out = [];
    for (let i = 0; i < segments; i++) {
      const az = (360 * i) / segments;
      const p = direct(lat, lon, az, radius_m, key);
      out.push({ lat: p.lat, lon: p.lon, azimuth_deg: az });
    }
    return out;
  }
  function annulusPolygon(lat, lon, inner_m, outer_m, segments, key) {
    segments = segments || 72;
    const outer = [], inner = [];
    for (let i = 0; i < segments; i++) {
      const az = (360 * i) / segments;
      outer.push(direct(lat, lon, az, outer_m, key));
      inner.push(direct(lat, lon, az, inner_m, key));
    }
    return { outer, inner: inner.reverse() };
  }
  function circleIntersection(p1, r1, p2, r2, opts) {
    const o = opts || {};
    if (!p1 || !p2 || !isFinite(p1.lat) || !isFinite(p1.lon) || !isFinite(p2.lat) || !isFinite(p2.lon)
      || !isFinite(r1) || !isFinite(r2)) {
      // 传成 [lat,lon] 数组时 .lat 是 undefined，会一路 NaN 到余弦定理里；那种情况要说清是入参不对，不是解域不够
      return { ok: false, reason: '入参不是有限的圆心/半径（需要 {lat,lon} 与米制半径，不是 [lat,lon] 数组）', candidates: [] };
    }
    const d = inverse(p1.lat, p1.lon, p2.lat, p2.lon, o.key || 'WGS84').distance_m;
    const az12 = d === 0 ? null : initialBearing(p1.lat, p1.lon, p2.lat, p2.lon);
    if (d === 0) return { ok: false, reason: '两圆心重合，无法交会', candidates: [] };
    const eps = Math.max(1, d * 1e-9);
    if (d > r1 + r2 + eps) return { ok: false, reason: '两圆相离（圆心距 ' + Math.round(d) + ' m 大于半径和 ' + Math.round(r1 + r2) + ' m）', candidates: [], gap_m: d - (r1 + r2) };
    if (d < Math.abs(r1 - r2) - eps) return { ok: false, reason: '一圆完全含于另一圆（圆心距 ' + Math.round(d) + ' m，半径差 ' + Math.round(Math.abs(r1 - r2)) + ' m）', candidates: [], gap_m: Math.abs(r1 - r2) - d };
    const R = ell(o.key || 'WGS84').a;
    const cosA = (Math.cos(r2 / R) - Math.cos(d / R) * Math.cos(r1 / R)) / (Math.sin(d / R) * Math.sin(r1 / R));
    if (!isFinite(cosA)) return { ok: false, reason: '数值超出球面三角解域', candidates: [] };
    const A = Math.acos(clamp(cosA, -1, 1)) * R2D;
    const azA = wrap360(az12 + A), azB = wrap360(az12 - A);
    const ca = direct(p1.lat, p1.lon, azA, r1, o.key), cb = direct(p1.lat, p1.lon, azB, r1, o.key);
    return {
      ok: true, center_distance_m: d, angle_offset_deg: A, tangent: Math.abs(d - (r1 + r2)) < eps || Math.abs(d - Math.abs(r1 - r2)) < eps,
      candidates: [
        { lat: ca.lat, lon: ca.lon, bearing_from_p1: azA, side: 'right' },
        { lat: cb.lat, lon: cb.lon, bearing_from_p1: azB, side: 'left' },
      ],
    };
  }
  function offsetLatLon(lat, lon, east_m, north_m, key) {
    const mpd = metersPerDegree(lat, key || 'WGS84');
    return { lat: lat + north_m / mpd.lat_m, lon: wrapLon(lon + east_m / mpd.lon_m) };
  }
  function gridPoints(center, spacing_m, cols, rows) {
    const out = [], c = Math.floor(cols / 2), r = Math.floor(rows / 2);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out.push(Object.assign(offsetLatLon(center.lat, center.lon, (j - c) * spacing_m, (i - r) * spacing_m), { row: i, col: j }));
    return out;
  }

  function geodeticToEcef(lat, lon, h, key) {
    const e = ell(key || 'WGS84'), s = Math.sin(lat * D2R), c = Math.cos(lat * D2R), l = lon * D2R, hh = h || 0;
    const N = e.a / SQ(1 - e.e2 * s * s);
    return { x: (N + hh) * c * Math.cos(l), y: (N + hh) * c * Math.sin(l), z: (N * (1 - e.e2) + hh) * s, N, h: hh };
  }
  function ecefToGeodetic(x, y, z, key) {
    const e = ell(key || 'WGS84');
    const p = Math.hypot(x, y);
    if (p < 1e-9) return { lat: z >= 0 ? 90 : -90, lon: 0, h: Math.abs(z) - e.b, p };
    const lon = Math.atan2(y, x) * R2D;
    let lat = Math.atan2(z, p * (1 - e.e2));
    for (let i = 0; i < 12; i++) {
      const s = Math.sin(lat), N = e.a / SQ(1 - e.e2 * s * s);
      const h = p / Math.cos(lat) - N;
      if (!isFinite(h)) break;
      lat = Math.atan2(z, p * (1 - e.e2 * N / (N + h)));
    }
    const s = Math.sin(lat), N = e.a / SQ(1 - e.e2 * s * s);
    return { lat: lat * R2D, lon: wrapLon(lon), h: p / Math.cos(lat) - N, p };
  }
  function ecefToEnu(dx, dy, dz, lat, lon) {
    const sLa = Math.sin(lat * D2R), cLa = Math.cos(lat * D2R), sLo = Math.sin(lon * D2R), cLo = Math.cos(lon * D2R);
    return { e: -sLo * dx + cLo * dy, n: -sLa * cLo * dx - sLa * sLo * dy + cLa * dz, u: cLa * cLo * dx + cLa * sLo * dy + sLa * dz };
  }
  function enuToEcef(e_, n_, u_, lat, lon) {
    const sLa = Math.sin(lat * D2R), cLa = Math.cos(lat * D2R), sLo = Math.sin(lon * D2R), cLo = Math.cos(lon * D2R);
    return { x: -sLo * e_ - sLa * cLo * n_ + cLa * cLo * u_, y: cLo * e_ - sLa * sLo * n_ + cLa * sLo * u_, z: cLa * n_ + sLa * u_ };
  }
  function enuFromDelta(lat0, lon0, lat1, lon1, h0, h1, key) {
    const e = ell(key || 'WGS84');
    const p0 = geodeticToEcef(lat0, lon0, h0 || 0, e.id), p1 = geodeticToEcef(lat1, lon1, h1 || 0, e.id);
    const v = ecefToEnu(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z, lat0, lon0);
    v.slant_m = Math.hypot(v.e, v.n, v.u);
    v.horizontal_m = Math.hypot(v.e, v.n);
    v.azimuth_deg = wrap360(Math.atan2(v.e, v.n) * R2D);
    v.elevation_deg = v.slant_m ? Math.atan2(v.u, Math.hypot(v.e, v.n)) * R2D : 0;
    return v;
  }
  function datumShift7(lat, lon, h, p) {
    const src = ell(p.from || 'WGS84'), dst = ell(p.to || 'WGS84');
    const s = Math.sin(lat * D2R), c = Math.cos(lat * D2R), l = lon * D2R;
    const N1 = src.a / SQ(1 - src.e2 * s * s);
    const x1 = (N1 + h) * c * Math.cos(l), y1 = (N1 + h) * c * Math.sin(l), z1 = (N1 * (1 - src.e2) + h) * s;
    const m = 1 + (p.scale_ppm || 0) * 1e-6;
    const rx = (p.rx_sec || 0) / 206265, ry = (p.ry_sec || 0) / 206265, rz = (p.rz_sec || 0) / 206265;
    const x2 = (p.dx || 0) + m * (x1 - rz * y1 + ry * z1);
    const y2 = (p.dy || 0) + m * (rz * x1 + y1 - rx * z1);
    const z2 = (p.dz || 0) + m * (-ry * x1 + rx * y1 + z1);
    const out = ecefToGeodetic(x2, y2, z2, p.to || 'WGS84');
    return Object.assign({}, out, { ecef: { x: x2, y: y2, z: z2 }, method: 'Bursa-Wolf 7 参数（坐标轴旋转约定）' });
  }
  function heightConvert(ellipsoidal_h, geoid_n) {
    const n = num(geoid_n);
    if (!isFinite(n)) return { ellipsoidal_m: ellipsoidal_h, geoid_m: null, note: '未提供大地水准面差距 N：离线无 EGM 模型，请在“联网”页取 EGM2008 或手填 N 值' };
    return { ellipsoidal_m: ellipsoidal_h, geoid_m: ellipsoidal_h - n, geoid_undulation_m: n, method: 'H(正高/海拔) = h(椭球高) − N' };
  }
  function graticule(bbox, step) {
    const lines = [];
    for (let lat = Math.ceil(bbox.south / step) * step; lat <= bbox.north; lat += step) lines.push({ type: 'parallel', value: lat, a: { lat, lon: bbox.west }, b: { lat, lon: bbox.east } });
    for (let lon = Math.ceil(bbox.west / step) * step; lon <= bbox.east; lon += step) lines.push({ type: 'meridian', value: lon, a: { lat: bbox.south, lon }, b: { lat: bbox.north, lon } });
    return lines;
  }

  const METHODS = [
    { id: 'strict', name: '严格大地线（Clairaut 方程 RK4 数值积分）', note: '本程序主用；对跖点、近极点均可解；赤道/子午线误差 <0.001 m' },
    { id: 'haversine', name: 'Haversine（正球面，平均半径）', note: '最快，忽略扁率；长距离偏差可达 0.3%' },
    { id: 'spherical', name: '球面大圆（长半轴半径）', note: '与 Haversine 差约 0.1%' },
  ];

  const API = {
    D2R, R2D, clamp, wrapLon, wrap360, wrap180, num, ell, ELLIPSOIDS, METHODS, radii, metersPerDegree,
    authalicLatitude, latitudeFromAuthalic, zoneIntegralRad,
    validate, precisionTable, precisionOf, precisionLabel, decimalsOf,
    haversine, centralAngle, inverse: geodesicInverse(), direct, initialBearing, finalBearing, geodesic,
    rhumbDistance, rhumbBearing, rhumbDestination, polygonArea, planarArea, polylineLength, pathBearings,
    compass16, compass32, pointInPolygon, distanceToPolygon, closestPointOnSegment, centroid, boundingBox,
    convexHull, densify, greatCirclePoints, smallCirclePolygon, annulusPolygon, circleIntersection,
    offsetLatLon, gridPoints, geodeticToEcef, ecefToGeodetic, ecefToEnu, enuToEcef, enuFromDelta,
    datumShift7, heightConvert, graticule, norm, integrate,
    selfTest,
  };
  function geodesicInverse() { return inverse; }

  function selfTest() {
    const t = [];
    const push = (name, pass, detail) => t.push({ name, pass: !!pass, detail });
    const SH = { lat: 31.2304, lon: 121.4737 }, BJ = { lat: 39.9042, lon: 116.4074 };
    push('赤道 1° 经度 = a·Δλ（111319.4908 m）', Math.abs(inverse(0, 0, 0, 1, 'WGS84').distance_m - 6378137 * D2R) < 0.001, inverse(0, 0, 0, 1).distance_m.toFixed(4) + ' m');
    push('子午 0→1° = 110574.389 m', Math.abs(inverse(0, 0, 1, 0).distance_m - 110574.389) < 0.005, inverse(0, 0, 1, 0).distance_m.toFixed(4));
    push('子午 31→32° 随纬度增大', (() => { const d = inverse(31, 121, 32, 121).distance_m; return d > 110870 && d < 110890; })(), inverse(31, 121, 32, 121).distance_m.toFixed(3) + ' m');
    push('跨赤道子午 −45→20°', Math.abs(inverse(-45, 10, 20, 10).distance_m - (inverse(-45, 10, 0, 10).distance_m + inverse(0, 10, 20, 10).distance_m)) < 0.002, '分段可加');
    const v1 = inverse(SH.lat, SH.lon, BJ.lat, BJ.lon), v2 = inverse(BJ.lat, BJ.lon, SH.lat, SH.lon);
    push('往返距离对称 <1 mm', Math.abs(v1.distance_m - v2.distance_m) < 0.001, v1.distance_m.toFixed(4) + ' / ' + v2.distance_m.toFixed(4));
    const back = direct(BJ.lat, BJ.lon, v2.initial_bearing_deg, v2.distance_m);
    push('反向正算精确回到起点', Math.abs(back.lat - SH.lat) < 1e-9 && Math.abs(wrapLon(back.lon - SH.lon)) < 1e-9, back.lat.toFixed(9));
    push('方位角互反（差 180°）', Math.abs(wrap180(back.forward_azimuth_at_end - v1.initial_bearing_deg - 180)) < 1e-6, back.forward_azimuth_at_end.toFixed(6) + ' vs ' + v1.initial_bearing_deg.toFixed(6));
    push('反算残差 <1 mm', v1.residual_m < 1e-3, v1.residual_m.toExponential(2) + ' m，迭代 ' + v1.iterations + ' 次');
    push('上海→北京 ≈1065.8 km', Math.abs(v1.distance_m - 1065846) < 50, Math.round(v1.distance_m) + ' m，起始方位 ' + v1.initial_bearing_deg.toFixed(3) + '°');
    const hav = haversine(SH.lat, SH.lon, BJ.lat, BJ.lon);
    push('椭球/球面比在 0.995~1.005', v1.distance_m / hav > 0.995 && v1.distance_m / hav < 1.005, (v1.distance_m / hav).toFixed(6));
    const anti = inverse(0, 0, -0.0002, 179.9998);
    push('近对跖点收敛', anti.residual_m < 1e-2 && anti.distance_m > 2.0e7, Math.round(anti.distance_m) + ' m，残差 ' + anti.residual_m.toExponential(1));
    const polar = inverse(89.9, 0, 89.9, 180);
    push('近北极两点过极点 22.32 km', Math.abs(polar.distance_m - 0.2 * metersPerDegree(89.95).lat_m) < 30, Math.round(polar.distance_m) + ' m（解析 ' + Math.round(0.2 * metersPerDegree(89.95).lat_m) + ' m）');
    const sydney = inverse(-33.8688, 151.2093, 51.4769, -0.0005);
    push('悉尼→格林尼治半周 <0.1% 残差', sydney.residual_m < 1, Math.round(sydney.distance_m) + ' m，az1=' + sydney.initial_bearing_deg.toFixed(3));
    push('零距离', inverse(20, 20, 20, 20).distance_m === 0, '0');
    push('步数无关（300 vs 3000 差 <0.01 m）', (() => {
      const e = ell('WGS84');
      const a1 = integrate(SH.lat * D2R, SH.lon * D2R, v1.initial_bearing_deg * D2R, v1.distance_m, e, 300);
      const a2 = integrate(SH.lat * D2R, SH.lon * D2R, v1.initial_bearing_deg * D2R, v1.distance_m, e, 3000);
      return Math.abs(a1.lat_rad - a2.lat_rad) * 111132 < 0.01;
    })(), 'RK4 收敛阶验证');
    const sq = polygonArea([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }], 'WGS84');
    push('1°×1° 赤道带面积 = 12308.5 km²', Math.abs(sq.km2 - 12308.46) < 1.5, sq.km2.toFixed(3) + ' km²');
    push('该方格周长 = 443.78 km', Math.abs(sq.perimeter_km - 443.788) < 0.5, sq.perimeter_km.toFixed(3) + ' km（含闭合边）');
    const tri = polygonArea([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 0 }], 'WGS84');
    push('直角三角形面积 = 方格一半', Math.abs(tri.m2 - sq.m2 / 2) < sq.m2 * 1e-6, tri.km2.toFixed(3) + ' km²');
    const beijing = polygonArea([{ lat: 39.5, lon: 116 }, { lat: 40.5, lon: 116 }, { lat: 40.5, lon: 117.5 }, { lat: 39.5, lon: 117.5 }], 'WGS84');
    push('中纬度 1°×1.5° 面积 ≈ 1.42 万 km²', beijing.km2 > 14150 && beijing.km2 < 14300, beijing.km2.toFixed(1) + ' km² = ' + (beijing.m2 / 1e4).toFixed(0) + ' ha');
    push('点在多边形内', pointInPolygon(0.5, 0.5, [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }]), 'true');
    push('点在多边形外', !pointInPolygon(2, 0.5, [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }]), 'false');
    push('方位角正北=0', Math.abs(initialBearing(0, 0, 1, 0)) < 1e-9, initialBearing(0, 0, 1, 0).toFixed(9));
    push('方位角正东=90', Math.abs(initialBearing(0, 0, 0, 1) - 90) < 1e-6, initialBearing(0, 0, 0, 1).toFixed(9));
    push('恒向线 ≥ 大圆（北京-上海）', rhumbDistance(SH.lat, SH.lon, BJ.lat, BJ.lon, 'Sphere') >= haversine(SH.lat, SH.lon, BJ.lat, BJ.lon) * 0.999, Math.round(rhumbDistance(SH.lat, SH.lon, BJ.lat, BJ.lon, 'Sphere')) + ' vs 球面 ' + Math.round(haversine(SH.lat, SH.lon, BJ.lat, BJ.lon)));
    push('恒向线赤道上等于大圆', Math.abs(rhumbDistance(0, 0, 0, 10, 'Sphere') - haversine(0, 0, 0, 10, ell('Sphere').a)) < 5000, Math.round(rhumbDistance(0, 0, 0, 10, 'Sphere')) + ' m');
    push('恒向线方位角在赤道上=90', Math.abs(rhumbBearing(0, 0, 0, 10) - 90) < 1e-6, rhumbBearing(0, 0, 0, 10).toFixed(6));
    push('恒向线正算回代一致', (() => { const p = rhumbDestination(35, 139, rhumbBearing(35, 139, 40, 145), rhumbDistance(35, 139, 40, 145, 'Sphere'), 'Sphere'); return Math.abs(p.lat - 40) < 0.02 && Math.abs(p.lon - 145) < 0.02; })(), 'ok');
    const pr = precisionOf(31.2304123, 121.4737123);
    push('7 位小数 ≈ 1.11 cm（31°N）', pr.meters_lat < 0.0111 && pr.meters_lat > 0.0110, pr.meters_lat.toFixed(6) + ' m（' + pr.note + '）');
    const ci = circleIntersection({ lat: 0, lon: 0 }, 150000, { lat: 0, lon: 2 }, 150000);
    push('两圆交会交点到两圆心距离精确等于半径', ci.ok && Math.abs(inverse(0, 0, ci.candidates[0].lat, ci.candidates[0].lon).distance_m - 150000) < 2 && Math.abs(inverse(0, 2, ci.candidates[0].lat, ci.candidates[0].lon).distance_m - 150000) < 2, '交点 ' + ci.candidates[0].lat.toFixed(4) + ',' + ci.candidates[0].lon.toFixed(4) + '（偏北 ' + ci.candidates[0].lat.toFixed(3) + '°）');
    push('交会两解左右对称', ci.ok && Math.abs(ci.candidates[0].lat + ci.candidates[1].lat) < 1e-6 && Math.abs(ci.candidates[0].lon - ci.candidates[1].lon) < 1e-6, ci.candidates.map((c) => c.lat.toFixed(5)).join(' / '));
    push('相离两圆返回原因不崩溃', circleIntersection({ lat: 0, lon: 0 }, 1000, { lat: 0, lon: 10 }, 1000).ok === false, circleIntersection({ lat: 0, lon: 0 }, 1000, { lat: 0, lon: 10 }, 1000).reason);
    push('相切两圆给出单点', circleIntersection({ lat: 0, lon: 0 }, 111319.49, { lat: 0, lon: 2 }, 111319.49).ok === true, 'tangent=' + circleIntersection({ lat: 0, lon: 0 }, 111319.49, { lat: 0, lon: 2 }, 111319.49).tangent);
    const ciBad = circleIntersection([0, 0], 150000, [0, 2], 150000);
    push('数组形入参被明确拒绝而不是伪装成解域问题', ciBad.ok === false && ciBad.candidates.length === 0 && /入参/.test(ciBad.reason) && !/球面三角/.test(ciBad.reason), ciBad.reason);
    const e = geodeticToEcef(0, 0, 0, 'WGS84');
    push('ECEF 赤道本初子午线', Math.abs(e.x - 6378137) < 1 && Math.abs(e.y) < 1e-9 && Math.abs(e.z) < 1e-9, e.x.toFixed(3));
    const e2v = geodeticToEcef(-33.8688, -70.6693, 512.4, 'WGS84');
    const b2 = ecefToGeodetic(e2v.x, e2v.y, e2v.z, 'WGS84');
    push('ECEF 往返（含高程）', Math.abs(b2.lat + 33.8688) < 1e-9 && Math.abs(wrapLon(b2.lon + 70.6693)) < 1e-9 && Math.abs(b2.h - 512.4) < 1e-4, b2.h.toFixed(5));
    const b3 = ecefToGeodetic(...Object.values(geodeticToEcef(89.999999, 12.3, 0, 'WGS84')), 'WGS84');
    push('ECEF 往返（近极点）', Math.abs(b3.lat - 89.999999) < 1e-6, b3.lat.toFixed(8));
    const b4 = ecefToGeodetic(0, 0, -6356752.314, 'WGS84');
    push('ECEF 南极点', Math.abs(b4.lat + 90) < 1e-9 && Math.abs(b4.h) < 1, b4.lat.toFixed(6) + ' h=' + b4.h.toFixed(3));
    const enu = ecefToEnu(0, 100, 0, 0, 0);
    push('ECEF→ENU 在 (0,0) 的 +Y 是东', Math.abs(enu.e - 100) < 1e-9 && Math.abs(enu.n) < 1e-9 && Math.abs(enu.u) < 1e-9, JSON.stringify(enu));
    const enu2 = ecefToEnu(0, 0, 100, 0, 0);
    push('ECEF→ENU 在 (0,0) 的 +Z 是北', Math.abs(enu2.n - 100) < 1e-9, JSON.stringify(enu2));
    const rt = enuToEcef(...Object.values(ecefToEnu(10, 20, 30, 35, 139)), 35, 139);
    push('ENU 往返', Math.abs(rt.x - 10) < 1e-6 && Math.abs(rt.y - 20) < 1e-6 && Math.abs(rt.z - 30) < 1e-6, JSON.stringify(rt));
    const dv = enuFromDelta(31.2304, 121.4737, 31.2314, 121.4737, 0, 0);
    push('ENU 增量正北 0.001° ≈ 111 m', Math.abs(dv.n - 110.87) < 1 && Math.abs(dv.e) < 0.01 && Math.min(dv.azimuth_deg, 360 - dv.azimuth_deg) < 0.01, dv.n.toFixed(3) + ' m 方位 ' + dv.azimuth_deg.toFixed(6));
    push('非法纬度被拦截', validate(120, 10).valid === false, JSON.stringify(validate(120, 10).issues));
    push('经度归一化 370→10', validate(0, 370).normalized.lon === 10, String(validate(0, 370).normalized.lon));
    const g = geodesic(SH.lat, SH.lon, BJ.lat, BJ.lon, 'WGS84');
    push('单位换算自洽（mi/ft/海里/光时）', Math.abs(g.miles - g.m / 1609.344) < 1e-9 && Math.abs(g.nautical_miles - g.m / 1852) < 1e-9 && Math.abs(g.travel.light_ms - (g.m / 299792458) * 1000) < 1e-9, g.m.toFixed(1) + ' m');
    push('球面子午 1° vs Haversine', Math.abs(geodesic(0, 0, 1, 0, 'Sphere', 'strict').distance_m - haversine(0, 0, 1, 0, 6371008.7714)) < 5000, geodesic(0, 0, 1, 0, 'Sphere').distance_m.toFixed(1));
    const dz = datumShift7(31.2304, 121.4737, 0, { from: 'WGS84', to: 'WGS84' });
    push('零参数 7 参数转换恒等', Math.abs(dz.lat - 31.2304) < 1e-12 && Math.abs(dz.lon - 121.4737) < 1e-12, dz.lat.toFixed(10));
    const dz2 = datumShift7(31.2304, 121.4737, 0, { from: 'WGS84', to: 'WGS84', dz: 100 });
    const dHoriz = inverse(31.2304, 121.4737, dz2.lat, dz2.lon).distance_m;
    // +Z 平移在地心坐标系里，投影到当地 ENU 恰好是「北 100·cosφ / 天 100·sinφ」
    push('dz=100 分解为北移 100·cosφ、抬升 100·sinφ', Math.abs(dHoriz - 100 * Math.cos(31.2304 * D2R)) < 2 && Math.abs(dz2.h - 100 * Math.sin(31.2304 * D2R)) < 2, '水平 ' + dHoriz.toFixed(2) + ' m，高程 ' + dz2.h.toFixed(2) + ' m');
    const dens = densify([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], 20000, 'WGS84');
    push('路径加密点数与间距', dens.length >= 5 && Math.abs(inverse(dens[0].lat, dens[0].lon, dens[1].lat, dens[1].lon).distance_m - 22264) < 3000, dens.length + ' 点，间距 ' + Math.round(inverse(dens[0].lat, dens[0].lon, dens[1].lat, dens[1].lon).distance_m) + ' m');
    const hull = convexHull([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 0, lon: 1 }, { lat: 0.2, lon: 0.2 }, { lat: 1, lon: 0 }]);
    push('凸包剔除内部点', hull.length === 4, hull.length + ' 顶点');
    const c = centroid([{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }, { lat: 2, lon: 2 }, { lat: 2, lon: 0 }]);
    push('质心 (1,1)', Math.abs(c.lat - 1) < 0.02 && Math.abs(c.lon - 1) < 0.02, c.lat.toFixed(4));
    const gc = greatCirclePoints(0, 0, 0, 90, 16);
    push('大圆弧中点在赤道 45°E', Math.abs(gc[8].lon - 45) < 0.01 && Math.abs(gc[8].lat) < 0.01, '中点 ' + gc[8].lat.toFixed(3) + ',' + gc[8].lon.toFixed(3));
    const sc = smallCirclePolygon(0, 0, 100000, 36);
    push('等距圆每点到圆心 100 km', Math.abs(inverse(0, 0, sc[9].lat, sc[9].lon).distance_m - 100000) < 50, Math.round(inverse(0, 0, sc[9].lat, sc[9].lon).distance_m) + ' m');
    push('等距圆高纬同样成立', (() => { const p = smallCirclePolygon(60, 15, 50000, 24); return Math.abs(inverse(60, 15, p[7].lat, p[7].lon).distance_m - 50000) < 50; })(), 'ok');
    const mp = metersPerDegree(0), mp60 = metersPerDegree(60);
    push('1° 经度随纬度收缩（0°:111319.5 / 60°:55800.0 = N·cosφ）', Math.abs(mp.lon_m - 111319.49) < 1 && Math.abs(mp60.lon_m - 55800.0) < 2 && Math.abs(mp60.lat_m - 111412.29) < 2, mp.lon_m.toFixed(1) + ' / ' + mp60.lon_m.toFixed(1) + '；60°处 1° 纬度 ' + mp60.lat_m.toFixed(1));
    push('等面积纬度单调', (() => { for (let i = 1; i <= 90; i += 9) { if (!(authalicLatitude(i) > authalicLatitude(i - 1))) return false; } return true; })(), 'ok');
    push('R_auth 在 b~a 之间', ell('WGS84').authalic_radius > 6371000 && ell('WGS84').authalic_radius < 6371015, ell('WGS84').authalic_radius.toFixed(2) + ' m');
    push('高度换算缺 N 时不给假值', heightConvert(100).geoid_m === null, JSON.stringify(heightConvert(100).note));
    push('高度换算给 N 时精确', Math.abs(heightConvert(100, -32.5).geoid_m - 132.5) < 1e-9, heightConvert(100, -32.5).geoid_m);
    push('球体椭球 f=0 走球面分支', (() => { const v = inverse(10, 10, 20, 20, 'Sphere'); return Math.abs(v.distance_m - centralAngle(10, 10, 20, 20) * 6371008.7714) < 1e-6; })(), 'ok');
    // 计时闸门只当「没把算法写崩」的保险，不当基准测试：冷启动的头几次是解释执行，
    // 慢机器或新进程里能到十几毫秒，那是 JIT 噪声不是公式问题。先预热，再测，且只测一遍，
    // 判定与展示用同一个数（原来两处各跑一遍，展示的数与被测的数根本不是同一次）。
    const inv_ms = (() => {
      for (let i = 0; i < 30; i++) inverse(SH.lat, SH.lon, BJ.lat, BJ.lon);
      const t0 = Date.now();
      for (let i = 0; i < 30; i++) inverse(SH.lat, SH.lon, BJ.lat, BJ.lon);
      return (Date.now() - t0) / 30;
    })();
    push('单次反算耗时（预热后 30 次均值 < 40 ms）', inv_ms < 40, inv_ms.toFixed(2) + ' ms/次');

    // —— 罗经点：两张独立表（16 点 / 32 点）必须互洽，且每个方位都要有名字
    const c32 = [];
    for (let k = 0; k < 32; k++) c32.push(compass32(k * 11.25 + 0.001));
    push('32 罗经点每点都有名称（覆盖 0~360° 全周）', c32.every((n) => typeof n === 'string' && n.length >= 1) && new Set(c32).size === 32, c32.slice(0, 8).join(' ') + ' …（32 个名字互不重复）');
    push('32 点表的 8 个主点名与 16 点表一致', (() => {
      const main = ['N', 'E', 'S', 'W', 'NE', 'SE', 'SW', 'NW'];
      const az = [0, 90, 180, 270, 45, 135, 225, 315];
      return main.every((nm, i) => compass32(az[i]) === nm && String(compass16(az[i])).indexOf(nm) >= 0);
    })(), [0, 90, 180, 270, 45, 135, 225, 315].map((a) => a + '°→' + compass32(a) + '/' + compass16(a)).join('，'));
    push('32 点的偶数位就是 16 点表同名点（两表互校）', (() => {
      const abbr16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
      const full16 = ['北 N', '北偏东 NNE', '东北 NE', '东偏北 ENE', '东 E', '东偏南 ESE', '东南 SE', '南偏东 SSE', '南 S', '南偏西 SSW', '西南 SW', '西偏南 WSW', '西 W', '西偏北 WNW', '西北 NW', '北偏西 NNW'];
      for (let k = 0; k < 32; k += 2) {
        const a = k * 11.25;                       // 偶数位 = 16 点上的 22.5° 整数倍
        if (compass32(a) !== abbr16[k / 2]) return false;
        if (compass16(a) !== full16[k / 2]) return false;
      }
      return true;
    })(), '16 个 16 点位逐位比对（32 点表偶数位 == 16 点表）');
    push('罗经点边界取最近点（240.5°→SWbW / 16 点为 WSW）', compass32(240.5) === 'SWbW' && compass16(240.5) === '西偏南 WSW', compass32(240.5) + ' / ' + compass16(240.5));
    push('wrap360 后再取点：354°→NbW、-90°→W、359.9°→N', compass32(354) === 'NbW' && compass32(-90) === 'W' && compass32(359.9) === 'N', compass32(354) + ' / ' + compass32(-90) + ' / ' + compass32(359.9));
    return t;
  }
  globalThis.GEOGEO = API;
})();
