/* 经纬度定位工作站 — 地图层（GEOUI_MAP）
 * 只负责「把内核算出来的几何画出来」：离线矢量陆域、经纬网、点位、误差椭圆、
 * 距离圈、扇区、轨迹、晨昏线、天空图。不做任何定位计算。
 * Leaflet 缺失（例如 vendor 文件被删）时降级为可读提示，其余功能照常。
 */
(function (global) {
  'use strict';

  var G = global;
  var state = {
    map: null,
    layers: { base: null, land: null, grid: null, cities: null, results: null, overlay: null, tile: null },
    haveLeaf: false,
    graticule: true,
    citiesOn: false,
    cursorCb: null,
    crossCb: null,
    crossOn: false,
    landBuilt: false,
    tileStat: { loaded: 0, errored: 0 }
  };

  function gg() { return G.GEOGEO || null; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ------------------------------------------------ 初始化 */
  function init(elId) {
    var el = document.getElementById(elId);
    if (!el) return { error: 'no_container' };
    if (typeof G.L === 'undefined' || !G.L.map) {
      el.innerHTML = '<div class="offline-note" style="position:static;margin:16px">' +
        '地图组件 vendor/leaflet.js 未加载：所有数值功能仍可用，只是没有底图。</div>';
      return { error: 'no_leaflet' };
    }
    state.haveLeaf = true;
    var L = G.L;
    state.map = L.map(el, {
      center: [31.2304, 121.4737],
      zoom: 5,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      preferCanvas: true
    });
    state.map.attributionControl.setPrefix('本地内核');
    state.map.on('mousemove', function (e) {
      if (state.cursorCb) state.cursorCb(e.latlng.lat, e.latlng.lng);
    });
    // 准星开着时：点哪儿就把哪儿转到正中（保持缩放），moveend 再刷新读数
    state.map.on('click', function (e) {
      if (!state.crossOn) return;
      state.map.setView(e.latlng, state.map.getZoom(), { animate: true });
    });
    state.map.on('moveend', function () { fireCenter(); });
    for (var k in state.layers) if (k !== 'tile') state.layers[k] = L.layerGroup().addTo(state.map);
    buildLand();
    buildGraticule();
    return { ok: true };
  }

  /* ------------------------------------------------ 离线矢量陆域 */
  // 数据结构（见 app/data/data-land.js 头部说明）：blocks = [块, ...]；块 = [外环, 洞环, ...]；
  // 环 = 扁平数组 [lon,lat,lon,...] 且**不闭合存储**。所以这里要下钻两层，并自己把环首尾接上。
  function buildLand() {
    if (!state.haveLeaf || state.landBuilt) return;
    var D = G.GEODATA;
    if (!D || !D.land || !Array.isArray(D.land.blocks)) return;
    var L = G.L, polys = [];
    var blocks = D.land.blocks;
    for (var i = 0; i < blocks.length; i++) {
      var rings = blocks[i];
      if (!Array.isArray(rings) || !rings.length) continue;
      var poly = [];
      for (var k = 0; k < rings.length; k++) {
        var flat = rings[k];
        if (!Array.isArray(flat) || flat.length < 6) continue;
        var ring = [];
        for (var j = 0; j + 1 < flat.length; j += 2) ring.push([flat[j], flat[j + 1]]); // [lon,lat]
        ring.push(ring[0]);
        poly.push(ring);
      }
      if (poly.length) polys.push(poly);
    }
    state.landPolys = polys.length;
    L.geoJSON({ type: 'MultiPolygon', coordinates: polys }, {
      interactive: false,
      style: { stroke: true, color: cssVar('--land-stroke'), weight: 0.6, fillColor: cssVar('--land'), fillOpacity: 0.85, opacity: 0.9 }
    }).addTo(state.layers.base);
    state.landBuilt = true;
  }

  function cssVar(name) {
    var v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || '#456';
  }

  /* ------------------------------------------------ 经纬网 */
  function buildGraticule() {
    if (!state.haveLeaf) return;
    var L = G.L, g = state.layers.grid;
    g.clearLayers();
    if (!state.graticule) return;
    var step = 10;
    for (var lon = -180; lon <= 180; lon += step) {
      L.polyline([[-85, lon], [85, lon]], { color: cssVar('--grid'), weight: 0.5, interactive: false }).addTo(g);
    }
    for (var lat = -80; lat <= 80; lat += step) {
      L.polyline([[lat, -180], [lat, 180]], { color: cssVar('--grid'), weight: 0.5, interactive: false }).addTo(g);
      L.marker([lat, 180 - step / 2], {
        interactive: false,
        icon: L.divIcon({ className: '', html: '<span style="color:' + cssVar('--fg-dim') + ';font-size:10px">' + lat + '°</span>', iconSize: [30, 12] })
      }).addTo(g);
    }
  }

  /* ------------------------------------------------ 城市注记 */
  var cityCache = null;
  function cityRows() {
    var D = G.GEODATA;
    if (!D || !D.cities || !Array.isArray(D.cities.rows)) return null;
    if (cityCache) return cityCache;
    var f = D.cities.fields, iP = f.indexOf('population'), iZ = f.indexOf('zh_name'), iN = f.indexOf('asciiname');
    var iLat = f.indexOf('lat'), iLon = f.indexOf('lon'), iCc = f.indexOf('cc');
    cityCache = D.cities.rows.map(function (r) {
      return { name: (r[iZ] && String(r[iZ])) || String(r[iN] || ''), lat: r[iLat], lon: r[iLon], pop: r[iP] || 0, cc: r[iCc] };
    });
    return cityCache;
  }

  function buildCities(minPop) {
    if (!state.haveLeaf) return;
    var rows = cityRows();
    state.layers.cities.clearLayers();
    if (!rows || !state.citiesOn) return;
    var L = G.L;
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      if (c.pop < (minPop || 1500000)) continue;
      L.circleMarker([c.lat, c.lon], { radius: 3, color: cssVar('--accent-2'), weight: 1, fillColor: cssVar('--accent-2'), fillOpacity: .5 })
        .bindTooltip(c.name + '（' + c.pop.toLocaleString() + '）', { permanent: false, direction: 'right', className: 'city-tip' })
        .addTo(state.layers.cities);
    }
  }

  /* ------------------------------------------------ 在线底图 */
  function setTiles(on) {
    if (!state.haveLeaf) return { error: 'no_leaflet' };
    var L = G.L;
    if (state.layers.tile) { state.map.removeLayer(state.layers.tile); state.layers.tile = null; }
    state.tileStat.loaded = 0; state.tileStat.errored = 0;
    if (!on) return { ok: true, tiles: false };
    if (!navigator.onLine) return { ok: false, tiles: false, message: '当前离线：在线底图需要网络。矢量陆域仍可用。' };
    state.layers.tile = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© OpenStreetMap（仅联网时加载）'
    });
    state.layers.tile.addTo(state.map);
    // 「layer 加上了」不等于「瓦片真的回来了」：navigator.onLine 只要网卡活着就是 true，
    // 取不到图仍然是一片空白。所以按张计数，让界面能说实话。
    state.tileStat.loaded = 0; state.tileStat.errored = 0;
    state.layers.tile.on('tileload', function () { state.tileStat.loaded++; });
    // 瓦片失败（被墙/断网）不弹错误，只提示
    state.layers.tile.on('tileerror', function () { state.tileStat.errored++; state.layers.tile._errored = true; });
    return { ok: true, tiles: true };
  }

  /* ------------------------------------------------ 结果绘制 */
  function pinIcon(kind) {
    var L = G.L;
    return L.divIcon({ className: '', html: '<div class="pin pin-' + esc(kind) + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  function kindOf(source) {
    var s = String(source || '').toLowerCase();
    if (s.indexOf('gps') >= 0 || s.indexOf('gnss') >= 0 || s.indexOf('nmea') >= 0 || s.indexOf('浏览器') >= 0) return 'me';
    if (s.indexOf('基站') >= 0 || s.indexOf('cell') >= 0 || s.indexOf('lac') >= 0) return 'cell';
    if (s.indexOf('wifi') >= 0 || s.indexOf('指纹') >= 0 || s.indexOf('ble') >= 0 || s.indexOf('信号') >= 0) return 'cell';
    if (s.indexOf('ip') >= 0 || s.indexOf('路由') >= 0 || s.indexOf('联网') >= 0) return 'ip';
    if (s.indexOf('天象') >= 0 || s.indexOf('星') >= 0 || s.indexOf('太阳') >= 0 || s.indexOf('月') >= 0) return 'astro';
    if (s.indexOf('卫星') >= 0 || s.indexOf('sat') >= 0) return 'sat';
    return 'unknown';
  }

  /* items: [{lat,lon,label,source,accuracy_m,note}]
   * extras: {circles:[{lat,lon,r_m,label}], sectors:[{lat,lon,az_deg,beam_deg,r_m,label}],
   *          tracks:[{points:[[lat,lon]],label,dash}], ellipses:[{lat,lon,a_m,b_m,rot_deg,label}],
   *          lines:[{from:[lat,lon],to:[lat,lon],label}], focus:{lat,lon}} */
  function render(items, extras, replace) {
    if (!state.haveLeaf) return { error: 'no_leaflet' };
    var L = G.L, grp = state.layers.results;
    if (replace !== false) grp.clearLayers();
    (items || []).forEach(function (it) {
      if (!it || !isFinite(it.lat) || !isFinite(it.lon)) return;
      var kind = it.kind || kindOf(it.source || it.label);
      L.marker([it.lat, it.lon], { icon: pinIcon(kind) })
        .bindPopup('<b>' + esc(it.label || '结果') + '</b><br>' +
          'lat ' + fmt(it.lat, 6) + '<br>lon ' + fmt(it.lon, 6) +
          (it.accuracy_m != null ? '<br>精度 ≈ ' + fmt(it.accuracy_m, 0) + ' m' : '') +
          (it.note ? '<br><span style="color:#888">' + esc(it.note) + '</span>' : ''))
        .bindTooltip(String(it.label || ''), { direction: 'top', offset: [0, -8] })
        .addTo(grp);
      if (it.accuracy_m > 0) {
        L.circle([it.lat, it.lon], { radius: it.accuracy_m, color: cssVar('--accent'), weight: 1, dashArray: '3,3', fill: false }).addTo(grp);
      }
    });
    var ov = state.layers.overlay;
    ov.clearLayers();
    if (extras) {
      (extras.circles || []).forEach(function (c) {
        if (!isFinite(c.r_m) || c.r_m <= 0) return;
        L.circle([c.lat, c.lon], { radius: c.r_m, color: cssVar('--warn'), weight: 1, fillOpacity: 0.05, dashArray: '4,4' })
          .bindTooltip(c.label || (fmt(c.r_m, 0) + ' m'), { permanent: false }).addTo(ov);
      });
      (extras.sectors || []).forEach(function (s) {
        var pts = sectorPts(s.lat, s.lon, s.az_deg, s.beam_deg || 65, s.r_m || 800);
        L.polygon(pts, { color: cssVar('--warn'), weight: 1, fillColor: cssVar('--warn'), fillOpacity: 0.18 })
          .bindTooltip(s.label || '', { permanent: false }).addTo(ov);
      });
      (extras.tracks || []).forEach(function (t) {
        if (!t.points || t.points.length < 2) return;
        L.polyline(t.points, { color: cssVar('--accent-2'), weight: 2, dashArray: t.dash ? '6,6' : null })
          .bindTooltip(t.label || '轨迹', { permanent: false }).addTo(ov);
      });
      (extras.lines || []).forEach(function (ln) {
        L.polyline([ln.from, ln.to], { color: cssVar('--accent'), weight: 1.2, dashArray: '5,5' })
          .bindTooltip(ln.label || '', { permanent: false }).addTo(ov);
      });
      (extras.ellipses || []).forEach(function (e) {
        var pts = ellipsePts(e);
        if (pts.length) L.polygon(pts, { color: cssVar('--bad'), weight: 1.5, fillColor: cssVar('--bad'), fillOpacity: 0.12 })
          .bindTooltip(e.label || '误差椭圆', { permanent: false }).addTo(ov);
      });
      /* 焦点已经看得见就别动镜头：用户特意缩到全球看晨昏线，下一次点击不该把视野拽回 6 级 */
      if (extras.focus && isFinite(extras.focus.lat) && !state.map.getBounds().contains([extras.focus.lat, extras.focus.lon]))
        fitTo([[extras.focus.lat, extras.focus.lon]], 0);
    }
    return { ok: true, n: (items || []).length };
  }

  function fmt(v, d) { return isFinite(v) ? Number(v).toFixed(d == null ? 4 : d) : '—'; }

  function sectorPts(lat, lon, az, beam, rM) {
    var g = gg(), out = [[lat, lon]];
    var a0 = az - beam / 2, a1 = az + beam / 2, steps = 16;
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * i / steps;
      out.push(destLatLng(lat, lon, a, rM));
    }
    return out;
  }

  function destLatLng(lat, lon, azDeg, distM) {
    var R = 6371008.7714 * 1000, d = distM / R, br = azDeg * Math.PI / 180, p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
    var l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
  }

  function ellipsePts(e) {
    var out = [], n = 48;
    for (var i = 0; i <= n; i++) {
      var t = 2 * Math.PI * i / n;
      var xe = Math.cos(t) * (e.a_m || 0), yn = Math.sin(t) * (e.b_m || 0);
      var rot = (e.rot_deg || 0) * Math.PI / 180;
      var eE = xe * Math.cos(rot) - yn * Math.sin(rot);
      var nN = xe * Math.sin(rot) + yn * Math.cos(rot);
      out.push([e.lat + nN / 110574.276, e.lon + eE / (111319.491 * Math.max(1e-6, Math.cos(e.lat * Math.PI / 180)))]);
    }
    return out;
  }

  /* ------------------------------------------------ 晨昏线（几何精确） */
  /* 加进 overlay 层组：调用顺序必须是「先 render() 再画晨昏线」，否则会被清空。 */
  function nightPolyline(subLon, subLat) {
    if (!state.haveLeaf) return { error: 'no_leaflet' };
    if (!isFinite(subLon) || !isFinite(subLat)) return { error: '日下点经纬度不是数值，画不出晨昏线' };
    var L = G.L, r2 = Math.PI / 180;
    /* 晨昏线 = 与日下点方向正交的大圆。用正交基参数化，而不是 lat(λ)=f(λ) 的显式式子：
       后者在 δ→0（春分/秋分）会除零，而且很容易把 tan 写成乘号——原来就是栽在这里，
       δ=−15.8° 时只画到 16°N，真实交界在 74°N。 */
    var S = [Math.cos(subLat * r2) * Math.cos(subLon * r2), Math.cos(subLat * r2) * Math.sin(subLon * r2), Math.sin(subLat * r2)];
    var A = Math.abs(S[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    var u = nrm(cross(A, S)), v = cross(S, u);
    var pts = [];
    for (var i = 0; i <= 360; i += 2) {
      var t = i * r2, p = [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t), u[2] * Math.cos(t) + v[2] * Math.sin(t)];
      var lat = Math.asin(clamp1(p[2])) * 180 / Math.PI;
      var lon = Math.atan2(p[1], p[0]) * 180 / Math.PI;
      pts.push([Number(lat.toFixed(6)), Number(lon.toFixed(6))]);
    }
    /* 环必须按经度连续展开，否则 atan2 的 ±180° 断点会让连线横穿整张图 */
    pts = unwrapByLon(pts);
    if (pts.length < 3) return { ok: true, n: 0, message: '晨昏线退化（极区全天白/夜）' };
    L.polyline(pts, { color: cssVar('--warn'), weight: 1.2, dashArray: '2,6', interactive: false }).addTo(state.layers.overlay);
    var latMax = 90 - Math.abs(subLat);
    var pole = subLat > 0 ? -1 : 1;
    var cap = pts.map(function (p) { return [pole * latMax, p[1]]; });
    L.polygon(pts.concat(cap.reverse()), { color: 'transparent', fillColor: '#04080f', fillOpacity: 0.28, interactive: false }).addTo(state.layers.overlay);
    var b = extent(pts);
    /* 视野判断要逐点问，不能用外包框：线整体能达到 74°N，但那是别处的经度。 */
    var vb = state.map.getBounds(), inView = 0;
    for (var k = 0; k < pts.length; k++) {
      var wLon = ((pts[k][1] + 540) % 360) - 180;
      if (vb.contains([pts[k][0], wLon])) inView++;
    }
    return { ok: true, n: pts.length, in_view: inView, lat_min: b.lat_min, lat_max: b.lat_max, lon_min: b.lon_min, lon_max: b.lon_max };
  }

  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function nrm(a) { var m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; }
  function clamp1(x) { return x < -1 ? -1 : (x > 1 ? 1 : x); }
  function unwrapByLon(pts) {
    var out = [], prev = pts[0][1];
    for (var i = 0; i < pts.length; i++) {
      var lon = pts[i][1];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
      prev = lon;
      out.push([pts[i][0], lon]);
    }
    return out;
  }
  function extent(pts) {
    var o = { lat_min: 90, lat_max: -90, lon_min: 180, lon_max: -180 };
    pts.forEach(function (p) {
      if (p[0] < o.lat_min) o.lat_min = p[0];
      if (p[0] > o.lat_max) o.lat_max = p[0];
      if (p[1] < o.lon_min) o.lon_min = p[1];
      if (p[1] > o.lon_max) o.lon_max = p[1];
    });
    return o;
  }

  /* ------------------------------------------------ 视野控制 */
  function fitTo(points, pad) {
    if (!state.haveLeaf || !points || !points.length) return;
    var L = G.L;
    if (points.length === 1) { state.map.setView(points[0], Math.max(4, state.map.getZoom() < 6 ? 6 : state.map.getZoom())); return; }
    state.map.fitBounds(L.latLngBounds(points), { padding: [pad || 24, pad || 24] });
  }

  function fitAll() {
    var pts = [], skipped = [];
    var add = function (lat, lng, tag) {
      if (isFinite(lat) && isFinite(lng)) pts.push([lat, lng]);
      else if (skipped.length < 6) skipped.push(tag + '=' + JSON.stringify([lat, lng]));
    };
    state.layers.results.eachLayer(function (m) {
      if (m.getLatLng) { var p = m.getLatLng(); add(p.lat, p.lng, 'point'); }
    });
    state.layers.overlay.eachLayer(function (l) {
      if (l.getLatLng) { var p = l.getLatLng(); add(p.lat, p.lng, 'circle'); }
      else if (l.getLatLngs) {
        // 带洞的多边形（圆环）getLatLngs() 是嵌套数组，直接取 .lat 会得到 undefined
        var flat = [];
        (function walk(a) { a.forEach(function (x) { if (Array.isArray(x)) walk(x); else flat.push(x); }); })(l.getLatLngs());
        flat.forEach(function (p) { add(p.lat, p.lng, (l.constructor && l.constructor.name) || 'ring'); });
      }
    });
    if (!pts.length) { state.map.setView([31.2304, 121.4737], 5); return { n: 0, skipped: skipped }; }
    fitTo(pts);
    return { n: pts.length, skipped: skipped };
  }

  function centerOn(lat, lon, zoom) {
    if (!state.haveLeaf) return;
    state.map.setView([lat, lon], zoom || Math.max(6, state.map.getZoom()));
  }

  function clear() {
    if (!state.haveLeaf) return;
    state.layers.results.clearLayers();
    state.layers.overlay.clearLayers();
  }

  /* ------------------------------------------------ 最近城市（离线反查） */
  function nearestCity(lat, lon, limit) {
    var rows = cityRows();
    if (!rows) return { error: 'no_city_data' };
    var best = [], g = gg();
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i];
      // GEOGEO.haversine 直接返回米（数值），不是 {distance} 对象：读成 .distance 会得到
      // undefined，整个排序退化成 NaN 比较，"最近城市"就变成城市表的前 N 行。
      var hm = g && typeof g.haversine === 'function' ? g.haversine(lat, lon, c.lat, c.lon) : NaN;
      var d = isFinite(hm) ? hm : Math.hypot((c.lat - lat) * 110574.276,
        (c.lon - lon) * 111319.491 * Math.cos(lat * Math.PI / 180));
      if (best.length < (limit || 4)) { best.push({ city: c, km: d / 1000 }); best.sort(function (a, b) { return a.km - b.km; }); }
      else if (d / 1000 < best[best.length - 1].km) { best[best.length - 1] = { city: c, km: d / 1000 }; best.sort(function (a, b) { return a.km - b.km; }); }
    }
    return { list: best.map(function (b) { return { name: b.city.name, cc: b.city.cc, lat: b.city.lat, lon: b.city.lon, pop: b.city.pop, km: b.km }; }) };
  }

  function countryName(cc) {
    var D = G.GEODATA;
    var t = D && D.countries && D.countries[cc];
    return t ? (t.zh || t.en) : cc;
  }

  /* ------------------------------------------------ 天空图（Canvas，与地图无关） */
  function skyPlot(canvas, sats, opts) {
    if (!canvas || !canvas.getContext) return { error: 'no_canvas' };
    var o = opts || {}, ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, R = Math.min(cx, cy) - 26;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = cssVar('--line'); ctx.fillStyle = cssVar('--bg-3');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    [30, 60].forEach(function (el) {
      ctx.beginPath(); ctx.arc(cx, cy, R * el / 90, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = cssVar('--fg-dim'); ctx.font = '10px monospace';
      ctx.fillText(el + '°', cx + R * el / 90 - 8, cy - 3);
    });
    ctx.fillStyle = cssVar('--fg-dim'); ctx.font = '10px monospace';
    ['N', 'E', 'S', 'W'].forEach(function (d, i) {
      var a = (i * 90) * Math.PI / 180;
      ctx.fillText(d, cx + Math.sin(a) * (R + 12) - 4, cy - Math.cos(a) * (R + 12) + 4);
    });
    (sats || []).forEach(function (s) {
      if (!isFinite(s.az) || !isFinite(s.el)) return;
      var r = R * (90 - s.el) / 90;
      var x = cx + r * Math.sin(s.az * Math.PI / 180), y = cy - r * Math.cos(s.az * Math.PI / 180);
      ctx.fillStyle = s.used === false ? cssVar('--bad') : cssVar('--accent');
      ctx.beginPath(); ctx.arc(x, y, 6 + Math.min(6, (s.snr_db || 0) / 10), 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '9px monospace';
      ctx.fillText(String(s.prn || ''), x - 6, y + 3);
    });
    return { ok: true };
  }

  /* ------------------------------------------------ 主题联动 */
  function restyle() {
    if (!state.haveLeaf) return;
    state.layers.base.eachLayer(function (l) {
      if (l.setStyle) l.setStyle({ fillColor: cssVar('--land'), color: cssVar('--land-stroke') });
    });
    buildGraticule();
    buildCities();
    var t = G.GEOUI && G.GEOUI.snapshot ? G.GEOUI.snapshot() : null;
    if (t) render(t.items, t.extras, true);
  }

  function bindCursor(cb) { state.cursorCb = cb; }
  function setGraticule(on) { state.graticule = !!on; buildGraticule(); }
  function setCities(on) { state.citiesOn = !!on; buildCities(); }

  /* ------------------------------------------------ 准星（专门用来确认位置） */
  // 准星是钉在容器正中的 DOM 叠层，不画在地理坐标上：这样它永远严格等于 map.getCenter()，
  // 缩放平移都不会漂。开着准星时点地图任意处 = 把那点转到准星正下方，读数条随之锁定。
  function setCrosshair(on) {
    if (!state.haveLeaf) return { error: 'no_leaflet' };
    state.crossOn = !!on;
    var el = state.map.getContainer();
    var old = el.querySelector('.crosshair');
    if (state.crossOn) {
      if (!old) {
        var d = G.document.createElement('div');
        d.className = 'crosshair';
        d.setAttribute('aria-hidden', 'true');
        d.innerHTML = '<i class="ch-up"></i><i class="ch-down"></i><i class="ch-left"></i><i class="ch-right"></i><i class="ch-ring"></i>';
        el.appendChild(d);
      }
    } else if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    fireCenter();
    var c = state.map.getCenter();
    return { ok: true, on: state.crossOn, lat: c.lat, lon: c.lng, zoom: state.map.getZoom() };
  }
  function fireCenter() {
    if (!state.crossCb || !state.haveLeaf) return;
    var c = state.map.getCenter();
    state.crossCb(c.lat, c.lng, !!state.crossOn);
  }
  function bindCenter(cb) { state.crossCb = cb; fireCenter(); }
  function crosshairOn() { return !!state.crossOn; }
  function centerPoint() {
    if (!state.haveLeaf) return { error: 'no_leaflet' };
    var c = state.map.getCenter();
    return { lat: c.lat, lon: c.lng, zoom: state.map.getZoom() };
  }

  function isReady() { return !!state.haveLeaf; }
  /* 当前视野范围：用来老实说明「画了，但不在你看得见的地方」 */
  function viewBounds() {
    if (!state.haveLeaf) return { error: 'no_leaflet' };
    var b = state.map.getBounds();
    return { lat_min: b.getSouth(), lat_max: b.getNorth(), lon_min: b.getWest(), lon_max: b.getEast() };
  }
  function tileStatus() {
    return { on: !!state.layers.tile, loaded: state.tileStat.loaded, errored: state.tileStat.errored };
  }
  // 给 ⑪ 界面自检用：只说「GEODATA 已加载」不够，必须确认矢量真的挂到了地图上。
  function layerStats() {
    var c = {};
    for (var k in state.layers) {
      var g = state.layers[k];
      if (g && typeof g.getLayers === 'function') c[k] = g.getLayers().length;
    }
    return { ready: !!state.map, land_blocks: state.landPolys || 0, layers: c };
  }

  G.GEOUI_MAP = {
    init: init, render: render, clear: clear, fitAll: fitAll, fitTo: fitTo, centerOn: centerOn,
    setTiles: setTiles, setGraticule: setGraticule, setCities: setCities, nearestCity: nearestCity,
    countryName: countryName, skyPlot: skyPlot, nightPolyline: nightPolyline, restyle: restyle,
    bindCursor: bindCursor, isReady: isReady, tileStatus: tileStatus, viewBounds: viewBounds,
    destLatLng: destLatLng, kindOf: kindOf, esc: esc, layerStats: layerStats,
    setCrosshair: setCrosshair, bindCenter: bindCenter, crosshairOn: crosshairOn, centerPoint: centerPoint
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
