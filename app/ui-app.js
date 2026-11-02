/* 经纬度定位工作站 — 应用外壳（GEOUI）
 * 职责边界：只把六个内核的输出组织成可读的结果，并驱动地图/历史/导出。
 * 这里不做任何定位计算：所有数值都来自 GEOGEO / GEODATUM / GEOCELL / GEOGNSS /
 * GEOASTRO / GEONET；本页找不到内核时显示「内核缺失」，绝不自己凑一个数。
 */
(function (global) {
  'use strict';

  var G = global;
  var DOC = (typeof document !== 'undefined') ? document : null;

  /* ============================================================ 0. 小工具 */
  function $(id) { return DOC && DOC.getElementById ? DOC.getElementById(id) : null; }
  function V(id) { var el = $(id); return el ? String(el.value == null ? '' : el.value).trim() : ''; }
  function N(id) {
    var s = V(id); if (s === '') return null;
    var v = Number(s.replace(/[^\d.eE+\-]/g, ''));
    return isFinite(v) ? v : null;
  }
  function B(id) { var el = $(id); return !!(el && el.checked); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function on(id, ev, fn) {
    var el = $(id);
    if (!el) { miss.push(id); return; }
    el.addEventListener(ev, function (e) {
      try { fn(e); } catch (err) { fatal(id, err); }
    });
  }
  var miss = [];   // 绑定时找不到的元素 id（自检面板会显示，界面不会静默失灵）

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmt(v, d) { return isNum(v) ? Number(v).toFixed(d == null ? 4 : d) : '—'; }
  function m(v, d) { return isNum(v) ? fmt(v, d == null ? 1 : d) + ' m' : '—'; }
  function km(v) { return isNum(v) ? fmt(v / 1000, 3) + ' km' : '—'; }
  function deg(v, d) { return isNum(v) ? fmt(v, d == null ? 6 : d) + '°' : '—'; }
  function pct(v) { return isNum(v) ? fmt(v * 100, 2) + '%' : '—'; }
  function yesno(v) { return v === true ? '<span class="good">是</span>' : v === false ? '<span class="bad">否</span>' : '—'; }

  /* 结果块：一律「键/值」表 + 说明，不写自由发挥的数字 */
  function kv(rows) {
    var h = '<table class="kv">';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      if (r === '-') { h += '</table><table class="kv">'; continue; }
      h += '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>';
    }
    return h + '</table>';
  }
  function h4(t) { return '<h4>' + esc(t) + '</h4>'; }
  function note(t) { return t ? '<div class="note">' + t + '</div>' : ''; }
  function pre(t) { return '<pre>' + esc(t) + '</pre>'; }
  function bad(t) { return '<span class="bad">' + esc(t) + '</span>'; }
  function good(t) { return '<span class="good">' + esc(t) + '</span>'; }
  function warn(t) { return '<span class="warn">' + esc(t) + '</span>'; }

  function put(id, html) {
    var el = $(id);
    if (!el) { miss.push(id); return false; }
    el.innerHTML = html == null ? '' : html;
    return true;
  }
  function putError(id, msg) { put(id, h4('未能得到结果') + note(bad(msg))); }

  function status(text, cls) {
    var el = $('statusText');
    if (!el) return;
    el.textContent = text;
    el.className = cls || '';
  }

  function fatal(where, err) {
    var msg = (err && err.message) ? err.message : String(err);
    status('操作失败（' + where + '）：' + msg, 'bad');
    var box = $('kernelBadge');
    if (box) box.title = '最近异常：' + msg;
  }

  /* 内核存在性：缺哪个就禁用哪个面板，并说清楚 */
  function eng(name) { return G[name] || null; }
  function need(name) {
    var e = eng(name);
    if (!e) { status('内核 ' + name + ' 未加载（检查 app/ 目录）', 'bad'); return null; }
    return e;
  }

  /* ============================================================ 1. 会话状态 */
  var state = {
    solutions: [],        // 本次会话的全部解（总览表格的数据源）
    draw: {},             // 各面板提交的地图要素，按面板名覆盖
    terminator: null,     // {subLon, subLat} 天象面板写入，重绘时补画
    nightOn: false,
    lastNight: null,      // 上一次画晨昏线内核回了什么（点数/范围），用来说明在不在视野里
    lastFix: null,        // GNSS 最近一次解算（供联网升级判定）
    lastSky: null,        // GNSS 最近一次星座（天空图）
    lastScene: null,
    lastNmea: null,
    online: null,         // 最近一次联网融合结果
    batch: null,          // 批处理结果行
    tab: 'overview',
    quick: false
  };

  var LS = { hist: 'llgz.history.v1', fav: 'llgz.fav.v1', prefs: 'llgz.prefs.v1' };
  function lsGet(key, dflt) {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(key) : null;
      if (raw == null) return dflt;
      var v = JSON.parse(raw);
      return v == null ? dflt : v;
    } catch (e) { return dflt; }
  }
  function lsSet(key, val) {
    try {
      if (global.localStorage) { global.localStorage.setItem(key, JSON.stringify(val)); return { ok: true }; }
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    return { ok: false, error: 'localStorage 不可用（隐私模式或 file:// 限制）' };
  }

  /* ============================================================ 2. 地图同步 */
  function mapOf() { return eng('GEOUI_MAP'); }

  function setDraw(panel, payload) {
    state.draw[panel] = payload || null;
    syncMap();
  }

  function snapshot() {
    var items = state.solutions.map(function (s) {
      return { lat: s.lat, lon: s.lon, label: s.label || s.source, source: s.source, accuracy_m: s.accuracy_m, note: s.basis || '', kind: s.kind };
    });
    var extras = { circles: [], sectors: [], tracks: [], lines: [], ellipses: [] };
    for (var k in state.draw) {
      var d = state.draw[k];
      if (!d) continue;
      ['circles', 'sectors', 'tracks', 'lines', 'ellipses'].forEach(function (key) {
        if (Array.isArray(d[key])) extras[key] = extras[key].concat(d[key]);
      });
      if (d.focus && !extras.focus) extras.focus = d.focus;
    }
    return { items: items, extras: extras };
  }

  function syncMap() {
    var MAP = mapOf();
    if (!MAP || !MAP.isReady()) return;
    var snap = snapshot();
    MAP.render(snap.items, snap.extras, true);
    // 没有日下点就不画：拿 0,0 当默认值会画出一条「看起来对」的晨昏线，那是编的
    if (state.nightOn && state.terminator && MAP.nightPolyline) {
      state.lastNight = MAP.nightPolyline(state.terminator.subLon, state.terminator.subLat);
    } else {
      state.lastNight = null;
    }
  }

  function centerOn(lat, lon, zoom) {
    var MAP = mapOf();
    if (MAP && MAP.isReady()) MAP.centerOn(lat, lon, zoom);
  }

  /* ============================================================ 3. 解登记表 */
  var seq = 0;
  function addSolution(sol) {
    if (!sol || !isNum(sol.lat) || !isNum(sol.lon)) return null;
    seq += 1;
    var rec = {
      id: seq, source: sol.source || '未知来源', label: sol.label || sol.source || '解',
      lat: sol.lat, lon: ((sol.lon + 540) % 360) - 180,
      h: isNum(sol.h) ? sol.h : null,
      accuracy_m: isNum(sol.accuracy_m) ? sol.accuracy_m : null,
      sigma_e_m: isNum(sol.sigma_e_m) ? sol.sigma_e_m : null,
      sigma_n_m: isNum(sol.sigma_n_m) ? sol.sigma_n_m : null,
      basis: sol.basis || '', kind: sol.kind || null, ts: new Date().toISOString(), pinned: !!sol.pinned
    };
    state.solutions.push(rec);
    renderSolutions();
    syncMap();
    if (B('histAuto')) recordHistory(rec, '自动');
    status('已登记第 ' + rec.id + ' 号解（' + rec.source + '）', 'ok');
    return rec;
  }

  function fmtRowCells(g, d, lat, lon) {
    var out = [];
    if (!g || !d) return out;
    var inv = d.dmsFormat ? [d.dmsFormat(lat, 'lat', 3).text, d.dmsFormat(lon, 'lon', 3).text].join(' ') : '';
    out.push(inv);
    if (d.mgrsFromLatLon) out.push((d.mgrsFromLatLon(lat, lon, 5) || {}).compact || '');
    if (d.geohashEncode) out.push((d.geohashEncode(lat, lon, 9) || {}).geohash || '');
    return out;
  }

  function renderSolutions() {
    var g = eng('GEOGEO'), d = eng('GEODATUM');
    var el = $('solutionsTable');
    if (!el) { miss.push('solutionsTable'); return; }
    var tb = el.querySelector('tbody') || el;
    var html = '';
    state.solutions.forEach(function (s) {
      var acc = s.accuracy_m != null ? m(s.accuracy_m, 0) : '—';
      var cells = fmtRowCells(g, d, s.lat, s.lon);
      html += '<tr>' +
        '<td>' + s.id + '</td>' +
        '<td>' + esc(s.source) + (s.pinned ? ' ★' : '') + '</td>' +
        '<td class="num">' + fmt(s.lat, 6) + '</td>' +
        '<td class="num">' + fmt(s.lon, 6) + '</td>' +
        '<td class="num">' + acc + '</td>' +
        '<td>' + esc(cells[0] || '') + (s.basis ? '<br><span class="note">' + esc(s.basis) + '</span>' : '') + '</td>' +
        '<td><button data-act="loc" data-id="' + s.id + '">定位</button> ' +
        '<button data-act="del" data-id="' + s.id + '">移除</button></td>' +
        '</tr>';
    });
    tb.innerHTML = html || '<tr><td colspan="7">本次会话还没有解。用上面的按钮或任意面板解算一次。</td></tr>';
    Array.prototype.forEach.call(tb.querySelectorAll('button[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-id'));
        if (btn.getAttribute('data-act') === 'loc') {
          var s = findSol(id);
          if (s) centerOn(s.lat, s.lon, 9);
        } else {
          state.solutions = state.solutions.filter(function (x) { return x.id !== id; });
          renderSolutions(); syncMap(); compareSolutions();
        }
      });
    });
    compareSolutions();
  }

  function findSol(id) {
    for (var i = 0; i < state.solutions.length; i++) if (state.solutions[i].id === id) return state.solutions[i];
    return null;
  }

  /* 会话内多解对比：先给离散度，再给融合点（融合只在一致性检验通过时推荐） */
  function compareSolutions() {
    var g = eng('GEOGEO'), gn = eng('GEOGNSS');
    if (state.solutions.length < 2) {
      put('solutionCompare', state.solutions.length === 1
        ? note('只有 1 个解，无从对比。再解算一次即可比较不同来源的一致性。') : '');
      return;
    }
    if (!g) { putError('solutionCompare', '缺 GEOGEO 内核'); return; }
    var pts = state.solutions.map(function (s) { return { lat: s.lat, lon: s.lon, source: s.source }; });
    var cen = g.centroid ? g.centroid(pts) : null;
    var dists = [];
    for (var i = 0; i < pts.length; i++) {
      for (var j = i + 1; j < pts.length; j++) {
        var iv = g.inverse(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon, 'WGS84');
        if (iv && isNum(iv.distance_m)) dists.push({ a: pts[i].source, b: pts[j].source, d: iv.distance_m });
      }
    }
    var dd = dists.map(function (x) { return x.d; });
    var net = eng('GEONET');
    var med = net && net.median ? net.median(dd) : (dd.length ? dd.sort(function (a, b) { return a - b; })[Math.floor(dd.length / 2)] : null);
    var madv = net && net.mad ? net.mad(dd) : null;
    var rows = [
      ['参与对比的解', pts.length + ' 个（' + esc(pts.map(function (p) { return p.source; }).join('、')) + ')'],
      ['质心', cen && isNum(cen.lat) ? fmt(cen.lat, 6) + ', ' + fmt(cen.lon, 6) : '—'],
      ['两两距离中位数', m(med, 1)],
      ['两两距离 MAD', isNum(madv) ? m(madv, 1) : '—']
    ];
    dists.slice(0, 12).forEach(function (x) {
      rows.push([esc(x.a) + ' ↔ ' + esc(x.b), m(x.d, 1)]);
    });
    var html = h4('解之间的差异') + kv(rows);
    if (gn && gn.fuseSolutions) {
      var list = [];
      state.solutions.forEach(function (s) {
        var sig = s.accuracy_m != null ? s.accuracy_m : (s.sigma_e_m != null ? Math.hypot(s.sigma_e_m, s.sigma_n_m || s.sigma_e_m) / Math.SQRT2 : null);
        if (sig == null) return;   // 没有不确定度就不参与加权融合，避免把未知量当 0
        list.push({ lat: s.lat, lon: s.lon, h: s.h, sigma_m: Math.max(1, sig), source: s.source });
      });
      if (list.length >= 2) {
        var fus = gn.fuseSolutions(list);
        if (fus && isNum(fus.lat)) {
          var c = fus.consistency || {};
          html += h4('加权融合（BLUE）') + kv([
            ['融合点', fmt(fus.lat, 6) + ', ' + fmt(fus.lon, 6) + (isNum(fus.h) ? ', h ' + fmt(fus.h, 1) : '')],
            ['σ_e / σ_n', m(fus.sigma_e_m, 1) + ' / ' + m(fus.sigma_n_m, 1)],
            ['CEP68', m(fus.cep68_m, 1)],
            ['一致性 χ²', isNum(c.chi2) ? fmt(c.chi2, 2) + '（自由度 ' + c.dof + '，p=' + (isNum(c.p_value) ? c.p_value.toExponential(2) : '—') + '）' : '—'],
            ['是否一致', c.inconsistent === false ? good('一致，可取融合点') : (c.inconsistent === true ? warn('不一致') : '—')]
          ]) + note(esc(fus.recommendation || ''));
          (fus.warnings || []).forEach(function (w) { html += note(warn(esc(w))); });
        } else if (fus && fus.error) {
          html += note(bad(esc(fus.error)));
        }
      } else {
        html += note('有 ' + (state.solutions.length - list.length) + ' 个解缺少不确定度，未参与融合（不做「当作 0 m」的假设）。');
      }
    }
    put('solutionCompare', html);
  }

  /* ============================================================ 4. 坐标输入解析 */
  function parseTriple(text) {
    // "lat, lon[, h]" —— 只接受数字，不猜格式
    var parts = String(text || '').split(/[,;\s]+/).filter(function (x) { return x !== ''; });
    var nums = parts.map(Number).filter(isFinite);
    if (nums.length < 2) return { error: '至少需要纬度与经度两个数' };
    var lat = nums[0], lon = nums[1], h = nums.length > 2 ? nums[2] : null;
    if (Math.abs(lat) > 90) { // 常见「先经后纬」写法，交换并说明
      if (Math.abs(lon) <= 90) { var t = lat; lat = lon; lon = t; }
      else return { error: '纬度超出 ±90：' + nums[0] };
    }
    return { lat: lat, lon: ((lon + 540) % 360) - 180, h: h };
  }

  function parseAnyBest(text) {
    var d = eng('GEODATUM');
    if (!d) return { error: '缺 GEODATUM 内核' };
    var r = d.parseAny(text);
    if (!r || !r.candidates || !r.candidates.length) return { error: '无法从这段文本里解析出坐标', detail: r };
    var cs = r.candidates.slice().sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
    // Plus Code 候选只带编码不带经纬度：本地解码补上，否则用户点了也没有位置可定
    cs.forEach(function (c) {
      if (isNum(c.lat) && isNum(c.lon)) return;
      if (c.plus_code && d.olcDecode) {
        var p = d.olcDecode(c.plus_code);
        if (p && isNum(p.lat) && isNum(p.lon)) {
          c.lat = p.lat; c.lon = p.lon;
          c.note = (c.note ? c.note + '；' : '') + 'Plus Code 已本地解码，格宽 ' + fmt(p.resolution_m, 1) + ' m';
          if (p.checksum_valid === false) c.note += '（校验位不符，期望 ' + p.checksum_expected + '）';
        } else c.note = (c.note ? c.note + '；' : '') + 'Plus Code 解码失败：' + (p && p.error ? p.error : '未知');
      }
    });
    return { best: cs[0], candidates: cs, warnings: r.warnings || [], detail: r };
  }

  /* ============================================================ 5. 总览面板 */
  function bindOverview() {
    on('btnWhereAmI', 'click', function () {
      if (!global.navigator || !global.navigator.geolocation) {
        put('whereAmIResult', note(bad('这个浏览器没有 Geolocation API。可用「粘贴坐标」把设备上的坐标贴进来，全部解析仍在本地完成。')));
        return;
      }
      status('正在请求浏览器定位（只有你点击时才会发起）…', 'busy');
      put('whereAmIResult', note('已发起请求，等待系统授权…'));
      global.navigator.geolocation.getCurrentPosition(function (pos) {
        var c = pos.coords;
        showBrowserFix(c, pos);
      }, function (err) {
        var why = err && err.code === 1 ? '你拒绝了定位授权' :
          err && err.code === 2 ? '位置不可用（无 GPS/网络定位源）' :
            err && err.code === 3 ? '请求超时' : '未知错误';
        put('whereAmIResult', note(bad('浏览器定位失败：' + esc(why) + '（code=' + (err ? err.code : '?') + '）。') +
          ' 数值面板全部可用：直接在对应标签页输入观测数据即可，不依赖这一次定位。'));
        status('浏览器定位失败：' + why, 'bad');
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    });

    on('btnPasteFromClip', 'click', function () {
      if (!global.navigator || !global.navigator.clipboard || !global.navigator.clipboard.readText) {
        put('whereAmIResult', note(bad('浏览器未开放剪贴板读取（需要安全上下文与用户手势）。请手动粘贴到右侧输入框。')));
        return;
      }
      global.navigator.clipboard.readText().then(function (txt) {
        var el = $('quickCoord');
        if (el) { el.value = txt; }
        quickGo();
      }, function (e) {
        put('whereAmIResult', note(bad('剪贴板读取被拒绝：' + esc(String(e && e.message || e)) + '。请手动粘贴。')));
      });
    });

    on('btnQuickGo', 'click', quickGo);
    on('quickCoord', 'keydown', function (e) { if (e.key === 'Enter') quickGo(); });
    on('btnAB', 'click', runAB);
  }

  function showBrowserFix(c, pos) {
    var g = eng('GEOGEO'), d = eng('GEODATUM'), MAP = mapOf(), a = eng('GEOASTRO');
    var rows = [
      ['纬度 / 经度', fmt(c.latitude, 6) + ' / ' + fmt(c.longitude, 6)],
      ['浏览器给出的精度', isNum(c.accuracy) ? m(c.accuracy, 0) + '（68% 置信，量级随设备而定）' : '—'],
      ['高度', isNum(c.altitude) ? m(c.altitude, 1) + (c.altitudeAccuracy != null ? '（±' + fmt(c.altitudeAccuracy, 0) + ' m）' : '（不确定度未给出）') : '未提供'],
      ['速度 / 航向', (isNum(c.speed) ? fmt(c.speed * 3.6, 1) + ' km/h' : '—') + ' / ' + (isNum(c.heading) ? deg(c.heading, 1) : '—')],
      ['采集时刻', new Date(pos.timestamp).toLocaleString()]
    ];
    var near = MAP && MAP.nearestCity ? MAP.nearestCity(c.latitude, c.longitude, 3) : null;
    if (near && near.list) {
      rows.push(['离线数据反查（最近城市）', near.list.map(function (x) {
        return esc(x.name) + ' ' + fmt(x.km, 1) + ' km（' + (MAP.countryName ? MAP.countryName(x.cc) : x.cc) + '）';
      }).join('<br>')]);
    }
    if (d && d.outOfChina) rows.push(['是否在中国大陆偏转区', d.outOfChina(c.latitude, c.longitude) ? warn('是：地图底图与 GNSS 坐标差可达数十~数百米') : good('否')]);
    if (d && d.parseAny) {
      var utm = d.utmForward ? d.utmForward(c.latitude, c.longitude, 0) : null;
      if (utm && utm.easting != null) rows.push(['UTM', '第 ' + utm.zone + utm.hemisphere + ' 带 E ' + fmt(utm.easting, 1) + ' N ' + fmt(utm.northing, 1)]);
      if (d.mgrsFromLatLon) rows.push(['MGRS', esc((d.mgrsFromLatLon(c.latitude, c.longitude, 5) || {}).mgrs || '—')]);
      if (d.geohashEncode) rows.push(['Geohash(9)', esc((d.geohashEncode(c.latitude, c.longitude, 9) || {}).geohash || '—')]);
      if (d.olcEncode) rows.push(['Plus Code', esc((d.olcEncode(c.latitude, c.longitude, 11) || {}).code || '—')]);
    }
    if (a) {
      var jd = a.parseTime(new Date().toISOString()).jd;
      var sun = a.sunHorizon ? a.sunHorizon(jd, c.latitude, c.longitude) : null;
      if (sun && isNum(sun.alt_deg)) rows.push(['此刻太阳高度/方位（本地历算）', deg(sun.alt_deg, 2) + ' / ' + deg(sun.az_deg, 2) + (sun.alt_deg > 0 ? '（白天）' : '（夜间）')]);
    }
    put('whereAmIResult', h4('浏览器定位（坐标已在本地反查）') + kv(rows) +
      note('浏览器定位的来源（GPS/基站/Wi-Fi/IP）由浏览器决定，本页无法区分；精度框只是它自报的量级。'));
    addSolution({
      source: '浏览器定位', lat: c.latitude, lon: c.longitude,
      h: isNum(c.altitude) ? c.altitude : null,
      accuracy_m: isNum(c.accuracy) ? c.accuracy : null,
      basis: 'Geolocation API，' + (isNum(c.accuracy) ? '自报精度 ' + Math.round(c.accuracy) + ' m' : '未报精度')
    });
    centerOn(c.latitude, c.longitude, 10);
    status('浏览器定位完成：' + fmt(c.latitude, 5) + ', ' + fmt(c.longitude, 5), 'ok');
  }

  function quickGo() {
    var text = V('quickCoord');
    if (!text) { put('whereAmIResult', note('先在输入框里给一段坐标文本。')); return; }
    var r = parseAnyBest(text);
    if (r.error) { putError('whereAmIResult', r.error + '：' + esc(text)); return; }
    var d = eng('GEODATUM'), html = '';
    html += h4('解析结果（' + r.candidates.length + ' 个候选，按置信度排序）');
    var rows = [];
    r.candidates.slice(0, 6).forEach(function (c, i) {
      rows.push([
        (i === 0 ? good('最佳') : '候选 ' + (i + 1)) + '<br><span class="note">' + esc(c.label || '') + '</span>',
        fmt(c.lat, 6) + ', ' + fmt(c.lon, 6) +
        ' <span class="note">置信 ' + fmt(c.confidence, 2) + (c.crs_guess ? ' / ' + esc(c.crs_guess) : '') + (c.ambiguous ? ' / 有歧义' : '') + '</span>' +
        (c.note ? '<br><span class="note">' + esc(c.note) + '</span>' : '') +
        '<br><button data-pick="' + i + '">用这个（登记为解并定位）</button>'
      ]);
    });
    html += kv(rows);
    (r.warnings || []).forEach(function (w) { html += note(warn(esc(w))); });
    if (r.candidates.length > 1) html += note('同一串文本有多种读法时，本工具不替你选：把它们全部列出，由你按上下文点选。');
    put('whereAmIResult', html);
    pickButtons('whereAmIResult', function (i) {
      var c = r.candidates[i];
      if (!c) return;
      if (!isNum(c.lat) || !isNum(c.lon)) { status('这个候选没有可用的经纬度（' + (c.label || '未知格式') + '），未登记', 'bad'); return; }
      addSolution({ source: '文本解析：' + (c.label || '坐标'), lat: c.lat, lon: c.lon, accuracy_m: null, basis: '原文：' + text });
      centerOn(c.lat, c.lon, 11);
    });
    // 单候选且高置信时直接登记，省一次点击
    if (r.candidates.length === 1 && (r.candidates[0].confidence || 0) >= 0.9 && !r.candidates[0].ambiguous &&
      isNum(r.candidates[0].lat) && isNum(r.candidates[0].lon)) {
      var c0 = r.candidates[0];
      addSolution({ source: '文本解析：' + (c0.label || '坐标'), lat: c0.lat, lon: c0.lon, accuracy_m: null, basis: '原文：' + text });
      centerOn(c0.lat, c0.lon, 11);
    }
  }

  function runAB() {
    var g = eng('GEOGEO');
    if (!g) { putError('abResult', '缺 GEOGEO 内核'); return; }
    var A = parseTriple(V('abA')), Bp = parseTriple(V('abB'));
    if (A.error) { putError('abResult', '起点 A：' + A.error); return; }
    if (Bp.error) { putError('abResult', '终点 B：' + Bp.error); return; }
    var key = V('abEll') || 'WGS84';
    var meth = V('abMethod') || 'auto';
    var html = '';
    var iv = g.geodesic ? g.geodesic(A.lat, A.lon, Bp.lat, Bp.lon, key, meth === 'auto' ? undefined : meth) : g.inverse(A.lat, A.lon, Bp.lat, Bp.lon, key);
    if (iv.error) { putError('abResult', '反算失败：' + esc(iv.error)); return; }
    html += h4('反算 A→B') + kv([
      ['椭球', esc(iv.ellipsoid || key) + (iv.method ? '（' + esc(iv.method) + '）' : '')],
      ['长短轴', isNum(iv.a) ? fmt(iv.a, 3) + ' / ' + fmt(iv.b, 3) : (g.ell && g.ell(key) ? fmt(g.ell(key).a, 3) + ' / ' + fmt(g.ell(key).b, 3) : '—')],
      ['大地线长度', m(iv.distance_m, 3) + ' ＝ ' + km(iv.distance_m) + ' / ' + (isNum(iv.miles) ? fmt(iv.miles, 3) + ' mi' : '—') + ' / ' + (isNum(iv.nautical_miles) ? fmt(iv.nautical_miles, 3) + ' nmi' : '—')],
      ['起点方位角', deg(iv.initial_bearing_deg, 4) + ' ' + (g.compass16 ? esc(g.compass16(iv.initial_bearing_deg)) : '')],
      ['终点方位角', deg(iv.final_bearing_deg, 4)],
      ['中心角', deg(iv.central_angle_deg, 6)],
      ['迭代/收敛', (iv.iterations == null ? '—' : iv.iterations) + ' 次 / ' + yesno(iv.converged) + '，残差 ' + (isNum(iv.residual_m) ? iv.residual_m.toExponential(2) + ' m' : '—')]
    ]);
    var rh = g.rhumbDistance ? g.rhumbDistance(A.lat, A.lon, Bp.lat, Bp.lon, key) : null;
    if (rh && isNum(rh.distance_m)) {
      html += h4('恒向线（等方位角航线）') + kv([
        ['长度', m(rh.distance_m, 1)],
        ['方位角', deg(isNum(rh.bearing_deg) ? rh.bearing_deg : (g.rhumbBearing ? g.rhumbBearing(A.lat, A.lon, Bp.lat, Bp.lon, key) : null), 4)],
        ['与大地线之差', m(rh.distance_m - iv.distance_m, 1) + '（等方位角 ≠ 最短；只有沿赤道或正南北才相等）']
      ]);
    }
    var dr = g.direct ? g.direct(A.lat, A.lon, iv.initial_bearing_deg, iv.distance_m, key) : null;
    if (dr && isNum(dr.lat)) {
      var back = g.inverse(dr.lat, dr.lon, Bp.lat, Bp.lon, key);
      html += h4('往返自检（用上面的方位角+距离正算回 B）') + kv([
        ['正算得 B′', fmt(dr.lat, 6) + ', ' + fmt(dr.lon, 6)],
        ['B′ 与 B 之差', m(back.distance_m, 6) + ' ← 这一步独立复算了反算，两者不符就是公式或常数写错'],
        ['正算方法', esc(dr.method || '')]
      ]);
    }
    var en = g.enuFromDelta ? g.enuFromDelta(A.lat, A.lon, Bp.lat, Bp.lon, A.h || 0, Bp.h || 0, key) : null;
    if (en && isNum(en.e)) {
      html += h4('A 站心 ENU 基线（含高度差）') + kv([
        ['东 / 北 / 天', fmt(en.e, 3) + ' / ' + fmt(en.n, 3) + ' / ' + fmt(en.u, 3) + ' m'],
        ['水平距 / 斜距', m(en.horizontal_m, 3) + ' / ' + m(en.slant_m, 3)],
        ['方位角 / 高度角', deg(en.azimuth_deg, 4) + ' / ' + deg(en.elevation_deg, 4)]
      ]);
    }
    put('abResult', html);
    setDraw('ab', { lines: [{ from: [A.lat, A.lon], to: [Bp.lat, Bp.lon], label: 'A→B ' + km(iv.distance_m) }], focus: null });
  }

  /* ============================================================ 6. 启动 */
  var api = {
    snapshot: snapshot,
    state: state,
    addSolution: addSolution,
    status: status,
    syncMap: syncMap
  };
  G.GEOUI = api;

  /* ============================================================ 7. 通用：候选点选按钮 */
  function pickButtons(boxId, cb) {
    var box = $(boxId);
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('button[data-pick]'), function (btn) {
      btn.addEventListener('click', function () {
        try { cb(Number(btn.getAttribute('data-pick'))); } catch (e) { fatal(boxId, e); }
      });
    });
  }

  /* ============================================================ 8. ② 坐标与格式 */
  function bindCoords() {
    on('btnParseAny', 'click', runParseAny);
    on('coordAny', 'keydown', function (e) { if (e.key === 'Enter') runParseAny(); });
    on('btnParseDemo', 'click', function () {
      var el = $('coordAny');
      if (!el) return;
      el.value = '31°13\'49.44"N 121°28\'25.32"E';
      runParseAny();
    });
    on('btnProject', 'click', runProject);
    on('btnUnProject', 'click', runUtmInverse);
    on('btnMgrsInv', 'click', runMgrsInverse);
    on('btnGhInv', 'click', runGeohashInverse);
    on('btnOlcInv', 'click', runOlcInverse);
    on('btnGcj', 'click', runGcj);
    on('btnDatum', 'click', runDatum);
  }

  function runParseAny() {
    var text = V('coordAny');
    var d = eng('GEODATUM'), g = eng('GEOGEO');
    if (!text) { put('parseResult', note('输入为空。')); return; }
    if (!d) { putError('parseResult', '缺 GEODATUM 内核'); return; }
    var r = d.parseAny(text);
    if (!r || !r.candidates || !r.candidates.length) { putError('parseResult', '没有识别出任何坐标读法（原文 ' + r.input_length + ' 字符）'); return; }
    var rows = [];
    r.candidates.forEach(function (c, i) {
      rows.push([
        (i === 0 ? good('最佳') : '候选 ' + (i + 1)) + '<br><span class="note">' + esc(c.label || '') + '</span>',
        fmt(c.lat, 6) + ', ' + fmt(c.lon, 6) +
        ' <span class="note">置信 ' + fmt(c.confidence, 2) + (c.crs_guess ? ' / ' + esc(c.crs_guess) : '') + ' / 小数位 ' +
        (g ? g.decimalsOf(String(c.lat)) : '—') + '</span>' +
        (c.note ? '<br><span class="note">' + esc(c.note) + '</span>' : '') +
        (c.zone ? '<br><span class="note">UTM ' + c.zone + (c.hemisphere || c.hemi || '') + ' E ' + fmt(c.easting, 1) + ' N ' + fmt(c.northing, 1) + (c.cell_m ? '（格 ' + c.cell_m + ' m）' : '') + '</span>' : '') +
        '<br><button data-pick="' + i + '">登记为解</button>' +
        (c.needs_online ? '<button data-online="' + i + '">联网补全短码</button>' : '')
      ]);
    });
    var html = h4('候选读法（本工具不替你决定歧义）') + kv(rows);
    (r.warnings || []).forEach(function (w) { html += note(warn(esc(w))); });
    if (g) {
      var best = r.candidates[0];
      var extra = [];
      if (d.dmsFormat) extra.push(['度分秒', esc(d.dmsFormat(best.lat, 'lat', 3).text) + '<br>' + esc(d.dmsFormat(best.lon, 'lon', 3).text)]);
      if (d.ddmFormat) extra.push(['度分', esc(d.ddmFormat(best.lat, 'lat')) + '<br>' + esc(d.ddmFormat(best.lon, 'lon'))]);
      var pr = g.precisionOf ? g.precisionOf(best.lat, best.lon, 'WGS84') : null;
      if (pr) extra.push(['按输入小数位的量级', esc(pr.note || '') + '（' + pr.decimals + ' 位小数 ≈ ' + m(pr.worst_m, 2) + '）' + '<br><span class="note">取 min(纬度位, 经度位)：任一位写得粗，整个坐标就粗</span>']);
      if (extra.length) html += h4('换算与有效位') + kv(extra);
    }
    put('parseResult', html);
    pickButtons('parseResult', function (i) {
      var c = r.candidates[i];
      addSolution({ source: '解析：' + (c.label || '坐标'), lat: c.lat, lon: c.lon, basis: '原文 ' + text });
      centerOn(c.lat, c.lon, 12);
    });
    Array.prototype.forEach.call(($('parseResult') || { querySelectorAll: function () { return []; } }).querySelectorAll('button[data-online]'), function (btn) {
      btn.addEventListener('click', function () {
        put('parseResult', html + note('短码补全需要一个参考位置：在「②」下方用 UTM/Plus Code 反算，或先输入一个同区域的完整坐标。「需要联网」只指这一点——本工具的 Plus Code 编解码全在本地。'));
      });
    });
  }

  function runProject() {
    var d = eng('GEODATUM'), g = eng('GEOGEO');
    var lat = Number(V('pjLat')), lon = Number(V('pjLon'));
    if (!isNum(lat) || !isNum(lon)) { putError('projectResult', '纬度/经度不是数字'); return; }
    if (Math.abs(lat) > 90) { putError('projectResult', '纬度超出 ±90'); return; }
    var zone = N('pjZone') || 0;
    var html = '';
    if (!d) { putError('projectResult', '缺 GEODATUM 内核'); return; }
    if (Math.abs(lat) > 84) {
      var ups = d.upsForward(lat, lon);
      html += h4('UPS（|纬度|>84°，极地方位投影）') + kv([
        ['东 / 北', fmt(ups.easting, 2) + ' / ' + fmt(ups.northing, 2)],
        ['ρ / 余纬格值', fmt(ups.rho, 2) + ' m / ' + ups.colat_grid],
        ['长度比 k', fmt(ups.k, 6)],
        ['EPSG', ups.epsg],
        ['说明', esc(ups.note || '')]
      ]);
    } else {
      var u = d.utmForward(lat, lon, zone);
      html += h4('UTM') + kv([
        ['带号 / 中央经线', u.zone + (u.hemisphere || '') + ' / ' + u.cm_used + '°' + (zone ? '' : '（自动）')],
        ['东伪距 / 北伪距', fmt(u.easting, 3) + ' / ' + fmt(u.northing, 3)],
        ['长度比 k', fmt(u.k, 8) + '（中央经线上恒为 0.9996；带缘 ≈ 1.001）'],
        ['收敛角 γ', deg(u.gamma, 4) + '（网格北 − 真北；改正读数用）'],
        ['假东 / 假北', u.false_easting + ' / ' + (u.hemisphere === 'S' ? 10000000 : 0)]
      ]);
      var rt = d.utmInverse(u.easting, u.northing, u.zone, u.hemisphere);
      html += note('往返自检：反算得 ' + fmt(rt.lat, 7) + ', ' + fmt(rt.lon, 7) + '，与原值差 ' +
        (g ? m(g.inverse(lat, lon, rt.lat, rt.lon, 'WGS84').distance_m, 6) : '—') + '。');
    }
    var mg = d.mgrsFromLatLon(lat, lon, 5);
    html += h4('MGRS') + kv([
      ['分组写法', esc(mg.mgrs)],
      ['紧凑写法', esc(mg.compact)],
      ['带 / 区间 / 双字母', mg.zone + ' / ' + esc(mg.band) + ' / ' + esc(mg.col) + mg.row],
      ['格内 100 km 坐标', fmt(mg.east100k, 1) + ' / ' + fmt(mg.north100k, 1) + '（' + mg.digits + ' 位 → ' + mg.cell_m + ' m 网格）']
    ]);
    var gh = d.geohashEncode(lat, lon, 9);
    html += h4('Geohash') + kv([
      ['9 位编码', esc(gh.geohash)],
      ['格子尺寸', m(gh.cell_lat_m, 1) + ' × ' + m(gh.cell_lon_m, 1)],
      ['最大误差', m(Math.max(gh.error_lat_m || 0, gh.error_lon_m || 0), 1) + '（取格中心时的位置误差上界）']
    ]);
    var olc = d.olcEncode(lat, lon, 11);
    html += h4('Plus Code（本工具实现）') + kv([
      ['11 位', esc(olc.code)],
      ['含校验位', esc(olc.code_local) + '（校验位方案为本工具自定，非 Google 官方）'],
      ['格子尺寸', m(olc.resolution_m, 2)]
    ]);
    var wm = d.webMercatorForward(lat, lon);
    html += h4('Web 墨卡托 / 度分秒') + kv([
      ['EPSG:3857', fmt(wm.x, 3) + ' / ' + fmt(wm.y, 3)],
      ['DMS', esc(d.dmsFormat(lat, 'lat', 2).text) + ' ' + esc(d.dmsFormat(lon, 'lon', 2).text)],
      ['1° 对应的米', g ? m(g.metersPerDegree(lat, 'WGS84').lat_m, 2) + ' / ' + m(g.metersPerDegree(lat, 'WGS84').lon_m, 2) : '—']
    ]);
    put('projectResult', html);
  }

  function runUtmInverse() {
    var d = eng('GEODATUM'), g = eng('GEOGEO');
    var e = Number(V('upE')), n = Number(V('upN'));
    var z = Number(V('upZone')) || 1, hemi = V('upHemi') || 'N';
    if (!(isNum(e) && isNum(n))) { putError('projectResult', 'UTM 数值非法'); return; }
    var r = d.utmInverse(e, n, z, hemi);
    if (!isNum(r.lat)) { putError('projectResult', esc(r.error || 'UTM 反算失败')); return; }
    var html = h4('UTM 反算') + kv([
      ['经纬度', fmt(r.lat, 7) + ', ' + fmt(r.lon, 7)],
      ['带 / 半球 / 中央经线', r.zone + ' / ' + r.hemisphere + ' / ' + r.cm_used + '°'],
      ['收敛角 γ', isNum(r.gamma) ? deg(r.gamma, 4) : '—']
    ]);
    var fwd = d.utmForward(r.lat, r.lon, r.zone);
    html += note('往返自检：重新正算 E ' + fmt(fwd.easting, 4) + ' N ' + fmt(fwd.northing, 4) + '，与输入差 ' +
      fmt(Math.abs(fwd.easting - e), 4) + ' / ' + fmt(Math.abs(fwd.northing - n), 4) + ' m。');
    put('projectResult', html);
    addSolution({ source: 'UTM 反算', lat: r.lat, lon: r.lon, basis: 'UTM ' + r.zone + r.hemisphere + ' E' + e + ' N' + n });
    centerOn(r.lat, r.lon, 11);
  }

  function runMgrsInverse() {
    var d = eng('GEODATUM');
    var r = d.latLonFromMgrs(V('mgrsIn'));
    if (!isNum(r.lat)) { putError('projectResult', esc(r.error || 'MGRS 反算失败')); return; }
    var back = d.mgrsFromLatLon(r.lat, r.lon, r.digits || 5);
    var html = h4('MGRS 反算') + kv([
      ['经纬度（格中心）', fmt(r.lat, 6) + ', ' + fmt(r.lon, 6)],
      ['带 / 区间 / 双字母', r.zone + ' / ' + r.band + ' / ' + r.col + r.row],
      ['格内东 / 北', fmt(r.easting, 1) + ' / ' + fmt(r.northing, 1)],
      ['格宽（精度位）', r.cell_m + ' m（' + r.digits + ' 位）'],
      ['西南角', fmt(r.cell_sw.easting, 0) + ' / ' + fmt(r.cell_sw.northing, 0)]
    ]) + note('往返自检：重编得 ' + esc(back.compact) + '，与输入 ' + esc(V('mgrsIn').replace(/\s/g, '')) + ' ' +
      (back.compact === V('mgrsIn').replace(/\s/g, '').toUpperCase() ? good('一致') : bad('不一致（位数或写法差异，见上）')));
    put('projectResult', html);
    addSolution({ source: 'MGRS 反算', lat: r.lat, lon: r.lon, accuracy_m: r.cell_m / Math.SQRT2, basis: 'MGRS ' + V('mgrsIn') });
    centerOn(r.lat, r.lon, 12);
  }

  function runGeohashInverse() {
    var d = eng('GEODATUM');
    var r = d.geohashDecode(V('ghIn'));
    if (!isNum(r.lat)) { putError('projectResult', esc(r.error || 'Geohash 反算失败')); return; }
    put('projectResult', h4('Geohash 反算') + kv([
      ['中心', fmt(r.lat, 7) + ', ' + fmt(r.lon, 7)],
      ['范围', fmt(r.bbox.lat_min, 6) + '~' + fmt(r.bbox.lat_max, 6) + ' / ' + fmt(r.bbox.lon_min, 6) + '~' + fmt(r.bbox.lon_max, 6)],
      ['格子', m(r.cell_lat_m, 2) + ' × ' + m(r.cell_lon_m, 2)],
      ['位置误差上界', m(Math.hypot(r.error_lat_m, r.error_lon_m), 2) + '（取中心时对角落的最大偏差）'],
      ['位数', r.precision]
    ]));
    addSolution({ source: 'Geohash 反算', lat: r.lat, lon: r.lon, accuracy_m: Math.hypot(r.error_lat_m, r.error_lon_m), basis: 'Geohash ' + V('ghIn') });
    centerOn(r.lat, r.lon, 13);
  }

  function runOlcInverse() {
    var d = eng('GEODATUM');
    var raw = V('olcIn');
    var r = d.olcDecode(raw);
    if (!isNum(r.lat)) {
      // 短码需要参考点：用当前会话最近的解，没有就明确要求补全
      var ref = state.solutions.length ? state.solutions[state.solutions.length - 1] : null;
      if (!ref) { putError('projectResult', esc(r.error || 'Plus Code 解码失败') + '；短码必须给参考位置（先登记一个同区域的解）。'); return; }
      var rec = d.olcRecover(raw, ref.lat, ref.lon);
      if (!isNum(rec.lat)) { putError('projectResult', esc(rec.error || '短码补全失败')); return; }
      put('projectResult', h4('Plus Code 短码补全') + kv([
        ['参考点', fmt(ref.lat, 6) + ', ' + fmt(ref.lon, 6) + '（第 ' + ref.id + ' 号解）'],
        ['补全结果', esc(rec.code || '') + ' → ' + fmt(rec.lat, 6) + ', ' + fmt(rec.lon, 6)]
      ]));
      addSolution({ source: 'Plus Code 短码', lat: rec.lat, lon: rec.lon, accuracy_m: rec.resolution_m || null, basis: '相对第 ' + ref.id + ' 号解补全' });
      return;
    }
    put('projectResult', h4('Plus Code 反算') + kv([
      ['中心', fmt(r.lat, 7) + ', ' + fmt(r.lon, 7)],
      ['角点', fmt(r.corner.lat, 7) + ', ' + fmt(r.corner.lon, 7) + '（西南角）'],
      ['格尺寸', m(r.resolution_m, 2) + '（' + r.length + ' 位）'],
      ['校验位', r.checksum_valid === true ? good('自洽（本工具方案）') : r.checksum_valid === false ? warn('不符：' + esc(r.checksum_note || '')) : '未附校验位'],
      ['范围', fmt(r.bbox.lat_min, 6) + '~' + fmt(r.bbox.lat_max, 6) + ' / ' + fmt(r.bbox.lon_min, 6) + '~' + fmt(r.bbox.lon_max, 6)]
    ]) + note('校验位方案是本工具自定义的，与 Google 官方不同：换工具时不要指望这一段字符互通。'));
    addSolution({ source: 'Plus Code 反算', lat: r.lat, lon: r.lon, accuracy_m: r.resolution_m, basis: 'OLC ' + raw });
    centerOn(r.lat, r.lon, 13);
  }

  function runGcj() {
    var d = eng('GEODATUM'), g = eng('GEOGEO');
    var from = V('gcjFrom'), to = V('gcjTo');
    var cur = state.solutions.length ? state.solutions[state.solutions.length - 1] : null;
    var lat = cur ? cur.lat : 31.2304, lon = cur ? cur.lon : 121.4737;
    if (from === to) { putError('gcjResult', '源与目标相同，无需转换。'); return; }
    var p = { lat: lat, lon: lon };
    var step = [];
    var wgs = from === 'WGS84' ? { lat: lat, lon: lon } : d.toWgs84({ lat: lat, lon: lon }, from);
    if (!wgs || !isNum(wgs.lat)) { putError('gcjResult', esc((wgs && wgs.error) || '无法把源坐标转到 WGS84')); return; }
    step.push(['→ WGS84', fmt(wgs.lat, 7) + ', ' + fmt(wgs.lon, 7)]);
    var dst = to === 'WGS84' ? { lat: wgs.lat, lon: wgs.lon } : d.fromWgs84(wgs.lat, wgs.lon, to);
    if (!dst || !isNum(dst.lat)) { putError('gcjResult', esc((dst && dst.error) || '无法从 WGS84 转到目标')); return; }
    step.push(['WGS84 → ' + esc(to), fmt(dst.lat, 7) + ', ' + fmt(dst.lon, 7)]);
    var shift = g.inverse(wgs.lat, wgs.lon, dst.lat, dst.lon, 'Sphere').distance_m;
    var html = h4(from + ' → ' + to) + kv([
      ['输入点（' + (cur ? '第 ' + cur.id + ' 号解' : '默认上海') + '）', fmt(lat, 7) + ', ' + fmt(lon, 7)],
      ['换算路径', step.map(function (s) { return s[0] + '：' + s[1]; }).join('<br>')],
      ['偏移量级', m(shift, 1) + '（仅示意，随位置变化数十~数百米）'],
      ['是否在中国大陆', d.outOfChina(lat, lon) ? warn('在偏转区外：GCJ-02/BD-09 只是恒等变换') : good('在偏转区内')]
    ]) + note('GCJ-02 的加偏函数不可逆，「反算」用的是迭代逼近，残差见下。');
    if (to !== 'WGS84') {
      var back = d.toWgs84({ lat: dst.lat, lon: dst.lon }, to);
      html += kv([['迭代反算回 WGS84', fmt(back.lat, 7) + ', ' + fmt(back.lon, 7)],
      ['与原 WGS84 之差', m(g.inverse(wgs.lat, wgs.lon, back.lat, back.lon, 'Sphere').distance_m, 4)]]);
    }
    put('gcjResult', html);
  }

  function runDatum() {
    var g = eng('GEOGEO'), d = eng('GEODATUM');
    var a = V('datumSel'), b = V('datumSel2');
    var cur = state.solutions.length ? state.solutions[state.solutions.length - 1] : { lat: 31.2304, lon: 121.4737, h: 12 };
    var p = {
      dx: N('dDx') || 0, dy: N('dDy') || 0, dz: N('dDz') || 0,
      rx: N('dRx') || 0, ry: N('dRy') || 0, rz: N('dRz') || 0,
      s: N('dDs') || 0,
      convention: V('dConv') || 'position-vector'
    };
    if (!g) { putError('datumResult', '缺 GEOGEO 内核'); return; }
    var r1 = g.datumShift7(cur.lat, cur.lon, cur.h || 0, p);
    if (r1.error) { putError('datumResult', esc(r1.error)); return; }
    var neg = { dx: -p.dx, dy: -p.dy, dz: -p.dz, rx: -p.rx, ry: -p.ry, rz: -p.rz, s: -p.s, convention: p.convention };
    var r2 = g.datumShift7(r1.lat, r1.lon, r1.h, neg);
    var shift = g.inverse(cur.lat, cur.lon, r1.lat, r1.lon, 'WGS84').distance_m;
    var html = h4('布尔莎 7 参数（源 ' + esc(a) + ' → 目标 ' + esc(b) + '）') + kv([
      ['输入', fmt(cur.lat, 7) + ', ' + fmt(cur.lon, 7) + ', h ' + fmt(cur.h || 0, 2)],
      ['参数', '平移 ' + p.dx + ' / ' + p.dy + ' / ' + p.dz + ' m，旋转 ' + p.rx + ' / ' + p.ry + ' / ' + p.rz + ' ″，尺度 ' + p.s + ' ppm'],
      ['约定', esc(p.convention) + '（' + (p.convention === 'position-vector' ? '位置矢量：旋转取负' : '坐标轴旋转：旋转取正') + '）'],
      ['输出', fmt(r1.lat, 7) + ', ' + fmt(r1.lon, 7) + ', h ' + fmt(r1.h, 3)],
      ['平面偏移量级', m(shift, 3)],
      ['ECEF', fmt(r1.ecef.x, 3) + ', ' + fmt(r1.ecef.y, 3) + ', ' + fmt(r1.ecef.z, 3)]
    ]) + h4('往返自检') + kv([
      ['用符号相反的参数量回去', fmt(r2.lat, 9) + ', ' + fmt(r2.lon, 9)],
      ['与输入之差', m(g.inverse(cur.lat, cur.lon, r2.lat, r2.lon, 'WGS84').distance_m, 6) + ' ← 不为 0 就是旋转/尺度符号约定写错']
    ]);
    if (a !== b) html += note(warn('下拉里的基准名只是标签：真正的参数要你填进来。内核不会因为「选了 CGCS2000」就替你猜一组参数。'));
    put('datumResult', html);
  }

  /* ============================================================ 9. ③ 基站定位 */
  function cellOpts() {
    var o = {};
    if (V('cellModel')) o.model = V('cellModel');
    if (V('cellEnv')) o.environment = V('cellEnv');
    if (isNum(N('cellFreq'))) o.freq_mhz = N('cellFreq');
    if (isNum(N('cellEirp'))) o.tx_power_dbm = N('cellEirp');
    return o;
  }

  function runCell() {
    var c = eng('GEOCELL');
    if (!c) { putError('cellResult', '缺 GEOCELL 内核'); return; }
    var parsed = c.parseInput(V('cellInput'));
    if (!parsed || !parsed.towers || !parsed.towers.length) {
      putError('cellStations', '没有解析出任何基站'); putError('cellResult', '输入既不是 JSON，也没有可识别的基站文本行');
      return;
    }
    var towers = parsed.towers;
    var o = cellOpts();
    var rows = [];
    towers.forEach(function (t, i) {
      var rng = c.rssiToDistance(t.rssi_dbm != null ? t.rssi_dbm : t.rsrp_dbm, Object.assign({}, o, {
        freq_mhz: t.freq_mhz || o.freq_mhz, tx_power_dbm: t.tx_power_dbm || o.tx_power_dbm,
        timing_advance: t.timing_advance, rat: t.rat
      }));
      var r = rangeOf(c, t, o);
      // operatorName() 返回的是 {operator, country, mcc, mnc, iso2} 对象，直接拼进字符串会打成 [object Object]；
      // normalizeTower 已把查表结果写进 t.network，这里只在它为空时补一句「运营商未知」。
      var who = t.network || (t.mcc == null && t.mnc == null ? '无 MCC/MNC' : '运营商未知（查表未命中）');
      rows.push([
        (i + 1) + '. ' + esc(t.label || ''),
        'MCC ' + t.mcc + ' / MNC ' + t.mnc + ' / LAC ' + t.lac + ' / CI ' + t.ci + (t.cid_hex ? '（hex ' + t.cid_hex + '）' : '') +
        '<br>' + esc(who) + ' · ' + esc(t.rat || '') +
        (t.arfcn != null ? ' · ARFCN/EARFCN ' + t.arfcn + (t.freq_mhz ? ' → ' + fmt(t.freq_mhz, 1) + ' MHz' : '') : '') +
        '<br>信号 ' + (t.rssi_dbm != null ? t.rssi_dbm + ' dBm' : t.rsrp_dbm + ' dBm') +
        (t.timing_advance != null ? ' · TA ' + t.timing_advance : '') +
        (t.lat != null ? '<br>坐标 ' + fmt(t.lat, 5) + ', ' + fmt(t.lon, 5) : '<br><span class="warn">无坐标</span>') +
        (r && r.range_m != null ? '<br>估距 ' + m(r.range_m, 0) + '（' + esc(r.how || '') + (isNum(r.sigma_m) ? '，σ ' + fmt(r.sigma_m, 0) + ' m' : '') + '）' : '') +
        (rng && rng.clamped ? '<br><span class="note">' + esc(rng.clamped_reason) + '</span>' : '')
      ]);
    });
    put('cellStations', h4('基站清单（' + towers.length + ' 个）') + kv(rows) +
      (parsed.warnings || []).map(function (w) { return note(warn(esc(w))); }).join(''));

    // 地图：距离圈 + 扇区
    var circles = [], sectors = [];
    towers.forEach(function (t) {
      if (!isNum(t.lat) || !isNum(t.lon)) return;
      var r = rangeOf(c, t, o);
      if (r && isNum(r.range_m)) circles.push({ lat: t.lat, lon: t.lon, r_m: r.range_m, label: esc(t.label || '') + ' ' + m(r.range_m, 0) });
      if (isNum(t.azimuth)) sectors.push({ lat: t.lat, lon: t.lon, az_deg: t.azimuth, beam_deg: t.beamwidth || 65, r_m: r && r.range_m ? r.range_m : 800, label: '扇区 ' + esc(t.label || '') });
    });
    var sol = c.trilaterate(towers, o);
    var html = '';
    if (sol.ok && isNum(sol.lat)) {
      html += h4('多边定位结果') + kv([
        ['位置', fmt(sol.lat, 6) + ', ' + fmt(sol.lon, 6)],
        ['方法', esc(sol.method) + '（' + sol.n_used + ' 站参与，' + sol.n_rejected + ' 站剔除，' + sol.iterations + ' 次迭代）'],
        ['残差 RMS', m(sol.residual_rmse_m, 1) + '，最大 ' + m(sol.max_residual_m, 1)],
        ['不确定半径', m(sol.confidence_radius_m, 1)],
        ['误差椭圆', isNum(sol.ellipsis.semi_major_m) ? '长半轴 ' + m(sol.ellipsis.semi_major_m, 1) + '，短半轴 ' + m(sol.ellipsis.semi_minor_m, 1) + '，方位 ' + deg(sol.ellipsis.orientation_deg, 1) : '—'],
        ['GDOP', isNum(sol.gdop) ? fmt(sol.gdop, 2) : '—'],
        ['估距依据', (sol.estimated_from || []).map(function (s) { return esc(s); }).join('<br>')]
      ]);
      setDraw('cell', {
        circles: circles, sectors: sectors,
        ellipses: isNum(sol.ellipsis.semi_major_m) ? [{ lat: sol.lat, lon: sol.lon, a_m: sol.ellipsis.semi_major_m, b_m: sol.ellipsis.semi_minor_m || 1, rot_deg: sol.ellipsis.orientation_deg || 0, label: '基站定位误差椭圆' }] : [],
        focus: null
      });
      addSolution({ source: '基站定位', lat: sol.lat, lon: sol.lon, accuracy_m: sol.confidence_radius_m, sigma_e_m: sol.ellipsis.semi_major_m, sigma_n_m: sol.ellipsis.semi_minor_m, basis: 'LTE/GSM 多边定位，RMS ' + (isNum(sol.residual_rmse_m) ? Math.round(sol.residual_rmse_m) + ' m' : '—') });
      centerOn(sol.lat, sol.lon, 12);
    } else {
      html += h4('无法给出位置') + kv([
        ['原因', (sol.warnings || []).map(function (w) { return warn(esc(w)); }).join('<br>') || '未知'],
        ['已算出的量', circles.length ? '每个基站的估距与覆盖圆（已画在图上）' : '只有基站识别，没有距离'],
        ['还缺什么', warn('基站经纬度：请补充「手工坐标」或在 JSON 里给 lat/lon（基站坐标来自运营商城管数据，本机无法凭空生成）')]
      ]);
      setDraw('cell', { circles: circles, sectors: sectors });
    }
    (sol.warnings || []).forEach(function (w) { html += note(warn(esc(w))); });
    html += note('RSSI→距离是链路预算估计，不是测量：模型给出的 σ 就是它自己的不确定度，不要把 ' + m(sol.confidence_radius_m || 0, 0) + ' 当成精度承诺。');
    put('cellResult', html);
    state.lastCell = sol;
  }

  /* 单站估距：显式 range_m > 定时提前 > RSSI 链路预算（制式不同，TA 的位长不同） */
  function rangeOf(c, t, o) {
    if (isNum(t.range_m)) return { range_m: t.range_m, how: '显式给定', sigma_m: null };
    var rat = String(t.rat || o.rat || '').toLowerCase();
    if (isNum(t.timing_advance)) {
      var perBit = /gsm|cdma/.test(rat) ? 554.69 : (/wcdma|umts|hsdpa/.test(rat) ? 39.06 : 78.17);
      var info = (c.RAT_INFO || {})[rat];
      return { range_m: t.timing_advance * perBit, how: '定时提前 ' + t.timing_advance + ' × ' + perBit + ' m' + (info ? '（' + info.name + '）' : '（制式未识别，按 LTE 步长 78.17 m 假定）'), sigma_m: perBit / 2 };
    }
    var rssi = t.rssi_dbm != null ? t.rssi_dbm : t.rsrp_dbm;
    if (!isNum(rssi)) return { range_m: null, how: '无信号量', sigma_m: null };
    var r = c.rssiToDistance(rssi, Object.assign({}, o, { freq_mhz: t.freq_mhz || o.freq_mhz, tx_power_dbm: t.tx_power_dbm || o.tx_power_dbm, rat: rat }));
    return { range_m: r.dist_m, how: (r.model || 'log-distance') + ' ' + rssi + ' dBm', sigma_m: r.sigma_m };
  }

  function runCellKnown() {
    var c = eng('GEOCELL');
    var text = V('cellKnown');
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)
      .filter(function (s) { return !/^[#;]/.test(s); });
    if (!lines.length) { putError('cellKnownResult', '没有内容。格式：ci = lat, lon[, 方位角, 波束宽]'); return; }
    var parsed = c.parseInput(V('cellInput'));
    var towers = parsed.towers || [];
    var keys = towers.map(function (t) {
      var hex = t.cid_hex ? String(t.cid_hex).toLowerCase() : null;
      if (t.ci == null) return hex || '(无名基站)';
      return hex ? t.ci + '（' + hex + '）' : String(t.ci);
    });
    var applied = [], errors = [];
    lines.forEach(function (ln) {
      var m1 = ln.match(/^([0-9A-Fa-f]+|\d+(?::\d+)?)\s*=\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([-\d.]+)\s*,\s*([-\d.]+))?$/);
      if (!m1) { errors.push('无法识别：' + ln); return; }
      var key = m1[1].toLowerCase(), lat = Number(m1[2]), lon = Number(m1[3]);
      if (!isFinite(lat) || !isFinite(lon)) { errors.push('坐标非法：' + ln); return; }
      var hit = null;
      towers.forEach(function (t) {
        // 只有 cid_hex 没有 ci 的基站，t.ci 是 null；不判空就会在 .toLowerCase() 上抛
        var tk = t.ci == null ? null : String(t.ci).toLowerCase();
        var combo = (t.lac == null || t.ci == null) ? null : String(t.lac) + ':' + tk;
        var hx = t.cid_hex ? String(t.cid_hex).toLowerCase() : null;
        if (key === tk || key === combo || (hx && key === hx)) hit = t;
      });
      if (!hit) { errors.push('当前基站清单里没有 ' + m1[1] + '；清单现有 ' + (keys.length ? keys.join('、') : '（空）')); return; }
      hit.lat = lat; hit.lon = ((lon + 540) % 360) - 180;
      if (m1[4]) hit.azimuth = Number(m1[4]);
      if (m1[5]) hit.beamwidth = Number(m1[5]);
      applied.push(m1[1] + ' → ' + fmt(hit.lat, 6) + ', ' + fmt(hit.lon, 6));
    });
    put('cellKnownResult', h4('补充了 ' + applied.length + ' 个基站坐标') +
      kv(applied.map(function (x) { return ['已应用', esc(x)]; }).concat(errors.map(function (e) { return ['未匹配', bad(esc(e))]; }))) +
      note('补充后请再点一次「解算基站位置」。'));
    if (applied.length) runCell();
  }

  /* ============================================================ 10. ④ 三角定位 */
  function runTriBear() {
    var c = eng('GEOCELL'), g = eng('GEOGEO');
    if (!c) { putError('triBearResult', '缺 GEOCELL 内核'); return; }
    var sig = N('triSigma') || 2;
    var obs = [];
    [['triP1', 'triB1'], ['triP2', 'triB2'], ['triP3', 'triB3']].forEach(function (pair, i) {
      var p = parseTriple(V(pair[0])), az = N(pair[1]);
      if (p.error || az == null) return;
      // bearing_sigma_deg 是「每条观测」的字段，不是全局选项：不同目标的照准精度本来就该不同
      obs.push({ lat: p.lat, lon: p.lon, azimuth_deg: az, bearing_sigma_deg: sig, label: '地标 ' + (i + 1) });
    });
    if (obs.length < 2) { putError('triBearResult', '至少要两组「参考点 + 方位角」；第三组用于多余观测检核。'); return; }
    var r = c.triangulateBearings(obs, {});
    if (!r.ok || !isNum(r.lat)) {
      putError('triBearResult', (r.warnings || []).join('；') || '方位交会无解（观测方向平行或参考点共线）');
      return;
    }
    var lines = obs.map(function (o) {
      var far = g.direct(o.lat, o.lon, o.azimuth_deg, 25000, 'WGS84');
      return { from: [o.lat, o.lon], to: [far.lat, far.lon], label: '观测方位 ' + fmt(o.azimuth_deg, 2) + '°' };
    });
    var cand = (r.candidates || []).map(function (p, i) {
      return '支 ' + (i + 1) + '：' + fmt(p.lat, 6) + ', ' + fmt(p.lon, 6) + '（权重 ' + fmt(p.weight, 3) + '）';
    }).join('<br>');
    put('triBearResult', h4('方位交会') + kv([
      ['待定点', fmt(r.lat, 6) + ', ' + fmt(r.lon, 6)],
      ['方法', esc(r.method) + '（' + r.n_used + ' 条方位，' + r.iterations + ' 次迭代，σ=' + fmt(sig, 1) + '°/条）'],
      ['角残差 / 距离残差', fmt(r.residual_rmse_m, 1) + ' m 等效 / 最大 ' + m(r.max_residual_m, 1)],
      ['不确定半径', m(r.confidence_radius_m, 1)],
      ['GDOP', isNum(r.gdop) ? fmt(r.gdop, 2) : '—（两条方位线交会不给几何因子，第三条以上才有）'],
      ['候选支', cand || '—'],
      ['各站→点的反方位', obs.map(function (o) {
        var iv = g.inverse(o.lat, o.lon, r.lat, r.lon, 'WGS84');
        return esc(o.label) + '：观测 ' + fmt(o.azimuth_deg, 2) + '°，反算 ' + fmt(iv.initial_bearing_deg, 2) + '°，差 ' + fmt(wrap180v(iv.initial_bearing_deg - o.azimuth_deg), 2) + '° = ' + fmt(wrap180v(iv.initial_bearing_deg - o.azimuth_deg) * iv.distance_m * Math.PI / 180, 0) + ' m 横向（边长 ' + m(iv.distance_m, 0) + '）';
      }).join('<br>')]
    ]) + (r.warnings || []).map(function (w) { return note(warn(esc(w))); }).join('') +
      note('两条方位线交点的误差由「测角精度 × 边长」决定：σ=1° 时 10 km 外就是约 175 m 的横向误差。方位必须统一成「站→目标」，否则残差会落在反向延长线上。'));
    setDraw('tri', { lines: lines, circles: [{ lat: r.lat, lon: r.lon, r_m: r.confidence_radius_m || 0, label: '方位交会不确定圆' }], focus: null });
    addSolution({ source: '方位交会', lat: r.lat, lon: r.lon, accuracy_m: r.confidence_radius_m, basis: r.n_used + ' 条方位角交会' });
    centerOn(r.lat, r.lon, 10);
  }

  function wrap180v(x) { var v = ((x + 540) % 360) - 180; return v; }

  function runTriRange() {
    var c = eng('GEOCELL'), g = eng('GEOGEO');
    if (!c) { putError('triRangeResult', '缺 GEOCELL 内核'); return; }
    var lines = V('triRanges').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var towers = [], errors = [];
    lines.forEach(function (ln, i) {
      if (/^[#;]/.test(ln)) return;   // 注释行里往往也带数字，不跳就会被当成第 4、第 5 个参考圆
      var p = parseTriple(ln);
      if (p.error) { errors.push('第 ' + (i + 1) + ' 行：' + p.error); return; }
      var parts = ln.split(/[,;\s]+/).filter(Boolean).map(Number);
      if (parts.length < 3) { errors.push('第 ' + (i + 1) + ' 行缺距离'); return; }
      towers.push({ lat: p.lat, lon: p.lon, range_m: parts[2], label: '参考 ' + (i + 1), accuracy_m: N('triRangeSigma') || 30 });
    });
    if (towers.length < 2) { putError('triRangeResult', '至少 2 个「纬度,经度,距离」。' + errors.join('；')); return; }
    var o = B('triLSQ') ? { weighted: true } : { method: 'pairwise' };
    var r = c.trilaterate(towers, o);
    if (!r.ok || !isNum(r.lat)) {
      putError('triRangeResult', (r.warnings || []).join('；') || '距离交会无解（圆不相交或近似共线）');
      return;
    }
    var inter = towers.length >= 2 ? g.circleIntersection({ lat: towers[0].lat, lon: towers[0].lon }, towers[0].range_m, { lat: towers[1].lat, lon: towers[1].lon }, towers[1].range_m) : null;
    var html = h4('距离交会 / 多边定位') + kv([
      ['位置', fmt(r.lat, 6) + ', ' + fmt(r.lon, 6)],
      ['方法', esc(r.method) + '，' + r.n_used + ' 个圆参与'],
      ['残差 RMS', m(r.residual_rmse_m, 1) + '，最大 ' + m(r.max_residual_m, 1)],
      ['不确定半径', m(r.confidence_radius_m, 1)],
      ['GDOP', isNum(r.gdop) ? fmt(r.gdop, 2) : '—'],
      ['前两圆解析交点', inter && inter.ok ? (inter.points || inter.candidates || []).map(function (p) { return fmt(p.lat, 6) + ', ' + fmt(p.lon, 6); }).join('　或　') : warn((inter && inter.reason) || '不相交：两距离与站间距不满足三角不等式')]
    ]);
    if (towers.length >= 4 && B('triLSQ')) {
      var gd = c.gdopFromGeometry(towers.map(function (t) { return { lat: t.lat, lon: t.lon }; }), [r.lat, r.lon]);
      html += h4('几何因子（将参考点当作观测站）') + kv([
        ['GDOP / PDOP / HDOP', fmt(gd.gdop, 2) + ' / ' + fmt(gd.pdop, 2) + ' / ' + fmt(gd.hdop, 2)],
        ['条件数', isNum(gd.condition_number) ? fmt(gd.condition_number, 1) : '—']
      ]) + (gd.warnings || []).map(function (w) { return note(warn(esc(w))); }).join('');
    }
    html += (r.warnings || []).map(function (w) { return note(warn(esc(w))); }).join('');
    html += note('圆相交有两个解时，内核用其余圆选出物理上更合理的一支；只有两个圆时必须由你判断取舍。');
    put('triRangeResult', html);
    setDraw('tri', {
      circles: towers.map(function (t) { return { lat: t.lat, lon: t.lon, r_m: t.range_m, label: esc(t.label) + ' ' + m(t.range_m, 0) }; }),
      ellipses: isNum(r.ellipsis.semi_major_m) ? [{ lat: r.lat, lon: r.lon, a_m: r.ellipsis.semi_major_m, b_m: r.ellipsis.semi_minor_m || 1, rot_deg: r.ellipsis.orientation_deg || 0, label: '距离交会误差椭圆' }] : []
    });
    addSolution({ source: '距离交会', lat: r.lat, lon: r.lon, accuracy_m: r.confidence_radius_m, sigma_e_m: r.ellipsis.semi_major_m, sigma_n_m: r.ellipsis.semi_minor_m, basis: towers.length + ' 个距离圆' });
    centerOn(r.lat, r.lon, 10);
  }

  function runTriBack() {
    var g = eng('GEOGEO'), c = eng('GEOCELL');
    var p = parseTriple(V('triUnknown'));
    if (p.error) { putError('triBackResult', '待定点：' + p.error); return; }
    var refs = V('triRanges').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)
      .filter(function (s) { return !/^[#;]/.test(s); })
      .map(parseTriple).filter(function (x) { return !x.error; });
    if (!refs.length) { putError('triBackResult', '先在 B 栏里给参考点。'); return; }
    var rows = refs.map(function (o, i) {
      var iv = g.inverse(p.lat, p.lon, o.lat, o.lon, 'WGS84');
      return ['→ 参考 ' + (i + 1) + '（' + fmt(o.lat, 4) + ', ' + fmt(o.lon, 4) + '）',
        m(iv.distance_m, 1) + '，方位 ' + deg(iv.initial_bearing_deg, 3) + ' ' + esc(g.compass16(iv.initial_bearing_deg)) + '，回方位 ' + deg(iv.final_bearing_deg, 3)];
    });
    put('triBackResult', h4('待定点 ' + fmt(p.lat, 6) + ', ' + fmt(p.lon, 6) + ' 到各参考点') + kv(rows) +
      note('这些距离/方位就是 B/A 栏的观测量：把它填回去可以做「已知点求待定点」的闭合检核。'));
    setDraw('tri-back', { lines: refs.map(function (o, i) { return { from: [p.lat, p.lon], to: [o.lat, o.lon], label: '到参考 ' + (i + 1) }; }) });
  }

  /* ============================================================ 11. ⑤ 信号测距 */
  function sigOpts() {
    var o = {};
    if (V('sigModel')) o.model = V('sigModel');
    if (V('sigEnv')) o.environment = V('sigEnv');
    if (isNum(N('sigFreq'))) o.freq_mhz = N('sigFreq');
    if (isNum(N('sigN'))) o.exponent = N('sigN');
    if (isNum(N('sigFspl'))) o.path_loss_at_1m_db = N('sigFspl');
    if (isNum(N('sigTx'))) o.tx_power_dbm = N('sigTx');
    return o;
  }

  /* 参考距离损耗：模型有「有效下限」，1 m 不在域内时内核会截断，这里如实显示截断后的距离 */
  function refLossAt(c, o, d) {
    var r = c.distanceToRssi(d, o);
    return { dist_m: r.dist_m, path_loss_db: r.path_loss_db, clamped: r.clamped, reason: r.clamped_reason };
  }

  function runSigRssi() {
    var c = eng('GEOCELL');
    if (!c) { putError('sigRssiResult', '缺 GEOCELL 内核'); return; }
    var rssi = N('sigRssi');
    if (rssi == null) { putError('sigRssiResult', 'RSSI 未填'); return; }
    var o = sigOpts();
    var r = c.rssiToDistance(rssi, o);
    var back = c.distanceToRssi(r.dist_m, o);
    var ref = refLossAt(c, o, 1);
    var gn = eng('GEOGNSS');
    var lambda = gn && gn.wavelengthM ? gn.wavelengthM(r.freq_mhz) : null;
    var html = h4('RSSI → 距离') + kv([
      ['模型', esc(r.model || '') + '（' + esc(modelName(c, r.model)) + '）' + (r.environment ? ' · 环境 ' + esc(r.environment) : '')],
      ['频率 / 有效指数', fmt(r.freq_mhz, 1) + ' MHz / ' + fmt(r.exponent, 3) + '（n=2 为自由空间，室内常 2.7~4）'],
      ['EIRP', fmt(r.eirp_dbm, 1) + ' dBm（发射功率 + 天线增益）'],
      [ref.dist_m === 1 ? '1 m 参考损耗' : '参考损耗（' + fmt(ref.dist_m, 0) + ' m，模型下限）',
        fmt(ref.path_loss_db, 2) + ' dB' + (N('sigFspl') ? '（已由你输入 ' + fmt(N('sigFspl'), 2) + ' dB 覆盖）' : '') +
        (isNum(ref.path_loss_db) && isNum(r.path_loss_db) && ref.dist_m > 0 ? ' → 该点路损比参考点大 ' + fmt(r.path_loss_db - ref.path_loss_db, 2) + ' dB' : '') +
        (ref.clamped ? ' ' + warn(esc(ref.reason)) : '')],
      ['路损', fmt(r.path_loss_db, 2) + ' dB'],
      ['距离', m(r.dist_m, 1) + (r.clamped ? ' ' + warn('已截断：' + esc(r.clamped_reason)) : '')],
      ['σ（模型自报）', m(r.sigma_m, 1) + '（阴影衰减的标准差折算，不是「测量精度」）'],
      ['波长', isNum(lambda) ? fmt(lambda * 1000, 2) + ' mm（λ=' + fmt(lambda, 5) + ' m）' : '—']
    ]) + h4('往返自检') + kv([
      ['用该距离反推 RSSI', fmt(back.rssi_dbm, 3) + ' dBm（输入 ' + rssi + '）'],
      ['差值', fmt(Math.abs(back.rssi_dbm - rssi), 6) + ' dB ← 不为 0 就是模型实现与自身定义矛盾']
    ]);
    if (r.clamped) html += note(warn('结果被模型有效域截断，' + fmt(r.dist_m, 0) + ' m 是边界值而不是估计值。'));
    put('sigRssiResult', html);
  }

  function runSigInv() {
    var c = eng('GEOCELL');
    var dist = N('sigDist');
    if (dist == null) { putError('sigRssiResult', '目标距离未填'); return; }
    var o = sigOpts();
    var r = c.distanceToRssi(dist, o);
    var back = c.rssiToDistance(r.rssi_dbm, o);
    var n = isNum(r.exponent) ? r.exponent : (o.exponent || 2.7);
    put('sigRssiResult', h4('距离 → 期望 RSSI') + kv([
      ['距离', m(dist, 1) + (r.clamped ? ' ' + warn(esc(r.clamped_reason)) : '')],
      ['模型', esc(r.model || '') + '（' + esc(modelName(c, r.model)) + '）· 期望 n ' + fmt(n, 2)],
      ['模型路损', fmt(r.path_loss_db, 2) + ' dB（EIRP ' + fmt(r.eirp_dbm, 1) + ' dBm）'],
      ['期望 RSSI', fmt(r.rssi_dbm, 2) + ' dBm'],
      ['往返自检', m(back.dist_m, 3) + '（与输入差 ' + fmt(Math.abs(back.dist_m - dist), 4) + ' m）'],
      ['实测比期望弱 6 dB 时', '按 n=' + fmt(n, 2) + ' 外推为 ' + fmt(dist * Math.pow(10, 6 / (10 * n)), 1) + ' m（×' + fmt(Math.pow(10, 6 / (10 * n)), 2) + '）'],
      ['实测比期望弱 10 dB 时', '按 n=' + fmt(n, 2) + ' 外推为 ' + fmt(dist * Math.pow(10, 10 / (10 * n)), 1) + ' m（×' + fmt(Math.pow(10, 1 / n), 2) + '）']
    ]) + note('「弱多少 dB → 远多少倍」只是把缺口全记在自由空间模型上的说法，多径和遮挡会让它错得很离谱：真正能用的判据是同一位置多次扫描的分布，不是单次读数。'));
  }

  function modelName(c, id) {
    var mm = (c && c.MODELS) || {};
    return (mm[id] && mm[id].name) || id || '—';
  }

  function runFingerprint() {
    var c = eng('GEOCELL');
    if (!c) { putError('sigFpResult', '缺 GEOCELL 内核'); return; }
    var fps, scan;
    try { fps = JSON.parse(V('fpRef')); } catch (e) { putError('sigFpResult', '指纹库不是合法 JSON：' + esc(e.message)); return; }
    try { scan = JSON.parse(V('fpScan')); } catch (e) { putError('sigFpResult', '现场扫描不是合法 JSON：' + esc(e.message)); return; }
    var sim = V('fpMethod') || 'cosine';
    var r = c.fingerprintMatch(fps, scan, { k: N('fpK') || 3, similarity: sim });
    if (!isNum(r.lat)) { putError('sigFpResult', esc(r.warning || '指纹库里没有一个 AP 在现场出现，无法定位')); return; }
    var rows = (r.matched || []).map(function (x) {
      return [esc(x.label || '指纹'), '得分 ' + fmt(x.score, 4) + ' · 公共 AP ' + x.common_ap + ' 个 · 距加权中心 ' + m(x.dist_m, 1)];
    });
    put('sigFpResult', h4('指纹匹配') + kv([
      ['位置', fmt(r.lat, 6) + ', ' + fmt(r.lon, 6)],
      ['相似度 / 融合', esc(sim) + ' → ' + esc(r.method || 'knn')],
      ['置信', m(r.confidence_m, 1) + '（= 参与点围绕加权中心的加权 RMS 距离）'],
      ['现场 AP', (scan || []).length + ' 个，其中 ' + (r.matched || []).filter(function (x) { return x.common_ap > 0; }).length + ' 个在库中有重叠']
    ].concat(rows)) + (r.warning ? note(warn(esc(r.warning))) : '') +
      note('指纹库覆盖不到的区域不会有可靠结果：置信量级来自匹配点之间的实际间距，与 RSSI 精确度无关。'));
    setDraw('signal', { circles: [{ lat: r.lat, lon: r.lon, r_m: r.confidence_m || 0, label: '指纹置信圈' }], focus: null });
    addSolution({ source: 'Wi-Fi 指纹', lat: r.lat, lon: r.lon, accuracy_m: r.confidence_m, basis: (r.matched || []).length + ' 个参考点加权' });
    centerOn(r.lat, r.lon, 16);
  }

  function runBle() {
    var c = eng('GEOCELL');
    var r = c.bleProximity(N('bleRssi'), { measured_power_dbm: N('bleTx'), exponent: N('bleN') });
    if (!isNum(r.dist_m)) { putError('sigFpResult', esc(r.error || 'BLE 估距失败')); return; }
    put('sigFpResult', h4('BLE 邻近估距') + kv([
      ['距离', m(r.dist_m, 2) + '（σ ' + m(r.sigma_m, 2) + '）'],
      ['置信档', esc(r.confidence || '—')],
      ['模型', esc(r.note || '')]
    ]) + note('iBeacon 单点估距对多径极敏感：' + m(r.dist_m, 1) + ' 只是量级，不能当作「几米精度」。'));
  }

  function runTdoa() {
    var c = eng('GEOCELL');
    if (!c) { putError('tdoaResult', '缺 GEOCELL 内核'); return; }
    var obj;
    try { obj = JSON.parse(V('tdoaInput')); } catch (e) { putError('tdoaResult', '输入不是合法 JSON：' + esc(e.message)); return; }
    var anchor = Array.isArray(obj.anchor) ? { lat: obj.anchor[0], lon: obj.anchor[1], h: obj.anchor[2], label: '参考站' } : obj.anchor;
    var stations = (obj.stations || []).map(function (s, i) {
      var ns = isNum(s.ns) ? s.ns : (isNum(s.tdoa_s) ? s.tdoa_s * 1e9 : null);
      return { lat: s.lat, lon: s.lon, label: s.label || ('站 ' + (i + 1)), ns: ns, tdoa_s: isNum(s.tdoa_s) ? s.tdoa_s : (isNum(ns) ? ns * 1e-9 : null) };
    });
    var all = [anchor].concat(stations);
    // 内核按「观测数组与站点数组同长、下标 0 是参考站且时差恒为 0」处理，所以这里必须补 0
    var tdoa = [0].concat(stations.map(function (s) { return s.tdoa_s; }));
    if (stations.filter(function (s) { return isNum(s.tdoa_s); }).length < 2) {
      putError('tdoaResult', '至少要 2 条时差观测量（ns 或 tdoa_s），加参考站共 3 个站才有唯一解。');
      return;
    }
    var r = c.multilaterateTDOA(all, tdoa, { sigma_m: N('tdoaSigma') || undefined });
    if (!r.ok || !isNum(r.lat)) { putError('tdoaResult', (r.warnings || []).join('；') || 'TDOA 解算失败'); return; }
    var html = h4('TDOA 双曲线定位') + kv([
      ['位置', fmt(r.lat, 6) + ', ' + fmt(r.lon, 6)],
      ['参考站', esc(anchor.label || '') + '（时差下标 0，恒为 0 ns）'],
      ['时差→距离差', stations.map(function (s) { return isNum(s.ns) ? esc(s.label) + '：' + fmt(s.ns, 1) + ' ns → ' + m(c.tdoaDistanceFromNs(s.ns), 1) + '（本站比参考站' + (s.ns > 0 ? '远' : '近') + '）' : esc(s.label) + '：缺时差观测量'; }).join('<br>')],
      ['符号约定', 'tdoa = (本站距离 − 参考站距离)/c；正＝更远'],
      ['残差 RMS', m(r.residual_rmse_m, 1) + '，最大 ' + m(r.max_residual_m, 1)],
      ['GDOP', isNum(r.gdop) ? fmt(r.gdop, 2) : '—'],
      ['不确定半径', m(r.confidence_radius_m, 1)],
      ['另一支解', (r.candidates || []).length > 1 ? r.candidates.slice(1).map(function (p) { return fmt(p.lat, 6) + ', ' + fmt(p.lon, 6); }).join('　') : '双曲线组只给出一个可行支']
    ]);
    html += (r.warnings || []).map(function (w) { return note(warn(esc(w))); }).join('');
    html += note('TDOA 需要站间时钟同步（GPS 共视或 802.11 帧间计时）；ns 级同步误差直接换算成约 0.3 m/ns 的距离误差。' +
      '内核用切平面线性化，基线越长（>50 km）地球曲率的系统差越明显：本站演示用 ~10 km 基线。');
    put('tdoaResult', html);
    setDraw('tdoa', {
      circles: stations.filter(function (s) { return isNum(s.ns); }).map(function (s) {
        var dd = c.tdoaDistanceFromNs(s.ns) + geo(all[0], s);
        return { lat: s.lat, lon: s.lon, r_m: Math.max(1, dd), label: esc(s.label) + ' 双曲线等效圆 r₀+Δr' };
      }), focus: null
    });
    addSolution({ source: 'TDOA', lat: r.lat, lon: r.lon, accuracy_m: r.confidence_radius_m, basis: stations.length + ' 条时差' });
    centerOn(r.lat, r.lon, 9);
  }

  function geo(a, b) {
    var g = eng('GEOGEO');
    if (!g || !a || !b) return 0;
    return g.inverse(a.lat, a.lon, b.lat, b.lon, 'WGS84').distance_m;
  }

  /* ============================================================ 12. ③④⑤ 面板绑定 */
  /* 内置样例的 TA/RSSI 由「先定一个待定点、再用内核自己的口径反推」得到（推导脚本 app/_build/make-samples.mjs；
     app/_build/ 是开发目录，被 .gitignore 排除，clone 之后看不到它，样例数据本身随包发布）。
     手写 TA 曾经让「样例：GSM 定时提前」一点就解出 100 km 外的坐标：三站基线才 3 km，TA=66 格却是 37 km。 */
  var CELL_SAMPLES = {
    btnCellDemo1: {
      operator: 'China Mobile', towers: [
        { mcc: 460, mnc: 0, tac: 33262, ci: 1154321, rat: 'LTE', arfcn: 1650, pci: 213, rssi: -55, timing_adv: 13, lat: 31.2331, lon: 121.4690, azimuth: 120 },
        { mcc: 460, mnc: 0, tac: 33262, ci: 1154322, rat: 'LTE', arfcn: 1650, pci: 214, rssi: -58, timing_adv: 18, lat: 31.2214, lon: 121.4856, azimuth: 300 },
        { mcc: 460, mnc: 0, tac: 33263, ci: 998811, rat: 'LTE', arfcn: 900, pci: 101, rssi: -58, timing_adv: 18, lat: 31.2452, lon: 121.4848 }
      ]
    },
    btnCellDemo2: {
      operator: 'China Unicom', towers: [
        { mcc: 460, mnc: 1, lac: 21044, ci: 5311, rat: 'GSM', arfcn: 68, rssi: -53, timing_adv: 3, lat: 31.1980, lon: 121.4430 },
        { mcc: 460, mnc: 1, lac: 21044, ci: 5312, rat: 'GSM', arfcn: 75, rssi: -50, timing_adv: 2, lat: 31.2126, lon: 121.4672 },
        { mcc: 460, mnc: 1, lac: 21051, ci: 7702, rat: 'GSM', arfcn: 33, rssi: -58, timing_adv: 5, lat: 31.1842, lon: 121.4715 }
      ]
    },
    btnCellDemo3: {
      operator: 'China Telecom', towers: [
        { mcc: 460, mnc: 11, tac: 40112, ci: 500000001, rat: 'NR', freq_mhz: 3500, arfcn: 641280, rssi: -63, timing_adv: 17, lat: 31.2404, lon: 121.4837, azimuth: 35, beamwidth: 120 },
        { mcc: 460, mnc: 11, tac: 40112, ci: 500000002, rat: 'NR', freq_mhz: 3500, arfcn: 641280, rssi: -66, timing_adv: 24, lat: 31.2256, lon: 121.4602, azimuth: 215, beamwidth: 120 },
        { mcc: 460, mnc: 11, tac: 40119, ci: 500000108, rat: 'NR', freq_mhz: 3600, arfcn: 643280, rssi: -67, timing_adv: 28, lat: 31.2519, lon: 121.4521, azimuth: 150, beamwidth: 90 }
      ]
    }
  };

  function bindCell() {
    on('btnCellSolve', 'click', runCell);
    Object.keys(CELL_SAMPLES).forEach(function (id) {
      on(id, 'click', function () {
        var el = $('cellInput');
        if (!el) { miss.push('cellInput'); return; }
        el.value = JSON.stringify(CELL_SAMPLES[id], null, 1);
        runCell();
      });
    });
    on('btnCellKnown', 'click', runCellKnown);
  }

  function bindTri() {
    on('btnTriBear', 'click', runTriBear);
    on('btnTriRange', 'click', runTriRange);
    on('btnTriBack', 'click', runTriBack);
  }

  function bindSignal() {
    on('btnSigRssi', 'click', runSigRssi);
    on('btnSigInv', 'click', runSigInv);
    on('btnFingerprint', 'click', runFingerprint);
    on('btnBle', 'click', runBle);
    on('btnTdoa', 'click', runTdoa);
  }

  /* ============================================================ 13. ⑥ GNSS */
  function bindGnss() {
    on('btnNmeaDecode', 'click', runNmea);
    on('btnGpsSolve', 'click', runGpsSolve);
    on('btnSkyPlot', 'click', runSky);
    on('btnRelFix', 'click', runRelative);
    on('btnAtm', 'click', runAtmosphere);
    on('btnPppMsg', 'click', runPpp);
  }

  /* NMEA 逐句解码 + 合并。严格模式由外壳实现：内核 mergeNmea 一律「按原文解析」，
     校验和只标注不丢弃；勾选后外壳把 checksum_ok===false 的句子剔掉再合并。 */
  function runNmea() {
    var g = eng('GEOGNSS');
    if (!g) { putError('nmeaResult', '缺 GEOGNSS 内核'); return; }
    var raw = V('nmeaInput');
    var lines = String(raw).split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s && !/^[#;]/.test(s); });
    if (!lines.length) { putError('nmeaResult', '文本框是空的。粘贴设备输出的 NMEA，或点「载入样例」。'); return; }
    var strict = B('nmeaStrict');
    var dec = lines.map(function (ln) { return { line: ln, d: g.decodeNmea(ln) }; });
    var keptLines = dec.filter(function (x) { return !x.d.error && (!strict || x.d.checksum_ok !== false); }).map(function (x) { return x.line; });
    var m = g.mergeNmea(keptLines);
    var tz = N('nmeaTz');
    var rows = dec.map(function (x) {
      var d = x.d;
      if (d.error) return [esc(x.line.slice(0, 46)), bad(esc(d.error))];
      var extra = '';
      if (d.type === 'GGA') extra = fmt(d.lat, 5) + ', ' + fmt(d.lon, 5) + ' · 星 ' + d.sats + ' · HDOP ' + fmt(d.hdop, 2) + ' · 椭球高 ' + fmt(d.alt, 1) + ' m' + (isNum(d.geoid_sep) ? ' · N ' + fmt(d.geoid_sep, 1) : '');
      else if (d.type === 'RMC') extra = (d.status_text || d.status || '') + ' · 速度 ' + fmt(d.sog_knots, 1) + ' kn / ' + fmt(d.sog_mps, 2) + ' m/s · 航向 ' + fmt(d.cog_deg, 1) + '° · 日期 ' + esc(d.date && d.date.iso ? d.date.iso : (d.date ? d.date.raw || '—' : '—'));
      else if (d.type === 'GSA') extra = '定位类型 ' + esc(d.fix_type_text || '') + ' · 用星 ' + d.satellites_used + ' · PDOP ' + fmt(d.pdop, 2) + ' HDOP ' + fmt(d.hdop, 2) + ' VDOP ' + fmt(d.vdop, 2);
      else if (d.type === 'GST') extra = 'RMS ' + fmt(d.rms, 2) + ' m · 长轴 ' + fmt(d.semi_major_m, 2) + ' × 短轴 ' + fmt(d.semi_minor_m, 2) + ' m @ ' + fmt(d.orientation_deg, 1) + '°';
      else if (d.type === 'VTG') extra = '真航向 ' + fmt(d.cog_true_deg, 1) + '° · ' + fmt(d.sog_kmh, 2) + ' km/h（' + fmt(d.sog_mps, 3) + ' m/s）· ' + esc(d.pos_type || '');
      else if (d.type === 'GSV') extra = '本句 ' + (d.satellites || []).length + ' 颗 · 视野内共 ' + d.sats_in_view_total + ' 颗 · 字段步长 ' + d.field_stride;
      return [esc(d.talker || '') + ' ' + esc(d.type || '') + ' ' + esc(x.line.slice(0, 30)),
        (d.checksum_ok === true ? good('校验和 ✓') : d.checksum_ok === false ? bad('校验和 ✗（输入 ' + hexOf(d.checksum_input) + '，算得 ' + hexOf(d.checksum_computed) + '）' + (strict ? ' 已丢弃' : ' 仍按原文解析')) : warn('无校验和字段')) +
        (extra ? '<br><span class="note">' + extra + '</span>' : '')];
    });
    var html = h4('逐句解码（' + dec.length + ' 行，保留 ' + keptLines.length + ' 行）') + kv(rows);

    var f = m.fix || {};
    html += h4('合并后的定位') + kv([
      ['经纬度', isNum(f.lat) ? fmt(f.lat, 6) + ', ' + fmt(f.lon, 6) : warn('语句里没有定位句（GGA/RMC/GLL/GNS）')],
      ['质量', esc(f.fix && f.fix.label || '') + (f.fix && f.fix.usable === false ? ' ' + warn('不可用') : '') + ' · 参与星 ' + (f.sats != null ? f.sats : '—')],
      ['椭球高 / 大地水准面差距 / 正高', m2alt(f)],
      ['时刻（UTC）', esc(nmeaTimeText(f)) + (isNum(tz) ? ' → 本地约 ' + localTimeText(f, tz) : '')],
      ['DOP（GSA）', 'PDOP ' + fmt(m.pdop, 2) + ' · HDOP ' + fmt(m.hdop, 2) + ' · VDOP ' + fmt(m.vdop, 2) + ' · ' + esc(m.fix_type || '')],
      ['PDOP 恒等式检核', pdopCheck(m)],
      ['GST 给出的σ', m.uncertainty ? '长 ' + m2(m.uncertainty.semi_major_m) + ' / 短 ' + m2(m.uncertainty.semi_minor_m) + ' @ ' + deg(m.uncertainty.orientation_deg, 1) : '—（无 GST 句）'],
      ['运动（VTG）', m.motion ? fmt(m.motion.sog_kmh, 2) + ' km/h，航向 ' + deg(m.motion.cog_true_deg, 1) : '—'],
      ['视野 / 参与', (m.sats_in_view || []).length + ' 颗在视野（GSV），' + (m.used || []).length + ' 颗列入 GSA：' + esc((m.used || []).join(','))],
      ['跳过', m.skipped + ' 句' + (strict ? '（严格模式）' : '')]
    ]);
    (m.warnings || []).forEach(function (w) { html += note(warn(esc(w))); });
    html += note('NMEA 的时间字段一律 UTC，日期只在 RMC/ZDA 里；内核不做闰秒改正。' +
      'Talker ID（GP/GL/GA/BD/GN）决定星座归属，同 PRN 号在不同星座不合并。');
    put('nmeaResult', html);
    state.lastNmea = m;
    if (isNum(f.lat) && isNum(f.lon)) {
      addSolution({ source: 'NMEA 解码', lat: f.lat, lon: f.lon, h: isNum(f.alt) ? f.alt : null, accuracy_m: null, basis: (f.fix && f.fix.label ? f.fix.label + '，' + f.sats + ' 星，HDOP ' + fmt(f.hdop, 2) : 'NMEA') });
      centerOn(f.lat, f.lon, 11);
    }
    if ((m.sats_in_view || []).length) state.lastSky = { list: m.sats_in_view, mask: 0 };
    renderSky();
  }

  function hexOf(v) { return v == null ? '—' : (typeof v === 'number' ? v.toString(16).toUpperCase() : String(v)); }
  function m2(v) { return isNum(v) ? fmt(v, 2) + ' m' : '—'; }
  function m2alt(f) {
    if (!isNum(f.alt)) return '—（无 GGA 高程）';
    return m(f.alt, 1) + ' / ' + (isNum(f.geoid_sep) ? fmt(f.geoid_sep, 1) + ' m' : '—') + ' / ' + (isNum(f.height_msl) ? m(f.height_msl, 1) : '—') + '（正高只由语句自带的 N 算出）';
  }
  function nmeaTimeText(f) {
    var t = f.time, d = f.date;
    var s = t && isNum(t.hour) ? pad2(t.hour) + ':' + pad2(t.minute) + ':' + fmt(t.second, 3).replace(/^(\d+)/, function (x) { return pad2(Number(x)); }) : '—';
    if (d && d.iso) s += '（' + d.iso + '）';
    else if (d && d.raw) s += '（' + d.raw + '）';
    else s += '（无日期句，只能给时刻）';
    return s;
  }
  function pad2(x) { var v = Math.floor(Number(x)); return (v < 10 ? '0' : '') + v; }
  function localTimeText(f, tz) {
    if (!f.time || !isNum(f.time.hour)) return '—';
    var h = f.time.hour + tz, day = '';
    if (h < 0) { h += 24; day = '（前一日）'; } else if (h >= 24) { h -= 24; day = '（次日）'; }
    return pad2(h) + ':' + pad2(f.time.minute);
  }
  function pdopCheck(m) {
    if (!isNum(m.pdop) || !isNum(m.hdop) || !isNum(m.vdop)) return '—（缺 GSA）';
    var calc = Math.hypot(m.hdop, m.vdop);
    var diff = calc - m.pdop;
    return '√(HDOP²+VDOP²) = ' + fmt(calc, 4) + '，播发 PDOP = ' + fmt(m.pdop, 4) + '，差 ' + fmt(diff, 4) +
      (Math.abs(diff) < 0.02 ? ' ' + good('自洽') : ' ' + warn('设备自报值与几何定义不符（常见于把 PDOP 直接按星座合并取最大）；内核不替设备圆场'));
  }

  /* 演示场景 → 加权最小二乘 → RAIM/FDE → 与真值对比（真值由 demoScene 给出，是独立检核） */
  function runGpsSolve() {
    var g = eng('GEOGNSS'), geo = eng('GEOGEO');
    if (!g) { putError('gpsResult', '缺 GEOGNSS 内核'); return; }
    var p = parseTriple(V('gpsPrior'));
    if (p.error) { putError('gpsResult', '先验坐标：' + p.error); return; }
    var truth = { lat: p.lat, lon: p.lon, h: isNum(p.h) ? p.h : 12 };
    var raim = B('gpsRaim');
    var opt = {
      n: N('gpsN') || 9,
      noise_m: N('gpsNoise') == null ? 3 : N('gpsNoise'),
      mask_deg: N('gpsMask') == null ? 5 : N('gpsMask'),
      seed: N('gpsSeed') == null ? 20261101 : N('gpsSeed'),
      outlier_m: raim ? (N('gpsOutlier') == null ? 120 : N('gpsOutlier')) : 0
    };
    var sc = g.demoScene(truth, opt);
    if (sc.error) { putError('gpsResult', esc(sc.error)); return; }
    state.lastScene = sc;
    var so = { sigma_m: N('gpsSigma') == null ? 5 : N('gpsSigma'), raim: raim, weight: B('gpsWeightSnr') ? 'snr' : 'none', maxExclude: 3 };
    var fix = g.solvePosition(sc.satellites, sc.ranges_m, { lat: truth.lat + 0.08, lon: truth.lon - 0.08, h: truth.h + 60 }, so);
    if (fix.error) { putError('gpsResult', esc(fix.error)); return; }
    var err3 = Math.hypot(fix.x - sc.truth.x, fix.y - sc.truth.y, fix.z - sc.truth.z);
    var errH = geo ? geo.inverse(truth.lat, truth.lon, fix.lat, fix.lon, 'WGS84').distance_m : null;
    var html = h4('最小二乘单点定位') + kv([
      ['解（lat/lon/h）', fmt(fix.lat, 7) + ', ' + fmt(fix.lon, 7) + ', ' + m(fix.h, 2)],
      ['真值（场景给定）', fmt(sc.truth.lat, 7) + ', ' + sc.truth.lon.toFixed(7) + ', ' + m(sc.truth.h, 2)],
      ['与真值之差', m(errH, 2) + '（水平） / ' + m(err3, 2) + '（三维）← 独立检核：不依赖内核自报的 σ'],
      ['钟差解 / 场景钟差', m(fix.clock_bias_m, 3) + ' / ' + m(sc.clock_bias_m, 3) + '（差 ' + m(Math.abs(fix.clock_bias_m - sc.clock_bias_m), 4) + '）'],
      ['用星 / 剔除', fix.sats_used + ' 颗参与' + (fix.excluded_prns && fix.excluded_prns.length ? '，剔除 PRN ' + fix.excluded_prns.join(',') : '，未剔除'), ' + 迭代 ' + fix.iterations + ' 次' + (fix.converged ? '' : ' ' + warn('未收敛'))],
      ['残差 RMS', m(fix.rms_residual_m, 3) + '，最大残差 ' + m(Math.max.apply(null, (fix.residuals_m || [0]).map(Math.abs)), 2)],
      ['单位权后验 σ₀', m(fix.sigma0_posterior_m, 3) + '（先验 σ 取 ' + m(so.sigma_m, 1) + '）'],
      ['χ² / 自由度 / p', fmt(fix.chi2, 2) + ' / ' + fix.chi2_dof + ' / ' + (isNum(fix.chi2_p_value) ? fix.chi2_p_value.toExponential(2) : '—')],
      ['完整性', (fix.integrity ? (fix.integrity.alarm === true ? warn('报警') : fix.integrity.alarm === false ? good('通过') : warn('未判定')) : '—') + '<br><span class="note">' + esc((fix.integrity || {}).note || '') + '</span>'],
      ['DOP', 'HDOP ' + fmt(fix.dop.hdop, 3) + ' · VDOP ' + fmt(fix.dop.vdop, 3) + ' · PDOP ' + fmt(fix.dop.pdop, 3) + ' · GDOP ' + fmt(fix.dop.gdop, 3) + ' · TDOP ' + fmt(fix.dop.tdop, 3)],
      ['σ_e/σ_n/σ_u', m(fix.sigma_e_m, 2) + ' / ' + m(fix.sigma_n_m, 2) + ' / ' + m(fix.sigma_u_m, 2)],
      ['误差椭圆', m(fix.semi_major_m, 2) + ' × ' + m(fix.semi_minor_m, 2) + ' @ ' + deg(fix.ellipse_orientation_deg, 1)],
      ['CEP50/68/95', m(fix.cep50_m, 2) + ' / ' + m(fix.cep68_m, 2) + ' / ' + m(fix.cep95_m, 2)],
      ['最低高度角', deg(fix.elevation_min_deg, 1) + '（场景掩角 ' + deg(opt.mask_deg, 1) + '）']
    ]);
    html += note(esc(fix.note));
    html += note(esc(sc.ephemeris_source) + '；' + sc.note);

    var rm = g.raimCheck(fix, so.sigma_m, 0.01);
    if (!rm.error) {
      html += h4('RAIM 检验（独立实现：卡方分位数由本内核二分求根）') + kv([
        ['统计量 T / 临界值', fmt(rm.test_statistic, 2) + ' / ' + fmt(rm.critical_value, 2) + '（dof=' + rm.dof + '，α=' + rm.alpha + '）'],
        ['判决', rm.alarm === true ? warn('报警：存在粗差或未建模偏差') : good('通过')],
        ['HPL（水平保护级）', m(rm.protection_level_m, 2) + ' = K·σ₀·HDOP，K=Norm.inv(1−α/2n)'],
        ['注入的粗差', sc.outlier ? 'PRN ' + sc.outlier.prn + '，' + m(sc.outlier.offset_m, 0) : '未注入']
      ]) + note(esc(rm.note));
    }
    var ex = g.excludeAndResolve(sc.satellites, sc.ranges_m, { lat: fix.lat, lon: fix.lon, h: fix.h }, { sigma_m: so.sigma_m, raim: false });
    if (!ex.error && (ex.trials || []).length) {
      html += h4('逐星剔除（FDE 复核：不依赖内核内部排序）') + kv([
        ['不剔除时的 RMS', m(ex.base_rms, 3)]
      ].concat(ex.trials.slice(0, 6).map(function (t) {
        return ['剔除 PRN ' + t.excluded_prn, 'RMS ' + m(t.rms_residual_m, 3) + '，位置移动 ' + m(t.position_shift_m, 2) + '，HDOP ' + fmt(t.hdop, 2)];
      }))) + (sc.outlier ? note('最应该被剔的是 PRN ' + sc.outlier.prn + '：对比表里它的 RMS 是否最低，就能判断「剔除准则」是否被杠杆效应骗过。') : '');
    }
    var gm = g.geometryFromAzEl(sc.satellites, {});
    if (!gm.error) {
      html += h4('几何交叉检核：只看方位/高度角 vs 解算内部') + kv([
        ['由 az/el 算的 HDOP/VDOP/PDOP', fmt(gm.hdop, 4) + ' / ' + fmt(gm.vdop, 4) + ' / ' + fmt(gm.pdop, 4)],
        ['solvePosition 的', fmt(fix.dop.hdop, 4) + ' / ' + fmt(fix.dop.vdop, 4) + ' / ' + fmt(fix.dop.pdop, 4)],
        ['差', fmt(gm.hdop - fix.dop.hdop, 6) + '（两条路径：前者只用方向余弦，后者含迭代加权的法方程，掩星与剔除会造成可见差）']
      ]);
    }
    var qr = g.qualityReport(Object.assign({}, fix, { integrity_alarm: !!(fix.integrity && fix.integrity.alarm) }), { minSats: 4, sigma_m: so.sigma_m });
    if (!qr.error) {
      html += h4('质量评级') + kv([
        ['评分 / 档', fmt(qr.grade.score, 1) + ' / ' + esc(qr.grade.label) + '（' + esc(qr.grade.basis) + '）'],
        ['可用性', qr.usable ? good('可用') : bad('不可用')],
        ['星数 / 截止角 / RMS', qr.satellites + ' / ' + deg(qr.min_elevation_deg, 1) + ' / ' + m(qr.rms_residual_m, 2)]
      ]) + (qr.notes || []).map(function (n) { return note(esc(n)); }).join('');
    }
    put('gpsResult', html);

    // 逐星残差表：内核按「保留标志 + 原始顺序」返回残差，所以外壳用同样的规则对齐
    var excl = {};
    (fix.excluded_prns || []).forEach(function (p0) { excl[p0] = true; });
    var keptIdx = [];
    sc.satellites.forEach(function (s, j) { if (!excl[s.prn]) keptIdx.push(j); });
    var rowsR = (fix.residuals_m || []).map(function (v, j) {
      var s = sc.satellites[keptIdx[j]] || {};
      return { prn: s.prn, sys: s.sys, el: s.elevation_deg, r: v, h: (fix.leverage || [])[j], z: (fix.residual_z || [])[j] };
    });
    var tbl = '<table class="grid"><thead><tr><th>PRN</th><th>系统</th><th>高度°</th><th>残差 m</th><th>杠杆 h</th><th>归一化残差</th></tr></thead><tbody>' +
      rowsR.map(function (x) {
        return '<tr><td>' + (x.prn == null ? '—' : x.prn) + '</td><td>' + esc(x.sys || '') + '</td><td class="num">' + fmt(x.el, 1) + '</td><td class="num">' + fmt(x.r, 3) + '</td><td class="num">' + fmt(x.h, 4) + '</td><td class="num">' +
          (isNum(x.z) && Math.abs(x.z) > 3 ? warn(fmt(x.z, 2)) : fmt(x.z, 2)) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      ((fix.excluded_prns || []).length ? '<div class="note">被剔除：PRN ' + fix.excluded_prns.join(', ') + '（残差表里不再出现）</div>' : '');
    put('gpsSatTable', h4('逐星残差（' + rowsR.length + ' 条参与解算的观测）') + '<div class="tablewrap">' + tbl + '</div>' +
      (sc.outlier ? note('场景注入的粗差在 PRN ' + sc.outlier.prn + '（' + m(sc.outlier.offset_m, 0) + '）。') : '') +
      note('归一化残差已做杠杆修正 √(1−h)：只用 |r|/σ 会被掩蔽效应骗——粗差星越主导解、残差被吸收得越干净。'));
    state.lastSky = { list: sc.satellites.map(function (s) { return { prn: s.prn, system: s.sys, az: s.azimuth_deg, el: s.elevation_deg, snr: s.snr_db, used: (fix.excluded_prns || []).indexOf(s.prn) < 0 }; }), mask: opt.mask_deg };
    renderSky();
    setDraw('gnss', { circles: [{ lat: fix.lat, lon: fix.lon, r_m: fix.cep95_m || 0, label: 'GNSS CEP95' }] });
    addSolution({ source: 'GNSS 单点定位', lat: fix.lat, lon: fix.lon, h: fix.h, accuracy_m: fix.cep68_m, sigma_e_m: fix.sigma_e_m, sigma_n_m: fix.sigma_n_m, basis: 'LSQ PVT，' + fix.sats_used + ' 星，HDOP ' + fmt(fix.dop.hdop, 2) + '，σ₀ ' + m(fix.sigma0_posterior_m, 1) });
    centerOn(fix.lat, fix.lon, 9);
  }

  function runSky() {
    if (!state.lastScene && !state.lastSky) { putError('skyResult', '还没有星座数据：先做一次「最小二乘解算」或解码含 GSV 的 NMEA。'); return; }
    renderSky();
  }

  /* 天空图数据 + 独立检核：用 ECEF 反算方位/高度角（azElFromEcef），与场景里播发的
     azimuth_deg/elevation_deg 对比。两条路径不一致就说明几何链路有符号/约定错误。 */
  function renderSky() {
    var canvas = $('skyCanvas');
    if (!canvas) { miss.push('skyCanvas'); return; }
    var MAP = mapOf(), g = eng('GEOGNSS');
    if (!g || !MAP || !MAP.skyPlot) return;
    var sk = state.lastSky;
    if (!sk || !sk.list || !sk.list.length) return;
    var plot = g.skyPlot(sk.list, sk.mask || 0);
    if (plot.error) { putError('skyResult', esc(plot.error)); return; }
    MAP.skyPlot(canvas, plot.items.map(function (it) {
      return { az: it.az, el: it.el, snr_db: it.snr, prn: it.prn, used: it.visible };
    }));
    var los = '';
    if (state.lastScene && B('skyLos')) {
      var sc = state.lastScene;
      var rcv = { x: sc.truth.x, y: sc.truth.y, z: sc.truth.z };
      var worstAz = 0, worstEl = 0, n = 0, fails = 0;
      sc.satellites.forEach(function (s) {
        var ae = g.azElFromEcef(s, rcv, sc.truth.lat, sc.truth.lon);
        if (ae.error) { fails++; return; }
        n++;
        var dAz = Math.abs(wrap180v(ae.azimuth_deg - s.azimuth_deg));
        var dEl = Math.abs(ae.elevation_deg - s.elevation_deg);
        if (dAz > worstAz) worstAz = dAz;
        if (dEl > worstEl) worstEl = dEl;
        // 地球遮挡：卫星在地平以上时，站→星向量必须与站心法向成锐角
        var losV = [s.x - rcv.x, s.y - rcv.y, s.z - rcv.z];
        var dot = losV[0] * rcv.x + losV[1] * rcv.y + losV[2] * rcv.z;
        var nrm = Math.hypot(rcv.x, rcv.y, rcv.z) * Math.hypot(losV[0], losV[1], losV[2]);
        var cosInc = nrm ? dot / nrm : 0;
        if (s.elevation_deg > 0 && cosInc < 0) fails++;
      });
      los = h4('视线与角度独立检核（ECEF → 方位/高度角）') + kv([
        ['参与检核', n + ' 颗，异常 ' + (fails ? bad(fails + ' 项') : good('0 项'))],
        ['最大方位差 / 高度差', deg(worstAz, 9) + ' / ' + deg(worstEl, 9) + '（同一条几何的两次计算，应≈0）'],
        ['判据', '「高度角>0」与「站→星向量与站心法向成锐角」必须同真：不一致就是遮挡判定写反']
      ]);
    }
    put('skyResult', h4('天空图（' + plot.used + '/' + plot.total + ' 颗在掩角 ' + deg(plot.mask_deg, 1) + ' 以上）') +
      '<div class="tablewrap"><table class="grid"><thead><tr><th>PRN</th><th>系统</th><th>方位°</th><th>高度°</th><th>SNR dB</th><th>可见</th></tr></thead><tbody>' +
      plot.items.map(function (it) {
        return '<tr><td>' + (it.prn == null ? '—' : it.prn) + '</td><td>' + esc(it.system || '—') + '</td><td class="num">' + fmt(it.az, 1) + '</td><td class="num">' + fmt(it.el, 1) + '</td><td class="num">' + fmt(it.snr, 1) + '</td><td>' + (it.visible ? good('是') : bad('否')) + '</td></tr>';
      }).join('') + '</tbody></table></div>' + los +
      note('天空图用 Canvas 手绘，不联网、不用瓦片。外圈 = 地平线，圆心 = 天顶；红点表示被掩角或剔除挡住。'));
  }

  /* 相对定位：以两处 demoScene（同 seed、无噪声）生成同一星座，构造单差伪距量，再用相对模型解基线，
     与 GEOGEO 的 ENU 解析基线做独立对照。 */
  function runRelative() {
    var g = eng('GEOGNSS'), geo = eng('GEOGEO');
    if (!g) { putError('rfResult', '缺 GEOGNSS 内核'); return; }
    if (!geo) { putError('rfResult', '缺 GEOGEO 内核（独立对照需要它）'); return; }
    var b = parseTriple(V('rfBase')), r = parseTriple(V('rfRov'));
    if (b.error) { putError('rfResult', '基准点：' + b.error); return; }
    if (r.error) { putError('rfResult', '流动点：' + r.error); return; }
    var baseH = isNum(b.h) ? b.h : 12, rovH = isNum(r.h) ? r.h : 14;
    var sb = g.demoScene({ lat: b.lat, lon: b.lon, h: baseH }, { n: 8, noise_m: 0, seed: 20261101 });
    var sr = g.demoScene({ lat: r.lat, lon: r.lon, h: rovH }, { n: 8, noise_m: 0, seed: 20261101 });
    if (sb.error || sr.error) { putError('rfResult', esc((sb.error || sr.error || '') + '（两个场景必须同一 seed，卫星才可比）')); return; }
    var n = Math.min(sb.satellites.length, sr.satellites.length);
    var list = sr.satellites.slice(0, n).filter(function (s) { return s.elevation_deg > 5; });
    var idxR = {}, idxB = {};
    sr.satellites.forEach(function (s, i) { idxR[s.prn + ':' + s.sys] = i; });
    sb.satellites.forEach(function (s, i) { idxB[s.prn + ':' + s.sys] = i; });
    var deltas = [];
    var usable = [];
    list.forEach(function (s) {
      var k = s.prn + ':' + s.sys;
      if (idxR[k] == null || idxB[k] == null) return;
      deltas.push(sr.ranges_m[idxR[k]] - sb.ranges_m[idxB[k]]);
      usable.push(s);
    });
    if (usable.length < 4) { putError('rfResult', '两场景可比卫星只有 ' + usable.length + ' 颗，少于 4 颗（同 seed 但掩星不同就会这样）。请调低截止角或换 seed。'); return; }
    var rf = g.relativeFix(usable, deltas, { lat: b.lat, lon: b.lon }, {});
    if (rf.error) { putError('rfResult', esc(rf.error)); return; }
    // 独立对照：解析 ENU 基线
    var ecefB = geo.geodeticToEcef(b.lat, b.lon, baseH), ecefR = geo.geodeticToEcef(r.lat, r.lon, rovH);
    var dEcef = [ecefR.x - ecefB.x, ecefR.y - ecefB.y, ecefR.z - ecefB.z];
    var enu = geo.ecefToEnu(dEcef[0], dEcef[1], dEcef[2], b.lat, b.lon);
    put('rfResult', h4('单差相对定位（基线 ' + m(Math.hypot(dEcef[0], dEcef[1], dEcef[2]), 1) + '）') + kv([
      ['流动点（相对基准）', fmt(rf.lat, 7) + ', ' + fmt(rf.lon, 7)],
      ['解算 ΔE/ΔN/ΔU', m(rf.dE_m, 3) + ' / ' + m(rf.dN_m, 3) + ' / ' + m(rf.dU_m, 3)],
      ['解析对照 ΔE/ΔN/ΔU', m(enu.e, 3) + ' / ' + m(enu.n, 3) + ' / ' + m(enu.u, 3) + '（GEOGEO 椭球 + ENU 旋转）'],
      ['与解析之差', m(Math.hypot(rf.dE_m - enu.e, rf.dN_m - enu.n, rf.dU_m - enu.u), 4) + '（无噪声时应为亚毫米；不为 0 就是符号约定或视线定义不一致）'],
      ['方程数 / 自由度', rf.equations + ' / ' + rf.dof + '，σ₀ ' + m(rf.sigma0_m, 4)],
      ['形式标准差', m(rf.formal_std_m.dE_m, 3) + ' / ' + rf.formal_std_m.dN_m.toFixed(3) + ' / ' + rf.formal_std_m.dU_m.toFixed(3) + ' m'],
      ['钟差', rf.clock_m === null ? '单差已抵消（无钟未知数）' : '—']
    ]) + note(esc(rf.note)) + note('这里把「同 seed 的两套伪距」当作两站同步观测：真实差分还要同一时刻、同一星座、整周模糊度，本内核不含载波相位，所以精度量级是米而不是厘米。'));
    setDraw('relative', { lines: [{ from: [b.lat, b.lon], to: [r.lat, r.lon], label: '基线 ' + m(Math.hypot(dEcef[0], dEcef[1], dEcef[2]), 0) }] });
    addSolution({ source: '相对定位（流动点）', lat: rf.lat, lon: rf.lon, accuracy_m: rf.formal_std_m ? Math.hypot(rf.formal_std_m.dE_m, rf.formal_std_m.dN_m) : null, basis: '单差基线 ' + m(Math.hypot(dEcef[0], dEcef[1], dEcef[2]), 0) });
    centerOn((b.lat + r.lat) / 2, (b.lon + r.lon) / 2, 13);
  }

  /* 大气改正与精密服务电文 */
  function runAtmosphere() {
    var g = eng('GEOGNSS');
    if (!g) { putError('atmResult', '缺 GEOGNSS 内核'); return; }
    var P = N('atmP'), T = N('atmT'), RH = N('atmRH'), lat = N('atmLat'), hkm = N('atmH'), el = N('atmElev');
    // 界面填的是热力学温度（K），Magnus 式的系数表是按摄氏拟的，混用会算出几万 hPa 的水汽压
    var Tk = isNum(T) ? (T > 200 ? T : T + 273.15) : 288.15;
    var Tc = Tk - 273.15;
    var e = null;
    if (isNum(RH)) e = 6.112 * Math.exp(17.625 * Tc / (243.04 + Tc)) * RH / 100;
    var zh = g.troposphereZenith(isNum(P) ? P : 1013.25, isNum(lat) ? lat : 31.23, isNum(hkm) ? hkm : 0.012,
      e == null ? 11 : e, Tk);
    var mp = g.troposphereMapping(isNum(el) ? el : 15);
    var html = '';
    if (zh.error) html += note(bad(esc(zh.error)));
    else html += h4('对流层天顶延迟（Saastamoinen 闭式）') + kv([
      ['输入', 'P ' + fmt(P, 2) + ' hPa，φ ' + deg(lat, 2) + '，h ' + fmt(hkm, 3) + ' km，T ' + fmt(Tk, 2) + ' K（' + fmt(Tc, 2) + ' °C）' + (isNum(RH) ? '，RH ' + fmt(RH, 0) + '% → e ' + fmt(e, 3) + ' hPa（Magnus 用摄氏：a=17.625，b=243.04，单位 hPa）' : '，未给湿度 → e 按典型 11 hPa')],
      ['ZHD / ZWD / 合计', m(zh.zhd_m, 4) + ' / ' + m(zh.zwd_m, 4) + ' / ' + m(zh.zenith_total_m, 4)],
      ['局部重力 / 归一因子', fmt(zh.gravity_mps2, 5) + ' m/s² / ' + fmt(zh.gravity_factor, 6) + '（按 g(45°,0) 归一）'],
      ['高度角 ' + deg(el, 1) + ' 的斜延迟', (isNum(mp.mapping) ? m(zh.zenith_total_m * mp.mapping, 3) + '（映射用内核返回的 ' + fmt(mp.mapping, 3) + '）' : bad(esc(mp.error || '')))],
      ['低高度角截断', isNum(mp.clipped_below_deg) ? (isNum(el) && el < mp.clipped_below_deg
        ? warn('E=' + fmt(el, 1) + '° 低于 ' + mp.clipped_below_deg + '°，内核按 ' + mp.clipped_below_deg + '° 取映射 ' + fmt(mp.mapping, 3) + '；不截断时 1/sinE=' + fmt(mp.at_true_elevation, 3) + '，这个量级闭式已不可信，应换 Niell/Hopfield')
        : 'E≥' + mp.clipped_below_deg + '°，未触发截断：映射 = 1/sinE = ' + fmt(mp.mapping, 3)) : '—']
    ]) + note(esc(zh.note)) + note(esc(mp.note || ''));

    var ionoEl = N('ionoElev'), vtec = N('ionoVtec'), f1 = N('ionoF1'), hs = N('ionoShell');
    var io = g.ionoShell(isNum(ionoEl) ? ionoEl : 15, isNum(hs) ? hs : 350, isNum(f1) ? f1 : 1575.42, isNum(vtec) ? vtec : 12);
    if (io.error) html += note(bad('电离层：' + esc(io.error)));
    else html += h4('单层壳电离层') + kv([
      ['壳高 / 映射因子', fmt(io.shell_km, 0) + ' km / ' + fmt(io.mapping_factor, 4)],
      [' IPP（穿透点）', '地心角 ' + deg(io.ipp_central_angle_deg, 3) + '，距接收机地影点 ' + km(io.ipp_distance_km * 1000, 1)],
      ['VTEC → 斜延迟', fmt(vtec, 1) + ' TECU → 垂直 ' + m(io.vertical_delay_m, 3) + '，斜 ' + m(io.group_delay_m, 3) + '（' + fmt(f1, 2) + ' MHz，Δρ=40.3·STEC/f²）'],
      ['斜 TEC', fmt(io.slant_tecu_tecu, 1) + ' TECU']
    ]) + note(esc(io.note));

    var r1 = N('ifP1'), r2 = N('ifP2'), f2 = N('ionoF2');
    var fr = g.ionoFreeRange(isNum(r1) ? r1 : 20000000, isNum(f1) ? f1 : 1575.42, isNum(r2) ? r2 : 20000003.9, isNum(f2) ? f2 : 1227.6);
    html += fr.error ? h4('双频无电离层组合') + note(bad(esc(fr.error))) :
      h4('双频无电离层组合') + kv([
        ['组合式', '(' + fmt(fr.coeff1, 4) + ')·P1 + (' + fmt(fr.coeff2, 4) + ')·P2 = ' + m(fr.range_m, 3)],
        ['噪声放大', fmt(fr.noise_amplification, 3) + ' ×（单频伪距噪声）'],
        ['残差', esc(fr.note)]
      ]);
    put('atmResult', html);
  }

  /* 精密服务电文解码：L6/CLAS 帧头、PPP-B2b IADS 消息、CSAS 域改正作用到卫星位置、伪距改正表 */
  function runPpp() {
    var g = eng('GEOGNSS');
    if (!g) { putError('pppResult', '缺 GEOGNSS 内核'); return; }
    var html = '';
    var bits = String(V('l6Bits')).replace(/[^01]/g, '');
    var l6 = g.decodeL6Frame(bits);
    html += h4('QZSS L6 / CLAS 帧头') + (l6.error ? note(bad(esc(l6.error))) : kv([
      ['PRN 提示 / 消息类型', l6.prn_hint + ' / MT ' + l6.message_type + (l6.is_clas ? ' ' + good('CLAS') : ''),
      ],
      ['NCF / SID / 批次', l6.ncf + ' / ' + l6.satellite_information_id + ' / ' + l6.batch_id + '（比特数 ' + l6.raw_bits + '）'],
      ['分层', (l6.layers || []).join(' → ') || '—'],
      ['诚实边界', esc(l6.service_note)]
    ]));
    var b2b = String(V('b2bBits')).replace(/[^01]/g, '');
    var scale = N('b2bScale');
    var d3 = g.decodePppB2b(b2b, isNum(scale) ? { radial_scale: scale } : {});
    html += h4('BDS PPP-B2b（IADS）') + (d3.error ? note(bad(esc(d3.error)) + note('有效消息类型 1~4（前 6 比特）。')) : kv([
      ['类型 / 名称', d3.message_type + ' · ' + esc(d3.message_name || '')],
      ['卫星 / IOD', (d3.satellite_id != null ? d3.satellite_id : '—') + ' / ' + (d3.iod != null ? d3.iod : '—')],
      ['径向改正', isNum(d3.radial_m) ? m(d3.radial_m, 3) : warn('未解出：' + esc(d3.note || ''))],
      ['切向 / 法向 / 钟差', '— / — / —（本实现不猜测比例因子）'],
      ['字段表版本', esc(d3.field_map_version || '')]
    ]));

    // CSAS/PPP 域改正 → 卫星位置：用演示场景里的第一颗星（含 vx/vy/vz，可构造完整 RTN）
    var sc = state.lastScene;
    var dr = { radial_m: N('pppR') || 0, tangential_m: N('pppT') || 0, normal_m: N('pppN') || 0 };
    if (!sc || !sc.satellites || !sc.satellites.length) {
      html += h4('把域改正作用到卫星位置') + note('先在 ⑥B 做一次最小二乘解算（演示场景提供卫星速度），否则没有 RTN 三轴可用的输入。');
    } else {
      var s0 = sc.satellites[0];
      var withVel = g.applyOrbitCorrection(s0, { vx: s0.vx, vy: s0.vy, vz: s0.vz }, dr);
      var noVel = g.applyOrbitCorrection(s0, null, dr);
      html += h4('把域改正作用到卫星 PRN ' + s0.prn + '（' + esc(s0.sys) + '）') + kv([
        ['改正量 R/T/N', m(dr.radial_m, 3) + ' / ' + m(dr.tangential_m, 3) + ' / ' + m(dr.normal_m, 3)],
        ['含速度（完整 RTN）', withVel.error ? bad(esc(withVel.error)) : '位移 ' + m(withVel.shift_m, 4) + '，degraded=' + (withVel.degraded ? warn('是') : good('否'))],
        ['不含速度', noVel.error ? bad(esc(noVel.error)) : '只加径向 ' + m(Math.hypot(noVel.position.x - s0.x, noVel.position.y - s0.y, noVel.position.z - s0.z), 4) + '，degraded=' + (noVel.degraded ? warn('是（切向/法向无法定义）') : '否')],
        ['说明', esc((withVel.service_note || '') + ' / ' + (noVel.note || ''))]
      ]);
      if (!withVel.error && (dr.radial_m || dr.tangential_m || dr.normal_m)) {
        var fixed = sc.satellites.map(function (s, i) {
          if (i !== 0) return s;
          var c = g.applyOrbitCorrection(s, { vx: s.vx, vy: s.vy, vz: s.vz }, dr);
          return c.error ? s : Object.assign({}, c.position, { prn: s.prn, sys: s.sys, azimuth_deg: s.azimuth_deg, elevation_deg: s.elevation_deg, snr_db: s.snr_db, vx: s.vx, vy: s.vy, vz: s.vz });
        });
        var so = { sigma_m: 5, raim: false };
        var before = g.solvePosition(sc.satellites, sc.ranges_m, { lat: sc.truth.lat + 0.05, lon: sc.truth.lon - 0.05, h: sc.truth.h + 40 }, so);
        var after = g.solvePosition(fixed, sc.ranges_m, { lat: sc.truth.lat + 0.05, lon: sc.truth.lon - 0.05, h: sc.truth.h + 40 }, so);
        if (!before.error && !after.error) {
          var d0 = Math.hypot(sc.truth.x - before.x, sc.truth.y - before.y, sc.truth.z - before.z);
          var d1 = Math.hypot(sc.truth.x - after.x, sc.truth.y - after.y, sc.truth.z - after.z);
          html += h4('改正前 → 改正后（伪距不变，只动卫星）') + kv([
            ['三维误差', m(d0, 3) + ' → ' + m(d1, 3) + '（变化 ' + m(d1 - d0, 3) + '）'],
            ['解读', d1 < d0 ? good('改正方向正确：误差变小') : warn('误差反而变大：说明注入的改正量与本场景的误差不匹配（演示场景的星历本来无误差，任何改正都会引入误差）')]
          ]);
        }
      }
    }

    // 伪距改正项表：输入用「秒/米」原始量纲，输出按加到伪距上的符号展开
    var satClockS = N('pppClkS'), tgdS = N('pppTgd'), ionoM = N('pppIonoM'), tropoM = N('pppTropoM');
    var raw = N('pppRawRange');
    var corr = {};
    if (isNum(satClockS)) corr.sat_clock_s = satClockS;
    if (isNum(tgdS)) corr.tgd_s = tgdS;
    if (isNum(ionoM)) corr.iono_m = ionoM;
    if (isNum(tropoM)) corr.tropo_m = tropoM;
    var cp = g.correctPseudorange(isNum(raw) ? raw : 20183546.712, corr);
    html += h4('伪距改正的符号表（ρ = ρ_raw + Σ）') + (cp.error ? note(bad(esc(cp.error))) :
      kv(Object.keys(cp.terms).map(function (k) { return [esc(k), m(cp.terms[k], 4)]; }).concat([
        ['合计 applied_m', m(cp.applied_m, 4)],
        ['改正后伪距', m(cp.range_m, 4)]
      ])) + note(esc(cp.note)));
    put('pppResult', html);
  }

  /* ============================================================ 14. ⑦ 天象定位 */
  /* 共用输入：时刻（含时区）+ 观测点。时间留空时用浏览器时钟，并在结果里写清来源。 */
  function astCtx() {
    var a = eng('GEOASTRO');
    if (!a) return { err: '缺 GEOASTRO 内核（检查 app/core-astro.js 是否加载）' };
    var tz = N('astTz'); if (tz == null) tz = 8;
    var raw = V('astTime'), t;
    if (raw === '') {
      t = { jd: Date.now() / 86400000 + 2440587.5, tz_offset_hours: 0, tz_source: '浏览器时钟（UT）' };
    } else {
      t = a.parseTime(raw, { tzOffsetHours: tz });
      if (t.error) return { err: '时间解析：' + esc(t.message || t.error) + '（支持 2026-11-02 14:30、…T14:30+08:00、纯 JD 数）' };
    }
    var p = parseTriple(V('astPos'));
    if (p.error) return { err: '观测点：' + esc(p.error) };
    return {
      a: a, jd: t.jd, tz: isNum(t.tz_offset_hours) ? t.tz_offset_hours : tz, tzSrc: t.tz_source,
      lat: p.lat, lon: p.lon, ts: a.timeSystems(t.jd, { tzOffsetHours: tz })
    };
  }
  function astHead(c) {
    var h = '<div class="note">时刻 ' + astTimeText(c.a, c.jd, c.tz) + '（时区 ' + fmt(c.tz, 2) + ' h，来源 ' + esc(c.tzSrc) + '）｜观测点 ' +
      fmt(c.lat, 6) + ', ' + fmt(c.lon, 6) + '</div>';
    if (c.ts && !c.ts.error) {
      h += note('时间尺度：' + esc(c.ts.ut1_utc_note) + '；' + esc(c.ts.tt_note) + '；' + esc(c.ts.leap_second_note));
    }
    return h;
  }
  // JD 的「本地日首」= 当地 0 点（仍以 UT 数值表示），sunEvents/moonEvents 要的就是这个
  function astDayStart(jd, tz) { return Math.floor(jd + tz / 24 - 0.5) + 0.5 - tz / 24; }
  function astTimeText(a, jd, tz) {
    if (!isNum(jd)) return '—（无事件，本窗口内没有发生）';
    var u = a.dateFromJd(jd), l = a.dateFromJd(jd + tz / 24);
    if (u.error) return '—（' + esc(u.message || u.error) + '）';
    return (l.error ? '—' : esc(l.iso.slice(0, 19).replace('T', ' '))) + ' 本地 / ' + esc(u.iso.slice(0, 19).replace('T', ' ')) + ' UT';
  }
  /* 独立检核：天体高度 = 90° − 到天体下点的大圆角距。这条只借用内核给出的下点经纬度，
     距离与方位改由 GEOGEO 的椭球大地线反算得到，与内核的地平三角解算是两条不同的路。 */
  function astHorizonCheck(lat, lon, subLat, subLon, altDeg, azDeg) {
    var geo = eng('GEOGEO');
    if (!geo || !isNum(subLat)) return '—（缺 GEOGEO 或下点）';
    var iv = geo.inverse(lat, lon, subLat, subLon, 'WGS84');
    if (!iv || !isNum(iv.distance_m)) return '—（大地线反算失败）';
    var z = isNum(iv.central_angle_deg) ? iv.central_angle_deg : iv.distance_m / 6371008.7714 * 180 / Math.PI;
    var altCheck = 90 - z;
    var dAlt = altCheck - altDeg;
    var dAz = isNum(azDeg) ? Math.abs(((iv.initial_bearing_deg - azDeg + 540) % 360) - 180) : null;
    return '大圆反算高度 ' + deg(altCheck, 4) + ' vs 内核地平解 ' + deg(altDeg, 4) + '，差 ' +
      fmt(dAlt, 4) + '°（' + fmt(Math.abs(dAlt) * 60, 1) + '′）' +
      (isNum(dAz) ? '；方位差 ' + fmt(dAz, 4) + '°' : '') +
      (Math.abs(dAlt) < 0.05 ? ' ' + good('两条路一致') : ' ' + warn('差异超出球面/椭球差，应检查是否混入折射或视差项'));
  }

  function runAstSun() {
    var c = astCtx(); if (c.err) { putError('astResult', c.err); return; }
    var a = c.a;
    var s = a.sunHorizon(c.jd, c.lat, c.lon);
    if (s.error) { putError('astResult', 'sunHorizon：' + esc(s.message || s.error)); return; }
    var sub = a.subSolarPoint(c.jd);
    var g = a.gmst(c.jd);
    var html = astHead(c) + h4('太阳视位置') + kv([
      ['地平坐标', '几何高度 ' + deg(s.alt_deg, 4) + ' · 视高度（含折射）' + deg(s.refracted_alt_deg, 4) + ' · 方位（真北顺时针）' + deg(s.az_deg, 4)],
      ['上/下边缘视高度', deg(s.upper_limb_apparent_alt, 4) + ' / ' + deg(s.lower_limb_apparent_alt, 4) + '（视半径 ' + fmt(s.semidiameter_deg * 60, 2) + '′，折射 ' + fmt(s.refraction_arcmin, 2) + '′）'],
      ['赤经/赤纬/时角', deg(s.sun_ra_deg, 5) + ' / ' + deg(s.sun_dec_deg, 5) + ' / ' + deg(s.ha_deg, 5) + '（' + fmt(s.ha_hours, 4) + ' h）'],
      ['GMST', isNum(g.deg) ? deg(g.deg, 6) + '（' + esc(g.hms && g.hms.text || '') + '）' : '—'],
      ['日下点', isNum(sub.lat) ? fmt(sub.lat, 5) + ', ' + fmt(sub.lon, 5) + '（' + (sub.within_tropics ? good('在回归线内') : warn('在回归线外')) + '，赤纬上界 ' + deg(sub.declination_bound_deg, 4) + '）' : bad(esc(sub.message || sub.error || ''))],
      ['高度独立检核', astHorizonCheck(c.lat, c.lon, sub.lat, sub.lon, s.alt_deg, s.az_deg)]
    ]);

    var ds = astDayStart(c.jd, c.tz);
    var ev = a.sunEvents(ds, c.lat, c.lon, {});
    if (ev.error) {
      html += h4('日出日落') + note(bad('sunEvents：' + esc(ev.message || ev.error)));
    } else {
      var decNow = s.sun_dec_deg;
      var an = a.analyticDayLength(c.lat, decNow, ev.geometric_center_alt_at_event_deg);
      var dayRow = isNum(ev.day_length_h) && an && isNum(an.day_length_h)
        ? fmt(ev.day_length_h, 4) + ' h（数值） vs ' + fmt(an.day_length_h, 4) + ' h（解析 cosH₀ 式）差 ' +
          fmt((ev.day_length_h - an.day_length_h) * 60, 2) + ' min' +
          (Math.abs(ev.day_length_h - an.day_length_h) * 60 < 3 ? ' ' + good('自洽') : ' ' + warn('超出 3 min：解析式用的是当日赤纬，赤纬日变化 ~0.4° 会带来同量级差'))
        : (ev.polar_state === 'polar_day' ? '极昼（24 h）' : ev.polar_state === 'polar_night' ? '极夜（0 h）' : '—（' + esc(String(ev.polar_state)) + '）');
      html += h4('日出日落与晨昏蒙影（本地日 ' + astTimeText(a, ds, c.tz) + '）') + kv([
        ['日出', astTimeText(a, ev.sunrise_jd, c.tz)],
        ['日落', astTimeText(a, ev.sunset_jd, c.tz)],
        ['阈值', '中心视高度 ' + deg(ev.threshold_center_apparent_deg, 5) + '（= −日面视半径；折射由内核自动叠加）→ 几何中心高度 ' + deg(ev.geometric_center_alt_at_event_deg, 5)],
        ['昼长', dayRow],
        ['当日最高/最低视高度', deg(ev.max_apparent_alt_deg, 4) + ' / ' + deg(ev.min_apparent_alt_deg, 4) + '（' + esc(String(ev.polar_state)) + (ev.polar_note ? '：' + esc(ev.polar_note) : '') + '）'],
        ['天文纬度用量', '正午（时角≈0）高度 ' + deg(s.alt_deg, 4) + '，与赤纬 ' + deg(decNow, 4) + ' 合起来即「φ = δ + z」的观测原料，见「由高度反推纬度」']
      ]);
      var twRows = [['civil', '民用（−6°）'], ['nautical', '航海（−12°）'], ['astronomical', '天文（−18°）']].map(function (p) {
        var t = ev.twilight[p[0]];
        if (!t) return [p[1], '—'];
        if (t.error) return [p[1], bad(esc(t.message || t.error))];
        var st = { no_darkness: warn('该夜不降到阈值（无真正天黑）'), always_below: '整夜低于阈值', no_twilight: '窗口内无交叉' };
        return [p[1], '入夜 ' + astTimeText(a, t.evening_jd, c.tz) + '<br>结束 ' + astTimeText(a, t.morning_jd, c.tz) +
          (st[t.status] ? '<br>' + st[t.status] : '')];
      });
      html += kv(twRows);
      html += note('精度：日出日落 ±0.7 min（Bennett 28.98′ vs 年历 34′，见「内核自报精度」）。此处不做地形、天气与地方时改正。');
    }
    put('astResult', html);
  }

  function runAstMoon() {
    var c = astCtx(); if (c.err) { putError('astResult', c.err); return; }
    var a = c.a;
    var tp = a.topocentricMoon(c.jd, c.lat, c.lon);
    if (tp.error) { putError('astResult', 'topocentricMoon：' + esc(tp.message || tp.error)); return; }
    var ph = a.moonPhase(c.jd);
    var sub = a.subLunarPoint(c.jd);
    var html = astHead(c) + h4('月亮') + kv([
      ['站心地平', '高度 ' + deg(tp.alt_deg, 4) + '（视高度 ' + deg(tp.refracted_alt_deg, 4) + '）· 方位 ' + deg(tp.az_deg, 4)],
      ['地心高度 / 视差改正', deg(tp.alt_deg_geocentric, 4) + ' → 站心 ' + deg(tp.alt_deg, 4) + '，差 ' + fmt(tp.parallax_in_altitude_deg, 4) + '°（地平视差 ' + fmt(tp.parallax_arcsec, 1) + '″）'],
      ['赤经/赤纬（站心）', deg(tp.ra_deg, 5) + ' / ' + deg(tp.dec_deg, 5)],
      ['视半径', fmt(tp.semidiameter_deg * 60, 2) + '′'],
      ['月下点', isNum(sub.lat) ? fmt(sub.lat, 5) + ', ' + fmt(sub.lon, 5) + '（地心，距 ' + fmt(sub.dist_km, 1) + ' km）' : bad(esc(sub.message || sub.error || ''))],
      ['高度独立检核', astHorizonCheck(c.lat, c.lon, sub.lat, sub.lon, tp.alt_deg_geocentric, null) +
        '<br><span class="note">对地心高度做检核；站心高度另有上面那一行量级的地心视差，两者不该直接相等。</span>']
    ]);
    if (!ph.error) {
      html += h4('月相') + kv([
        ['位相', good(esc(ph.phase_name)) + ' · ' + (ph.waxing ? '盈（月龄增）' : '亏（月龄减）')],
        ['照明分数', fmt(ph.illumination_fraction * 100, 2) + '%（严格式 f=(1+cos i)/2，相位角 i=' + deg(ph.phase_angle_deg, 4) + '）'],
        ['平行光近似', fmt(ph.illumination_parallel_approx * 100, 2) + '%，与严格式差 ' + fmt(ph.approx_minus_exact * 100, 4) + ' 个百分点'],
        ['距角 / 黄经差', deg(ph.elongation_deg, 4) + ' / ' + deg(ph.ecliptic_elongation_deg, 4)],
        ['平均月龄', fmt(ph.age_days_mean, 2) + ' d（按朔望月 29.530588853 d 线性推，非真实近点月）']
      ]);
      html += note(esc(ph.illum_formula));
    } else {
      html += h4('月相') + note(bad(esc(ph.message || ph.error)));
    }
    var me = a.moonEvents(astDayStart(c.jd, c.tz), c.lat, c.lon, {});
    if (me.error) {
      html += h4('月升/月落') + note(bad('moonEvents：' + esc(me.message || me.error)));
    } else {
      html += h4('月升/月落（本地日）') + kv([
        ['月出', astTimeText(a, me.rise_jd, c.tz)],
        ['月落', astTimeText(a, me.set_jd, c.tz)],
        ['阈值 / 极区状态', deg(me.threshold_deg, 4) + '（上边缘）· ' + esc(String(me.polar_state)) +
          (me.no_rise ? '，本日无月出' : '') + (me.no_set ? '，本日无月落' : '')],
        ['当日最高/最低视高度', deg(me.max_apparent_alt_deg, 4) + ' / ' + deg(me.min_apparent_alt_deg, 4)]
      ]);
    }
    html += note('诚实标注：月位是 Meeus 47 章截断主项，黄经累积截断 ≤0.4°（小于月视直径 0.5°），未与外部历表核对；' +
      '月下点位置可能有 ~40 km 偏差，不用于月掩星或月龄精算。');
    put('astResult', html);
  }

  function runAstStar() {
    var c = astCtx(); if (c.err) { putError('astResult', c.err); return; }
    var a = c.a;
    var key = V('astStar') || 'Polaris';
    var b = a.bearingFromStar({ star: key, utc: c.jd, tzOffsetHours: c.tz, lat: c.lat, lon: c.lon, alt_min_deg: 0 });
    var html = astHead(c);
    if (b.error) {
      html += h4('恒星方位') + note(bad('bearingFromStar：' + esc(b.message || b.error) + '（星表 46 颗，可输中文名/英文名/bayer/HIP/序号）'));
      put('astResult', html); return;
    }
    // 独立检核：用内核自己给出的 δ、H、观测者纬度重算 sin h，与解算高度对照（球面恒等式）
    var sinH = Math.sin(c.lat * Math.PI / 180) * Math.sin(b.dec_deg * Math.PI / 180) +
      Math.cos(c.lat * Math.PI / 180) * Math.cos(b.dec_deg * Math.PI / 180) * Math.cos(b.ha_deg * Math.PI / 180);
    var altRe = Math.asin(Math.max(-1, Math.min(1, sinH))) * 180 / Math.PI;
    html += h4('恒星 ' + esc(b.star) + '（' + esc(b.star_zh) + '）') + kv([
      ['方位 / 高度', deg(b.az_deg, 4) + ' / ' + deg(b.alt_deg, 4) + '（视高度 ' + deg(b.apparent_alt_deg, 4) + '）'],
      ['赤经 / 赤纬 / 时角', deg(b.ra_deg, 5) + ' / ' + deg(b.dec_deg, 5) + ' / ' + deg(b.ha_deg, 5)],
      ['LST / GMST', deg(b.lst_deg, 5) + ' / ' + deg(b.gmst_deg, 5)],
      ['太阳高度', isNum(b.sun_alt_deg) ? deg(b.sun_alt_deg, 4) + '（< −6° 才算夜）' : '—'],
      ['可用作定向', (b.visible ? good('可见（夜 + 高度>5°）') : warn('本时刻不宜')) ],
      ['高度恒等式检核', 'sin h = sinφ sinδ + cosφ cosδ cosH 重算得 ' + deg(altRe, 5) + '，与解算差 ' +
        fmt(Math.abs(altRe - b.alt_deg) * 3600, 3) + '″' + (Math.abs(altRe - b.alt_deg) < 1e-6 ? ' ' + good('严格一致') : ' ' + warn('不一致'))]
    ]);
    html += note(esc(b.note));

    var st = a.starsAt({ utc: c.jd, tzOffsetHours: c.tz, lat: c.lat, lon: c.lon, alt_min_deg: 5, sun_alt_max_deg: -6 });
    if (!st.error) {
      var vis = st.stars.filter(function (r) { return r.visible; }).slice(0, 12);
      html += h4('此刻可见亮星（按高度降序，取前 ' + vis.length + ' 颗 / 共 ' + st.visible_count + ' 颗，星表 ' + st.count + ' 颗）');
      html += '<div class="tablewrap"><table class="grid"><thead><tr><th>星</th><th>中文名</th><th>星等</th><th>方位°</th><th>视高度°</th><th>赤纬°</th></tr></thead><tbody>';
      vis.forEach(function (r) {
        html += '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.zh) + '</td><td class="num">' + fmt(r.v, 2) + '</td><td class="num">' +
          fmt(r.az_deg, 2) + '</td><td class="num">' + fmt(r.apparent_alt_deg, 2) + '</td><td class="num">' + fmt(r.dec_deg, 2) + '</td></tr>';
      });
      html += '</tbody></table></div>';
      html += note('星表坐标是自写入的常识值，离线无法逐条与外部星表核对（自估 ±0.01°…±0.1°）；HIP 编号只给出有把握的 20 余颗，其余留空而不是猜一个。够用于「哪颗星可见、大致方位、罗盘级定向」，不够用于角秒级天文定位。');
    } else {
      html += h4('可见星表') + note(bad(esc(st.message || st.error)));
    }
    put('astResult', html);
  }

  function runAstPolar() {
    var c = astCtx(); if (c.err) { putError('astResult', c.err); return; }
    var a = c.a;
    var r = a.polarisCompass({ utc: c.jd, lat: c.lat, lon: c.lon, lat_guess_deg: c.lat });
    if (r.error) { putError('astResult', 'polarisCompass：' + esc(r.message || r.error) + '（北半球才可用的罗盘法）'); return; }
    var html = astHead(c) + h4('北极星罗经') + kv([
      ['北极星方位', deg(r.az_deg, 4) + ' → 自真北偏 ' + deg(r.az_from_true_north_deg, 4) + '（一阶式估计 ' + deg(r.first_order_az_error_deg, 4) + '）'],
      ['高度', deg(r.alt_deg, 4) + '（时角 ' + deg(r.ha_deg, 3) + '，距极角 ' + deg(r.polar_distance_deg, 4) + '）'],
      ['可当真北？', (r.usable_as_compass ? good('偏差 < 2°，罗盘级够用') : warn('偏差 > 2°，等过中天或改用其他星')) ],
      ['夜间可见', (r.visible_at_night ? '是' : warn('否（太阳高度或高度角条件不满足）'))],
      ['估纬（精确反解）', deg(r.lat_estimate_deg, 4) + '（观测点纬度 ' + fmt(c.lat, 4) + '，差 ' + fmt(Math.abs(r.lat_estimate_deg - c.lat), 4) + '°）'],
      ['双解', (r.lat_solutions_deg || []).map(function (x) { return deg(x, 4); }).join(' / ') + '，选支=' + esc(String(r.solution_branch)) + '，两支间隔 ' + deg(r.solution_separation_deg, 3)],
      ['简单规则', 'φ≈h 给 ' + deg(r.lat_simple_deg, 4) + '，与精确反解差 ' + fmt(r.simple_rule_error_deg, 4) + '°（=距极角量级的系统差）']
    ]);
    html += note(esc(r.solution_method) + '；' + esc(r.error_note));
    put('astResult', html);
  }

  function runAstLat() {
    var c = astCtx(); if (c.err) { putError('astResult', c.err); return; }
    var a = c.a;
    var alt = N('astAlt');
    if (alt == null) { putError('astResult', '请填写「过中天最大高度」'); return; }
    var key = V('astStar') || 'Polaris';
    var toward = V('astToward') || 'south';
    var r = a.latFromStarAltitude({ max_altitude_deg: alt, star: key, toward: toward, utc: c.jd });
    if (r.error) { putError('astResult', 'latFromStarAltitude：' + esc(r.message || r.error)); return; }
    var fwd = 90 - Math.abs(r.lat_deg - r.dec_deg);
    var html = astHead(c) + h4('由过中天高度反推纬度') + kv([
      ['输入', esc(key) + ' 过中天最大高度 ' + deg(alt, 4) + '，天体位于观测者' + (toward === 'north' ? '之北' : '之南')],
      ['天体赤纬', deg(r.dec_deg, 5) + '（含岁差+自行，按本时刻）'],
      ['天顶距', deg(r.zenith_dist_deg, 5)],
      ['解出纬度', good(deg(r.lat_deg, 5)) + '（' + esc(String(r.resolved_by)) + ' 分支）' + (r.clamped ? ' ' + warn('|φ|>90 被截断') : '')],
      ['两支', '南 ' + deg((r.two_solutions || {}).south, 5) + ' / 北 ' + deg((r.two_solutions || {}).north, 5) + (r.ambiguity === 'direction' ? '（由方位区分）' : ' ' + warn(esc(String(r.ambiguity))))],
      ['正算回去', 'φ=' + fmt(r.lat_deg, 5) + '、δ=' + fmt(r.dec_deg, 5) + ' ⇒ 过中天高度 ' + deg(fwd, 5) + '，与输入差 ' +
        fmt(Math.abs(fwd - alt) * 60, 3) + '′' + (Math.abs(fwd - alt) < 1 / 60 ? ' ' + good('互逆') : ' ' + warn('不互逆，输入或赤纬有问题'))]
    ]);
    html += note(esc(r.formula) + '；' + esc(r.note));
    put('astResult', html);
  }

  function runAstSub() {
    var c = astCtx(); if (c.err) { putError('astSubResult', c.err); return; }
    var a = c.a;
    var sun = a.subSolarPoint(c.jd);
    var moon = a.subLunarPoint(c.jd);
    if (sun.error) { putError('astSubResult', 'subSolarPoint：' + esc(sun.message || sun.error)); return; }
    var lonCorr = N('astLonCorr');
    if (isNum(lonCorr)) { var s2 = a.subSolarPoint(c.jd, { longitude_correction_deg: lonCorr }); if (!s2.error) sun = s2; }
    state.terminator = { subLon: sun.lon, subLat: sun.lat };
    state.nightOn = B('astTerminator');
    var lines = [{ from: [c.lat, c.lon], to: [sun.lat, sun.lon], label: '观测点 → 日下点（天顶方向）' }];
    if (!moon.error) lines.push({ from: [c.lat, c.lon], to: [moon.lat, moon.lon], label: '观测点 → 月下点' });
    setDraw('astro', {
      lines: lines,
      circles: isNum(sun.lat) ? [{ lat: sun.lat, lon: sun.lon, r_m: 500000, label: '日下点（太阳在天顶，半径仅为可视）' }] : [],
      focus: { lat: c.lat, lon: c.lon }
    });
    var MAP = mapOf();
    // 晨昏线交给 syncMap：setDraw 里已经「先 render 再画线」，这里再画一遍会把夜面叠成两层
    var sh = a.sunHorizon(c.jd, c.lat, c.lon);
    var html = astHead(c) + h4('日下点 / 月下点') + kv([
      ['日下点', fmt(sun.lat, 5) + ', ' + fmt(sun.lon, 5) + '（赤纬 ' + deg(sun.dec_deg, 5) + '，赤经 ' + deg(sun.ra_deg, 5) + '，GMST ' + deg(sun.gmst_deg, 5) + '）'],
      ['日下点不确定度', '视差 ≤' + fmt(sun.parallax_shift_arcsec, 2) + '″ ≈ 0.27 km 未做方向分解；' + esc(String(sun.ut1_lon_error_m)) + ' m 级（UT1−UTC 未知）'],
      ['月下点', moon.error ? bad(esc(moon.message || moon.error)) : fmt(moon.lat, 5) + ', ' + fmt(moon.lon, 5) + '（距 ' + fmt(moon.dist_km, 1) + ' km，视差 ' + fmt(moon.parallax_arcsec, 1) + '″ ≈ ' + fmt(moon.parallax_shift_km_max, 1) + ' km）'],
      ['本地点太阳高度', isNum(sh.alt_deg) ? deg(sh.alt_deg, 4) + '（视高度 ' + deg(sh.refracted_alt_deg, 4) + '）' : '—'],
      ['晨昏线', nightLineHtml(MAP)]
    ]);
    html += note(esc(sun.note) + (moon.error ? '' : '；' + esc(moon.note)));
    html += note('晨昏线是几何大圆（不含折射与日面半径），所以实际明暗交界会比它早/晚约几分钟。');
    put('astSubResult', html);
  }

  /* 「画了」不等于「看得见」：线可能整段都在当前视野之外，那种情况必须说清楚，
     否则用户会以为这个功能坏了。 */
  function nightLineHtml(MAP) {
    if (!state.nightOn) return warn('未勾选，不绘制');
    if (!MAP || !MAP.isReady || !MAP.isReady()) return warn('已算出但地图未就绪（Leaflet 没加载或视野没建立）');
    var r = state.lastNight;
    if (!r) return bad('内核没有返回晨昏线');
    if (r.error) return bad(esc(r.error));
    if (!r.n) return warn(esc(r.message || '晨昏线退化（极区全天白/夜）'));
    var txt = good('已绘出（' + r.n + ' 点，纬度 ' + fmt(r.lat_min, 1) + '°～' + fmt(r.lat_max, 1) + '°）');
    if (!isNum(r.in_view)) return txt + warn('（内核没报视野命中数，无法判断在不在屏幕上）');
    if (r.in_view > 0) return txt + '，本次视野里有它的 ' + r.in_view + ' 个采样点';
    var v = MAP.viewBounds && MAP.viewBounds();
    var where = v && !v.error ? '，线上最低纬度 ' + fmt(r.lat_min, 1) + '°、最高 ' + fmt(r.lat_max, 1) + '°，你当前只看 ' + fmt(v.lat_min, 1) + '°～' + fmt(v.lat_max, 1) + '°' : '';
    return txt + warn('，但一个采样点都不在本次视野里' + where + '——点地图上的「全览」或把地图往外缩（滚轮向下）就能看到');
  }

  function runAstAccuracy() {
    var a = eng('GEOASTRO');
    if (!a) { putError('astAccuracy', '缺 GEOASTRO 内核'); return; }
    var r = a.accuracy();
    if (r.error) { putError('astAccuracy', 'accuracy()：' + esc(r.message || r.error)); return; }
    var html = h4('内核自报精度：' + esc(r.grade)) +
      '<div class="tablewrap"><table class="grid"><thead><tr><th>项目</th><th>自报精度</th><th>由什么独立验证</th></tr></thead><tbody>';
    (r.items || []).forEach(function (it) {
      html += '<tr><td>' + esc(it.what) + '</td><td class="num">' + esc(it.acc) + '</td><td>' + esc(it.verified_by) +
        (it.leap ? '<br><span class="note">' + esc(it.leap) + '</span>' : '') + '</td></tr>';
    });
    html += '</tbody></table></div>';
    var mi = r.measured_internally || {};
    html += kv([
      ['月位 vs 二体内差', deg(mi.moon_lon_vs_twobody_max_deg, 4)],
      ['日位 vs 二体内差', deg(mi.sun_lon_vs_twobody_max_deg, 4)],
      ['月球黄纬最大', deg(mi.moon_lat_max_deg, 4)],
      ['月地距范围', (mi.moon_dist_range_km || []).map(function (x) { return fmt(x, 0); }).join(' … ') + ' km'],
      ['月项振幅（出差/均轮/黄纬）', deg(mi.evection_amplitude_deg, 4) + ' / ' + deg(mi.equation_of_center_deg, 4) + ' / ' + deg(mi.lunar_latitude_amplitude_deg, 4)]
    ]);
    html += note(esc(r.caveat));
    put('astAccuracy', html);
  }

  function bindAstro() {
    var a = eng('GEOASTRO');
    if (!a) { put('astResult', note(bad('GEOASTRO 内核未加载'))); return; }
    var el = $('astTime');
    if (el && !el.value) {
      var d = new Date();
      el.value = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    on('btnAstSun', 'click', runAstSun);
    on('btnAstMoon', 'click', runAstMoon);
    on('btnAstStar', 'click', runAstStar);
    on('btnAstPolar', 'click', runAstPolar);
    on('btnAstLat', 'click', runAstLat);
    on('btnAstSub', 'click', runAstSub);
    on('btnAstAccuracy', 'click', runAstAccuracy);
    on('astTerminator', 'change', function () {
      state.nightOn = B('astTerminator');
      syncMap();
      if (state.nightOn && !state.terminator)
        put('mapReadout', '游标：' + warn('还没算过日下点，画不出晨昏线——先点「计算并标出子太阳点与子月点」'));
    });
    if (a.STAR_TABLE) {
      var s = $('astStar');
      if (s) s.title = '星表 ' + a.STAR_TABLE.length + ' 颗：' + a.STAR_TABLE.slice(0, 8).map(function (x) { return x.zh + '/' + x.name; }).join('、') + '…';
    }
  }

  /* ============================================================ 15. ⑧ 联网与路由 */
  /* 出网的唯一开关是 GEONET 的 allow_real_network。本面板在任何「禁用联网」选择下
     都不会调用 fetch——策略由内核执行，界面只是不点它。 */
  var netRunning = false;
  function guardAsync(where, fn) {
    if (netRunning) { status('上一个联网任务（' + where + '）还没结束', 'busy'); return; }
    netRunning = true;
    status('联网请求进行中（' + where + '）…', 'busy');
    var p;
    try { p = fn(); } catch (e) { netRunning = false; fatal(where, e); return; }
    if (!p || typeof p.then !== 'function') { netRunning = false; return; }
    p.then(function () { netRunning = false; status('联网任务完成（' + where + '）', 'ok'); },
      function (e) { netRunning = false; fatal(where, e); });
  }
  function netSetup() {
    var n = eng('GEONET');
    if (!n) return { err: '缺 GEONET 内核（检查 app/core-net.js）' };
    var policy = V('netPolicy') || 'ip_only';
    // 默认值交给内核按当前来源算（同源回环 → 端口跟着页面走），这里不再硬写 8765
    var base = V('netBridge') || (n.defaultBridgeBase ? n.defaultBridgeBase() : n.networkPolicy().bridge_base);
    if (policy === 'offline_only') {
      n.setNetworkPolicy({ allow_real_network: false, bridge_base: base });
      return { err: '当前策略=禁用联网，本页不发起任何请求。要出网请把「隐私策略」改为「只用 IP」。' };
    }
    var set = n.setNetworkPolicy({ allow_real_network: true, bridge_base: base });
    if (set && set.error) return { err: '策略被内核拒绝：' + esc(set.error) };
    return { n: n, policy: policy, base: base, pol: n.networkPolicy() };
  }
  function netPolBlock(s) {
    return note('生效策略：allow_real_network=' + (s.pol.allow_real_network ? warn('true（本面板已授权出网）') : 'false') +
      '，bridge_base=' + esc(String(s.pol.bridge_base)) + '；' + esc(String(s.pol.note)) +
      (s.policy === 'ip_plus_gps' ? '<br>「IP + 精确 GPS」只表示允许把浏览器定位当作**本地比对的离线参考**（请到①总览手动点「用浏览器定位我在这里」）；本页没有任何把 GPS 坐标写进查询串的代码路径。' : ''));
  }
  function netPrivacy(n, ip) {
    var au = n.privacyAudit(ip ? { ip: ip } : {});
    var badList = (au.details || []).filter(function (x) { return !x.ok; });
    return kv([
      ['URL 构造审计', (au.violations || []).length ? bad('发现 ' + au.violations.length + ' 处坐标痕迹：' + esc(au.violations.join('；'))) : good('扫描 ' + au.checked + ' 个源，未发现任何坐标类参数')],
      ['无法构造的源', badList.length ? badList.map(function (x) { return esc(x.source) + '：' + esc(x.reason); }).join('<br>') : '无'],
      ['内核声明', esc(au.policy)]
    ]) + note(esc(au.caveat));
  }
  function errKindText(n, kind) {
    var t = n.ERROR_KINDS && n.ERROR_KINDS[kind];
    return t ? t : String(kind || '未分类');
  }
  function ipResultsTable(n, results) {
    var h = '<div class="tablewrap"><table class="grid"><thead><tr><th>源</th><th>lat, lon</th><th>精度 km</th><th>城市 / 国家</th><th>耗时</th><th>状态</th></tr></thead><tbody>';
    (results || []).forEach(function (r) {
      if (!r) return;
      h += '<tr><td>' + esc(r.source) + '</td><td class="num">' + (r.ok ? fmt(r.lat, 4) + ', ' + fmt(r.lon, 4) : '—') + '</td>' +
        '<td class="num">' + (r.ok ? fmt(r.accuracy_km, 1) + (r.accuracy_fallback ? ' *' : '') : '—') + '</td>' +
        '<td>' + esc(r.city || '—') + ' / ' + esc(r.country || '—') + (r.from_cache ? '<br><span class="note">缓存命中</span>' : '') + '</td>' +
        '<td class="num">' + (isNum(r.latency_ms) ? fmt(r.latency_ms, 0) + ' ms' : '—') + '</td>' +
        '<td>' + (r.ok ? good('ok') : bad(esc(errKindText(n, r.error_kind)) + '：' + esc(r.error || ''))) + '</td></tr>';
    });
    return h + '</tbody></table></div>' + note('* 该源未返回精度字段，用的是内核 DEFAULTS.unknown_accuracy_km 的保守兜底量级（刻意偏「不知道」，不是该源的实测精度）。');
  }
  function fusedBlock(n, f) {
    if (!f) return note('没有融合结果');
    if (f.error || f.ok !== true) return note(bad('融合不可用：' + esc(f.error || (f.error_kind ? errKindText(n, f.error_kind) + '：' : '') + (f.error || ''))));
    var cs = f.consistency || {}, md = f.mad || {};
    var html = kv([
      ['融合点', fmt(f.lat, 6) + ', ' + fmt(f.lon, 6)],
      ['算法 / 引擎', esc(f.method) + '（' + esc(f.engine) + '）'],
      ['报告精度', fmt(f.accuracy_km, 1) + ' km（取 BLUE σ 与加权 75% 分位的较大者）；BLUE σ ' + fmt(f.sigma_blue_km, 2) + ' km，保守分位 ' + fmt(f.accuracy_km_conservative, 1) + ' km'],
      ['用源', f.n_used + ' / ' + f.n_sources + ' 源'],
      ['χ² 一致性', 'χ²=' + fmt(cs.chi2, 3) + '，dof=' + cs.dof + '，p=' + (isNum(cs.p_value) ? cs.p_value.toExponential(2) : '—') +
        '（α=' + fmt(cs.alpha, 4) + '）→ ' + (cs.inconsistent ? warn('源之间在给定不确定度下互相矛盾') : good('源之间不矛盾'))],
      ['MAD 判据', '中位偏差 ' + fmt(md.median_dev_km, 2) + ' km，σ̂ ' + fmt(md.sigma_hat_km, 2) + ' km，k=' + fmt(md.outlier_mad_k, 1) + '，地板 ' + fmt(md.floor_km, 0) + ' km'],
      ['各源到融合点', (f.deviations_km || []).map(function (d) { return esc(d.source) + '：判群偏差 ' + fmt(d.dev_km, 1) + ' km / 最终 ' + fmt(d.dev_final_km, 1) + ' km'; }).join('<br>') || '—'],
      ['被剔除', (f.rejected || []).length ? (f.rejected || []).map(function (r) { return esc(r.source) + '（' + esc(r.reason) + '）'; }).join('<br>') : good('无')]
    ]);
    html += note((f.caveats || []).map(function (x) { return esc(x); }).join('　·　'));
    html += note(esc(f.note));
    return html;
  }
  function bridgeGeoIpAll(n, ip, toMs) {
    var ids = n.sourceIds();
    var base = n.networkPolicy().bridge_base;
    return Promise.all(ids.map(function (id) {
      var params = { source: id };
      if (ip) params.ip = ip;
      var built = n.buildBridgeUrl('/api/geoip', params, { bridge_base: base });
      if (built.error) return Promise.resolve(n.errorResult(id, 'bad_input', built.error));
      return n.httpGetJson(built.url, { fetch_timeout_ms: toMs }).then(function (got) {
        if (!got.ok) return n.errorResult(id, got.error_kind, got.detail || errKindText(n, got.error_kind));
        var j = got.json || {};
        if (j.ok !== true) {
          return n.errorResult(id, j.error_kind || 'http_error', String(j.error || ('桥接返回 ok=false，HTTP ' + j.http_status)));
        }
        return n.parseIpSource(id, j.upstream, { latency_ms: isNum(j.elapsed_ms) ? j.elapsed_ms : got.latency_ms });
      });
    }));
  }
  function collectIpSolutions(n, ip, toMs) {
    return n.bridgeStatus({ fetch_timeout_ms: 1500 }).then(function (st) {
      var caps = (st && Array.isArray(st.capabilities)) ? st.capabilities : [];
      if (st && st.ok === true && caps.indexOf('geoip') >= 0) {
        return bridgeGeoIpAll(n, ip, toMs).then(function (results) {
          return { via: 'bridge', bridge: st, results: results, fused: n.fuseIpSolutions(results, {}), health: n.healthSnapshot() };
        });
      }
      return n.fetchGeoIpAll({ ip: ip || undefined, fetch_timeout_ms: toMs }).then(function (all) {
        return { via: 'direct', bridge: st, results: all.results || [], fused: all.fused, health: all.health, note: all.note, error: all.error };
      });
    });
  }
  function viaBlock(c) {
    var b = c.bridge || {};
    return kv([
      ['通道', c.via === 'bridge' ? good('本机桥接服务 server.py（绕开浏览器 CORS/混合内容限制）') : warn('浏览器直连（桥接不可用，可能被 CORS、混合内容或网络策略拦截）')],
      ['桥接状态', b.ok ? good('在线 ' + esc(String(b.server)) + ' ' + esc(String(b.version)) + '，' + fmt(b.latency_ms, 0) + ' ms') : bad(esc(errKindText(eng('GEONET'), b.error_kind)) + '：' + esc(b.error || ''))],
      ['桥接能力', ((b.capabilities || []).join(' / ')) || '—']
    ]) + (c.via === 'direct' ? note('如果桥接其实已经启动，请把页面用 ' + esc(String(eng('GEONET').networkPolicy().bridge_base)) + '/ 打开（同源），file:// 页面访问回环端口会被浏览器的私有网络策略拦下。') : '');
  }

  function runGeoIp() {
    var s = netSetup(); if (s.err) { putError('netResult', s.err); return Promise.resolve(); }
    var n = s.n;
    var ip = V('netIp'); ip = ip ? ip.trim() : null;
    if (ip) {
      var vh = n.validateHost(ip);
      if (!vh.ok) { putError('netResult', '被查 IP 校验未通过：' + esc(vh.reason)); return Promise.resolve(); }
    }
    var toMs = N('netTimeout') || 8000;
    var html = netPolBlock(s) + netPrivacy(n, ip);
    put('netResult', html + h4('查询中…'));
    return collectIpSolutions(n, ip, toMs).then(function (c) {
      state.online = { fused: c.fused, results: c.results, via: c.via, ts: new Date().toISOString(), ip: ip };
      html += h4('通道') + viaBlock(c);
      if (c.error) html += note(bad('多源查询失败：' + esc(c.error)));
      html += h4('各源结果') + ipResultsTable(n, c.results);
      html += h4('多源融合') + fusedBlock(n, c.fused);
      if (c.fused && c.fused.ok === true) {
        var rec = addSolution({
          source: 'IP 定位（' + (c.via === 'bridge' ? '桥接' : '直连') + '）',
          label: 'IP 融合点', lat: c.fused.lat, lon: c.fused.lon,
          accuracy_m: Math.round((c.fused.accuracy_km_conservative || n.DEFAULTS.unknown_accuracy_km) * 1000),
          basis: c.fused.n_used + '/' + c.fused.n_sources + ' 源，' + c.fused.method + '（' + c.fused.engine + '）'
        });
        if (rec) centerOn(rec.lat, rec.lon, 7);
        html += note('已把融合点登记为第 ' + rec.id + ' 号解（精度取保守分位）。它只是「联网侧独立证据」，不覆盖任何 GNSS/基站解。');
      }
      var esc2 = n.shouldEscalate(state.lastFix, c.fused && c.fused.ok ? c.fused : null, {});
      html += h4('对当前离线解的升级判定') + escalateBlock(n, esc2);
      put('netResult', html);
    });
  }
  function escalateBlock(n, d) {
    if (!d) return note('无判定结果');
    if (!d.checks || !d.checks.length) return note(warn('没有可判定的离线解：' + esc(d.reason || '本次会话还没解算过') + '。判定用的「离线解」来自⑥GNSS 面板最近一次解算，请先解一次。'));
    var th = d.thresholds || {};
    var rows = (d.checks || []).map(function (c) {
      var sev = isNum(c.severity) ? c.severity : null;
      var mark = c.fired === true ? bad('触发') : sev == null ? '—' : sev >= 0.4 ? bad(sev.toFixed(3)) : good(sev.toFixed(3));
      return '<tr><td>' + esc(c.name) + '</td><td class="num">' + mark + '</td><td>' + esc(c.detail) + '</td></tr>';
    }).join('');
    var html = '<div class="tablewrap"><table class="grid"><thead><tr><th>判据</th><th>强度</th><th>说明</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    html += kv([
      ['结论', d.escalate ? warn('建议升级：' + esc(d.reason)) : good('无需升级：' + esc(d.reason))],
      ['confidence', fmt(d.confidence, 4) + '（' + esc(d.confidence_basis || '启发式强度') + '）'],
      ['离线 σ（内核取用）', d.offline_sigma_m ? m(d.offline_sigma_m.e, 1) + ' / ' + m(d.offline_sigma_m.n, 1) + '（σ 地板 ' + m(th.sigma_floor_m, 0) + '）' : '—'],
      ['阈值', 'α=' + fmt(th.alpha, 4) + '，HDOP≤' + th.max_hdop + '，RMS≤' + th.max_rms_residual_m + ' m，星数≥' + th.min_sats + '，z 硬阈 ' + th.z_hard]
    ]);
    html += note(esc(d.note));
    return html;
  }
  function runEscalate() {
    var s = netSetup(); if (s.err) { putError('escalateResult', s.err); return Promise.resolve(); }
    var n = s.n;
    if (!state.lastFix) put('escalateResult', h4('判定') + note(warn('本次会话还没有 GNSS 解算结果。判定用的「离线解」来自⑥GNSS 面板最近一次解算；现在只能先取联网证据。')));
    var ip = V('netIp'); ip = ip ? ip.trim() : null;
    return collectIpSolutions(n, ip, N('netTimeout') || 8000).then(function (c) {
      var d = n.shouldEscalate(state.lastFix, c.fused && c.fused.ok ? c.fused : null, {});
      var html = netPolBlock(s) + h4('联网侧证据') + fusedBlock(n, c.fused) +
        h4('χ² 一致性判定（离线 ↔ 联网）') + escalateBlock(n, d);
      if (state.lastFix) {
        html += h4('被检的离线解') + kv([
          ['来源', esc(state.lastFix.source || 'GNSS 单点定位')],
          ['位置', fmt(state.lastFix.lat, 6) + ', ' + fmt(state.lastFix.lon, 6)],
          ['σ_e/σ_n', m(state.lastFix.sigma_e_m, 2) + ' / ' + m(state.lastFix.sigma_n_m, 2)],
          ['HDOP / RMS / 星数', fmt((state.lastFix.dop || {}).hdop != null ? state.lastFix.dop.hdop : state.lastFix.hdop, 2) + ' / ' +
            m(state.lastFix.rms_residual_m, 2) + ' / ' + ((state.lastFix.sats_used != null ? state.lastFix.sats_used : state.lastFix.satellites) || '—')]
        ]);
      }
      put('escalateResult', html);
    });
  }
  function runTrace() {
    var s = netSetup(); if (s.err) { putError('netResult', s.err); return Promise.resolve(); }
    var n = s.n;
    var host = V('netHost');
    if (!host) { putError('netResult', '路由追踪需要填写目标主机（留空不会自动填，以免误查自己）'); return Promise.resolve(); }
    var vh = n.validateHost(host);
    if (!vh.ok) { putError('netResult', '主机名校验未通过：' + esc(vh.reason)); return Promise.resolve(); }
    var opt = { max_hops: N('netMaxHops') || 20, timeout_ms: N('netTimeout') || 20000 };
    return n.tracerouteViaBridge(vh.host, opt).then(function (r) {
      var html = netPolBlock(s) + h4('路由追踪 ' + esc(vh.host) + '（' + esc(String(vh.kind)) + '）');
      if (r.ok !== true) {
        html += kv([
          ['通道', warn(String(r.via || 'browser-fallback'))],
          ['失败', bad(esc(errKindText(n, r.error_kind)) + '：' + esc(r.error || ''))],
          ['伪造跳数', yesno(r.fabricated_hops === true) + '（内核在桥接不可达时返回空跳数，绝不编造）'],
          ['降级可得', r.fallback && r.fallback.ok ? 'DoH 解析到 ' + (r.fallback.answers || []).map(function (a) { return esc(a.data); }).join('、') : '无（DoH 也失败：' + esc((r.fallback && r.fallback.error) || '—') + '）'],
          ['限制', esc(r.limitation || '')]
        ]);
        html += note(esc(r.note || ''));
        put('netResult', html); return;
      }
      var hops = r.hops || [];
      html += kv([
        ['通道', good(String(r.via)) + '（系统 traceroute 由桥接服务以 argv + shell=False 执行）'],
        ['跳数', hops.length + '（' + (r.reached ? good('到达目标') : warn('未在 ' + opt.max_hops + ' 跳内到达')) + '）'],
        ['伪造跳数', yesno(r.fabricated_hops === true)],
        ['耗时', fmt(r.elapsed_ms, 0) + ' ms']
      ]);
      html += '<div class="tablewrap"><table class="grid"><thead><tr><th>#</th><th>IP</th><th>主机名</th><th>RTT ms</th><th>状态</th></tr></thead><tbody>';
      if (!hops.length) html += '<tr><td colspan="5">' + warn('零跳：系统命令没吐出可解析的行（权限不足/ICMP 被拦/命令输出格式未知）。内核宁可给空表，也不按期望跳数补点。') + '</td></tr>';
      hops.forEach(function (h) {
        var rv = (h.rtts_ms || []).map(function (x) { return fmt(x, 1); });
        if ((h.rtt_bounds || []).length) rv.push(esc(h.rtt_bounds[0]) + ' ms×' + h.rtt_bounds.length);
        html += '<tr><td class="num">' + h.hop + '</td><td>' + esc(h.ip || '—') + '</td><td>' + esc(h.hostname || '—') + '</td>' +
          '<td class="num">' + (rv.length ? rv.join(' / ') : '—') + '</td>' +
          '<td>' + (h.timed_out ? warn('无响应（*）') : good('应答')) + (h.status ? ' ' + esc(h.status) : '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
      html += note(esc(r.note || '') + '；跳与跳之间的地理归属不在本工具能力内，不做任何猜测。');
      put('netResult', html);
    });
  }
  function runDoh() {
    var s = netSetup(); if (s.err) { putError('netResult', s.err); return Promise.resolve(); }
    var n = s.n;
    var host = V('netHost');
    if (!host) { putError('netResult', 'DoH 需要填写主机名'); return Promise.resolve(); }
    return n.dohResolve(host, { type: V('netDohType') || 'A', fetch_timeout_ms: N('netTimeout') || 8000 }).then(function (r) {
      var html = netPolBlock(s) + h4('DoH 解析 ' + esc(host) + '（' + esc(r.type || 'A') + '）');
      if (r.ok !== true) {
        html += kv([['状态', bad(esc(errKindText(n, r.error_kind)) + '：' + esc(r.error || ''))], ['URL', esc(r.url || '—')]]);
        put('netResult', html); return;
      }
      html += kv([['RCODE', esc(String(r.dns_status)) + '（' + esc(r.Status_text) + '）'], ['URL', esc(r.url)], ['耗时', fmt(r.latency_ms, 0) + ' ms']]);
      html += '<div class="tablewrap"><table class="grid"><thead><tr><th>类型</th><th>名称</th><th>数据</th><th>TTL</th></tr></thead><tbody>';
      (r.answers || []).forEach(function (a) {
        html += '<tr><td class="num">' + a.type + '</td><td>' + esc(a.name || '—') + '</td><td>' + esc(a.data) + '</td><td class="num">' + fmt(a.ttl, 0) + '</td></tr>';
      });
      html += '</tbody></table></div>' + note(esc(r.note));
      put('netResult', html);
    });
  }
  function runBridgeStatus() {
    var s = netSetup(); if (s.err) { putError('netResult', s.err); return Promise.resolve(); }
    var n = s.n;
    return n.bridgeStatus({ fetch_timeout_ms: 2500 }).then(function (r) {
      var html = netPolBlock(s) + h4('桥接自检') + kv([
        ['结果', r.ok ? good('在线') : bad(esc(errKindText(n, r.error_kind)) + '：' + esc(r.error || ''))],
        ['URL', esc(r.url || '—')],
        ['服务', esc(String(r.server || '—')) + ' ' + esc(String(r.version || '')) + '（Python ' + esc(String(r.python || '—')) + '，' + esc(String(r.platform || '—')) + '）'],
        ['能力', (r.capabilities || []).map(function (x) { return esc(x); }).join(' / ') || '—'],
        ['耗时', fmt(r.latency_ms, 0) + ' ms']
      ]);
      html += note(r.ok
        ? '桥接在回环上，只执行 traceroute/ping/dns/geoip 白名单命令；非回环绑定在启动阶段就被 server.py 拒绝。'
        : '桥接不可达时：路由追踪只能降级为 DoH（拿不到跳数），GeoIP 走浏览器直连，可能被 CORS 或混合内容拦截。说明书里有启动命令。');
      put('netResult', html);
    });
  }
  function runHealth() {
    var n = eng('GEONET');
    if (!n) { putError('netMisc', '缺 GEONET 内核'); return; }
    var hs = n.healthSnapshot(), cs = n.cacheStats({});
    var html = h4('源健康度') +
      '<div class="tablewrap"><table class="grid"><thead><tr><th>源</th><th>成/败</th><th>成功率</th><th>连续失败</th><th>最近错误</th><th>平均时延</th></tr></thead><tbody>';
    if (!hs.length) html += '<tr><td colspan="6">还没有任何联网记录（本面板不主动出网）。</td></tr>';
    hs.forEach(function (h) {
      html += '<tr><td>' + esc(h.source) + '</td><td class="num">' + h.ok_count + ' / ' + h.fail_count + '</td>' +
        '<td class="num">' + (h.success_rate == null ? '—' : pct(h.success_rate)) + '</td>' +
        '<td class="num">' + h.consecutive_failures + '</td>' +
        '<td>' + esc(h.last_error_kind ? errKindText(n, h.last_error_kind) : '—') + '</td>' +
        '<td class="num">' + fmt(h.latency_ms_avg, 0) + ' ms（末次 ' + fmt(h.latency_ms_last, 0) + '）</td></tr>';
    });
    html += '</tbody></table></div>';
    var pick = n.pickHealthySources({});
    html += h4('下一轮的选源') + kv([
      ['入选', (pick.sources || []).map(function (x) { return esc(x); }).join(' / ') || '—'],
      ['跳过', (pick.skipped || []).map(function (x) { return esc(x.source) + '（' + esc(x.reason) + '）'; }).join('<br>') || good('无')]
    ]);
    html += h4('缓存') + kv([
      ['存储', esc(cs.storage) + '（前缀 ' + esc(cs.prefix) + '）'],
      ['条目', cs.count + ' 条' + ((cs.entries || []).length ? '：' + cs.entries.slice(0, 8).map(function (e) { return esc(e.key) + '（' + (e.age_ms == null ? '损坏' : e.age_ms + ' ms 前') + '）'; }).join('、') : '')]
    ]);
    html += note('健康度与缓存都在本机（localStorage），清空只影响本页；缓存 TTL ' + (n.DEFAULTS.cache_ttl_ms / 1000) + ' s。');
    put('netMisc', html);
  }
  function runResetNet() {
    var n = eng('GEONET');
    if (!n) { putError('netMisc', '缺 GEONET 内核'); return; }
    var rh = n.resetHealth(), cc = n.clearCache({});
    put('netMisc', h4('已清空') + kv([
      ['健康度', esc(rh.note)],
      ['缓存', (cc.ok ? good('移除 ' + cc.removed + ' 条') : bad('移除失败')) + '（存储 ' + esc(cc.storage) + '）']
    ]) + note('策略与本次会话的解不受影响；下一次查询会重新累积。'));
    status('已清空联网健康度与缓存', 'ok');
  }
  function bindNet() {
    var n = eng('GEONET');
    if (!n) { put('netResult', note(bad('GEONET 内核未加载，联网面板不可用'))); return; }
    var base = $('netBridge');
    if (base && !base.value) base.value = n.defaultBridgeBase ? n.defaultBridgeBase() : n.networkPolicy().bridge_base;
    on('btnGeoIp', 'click', function () { guardAsync('IP 定位', runGeoIp); });
    on('btnTrace', 'click', function () { guardAsync('路由追踪', runTrace); });
    on('btnDoh', 'click', function () { guardAsync('DoH', runDoh); });
    on('btnBridgeStatus', 'click', function () { guardAsync('桥接自检', runBridgeStatus); });
    on('btnEscalate', 'click', function () { guardAsync('升级判定', runEscalate); });
    on('btnHealth', 'click', function () { try { runHealth(); } catch (e) { fatal('btnHealth', e); } });
    on('btnCacheStats', 'click', function () { try { runHealth(); } catch (e) { fatal('btnCacheStats', e); } });
    on('btnResetNet', 'click', function () { try { runResetNet(); } catch (e) { fatal('btnResetNet', e); } });
    on('netPolicy', 'change', function () {
      var v = V('netPolicy');
      var np = v === 'offline_only' ? { allow_real_network: false } : { allow_real_network: true };
      var br = V('netBridge'); if (br) np.bridge_base = br;
      var r = n.setNetworkPolicy(np);
      status('网络策略：' + (v === 'offline_only' ? '已收回联网授权（内核不再出网）' : '已授权出网（allow_real_network=true）'), v === 'offline_only' ? 'ok' : 'busy');
      put('netMisc', h4('当前策略') + kv([
        ['allow_real_network', String(r.allow_real_network)],
        ['bridge_base', esc(String(r.bridge_base))],
        ['说明', esc(String(r.note))]
      ]));
    });
  }

  /* ============================================================ 16. ⑨ 批处理与导出 */
  var NUMRE = /^[-+−]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  function cleanNum(s) { return Number(String(s).replace('−', '-')); }

  function batchFields(line) {
    var d = V('batchDelim'), src = String(line == null ? '' : line);
    if (d === 'tab') return src.split('\t');
    var out = [], cur = '', q = false, seps = d === ',' ? ',' : ',;';
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (ch === '"') { q = !q; continue; }
      if (!q && seps.indexOf(ch) >= 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    out = out.map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    if (out.length < 2) {                       // 只有一段就按空白再切一次（"31.2304 121.4737" 或 DMS 串）
      var sp = src.trim().split(/[\s;]+/).filter(function (x) { return x !== ''; });
      if (sp.length > out.length) out = sp;
    }
    return out;
  }

  function batchOne(line, idx) {
    var g = eng('GEOGEO'), d = eng('GEODATUM');
    var r = { i: idx, raw: line, name: '点' + idx, lat: null, lon: null, h: null, how: '', warns: [], error: null };
    if (!g || !d) { r.error = '缺 GEOGEO/GEODATUM 内核'; return r; }
    var fs = batchFields(line);
    if (!fs.length) { r.error = '空行'; return r; }
    var nums = fs.filter(function (x) { return NUMRE.test(x); }).map(cleanNum);
    var txts = fs.filter(function (x) { return !NUMRE.test(x); });
    if (txts.length) r.name = txts[0];
    if (nums.length >= 2) {
      var la = nums[0], lo = nums[1];
      if (Math.abs(la) > 90 && Math.abs(lo) <= 90) { var t = la; la = lo; lo = t; r.warns.push('首值超 ±90，按「经度在前」交换'); }
      if (Math.abs(la) > 90) { r.error = '纬度超出 ±90：' + la; return r; }
      r.lat = la; r.lon = ((lo + 540) % 360) - 180;
      if (nums.length >= 3) { r.h = nums[2]; r.warns.push('第三个数当作高度 ' + nums[2] + ' m'); }
      if (txts.length === 0 && nums.length >= 3) r.name = '点' + idx;
      r.how = nums.length + ' 个数字字段';
      if (txts.length > 1) r.warns.push('另有 ' + (txts.length - 1) + ' 个非数字字段未使用：' + txts.slice(1).join(' / '));
    } else {
      var p = parseAnyBest(line);
      if (p.error) { r.error = p.error; return r; }
      var b = p.best || {};
      if (!isNum(b.lat) || !isNum(b.lon)) { r.error = '候选里没有可用的经纬度（' + esc(b.label || '未知') + '）'; return r; }
      r.lat = b.lat; r.lon = b.lon; r.how = (b.label || 'parseAny') + '，置信 ' + fmt(b.confidence, 2);
      if (txts.length && !/^[-+−'°"”’\d]/.test(txts[0])) r.name = txts[0];
      if ((p.candidates || []).length > 1) r.warns.push('这一行还有 ' + (p.candidates.length - 1) + ' 种读法，取置信度最高的一种');
    }
    r.dms = d.dmsFormat(r.lat, 'lat', 3).text + ' ' + d.dmsFormat(r.lon, 'lon', 3).text;
    var u = d.utmForward(r.lat, r.lon, 0, {});
    r.utm = u.error ? '—' : (u.scheme === 'UPS' ? 'UPS ' + fmt(u.easting, 2) + 'E ' + fmt(u.northing, 2) + 'N（|φ|>84°）' : u.zone + u.hemisphere + ' ' + fmt(u.easting, 2) + 'E ' + fmt(u.northing, 2) + 'N');
    var mg = d.mgrsFromLatLon(r.lat, r.lon, 5);
    r.mgrs = mg.error ? '—' : mg.mgrs;
    var gh = d.geohashEncode(r.lat, r.lon, 9);
    r.geohash = gh.error ? '—' : gh.geohash;
    var ol = d.olcEncode(r.lat, r.lon, 11);
    r.olc = ol.error ? '—' : ol.code;
    var wc = d.webMercatorForward(r.lat, r.lon);
    r.merc = fmt(wc.x, 2) + ', ' + fmt(wc.y, 2);
    var pr = g.precisionOf(r.lat, r.lon, 'WGS84');
    r.prec = m(pr.worst_m, 2) + '（' + pr.decimals + ' 位小数）';
    return r;
  }

  function runBatch() {
    var g = eng('GEOGEO');
    if (!g) { putError('batchStats', '缺 GEOGEO 内核'); return; }
    var raw = String(V('batchInput')), viaXml = '';
    /* 粘进文本框的 GPX/KML/GeoJSON 也认：走的是和「选择文件」同一个 extractCoords，两个入口不该一个能一个不能 */
    if (/<(gpx|wpt|trkpt|rtept|Placemark|coordinates)|^\s*[\{\[]/.test(raw.trim())) {
      var ex = extractCoords('pasted', raw);
      if (ex) {
        viaXml = '识别为 ' + (/^\s*[\{\[]/.test(raw.trim()) ? 'GeoJSON' : (/trkpt|wpt|rtept/i.test(raw) ? 'GPX' : 'KML')) +
          '，已提取 ' + ex.split('\n').length + ' 个点（名称, 纬度, 经度[, 高度]）';
        raw = ex;
      }
    }
    var lines = raw.split(/\r?\n/);
    var rows = [], errs = [], n = 0;
    lines.forEach(function (ln) {
      n++;
      var s = ln.trim();
      if (!s || s.charAt(0) === '#') return;
      var r = batchOne(s, rows.length + 1);
      if (r.error) { r.i = rows.length + 1; errs.push(r); } else rows.push(r);
    });
    state.batch = rows;
    renderBatch(errs);
    put('batchStats', (viaXml ? note(good(viaXml)) : '') + batchStats(g, rows, errs));
    var pts = rows.map(function (r) { return [r.lat, r.lon]; });
    setDraw('batch', { tracks: pts.length > 1 ? [{ points: pts, label: '批次顺序连线（' + rows.length + ' 点）', dash: true }] : [], focus: null });
    status('批处理：' + rows.length + ' 行成功，' + errs.length + ' 行失败', errs.length ? 'busy' : 'ok');
  }

  function renderBatch(errs) {
    var el = $('batchTable');
    if (!el) { miss.push('batchTable'); return; }
    var head = '<tr><th>#</th><th>名称</th><th>纬度</th><th>经度</th><th>高度</th><th>DMS</th><th>UTM/UPS</th><th>MGRS</th><th>Geohash</th><th>OLC</th><th>Web墨卡托</th><th>有效位</th><th>依据 / 提醒</th></tr>';
    var th = el.querySelector('thead'), tb = el.querySelector('tbody');
    if (th) th.innerHTML = head;
    var html = '';
    (state.batch || []).forEach(function (r) {
      html += '<tr><td>' + r.i + '</td><td>' + esc(r.name) + ' <button data-act="bloc" data-id="' + r.i + '">定位</button></td>' +
        '<td class="num">' + fmt(r.lat, 7) + '</td><td class="num">' + fmt(r.lon, 7) + '</td><td class="num">' + (isNum(r.h) ? fmt(r.h, 1) : '—') + '</td>' +
        '<td>' + esc(r.dms) + '</td><td>' + esc(r.utm) + '</td><td>' + esc(r.mgrs) + '</td><td>' + esc(r.geohash) + '</td><td>' + esc(r.olc) + '</td>' +
        '<td class="num">' + esc(r.merc) + '</td><td class="num">' + esc(r.prec) + '</td>' +
        '<td>' + esc(r.how) + (r.warns.length ? '<br><span class="note">' + r.warns.map(esc).join('；') + '</span>' : '') + '</td></tr>';
    });
    (errs || []).forEach(function (r) {
      html += '<tr><td>' + r.i + '</td><td colspan="12">' + bad('未解析：' + esc(r.raw)) + '<br><span class="note">' + esc(r.error) + '</span></td></tr>';
    });
    if (tb) tb.innerHTML = html || '<tr><td colspan="13">没有可解析的行。</td></tr>';
    if (tb) Array.prototype.forEach.call(tb.querySelectorAll('button[data-act="bloc"]'), function (btn) {
      btn.addEventListener('click', function () {
        var r = (state.batch || []).filter(function (x) { return x.i === Number(btn.getAttribute('data-id')); })[0];
        if (r) { centerOn(r.lat, r.lon, 10); addSolution({ source: '批处理：' + r.name, lat: r.lat, lon: r.lon, h: r.h, basis: r.how }); }
      });
    });
  }

  function batchStats(g, rows, errs) {
    if (!rows.length) return h4('批次统计') + note(bad('一行也没解析成功。检查分隔符（默认按逗号/Tab/分号/空白切分），或直接贴「名称, 纬度, 经度[, 高度]」。'));
    var pts = rows.map(function (r) { return { lat: r.lat, lon: r.lon }; });
    var html = h4('批次统计（' + rows.length + ' 点）') + kv([
      ['成功 / 失败', String(rows.length) + ' / ' + (errs.length ? bad(errs.length + ' 行') : good('0 行'))],
      ['名称', esc(rows.slice(0, 3).map(function (r) { return r.name; }).join('、')) + (rows.length > 3 ? '…' : '')]
    ]);
    var pl = g.polylineLength(pts, 'WGS84');
    html += h4('按粘贴顺序的量测') + kv([
      ['折线长度（未闭合）', km(pl.total_m) + ' = ' + m(pl.total_m, 1) + '，' + pl.count + ' 段'],
      ['最长 / 平均段', km(pl.max_m) + ' / ' + km(pl.avg_m)],
      ['独立检核：分段求和', m(pl.segments.reduce(function (a, b) { return a + b; }, 0), 3) + '（与总数差 ' + fmt(Math.abs(pl.segments.reduce(function (a, b) { return a + b; }, 0) - pl.total_m), 9) + ' m）']
    ]);
    if (pts.length >= 3) {
      var closed = pts.concat([pts[0]]);
      var pa = g.polygonArea(pts, 'WGS84'), pc = g.polylineLength(closed, 'WGS84');
      var hull = g.convexHull(pts), ha = g.polygonArea(hull, 'WGS84');
      html += h4('面积与外包') + kv([
        ['多边形面积（按粘贴顺序）', fmt(pa.km2, 3) + ' km² = ' + fmt(pa.hectares, 1) + ' ha = ' + fmt(pa.mu, 1) + ' 亩'],
        ['多边形周长', km(pa.perimeter_m) + '；外壳独立把首尾闭合再算一次 ' + km(pc.total_m) + '（差 ' + fmt(Math.abs(pa.perimeter_m - pc.total_m), 6) + ' m，用来核对面积函数的闭合边是否被计入）'],
        ['凸包顶点 / 面积', hull.length + ' / ' + fmt(ha.km2, 3) + ' km²'],
        ['凸包 − 多边形', fmt(ha.km2 - pa.km2, 3) + ' km² ' + (Math.abs(ha.km2 - pa.km2) < pa.km2 * 1e-6 ? good('≈0：粘贴顺序本身就是凸的') : warn('>0：点序构成凹形，面积按点序围成的区域计'))],
        ['球面 vs 平面面积', fmt(pa.km2, 3) + ' km² vs ' + fmt(pa.planar_m2 / 1e6, 3) + ' km²（内核自报投影误差 ' + fmt(pa.projection_error_pct, 3) + ' %）']
      ]);
    }
    var bb = g.boundingBox(pts);
    var mpd = g.metersPerDegree((bb.north + bb.south) / 2, 'WGS84');
    var cen = g.centroid(pts);
    html += h4('范围与质心') + kv([
      ['外包框', 'N ' + fmt(bb.north, 6) + ' S ' + fmt(bb.south, 6) + ' E ' + fmt(bb.east, 6) + ' W ' + fmt(bb.west, 6)],
      ['南北 / 东西跨度', m(bb.lat_span * mpd.lat_m, 1) + ' / ' + m(bb.lon_span * mpd.lon_m, 1) + '（按中线纬度换算）'],
      ['球面质心', fmt(cen.lat, 6) + ', ' + fmt(cen.lon, 6)],
      ['算术平均', fmt(cen.arithmetic.lat, 6) + ', ' + fmt(cen.arithmetic.lon, 6)],
      ['两者之差', m(g.inverse(cen.lat, cen.lon, cen.arithmetic.lat, cen.arithmetic.lon, 'WGS84').distance_m, 1) + '（跨经度大或靠近 180° 时，直接平均经度会翻到地球另一边）']
    ]);
    html += note('导出按钮用的就是这张表的数据；面积/质心只描述点集，不代表任何法定界址。');
    return html;
  }

  /* ---- 导出 ---- */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[<>&'"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]; });
  }

  function batchBuild(fmtKind) {
    var rows = state.batch || [], g = eng('GEOGEO');
    if (!rows.length) return { error: '先解析一批坐标' };
    if (fmtKind === 'geojson') {
      var feats = rows.map(function (r) {
        return {
          type: 'Feature', properties: { name: r.name, lat: r.lat, lon: r.lon, h: r.h, mgrs: r.mgrs, geohash: r.geohash, plus_code: r.olc, source: '经纬度定位工作站批处理' },
          geometry: { type: 'Point', coordinates: isNum(r.h) ? [r.lon, r.lat, r.h] : [r.lon, r.lat] }
        };
      });
      return { text: JSON.stringify({ type: 'FeatureCollection', name: 'llgz-batch', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features: feats }, null, 1), ext: 'geojson', mime: 'application/geo+json' };
    }
    if (fmtKind === 'gpx') {
      var t = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="经纬度定位工作站" xmlns="http://www.topografix.com/GPX/1/1">\n';
      rows.forEach(function (r) { t += '  <wpt lat="' + r.lat.toFixed(7) + '" lon="' + r.lon.toFixed(7) + '">' + (isNum(r.h) ? '<ele>' + r.h + '</ele>' : '') + '<name>' + xmlEsc(r.name) + '</name></wpt>\n'; });
      if (rows.length > 1) {
        t += '  <trk><name>' + xmlEsc('批次 ' + rows.length + ' 点') + '</name><trkseg>\n';
        rows.forEach(function (r) { t += '    <trkpt lat="' + r.lat.toFixed(7) + '" lon="' + r.lon.toFixed(7) + '">' + (isNum(r.h) ? '<ele>' + r.h + '</ele>' : '') + '</trkpt>\n'; });
        t += '  </trkseg></trk>\n';
      }
      t += '</gpx>\n';
      return { text: t, ext: 'gpx', mime: 'application/gpx+xml' };
    }
    if (fmtKind === 'kml') {
      var k = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n';
      rows.forEach(function (r) {
        k += '  <Placemark><name>' + xmlEsc(r.name) + '</name>' + (r.note || r.how ? '<description>' + xmlEsc(r.how) + '</description>' : '') +
          '<Point><coordinates>' + r.lon.toFixed(7) + ',' + r.lat.toFixed(7) + ',' + (isNum(r.h) ? r.h : 0) + '</coordinates></Point></Placemark>\n';
      });
      k += '</Document></kml>\n';
      return { text: k, ext: 'kml', mime: 'application/vnd.google-earth.kml+xml' };
    }
    if (fmtKind === 'gml' || fmtKind === 'wkt') {
      if (!g) return { error: '缺 GEOGEO 内核' };
      if (rows.length < 3) return { error: '边界 WKT 至少需要 3 个点（当前 ' + rows.length + '）' };
      var pts = rows.map(function (r) { return { lat: r.lat, lon: r.lon }; });
      var ring = g.convexHull(pts).map(function (p) { return fmt(p.lon, 7) + ' ' + fmt(p.lat, 7); });
      ring.push(ring[0]);
      var area = g.polygonArea(pts, 'WGS84');
      var caveat = '轴序 lon lat（EPSG:4326）；面积 ' + fmt(area.km2, 4) + ' km²（按粘贴顺序，非凸包）';
      /* WKT 没有注释语法，文件里塞一行 # 说明会让 shapely/GEOS 直接读失败，说明只写在界面上 */
      return {
        text: 'POLYGON((' + ring.join(', ') + '))\n',
        ext: 'wkt', mime: 'text/plain', note: caveat
      };
    }
    var head = ['序号', '名称', '纬度', '经度', '高度', 'DMS', 'UTM/UPS', 'MGRS', 'Geohash', 'OLC', 'Web墨卡托X', 'Web墨卡托Y', '有效位'];
    var out = [head.join(',')];
    rows.forEach(function (r) {
      out.push([r.i, csvCell(r.name), r.lat, r.lon, isNum(r.h) ? r.h : '', csvCell(r.dms), csvCell(r.utm), csvCell(r.mgrs), csvCell(r.geohash), csvCell(r.olc), csvCell(r.merc), csvCell(r.prec)].join(','));
    });
    return { text: '\ufeff' + out.join('\r\n') + '\r\n', ext: 'csv', mime: 'text/csv;charset=utf-8' };
  }

  function stampName(ext) {
    var d = new Date();
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return 'llgz-' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()) + '.' + ext;
  }

  function batchExport() {
    var b = batchBuild(V('batchFmt') || 'csv');
    if (b.error) { put('batchStats', h4('导出') + note(bad(esc(b.error)))); return; }
    var ok1 = false, why = '';
    try {
      if (global.URL && global.URL.createObjectURL && global.Blob && DOC && DOC.createElement) {
        var a = DOC.createElement('a'),
          blob = new Blob([b.text], { type: /charset/i.test(b.mime) ? b.mime : b.mime + ';charset=utf-8' });
        a.href = global.URL.createObjectURL(blob);
        a.download = stampName(b.ext);
        DOC.body.appendChild(a); a.click();
        setTimeout(function () { try { global.URL.revokeObjectURL(a.href); DOC.body.removeChild(a); } catch (e) { } }, 200);
        ok1 = true;
      }
    } catch (e) { why = String(e && e.message || e); }
    put('batchStats', h4('导出（' + esc(b.ext) + '，' + b.text.length + ' 字符）') +
      (ok1 ? note(good('已交给浏览器下载。文件名 ' + stampName(b.ext) + '。')) : note(warn('这个环境不允许直接下载（' + esc(why || '无 Blob/createObjectURL') + '），下面是全文，可手动复制保存：'))) +
      (ok1 ? '' : pre(b.text.slice(0, 4000) + (b.text.length > 4000 ? '\n…（截断，完整内容请用「复制到剪贴板」）' : ''))) +
      note('CSV/GeoJSON/GPX/KML 的轴序差异：GeoJSON 与 KML 是「经度,纬度」，GPX 用 lat/lon 属性，CSV 按表头列名。') +
      (b.note ? note(esc(b.note)) : ''));
  }

  function batchCopy() {
    var b = batchBuild(V('batchFmt') || 'csv');
    if (b.error) { put('batchStats', h4('复制') + note(bad(esc(b.error)))); return; }
    var done = function (how) { put('batchStats', h4('复制') + note(good('已' + how + '：' + b.text.length + ' 字符（' + esc(b.ext) + '）。'))); };
    var text = b.text.replace(/^\uFEFF/, '');   // BOM 只服务导出文件的 Excel 识别，剪贴板里它是多余字符
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(function () { done('写入剪贴板'); }, function (e) { fallbackCopy(text, String(e && e.message || e)); });
    } else fallbackCopy(text, '无 clipboard API');
  }

  function fallbackCopy(text, why) {
    var ta = DOC && DOC.createElement ? DOC.createElement('textarea') : null;
    try {
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      DOC.body.appendChild(ta); ta.select();
      var okc = DOC.execCommand && DOC.execCommand('copy');
      DOC.body.removeChild(ta);
      put('batchStats', h4('复制') + note((okc ? good('已用 execCommand 复制') : bad('浏览器拒绝复制')) + '（' + esc(why) + '）。file:// 页面通常在安全上下文外，clipboard API 会被拦，建议改用「导出文件」。'));
      if (!okc) put('batchStats', h4('复制失败，全文如下') + pre(text.slice(0, 4000)));
    } catch (e) { put('batchStats', h4('复制') + note(bad(esc(String(e && e.message || e)) + '（' + esc(why) + '）'))); }
  }

  function batchFileLoad(file) {
    if (!file || !global.FileReader) { status('这个环境读不了文件，直接把内容粘到文本框里', 'bad'); return; }
    var fr = new global.FileReader();
    fr.onload = function () {
      var txt = String(fr.result || '');
      var extracted = extractCoords(file.name || '', txt);
      var el = $('batchInput');
      if (el) el.value = extracted || txt.slice(0, 200000);
      runBatch();
      status('已读入 ' + file.name + (extracted ? '（从地理文件提取 ' + extracted.split(/\r?\n/).length + ' 行）' : ''), 'ok');
    };
    fr.onerror = function () { status('文件读取失败：' + (fr.error && fr.error.name || '未知'), 'bad'); };
    fr.readAsText(file, 'utf-8');
  }

  /* 从 GPX / KML / GeoJSON 文本里提出「名称, 纬度, 经度[, 高度]」——全部本地正则/JSON 解析 */
  function extractCoords(name, txt) {
    var out = [], s = String(txt || '');
    if (/\.(geojson|json)$/i.test(name) || /^\s*[\{\[]/.test(s)) {
      try {
        var j = JSON.parse(s);
        var feats = j.type === 'FeatureCollection' ? j.features : (j.type === 'Feature' ? [j] : []);
        feats.forEach(function (f, i) {
          var co = f && f.geometry && f.geometry.coordinates;
          if (!co) return;
          var one = typeof co[0] === 'number' ? co : (co[0] && typeof co[0][0] === 'number' ? co[0] : null);
          if (!one) return;
          var nm = (f.properties && (f.properties.name || f.properties.zh_name)) || ('要素' + (i + 1));
          out.push(csvCell(nm) + ', ' + one[1] + ', ' + one[0] + (one.length > 2 ? ', ' + one[2] : ''));
        });
        if (out.length) return out.join('\n');
      } catch (e) { return ''; }
    }
    var m = s.match(/<(?:wpt|trkpt|rtept)[^>]*\blat="([-\d.]+)"\s+lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/(?:wpt|trkpt|rtept)>/gi);
    if (m) {
      m.forEach(function (seg, i) {
        var la = seg.match(/lat="([-\d.]+)"/), lo = seg.match(/lon="([-\d.]+)"/), nm = seg.match(/<name>([\s\S]*?)<\/name>/), el = seg.match(/<ele>([\s\S]*?)<\/ele>/);
        if (!la || !lo) return;
        out.push(csvCell(nm ? nm[1] : '点' + (i + 1)) + ', ' + la[1] + ', ' + lo[1] + (el ? ', ' + el[1] : ''));
      });
      if (out.length) return out.join('\n');
    }
    var cm = s.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi);
    if (cm) {
      cm.forEach(function (blk, bi) {
        var body = blk.replace(/<[^>]+>/g, '').trim().split(/\s+/);
        var nm = s.match(/<Placemark[^>]*>\s*<name>([\s\S]*?)<\/name>/);
        body.forEach(function (t, i) {
          var p = t.split(',');
          if (p.length < 2 || !isFinite(Number(p[0])) || !isFinite(Number(p[1]))) return;
          out.push(csvCell((bi ? '环' + (bi + 1) + '-' : '') + (i === 0 && nm ? nm[1] : '点' + (i + 1))) + ', ' + p[1] + ', ' + p[0] + (p[2] ? ', ' + p[2] : ''));
        });
      });
      if (out.length) return out.join('\n');
    }
    return '';
  }

  function pageLink(lat, lon, zoom) {
    var base = String(location.href || '').split('#')[0];
    return base + '#c=' + lat.toFixed(6) + ',' + lon.toFixed(6) + ',' + (zoom || 12);
  }

  function runShare() {
    var rows = state.batch || [];
    var lat, lon, zoom = 12, label;
    var last = state.solutions.length ? state.solutions[state.solutions.length - 1] : null;
    if (rows.length >= 3) { var c = eng('GEOGEO').centroid(rows.map(function (r) { return { lat: r.lat, lon: r.lon }; })); lat = c.lat; lon = c.lon; zoom = 6; label = '批次质心（' + rows.length + ' 点）'; }
    else if (rows.length) { lat = rows[0].lat; lon = rows[0].lon; label = rows[0].name; }
    else if (last) { lat = last.lat; lon = last.lon; label = last.source; }
    else { put('qrBox', note(bad('还没有可分享的点：先解析一批坐标或解算出一个解。'))); return null; }
    var link = pageLink(lat, lon, zoom);
    var el = $('shareLink');
    if (el) el.value = link;
    var osm = 'https://www.openstreetmap.org/?mlat=' + lat.toFixed(6) + '&mlon=' + lon.toFixed(6) + '#map=' + zoom + '/' + lat.toFixed(6) + '/' + lon.toFixed(6);
    var html = kv([
      ['标签', esc(label || '未命名')],
      ['坐标', fmt(lat, 6) + ', ' + fmt(lon, 6)],
      ['本页深链（对方打开就会居中）', esc(link)],
      ['纯文本（粘到①总览即可还原）', esc(fmt(lat, 6) + ', ' + fmt(lon, 6))],
      ['外部地图（需要联网，点了才会打开，本工具不代发请求）', esc(osm)]
    ]) + note('深链只携带经纬度，不含设备标识、历史或任何输入内容。');
    put('batchStats', h4('分享') + html);
    return { lat: lat, lon: lon, zoom: zoom, label: label, link: link, text: fmt(lat, 6) + ', ' + fmt(lon, 6) };
  }

  function runQr() {
    var s = runShare();
    if (!s) return;
    var box = $('qrBox');
    if (!box) { miss.push('qrBox'); return; }
    if (typeof global.qrcode !== 'function') { put('qrBox', note(bad('vendor/qrcode.js 未加载，无法本地生成二维码。'))); return; }
    try {
      var qr = global.qrcode(0, 'M');
      // vendor 编码器默认按 latin-1 取 charCodeAt&0xff；深链里可能出现中文目录名，切到 UTF-8 那档才不会截断字节
      if (global.qrcode.stringToBytesFuncs && global.qrcode.stringToBytesFuncs['UTF-8']) {
        global.qrcode.stringToBytes = global.qrcode.stringToBytesFuncs['UTF-8'];
      }
      qr.addData(s.link); qr.make();
      box.innerHTML = qr.createImgTag(4, 8, '定位分享二维码') + note('二维码由本机 vendor/qrcode.js 生成（' + qr.getModuleCount() + '×' + qr.getModuleCount() + ' 模块，纠错级 M），内容是上面那段本地格式文本，任何手机扫码得到的只是经纬度，不含设备信息。');
    } catch (e) { put('qrBox', note(bad('二维码生成失败：' + esc(String(e && e.message || e)) + '（多半是文本太长）'))); }
  }

  function bindBatch() {
    on('btnBatchRun', 'click', runBatch);
    on('btnBatchExport', 'click', batchExport);
    on('btnBatchCopy', 'click', batchCopy);
    on('btnShare', 'click', runShare);
    on('btnQr', 'click', runQr);
    on('batchFile', 'change', function (e) {
      var f = e && e.target && e.target.files && e.target.files[0];
      if (f) batchFileLoad(f);
    });
    on('btnBatchFile', 'click', function () {
      var el = $('batchFile');
      if (!el) { miss.push('batchFile'); return; }
      if (typeof el.click === 'function') el.click();
      else put('batchStats', note(warn('这个浏览器不能由脚本打开文件选择框，请手动把文件内容粘贴到文本框。')));
    });
    on('batchDelim', 'change', function () { if (state.batch) runBatch(); });
    on('batchFmt', 'change', function () { put('batchStats', h4('导出格式已选为 ' + esc(V('batchFmt'))) + note('点「导出文件」或「复制到剪贴板」生效。')); });
  }

  /* ============================================================ 17. ⑩ 历史与收藏 */
  function storeGet(key) {
    var v = lsGet(key, []);
    return Array.isArray(v) ? v : [];
  }
  function storeSet(key, arr) { return lsSet(key, arr.slice(0, 200)); }

  function recordHistory(rec, how) {
    if (!rec || !isNum(rec.lat)) return { ok: false, error: '没有可记录的解' };
    var list = storeGet(LS.hist);
    list.unshift({ ts: rec.ts || new Date().toISOString(), label: rec.label || rec.source, source: rec.source, lat: rec.lat, lon: rec.lon, h: rec.h || null, accuracy_m: rec.accuracy_m || null, how: how || '' });
    var r = storeSet(LS.hist, list);
    renderHistory();
    return r;
  }

  function histTime(iso) {
    var a = String(iso || '').match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/);
    return a ? a[2] + '-' + a[3] + ' ' + a[4] + ':' + a[5] : '—';
  }

  function renderHistory() {
    var el = $('histTable');
    if (!el) return;
    var tb = el.querySelector('tbody');
    var fav = storeGet(LS.fav), hist = storeGet(LS.hist);
    var html = '';
    function row(x, isFav, idx) {
      var kind = isFav ? 'f' : 'h';
      return '<tr><td>' + histTime(x.ts) + (isFav ? ' ' + good('★') : '') + '</td><td>' + esc(x.label || '未命名') + '</td>' +
        '<td class="num">' + fmt(x.lat, 6) + '</td><td class="num">' + fmt(x.lon, 6) + '</td><td>' + esc(x.source || '—') + (isNum(x.accuracy_m) ? ' / ' + m(x.accuracy_m, 0) : '') + '</td>' +
        '<td><button data-act="hloc" data-kind="' + kind + '" data-idx="' + idx + '">定位</button> ' +
        '<button data-act="' + (isFav ? 'hunfav' : 'hfav') + '" data-kind="' + kind + '" data-idx="' + idx + '">' + (isFav ? '取消收藏' : '收藏') + '</button> ' +
        '<button data-act="hdel" data-kind="' + kind + '" data-idx="' + idx + '">移除</button></td></tr>';
    }
    fav.forEach(function (x, i) { html += row(x, true, i); });
    hist.forEach(function (x, i) {
      var dup = fav.some(function (f) { return f.ts === x.ts && f.lat === x.lat && f.lon === x.lon; });
      if (!dup) html += row(x, false, i);
    });
    if (tb) tb.innerHTML = html || '<tr><td colspan="6">还没有记录。勾选「每次解算自动记历史」后，任何面板的解都会写进本机 localStorage（收藏则始终保留）。</td></tr>';
    if (tb) Array.prototype.forEach.call(tb.querySelectorAll('button[data-act]'), function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-kind'), idx = Number(btn.getAttribute('data-idx'));
        var keyName = kind === 'f' ? LS.fav : LS.hist;
        var arr = storeGet(keyName);
        var rec = arr[idx];
        var act = btn.getAttribute('data-act');
        if (act === 'hloc') {
          if (!rec) return;
          centerOn(rec.lat, rec.lon, 11);
          addSolution({ source: '历史：' + (rec.label || rec.source || ''), lat: rec.lat, lon: rec.lon, h: rec.h, accuracy_m: rec.accuracy_m, basis: '从' + (kind === 'f' ? '收藏' : '历史') + '调出（' + histTime(rec.ts) + '）' });
        } else if (act === 'hfav' && rec) {
          var f = storeGet(LS.fav); f.unshift(rec);
          var rr = storeSet(LS.fav, f);
          renderHistory();
          status(rr.ok ? '已收藏（本机共 ' + storeGet(LS.fav).length + ' 条）' : '收藏失败：' + (rr.error || ''), rr.ok ? 'ok' : 'bad');
        } else if (act === 'hunfav') {
          storeSet(LS.fav, arr.filter(function (x, i) { return i !== idx; })); renderHistory(); status('已取消收藏（历史记录未动）', 'ok');
        } else if (act === 'hdel') {
          storeSet(keyName, arr.filter(function (x, i) { return i !== idx; })); renderHistory(); status('已移除该条' + (kind === 'f' ? '收藏' : '历史'), 'ok');
        }
      });
    });
    var probe = lsSet('llgz.probe.v1', 1);
    if (probe.ok) { try { global.localStorage.removeItem('llgz.probe.v1'); } catch (e) { } }
    put('histNote', h4('本机存储') + kv([
      ['写入能力', probe.ok ? good('可用') : bad('不可写：' + esc(probe.error || ''))],
      ['键名', esc(LS.hist) + ' / ' + esc(LS.fav) + ' / ' + esc(LS.prefs)],
      ['条数', '历史 ' + hist.length + ' 条、收藏 ' + fav.length + ' 条（各上限 200 条，超出丢弃最旧的）']
    ]) + note('数据只存在这台机器的这个浏览器里：清缓存、换浏览器、换电脑都不会带过去；本页不会把历史发往任何服务器。'));
  }

  function saveCur() {
    if (!state.solutions.length) { status('本次会话还没有解', 'bad'); return; }
    var s = state.solutions[state.solutions.length - 1];
    var f = storeGet(LS.fav);
    var dup = f.some(function (x) { return Math.abs(x.lat - s.lat) < 1e-9 && Math.abs(x.lon - s.lon) < 1e-9 && x.source === s.source; });
    if (dup) { status('第 ' + s.id + ' 号解已经在收藏里', 'busy'); return; }
    f.unshift({ ts: new Date().toISOString(), label: s.label, source: s.source, lat: s.lat, lon: s.lon, h: s.h, accuracy_m: s.accuracy_m, how: '手动收藏' });
    var r = storeSet(LS.fav, f);
    renderHistory();
    status(r.ok ? '已收藏第 ' + s.id + ' 号解' : '收藏失败：' + (r.error || ''), r.ok ? 'ok' : 'bad');
  }

  function clearHist() {
    storeSet(LS.hist, []);
    renderHistory();
    status('历史已清空（收藏保留，上限 200 条）', 'ok');
  }

  function bindHistory() {
    on('btnSaveCur', 'click', saveCur);
    on('btnClearHist', 'click', clearHist);
    on('histAuto', 'change', function () { savePrefs(); });
    renderHistory();
  }

  /* ============================================================ 18. ⑪ 内核自检 */
  var ENGINES = [
    { ns: 'GEOGEO', name: '核心大地测量', quick: true },
    { ns: 'GEODATUM', name: '坐标系与格式', quick: true },
    { ns: 'GEOASTRO', name: '天象', quick: true },
    { ns: 'GEOCELL', name: '基站/信号', quick: false },
    { ns: 'GEOGNSS', name: 'GNSS', quick: false },
    { ns: 'GEONET', name: '联网与路由', quick: false }
  ];

  function runSelfTest(quick) {
    var t0 = Date.now();
    var total = 0, failed = 0, blocks = [];
    var picked = ENGINES.filter(function (e) { return !quick || e.quick; });
    picked.forEach(function (e) {
      var k = eng(e.ns);
      if (!k || typeof k.selfTest !== 'function') {
        failed++; total++;
        blocks.push({ ns: e.ns, name: e.name, gates: 1, bad: 1, rows: [['内核缺失', 'bad', '找不到 ' + e.ns + '（检查 app/ 脚本是否都加载）']] });
        return;
      }
      var rows = [], bad = 0, out;
      try { out = k.selfTest(); } catch (err) { out = [{ name: 'selfTest 抛出异常', pass: false, detail: String(err && err.message || err) }]; }
      if (!Array.isArray(out)) out = [];
      out.forEach(function (t) {
        if (!t.pass) bad++;
        if (!t.pass || B('stShowPass')) rows.push([t.name, t.pass ? 'ok' : 'bad', t.detail]);
      });
      total += out.length; failed += bad;
      blocks.push({ ns: e.ns, name: e.name, gates: out.length, bad: bad, rows: rows });
    });
    var html = '';
    blocks.forEach(function (b) {
      html += h4(b.ns + ' — ' + b.name + '：' + b.gates + ' 门，' + (b.bad ? bad(b.bad + ' 个失败') : good('0 失败'))) +
        (b.rows.length ? '<div class="tablewrap"><table class="grid"><thead><tr><th>门</th><th>结果</th><th>实测值</th></tr></thead><tbody>' +
          b.rows.map(function (r) {
            return '<tr><td>' + esc(r[0]) + '</td><td>' + (r[1] === 'bad' ? bad('FAIL') : good('PASS')) + '</td><td class="num">' + esc(r[2]) + '</td></tr>';
          }).join('') + '</tbody></table></div>' : note(good('全部通过（勾「展开通过项明细」看每一门的实测值）')));
    });
    var env = envReport();
    var okAll = failed === 0 && env.bad === 0;
    var skipped = ENGINES.filter(function (e) { return quick && !e.quick; }).map(function (e) { return e.ns; });
    put('stSummary', h4('总览') + kv([
      ['本次范围', quick ? '快速：' + picked.map(function (e) { return e.ns; }).join('、') : '全量 6 个内核'],
      ['闸门总数', String(total)],
      ['失败', failed ? bad(String(failed)) : good('0')],
      ['耗时', fmt((Date.now() - t0) / 1000, 2) + ' s'],
      ['界面元素缺失', env.miss ? warn(env.miss + ' 个 id 找不到') : good('0')],
      ['结论', okAll ? good('所有闸门 0 失败，依赖与界面齐备') : bad('存在失败项，见下方明细')]
    ]) + env.html + (skipped.length ? note(warn('快速模式跳过了 ' + skipped.join('、') + '；出具验收结论请跑全量。')) : ''));
    put('stDetail', html);
    status(okAll ? '自检通过：' + total + ' 门 0 失败' : '自检失败 ' + failed + ' 门', okAll ? 'ok' : 'bad');
    if (!quick && eng('GEONET') && typeof eng('GEONET').selfTestAsync === 'function' && !netRunning) {
      guardAsync('内核自检（异步）', function () {
        return eng('GEONET').selfTestAsync().then(function (list) {
          var b = (list || []).filter(function (x) { return !x.pass; });
          var el = $('stDetail');
          if (el) el.innerHTML += h4('GEONET 异步门（含并发/超时/缓存/隐私策略）：' + (list || []).length + ' 门，' + (b.length ? bad(b.length + ' 失败') : good('0 失败'))) +
            (b.length ? '<div class="tablewrap"><table class="grid"><thead><tr><th>门</th><th>实测值</th></tr></thead><tbody>' +
              b.map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td class="num">' + esc(x.detail) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '');
        });
      });
    }
  }

  function envReport() {
    var k = ENGINES.filter(function (e) { return !!eng(e.ns); }).length;
    var hasL = typeof G.L !== 'undefined', hasQ = typeof global.qrcode === 'function';
    var gd = eng('GEODATA');
    var gdKeys = gd ? Object.keys(gd).join('、') : '—';
    var ls = lsSet('llgz.probe.v2', 1);
    // 「GEODATA 已加载」和「地图上真的画出了陆域」是两件事：数据结构与渲染代码一旦不一致，
    // 地图就变成一块空白底，而旧报告照样全绿。这里直接数挂在 base 图层上的多边形块数。
    var mp = (hasL && typeof G.GEOUI_MAP !== 'undefined' && G.GEOUI_MAP.layerStats) ? G.GEOUI_MAP.layerStats() : null;
    var landBad = hasL && (!mp || !mp.ready || mp.land_blocks <= 0 || (mp.layers && mp.layers.base || 0) <= 0);
    var landRow = !hasL ? warn('Leaflet 未加载，跳过陆域渲染检查')
      : (landBad ? bad('地图就绪但一个陆域多边形都没挂上（blocks=' + (mp ? mp.land_blocks : '—') +
          '，base 图层对象=' + (mp && mp.layers ? mp.layers.base : '—') + '）：查数据嵌套与 buildLand 是否一致')
        : good('陆域多边形 ' + mp.land_blocks + ' 块已挂图（base 图层 ' + mp.layers.base + ' 个对象）'));
    var missU = [];
    miss.forEach(function (id) { if (missU.indexOf(id) < 0) missU.push(id); });
    var html = h4('运行环境') + kv([
      ['内核', k + ' / 6 已加载' + (k === 6 ? ' ' + good('齐') : ' ' + bad(ENGINES.filter(function (e) { return !eng(e.ns); }).map(function (e) { return e.ns; }).join('、')))],
      ['地图组件', hasL ? good('Leaflet 已加载') : warn('未加载：矢量陆域与底图不可用，数值功能不受影响')],
      ['二维码', hasQ ? good('vendor/qrcode.js 已加载') : bad('未加载：二维码不可用')],
      ['离线数据', gd ? good('GEODATA：' + esc(gdKeys)) : bad('未加载 GEODATA（app/data/ 三个文件）')],
      ['矢量陆域', landRow],
      ['localStorage', ls.ok ? good('可写') : bad('不可写：' + esc(ls.error || ''))],
      ['协议', esc(location.protocol) + (location.protocol === 'file:' ? '（路由追踪需要 server.py 桥接）' : '')],
      ['界面缺失 id', missU.length ? warn(missU.join('、')) : good('0 个')]
    ]);
    if (ls.ok) { try { global.localStorage.removeItem('llgz.probe.v2'); } catch (e) { } }
    return { html: html, bad: (k === 6 ? 0 : 1) + missU.length + (landBad ? 1 : 0), miss: missU.length };
  }

  /* ============================================================ 19. 启动 */
  function populateSelects() {
    var g = eng('GEOGEO'), d = eng('GEODATUM'), c = eng('GEOCELL');
    var e1 = $('abEll');
    if (g && e1 && !e1.options.length) {
      Object.keys(g.ELLIPSOIDS).forEach(function (id) {
        var o = DOC.createElement('option'); o.value = id; o.text = g.ELLIPSOIDS[id].name; e1.appendChild(o);
      });
      e1.value = 'WGS84';
    }
    var m1 = $('abMethod');
    if (g && m1 && !m1.options.length) {
      [['auto', '自动（按椭球选最稳的一条）'], ['strict', '严格大地线（数值积分）'], ['haversine', 'Haversine 球面'], ['spherical', '球面大圆']].forEach(function (p) {
        var o = DOC.createElement('option'); o.value = p[0]; o.text = p[1]; m1.appendChild(o);
      });
      m1.value = 'auto';
    }
    ['datumSel', 'datumSel2'].forEach(function (id, i) {
      var el = $(id);
      if (d && el && !el.options.length) {
        Object.keys(d.CRS).forEach(function (k) {
          if (d.CRS[k].kind !== 'geo') return;
          var o = DOC.createElement('option'); o.value = k; o.text = d.CRS[k].name; el.appendChild(o);
        });
        el.value = i === 0 ? 'CGCS2000' : 'WGS84';
        if (!el.value) el.selectedIndex = 0;
      }
    });
    var models = c ? Object.keys(c.MODELS).map(function (k) { return [k, c.MODELS[k].name]; }) : null;
    if (models) {
      ['cellModel', 'sigModel'].forEach(function (id) {
        var el = $(id);
        if (!el || el.options.length) return;
        models.forEach(function (p) { var o = DOC.createElement('option'); o.value = p[0]; o.text = p[1]; el.appendChild(o); });
        el.value = 'fspl';
      });
    }
  }

  function chipOn(a, b) {
    var ea = $(a), eb = $(b);
    if (ea) ea.classList.add('active');
    if (eb) eb.classList.remove('active');
  }

  /* 准星读数：把正中心那一点用六种写法摊开，再加最近城市做人工核对锚点 */
  function crossLine(lat, lon) {
    var d = eng('GEODATUM'), MAP = mapOf();
    var seg = ['准星：' + fmt(lat, 6) + ', ' + fmt(lon, 6)];
    if (d && d.dmsFormat) seg.push(d.dmsFormat(lat, 'lat', 2).text + ' ' + d.dmsFormat(lon, 'lon', 2).text);
    if (d && d.utmForward) {
      var u = d.utmForward(lat, lon, 0);
      if (u && isNum(u.easting)) seg.push('UTM ' + u.zone + esc(u.hemisphere || '') + ' E' + fmt(u.easting, 1) + ' N' + fmt(u.northing, 1));
    }
    if (d && d.mgrsFromLatLon) { var m = d.mgrsFromLatLon(lat, lon, 5); if (m && m.mgrs) seg.push('MGRS ' + esc(m.mgrs)); }
    if (d && d.olcEncode) { var p = d.olcEncode(lat, lon, 11); if (p && p.code) seg.push('Plus Code ' + esc(p.code)); }
    if (d && d.geohashEncode) { var gh = d.geohashEncode(lat, lon, 9); if (gh && gh.geohash) seg.push('Geohash ' + esc(gh.geohash)); }
    if (MAP && MAP.nearestCity) {
      var nc = MAP.nearestCity(lat, lon, 1), c0 = nc && nc.list && nc.list[0];
      if (c0) seg.push('最近城市 ' + esc(c0.name) + ' ' + fmt(c0.km, 1) + ' km');
    }
    if (d && d.outOfChina && d.outOfChina(lat, lon)) seg.push(warn('在大陆偏转区：底图与 GNSS 坐标可差数十~数百米'));
    var z = MAP && MAP.centerPoint ? MAP.centerPoint().zoom : null;
    if (isNum(z)) seg.push('缩放 ' + z);
    return seg.join(' ｜ ');
  }

  function bindShell() {
    var tabs = DOC.querySelectorAll('.tab'), panels = DOC.querySelectorAll('.panel');
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-tab');
        state.tab = name;
        Array.prototype.forEach.call(tabs, function (b) { b.classList.toggle('active', b === btn); });
        Array.prototype.forEach.call(panels, function (p) { p.classList.toggle('active', p.getAttribute('data-panel') === name); });
        savePrefs();
        if (name === 'history') renderHistory();
        if (name === 'selftest' && !V('stSummary')) put('stSummary', note('点「运行全部自检」跑一遍六个内核。'));
      });
    });
    on('btnTheme', 'click', function () {
      var cur = DOC.body.getAttribute('data-theme');
      DOC.body.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
      savePrefs();
      var MAP = mapOf();
      if (MAP && MAP.restyle) MAP.restyle();
      if (state.lastSky) renderSky();
      status('主题：' + (DOC.body.getAttribute('data-theme') === 'dark' ? '深色' : '浅色'), 'ok');
    });
    /* navigator.onLine 只说明网卡活着，取不到瓦片照样是一片空白；
       所以「叠加了没有」要看真的回来几张，而不是看图层加没加。 */
    function tileLine(ts) {
      if (!ts) return '在线底图已叠加（瓦片来自 openstreetmap.org）';
      if (ts.loaded > 0) return '在线底图已叠加：本次回来 ' + ts.loaded + ' 张瓦片' + (ts.errored ? '，另有 ' + ts.errored + ' 张失败' : '');
      if (ts.errored > 0) return bad('一张瓦片都没取到（失败 ' + ts.errored + ' 次）：系统说能联网，但到不了 openstreetmap.org；地图上仍是离线矢量陆域');
      return warn('已请求在线底图，瓦片还没返回（网速慢或被拦截）；先按离线矢量显示');
    }
    on('btnTileOn', 'click', function () {
      var MAP = mapOf(); if (!MAP) return;
      var r = MAP.setTiles(true);
      chipOn('btnTileOn', 'btnTileOff');
      if (!(r && r.ok)) {
        put('mapReadout', '游标：' + bad('在线底图未开启：' + ((r && r.message) || (r && r.error) || '未知原因')));
        return;
      }
      put('mapReadout', '游标：' + tileLine(MAP.tileStatus && MAP.tileStatus()));
      global.setTimeout(function () {
        if (!mapOf() || !DOC.getElementById('btnTileOn').classList.contains('active')) return;
        put('mapReadout', '游标：' + tileLine(MAP.tileStatus && MAP.tileStatus()));
      }, 2500);
    });
    on('btnTileOff', 'click', function () {
      var MAP = mapOf(); if (MAP) MAP.setTiles(false);
      chipOn('btnTileOff', 'btnTileOn');
      put('mapReadout', '游标：已回到离线矢量');
    });
    on('btnFit', 'click', function () {
      var MAP = mapOf(); if (!MAP || !MAP.isReady()) return;
      var r = MAP.fitAll();
      put('mapReadout', '已框住 ' + (r && r.n != null ? r.n : 0) + ' 个结果' +
        (r && r.skipped && r.skipped.length ? '（内核跳过 ' + r.skipped.length + ' 个非有限坐标：' + esc(r.skipped.join(' ')) + '）' : ''));
    });
    on('btnCenter', 'click', function () {
      var s = state.solutions.length ? state.solutions[state.solutions.length - 1] : null;
      if (s) centerOn(s.lat, s.lon, 12);
      else { status('本次会话还没有解，无法「回到我的位置」', 'busy'); put('mapReadout', '游标：无解可居中（先在别的面板解算一次）'); }
    });
    on('chkGraticule', 'change', function () { var MAP = mapOf(); if (MAP) MAP.setGraticule(B('chkGraticule')); });
    on('chkCities', 'change', function () { var MAP = mapOf(); if (MAP) MAP.setCities(B('chkCities')); });
    on('btnCross', 'click', function () {
      var MAP = mapOf();
      if (!MAP || !MAP.setCrosshair) { status('地图层不可用（缺 vendor/leaflet.js），准星无从依附', 'busy'); return; }
      var r = MAP.setCrosshair(!(MAP.crosshairOn && MAP.crosshairOn()));
      if (r && r.error) { put('mapReadout', '准星：' + bad('地图还没初始化（' + esc(String(r.error)) + '）')); return; }
      var btn = $('btnCross'); if (btn) btn.classList.toggle('active', !!r.on);
      if (r.on) { put('mapReadout', crossLine(r.lat, r.lon)); status('准星已开：点地图任意处把该点转到正中，读数条跟着更新', 'ok'); }
      else { put('mapReadout', '游标：准星已关闭'); status('准星已关', 'ok'); }
    });
    var MAP = mapOf();
    if (MAP && MAP.bindCenter) MAP.bindCenter(function (lat, lon, on) {
      if (on) put('mapReadout', crossLine(lat, lon));
    });
    if (MAP && MAP.bindCursor) MAP.bindCursor(function (lat, lon) {
      var d = eng('GEODATUM');
      var t = fmt(lat, 5) + ', ' + fmt(lon, 5);
      if (d) t += ' ｜ ' + d.dmsFormat(lat, 'lat', 2).text + ' ' + d.dmsFormat(lon, 'lon', 2).text;
      // 准星开着时不能把锁定读数冲掉：两者并排显示，鼠标位置只作参考
      if (MAP.crosshairOn && MAP.crosshairOn() && MAP.centerPoint) {
        var c = MAP.centerPoint();
        put('mapReadout', crossLine(c.lat, c.lon) + ' ｜ 游标 ' + t);
      } else put('mapReadout', '游标：' + t);
    });
    global.addEventListener && global.addEventListener('online', function () { updateBadges(); });
    global.addEventListener && global.addEventListener('offline', function () { updateBadges(); });
  }

  function updateBadges() {
    var nb = $('netBadge');
    if (nb) {
      var onLine = global.navigator ? navigator.onLine : true;
      nb.textContent = onLine ? '在线' : '离线';
      nb.className = 'badge ' + (onLine ? 'badge-ok' : 'badge-off');
      nb.title = onLine ? '浏览器报告可联网；联网查询仍只在离线证据不足或你点击时发起' : '浏览器报告无网络：只用本地内核与已缓存的数据';
    }
    var kb = $('kernelBadge');
    if (kb) {
      var ok = ENGINES.filter(function (e) { return !!eng(e.ns); });
      kb.textContent = '内核 ' + ok.length + '/6';
      kb.title = ok.length === 6 ? ok.map(function (e) { return e.ns + ' v' + (eng(e.ns).VERSION || '?'); }).join('、') : '缺失：' + ENGINES.filter(function (e) { return !eng(e.ns); }).map(function (e) { return e.ns; }).join('、');
    }
  }

  function savePrefs() {
    lsSet(LS.prefs, {
      theme: DOC.body.getAttribute('data-theme'), tab: state.tab,
      histAuto: B('histAuto'), netPolicy: V('netPolicy'), bridge: V('netBridge'),
      graticule: B('chkGraticule'), cities: B('chkCities')
    });
  }

  function applyPrefs() {
    var p = lsGet(LS.prefs, null);
    if (!p || typeof p !== 'object') return;
    if (p.theme) DOC.body.setAttribute('data-theme', p.theme);
    if (p.histAuto) { var h = $('histAuto'); if (h) h.checked = !!p.histAuto; }
    if (p.netPolicy) { var s = $('netPolicy'); if (s) s.value = p.netPolicy; }
    if (p.bridge) {
      var b = $('netBridge');
      var nn = eng('GEONET');
      var auto = (nn && nn.defaultBridgeBase) ? nn.defaultBridgeBase() : 'http://127.0.0.1:8765';
      // 早期版本把 8765 写死在输入框里，并顺着「记住面板状态」一起存进了 prefs。
      // 同源页面（server.py 换了端口）不该被这条残留钉死，所以只有非残留值才恢复。
      if (b) b.value = (p.bridge === 'http://127.0.0.1:8765' && auto !== p.bridge) ? auto : p.bridge;
    }
    if (p.graticule != null) { var g = $('chkGraticule'); if (g) g.checked = !!p.graticule; }
    if (p.cities != null) { var c = $('chkCities'); if (c) c.checked = !!p.cities; }
    if (p.tab) {
      var btn = DOC.querySelector('.tab[data-tab="' + p.tab + '"]');
      if (btn) btn.click();
    }
  }

  function precisionBlock() {
    var g = eng('GEOGEO');
    if (!g) return note(bad('缺 GEOGEO 内核'));
    var rows = g.precisionTable('WGS84');
    var cur = state.solutions.length ? state.solutions[state.solutions.length - 1] : null;
    var html = h4('小数位 → 地面量级（赤道）') +
      '<div class="tablewrap"><table class="grid"><thead><tr><th>小数位</th><th>度步进</th><th>南北方向</th><th>东西（赤道）</th><th>够干什么</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td class="num">' + r.decimals + '</td><td class="num">' + r.deg_step.toExponential(0) + '</td><td class="num">' + m(r.meters_lat, r.meters_lat < 1 ? 3 : 1) + '</td><td class="num">' + m(r.meters_lon_equator, r.meters_lon_equator < 1 ? 3 : 1) + '</td><td>' + esc(r.note) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    if (cur) {
      var po = g.precisionOf(cur.lat, cur.lon, 'WGS84');
      html += h4('第 ' + cur.id + ' 号解的有效位') + kv([
        ['小数位', po.decimals + ' 位（取纬度与经度里较少的一个）'],
        ['南北 / 东西步进', m(po.meters_lat, 3) + ' / ' + m(po.meters_lon, 3)],
        ['最差方向', m(po.worst_m, 3) + '（' + esc(po.note) + '）'],
        ['说明', '步进是「最后一位数字代表多大距离」，不等于定位精度：精度要看来源的不确定度']
      ]);
    } else {
      html += note('本表按赤道换算；东西方向随纬度按 cos φ 收缩，内核在结果里按实际纬度重算。');
    }
    return html;
  }

  function applyHash() {
    var m = String(location.hash || '').match(/#c=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+))?/);
    if (!m) return false;
    var lat = Number(m[1]), lon = Number(m[2]), z = m[3] ? Number(m[3]) : 12;
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90) return false;
    centerOn(lat, lon, z);
    addSolution({ source: '深链', lat: lat, lon: lon, accuracy_m: null, basis: 'URL #c=' + m[1] + ',' + m[2] });
    status('已从链接定位：' + fmt(lat, 5) + ', ' + fmt(lon, 5), 'ok');
    return true;
  }

  function boot() {
    populateSelects();
    var MAP = mapOf();
    if (MAP) {
      var r = MAP.init('map');
      if (r && r.error === 'no_leaflet') put('mapReadout', '地图不可用（缺 vendor/leaflet.js）：所有计算仍可用');
    }
    bindOverview(); bindCoords(); bindCell(); bindTri(); bindSignal(); bindGnss(); bindAstro(); bindNet(); bindBatch(); bindHistory();
    on('btnRunAll', 'click', function () { runSelfTest(false); });
    on('btnRunQuick', 'click', function () { runSelfTest(true); });
    bindShell();
    applyPrefs();
    updateBadges();
    syncMap();
    if (!applyHash()) centerOn(31.2304, 121.4737, 5);
    put('precisionResult', precisionBlock());
    Array.prototype.forEach.call(DOC.querySelectorAll('input,select,textarea'), function (el) {
      el.addEventListener('change', savePrefs);
    });
    status('就绪：六个内核全部本地计算。第一个建议——⑪ 跑一次全量自检。', 'ok');
  }

  if (DOC && DOC.readyState === 'complete') boot();
  else if (DOC) global.addEventListener('DOMContentLoaded', boot);

})(typeof globalThis !== 'undefined' ? globalThis : window);
