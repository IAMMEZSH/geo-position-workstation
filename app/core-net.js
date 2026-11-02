/*
 * core-net.js — 经纬度定位工作站 · 联网定位层
 * （IP 地理定位多源投票 / 加权融合 / 离线→联网自动升级 / Wi-Fi·基站 RSSI 测距三角定位 / 路由追踪桥接）
 * 纯浏览器脚本：无 import/export、无第三方库；Node 下可直接 require 跑数值自检。
 *
 * 与兄弟模块的分工：
 *   · core-gnss 负责「卫星观测 → 位置」，core-cell 负责「基站链路预算 → 位置」；
 *     本模块负责「有网络时能拿到的外部事实」：第三方 IP 地理库、本地桥接服务 server.py 的
 *     traceroute/ping/DNS，以及把它们与离线解做一致性比对后决定「是否值得联网」。
 *   · 本模块**默认完全离线**：没有显式注入 fetchImpl（或显式打开 allow_real_network）时，
 *     所有联网入口都返回 offline_disallowed，绝不去摸环境里的 window.fetch。
 *     为什么这么定：自检必须在无网络、可重复的前提下跑；而 Node22/浏览器里全局 fetch 本来就存在，
 *     「能不用就不用」和「禁止使用」是两回事——只有默认拒绝才挡得住自检时的意外真实请求。
 *
 * 诚实性约定（与 core-gnss 同一条纪律）：
 *   1) 第三方 IP 地理库的**字段名与返回结构按各家公开文档写的，未逐字段核对**（每个源的
 *      fields_note 都写明了这一点）。因此解析器一律「缺字段就报错或走显式兜底」，绝不猜一个看起来合理的值。
 *   2) 源没报告精度时，权重融合仍然需要一个方差。这里用可配置的保守量级 unknown_accuracy_km，
 *      并在结果里打 accuracy_fallback:true。它是「不知道」的表达，不是该源的真实性能指标。
 *   3) 不伪造跳数/往返时延：桥接服务不可用就明确返回 bridge_unavailable + hops:null。
 *
 * 隐私红线（写进代码，也写进自检）：
 *   · 对外 URL 只可能带「被查的 IP」和「API key」，永不带用户经纬度。
 *     buildSourceUrl 的实现里根本没有读取 opt.lat / opt.lon 的代码路径——不是「忘了拼」，是没有这个入口。
 *   · 自检用假位置（31.23 / 121.47）跑一遍 URL 构造，并断言任何 URL 都不含这两个字符串。
 *   · 查询「本机出口 IP」本身就会把 IP 暴露给第三方，这一点在 note 里如实写明，不假装匿名。
 */
(function (global) {
  'use strict';

  /* ================================================================ 0. 基础工具 */
  var PI = Math.PI, D2R = PI / 180, R2D = 180 / PI, LN10 = Math.log(10);
  var C_MS = 299792458;                 // m/s，SI 定义值（精确）
  var WGS84 = { a: 6378137.0, f: 1 / 298.257223563 };
  WGS84.b = WGS84.a * (1 - WGS84.f);
  WGS84.e2 = WGS84.f * (2 - WGS84.f);
  var MEAN_R_KM = 6371.0088;            // IUGG 平均半径（球面近似用）
  // 局部等距尺度：米/度 = 曲率半径 × π/180（子午圈用 a(1-e²)，卯酉圈用 a）
  var M_PER_DEG_LAT = WGS84.a * (1 - WGS84.e2) * (PI / 180);
  var M_PER_DEG_LON_EQ = WGS84.a * (PI / 180);

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrap180(a) { var x = ((a % 360) + 360) % 360; return x > 180 ? x - 360 : x; }
  function rnd(v, n) { if (!isNum(v)) return null; var p = Math.pow(10, n == null ? 4 : n); return Math.round(v * p) / p; }
  function mPerDegLon(lat) { return M_PER_DEG_LON_EQ * Math.max(Math.cos(clamp(lat, -90, 90) * D2R), 1e-6); }
  function esc(v) { return String(v == null ? '' : v); }

  // 宽松数字：只接受有限数（字符串尝试转换一次），失败返回 null，绝不返回 NaN
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      var s = v.trim(), t = parseFloat(s);
      return s !== '' && isFinite(t) ? t : null;
    }
    return null;
  }
  function pickNum(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (var i = 0; i < keys.length; i++) {
      var v = num(obj[keys[i]]);
      if (v != null) return v;
    }
    return null;
  }
  function pickStr(obj, keys, maxLen) {
    if (!obj || typeof obj !== 'object') return null;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === 'string' && v.trim()) {
        // UI 会原样打印这些字段：把控制字符和换行压掉，避免日志被单条脏数据撑坏
        var s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        return s ? s.slice(0, maxLen || 64) : null;
      }
    }
    return null;
  }

  function greatCircleKm(lat1, lon1, lat2, lon2) {
    if (!(isNum(lat1) && isNum(lon1) && isNum(lat2) && isNum(lon2))) return null;
    if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lon1) > 180 || Math.abs(lon2) > 180) return null;
    var p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    var h = Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
    return 2 * MEAN_R_KM * Math.asin(clamp(Math.sqrt(h), 0, 1));
  }
  function toPlane(ref, lat, lon) {
    return { e: (lon - ref.lon) * mPerDegLon(ref.lat), n: (lat - ref.lat) * M_PER_DEG_LAT };
  }
  function toLatLon(ref, e, n) {
    return { lat: clamp(ref.lat + n / M_PER_DEG_LAT, -90, 90), lon: wrap180(ref.lon + e / mPerDegLon(ref.lat)) };
  }

  function quantile(arr, q) {
    var a = (Array.isArray(arr) ? arr : []).filter(isNum).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var qq = num(q);
    if (qq == null) return null;            // 分位点本身非法就返回 null，不把 NaN 传下去
    var pos = (a.length - 1) * clamp(qq, 0, 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function median(arr) { return quantile(arr, 0.5); }
  function mad(values) {
    var src = Array.isArray(values) ? values.filter(isNum) : [];
    var m = quantile(src, 0.5);
    if (m == null) return null;
    var dev = src.map(function (v) { return Math.abs(v - m); });
    var med = quantile(dev, 0.5);
    // 1.4826 = 1/Φ⁻¹(0.75)：正态分布下 MAD 换算成 σ 的一致估计因子（数学常数，非经验值）
    return med == null ? null : { median: m, mad_raw: med, sigma_hat: 1.4826 * med };
  }

  /* ---------- 卡方分布（自实现，独立于 core-gnss；自检用解析恒等式抓错） ---------- */
  function logGamma(z) {
    // Lanczos 近似 g=7, n=9（Abramowitz & Stegun 7.1.24 的系数表；用相对论式恒等式 Γ(z)Γ(1−z)=π/sin(πz) 自检）
    var c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214202, 12.507343278686905, -0.13857109526239824, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (!isNum(z) || z <= 0) return null;
    if (z < 0.5) {
      var s = Math.sin(PI * z);
      if (!(s > 0)) return null;
      var other = logGamma(1 - z);
      return other == null ? null : Math.log(PI / s) - other;
    }
    z -= 1;
    var x = c[0];
    for (var i = 1; i < 9; i++) x += c[i] / (z + i);
    var t = z + 7.5;
    return 0.5 * Math.log(2 * PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  function gammaincUpper(a, x) {
    // Q(a,x) = Γ(a,x)/Γ(a)。x<a+1 用级数算 P 再取补（级数在小区间收敛快），否则用连分式。
    if (!(isNum(a) && a > 0) || !(isNum(x) && x >= 0)) return null;
    if (x === 0) return 1;
    var lg = logGamma(a);
    if (lg == null) return null;
    if (x < a + 1) {
      var ap = a, sum = 1 / a, del = sum;
      for (var n = 1; n < 800; n++) {
        ap += 1; del *= x / ap; sum += del;
        if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
      }
      var P = sum * Math.exp(-x + a * Math.log(x) - lg);
      return clamp(1 - P, 0, 1);
    }
    var tiny = 1e-300;
    var b = x + 1 - a, cc = 1 / tiny, d = 1 / b, h = d;
    for (var k = 1; k < 800; k++) {
      var an = -k * (k - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
      cc = b + an / cc; if (Math.abs(cc) < tiny) cc = tiny;
      d = 1 / d;
      var del2 = d * cc;
      h *= del2;
      if (Math.abs(del2 - 1) < 1e-15) break;
    }
    return clamp(Math.exp(-x + a * Math.log(x) - lg) * h, 0, 1);
  }
  function chiSquareSurvival(x, dof) {
    if (!isNum(dof) || dof <= 0) return null;
    if (!isNum(x) || x < 0) return null;
    return gammaincUpper(dof / 2, x / 2);
  }
  function chiSquareCdf(x, dof) {
    var s = chiSquareSurvival(x, dof);
    return s == null ? null : 1 - s;
  }
  function chiSquareCritical(dof, upperProb) {
    // 分位值用二分求（避免引入未核对的查表常数）；单调性由 chiSquareSurvival 保证
    if (!isNum(dof) || dof <= 0) return null;
    var p = num(upperProb);
    if (p == null || p <= 0 || p >= 1) return null;
    var lo = 0, hi = Math.max(10, dof * 10 + 100), it = 0;
    while (chiSquareSurvival(hi, dof) > p && it++ < 200) hi *= 2;
    for (var i = 0; i < 200 && hi - lo > 1e-10; i++) {
      var mid = (lo + hi) / 2;
      if (chiSquareSurvival(mid, dof) > p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* ================================================================ 1. 运行环境注入与网络策略 */
  // 默认策略：拒绝使用环境里的 fetch/localStorage。自检与命令行 require 都走这条路，绝不出网。
  // 桥接默认地址：页面由本机桥接服务自己提供时，端口跟着页面走（同源）。
  // 否则 `python server.py --port 8899` 打开 http://127.0.0.1:8899/ 仍会去敲 8765，白白报「桥接不可用」。
  // file:// 双击、以及任何非回环来源都没有同源可用，一律退回默认端口 8765。
  function defaultBridgeBase(loc) {
    // 显式传参（自检用）时绝不回看真实 location：浏览器里那就是页面自己，会让闸门随环境漂移。
    var l = (arguments.length > 0)
      ? ((loc && typeof loc === 'object') ? loc : null)
      : (typeof location !== 'undefined' ? location : null);
    if (!l) return 'http://127.0.0.1:8765';
    var proto = String(l.protocol || '');
    var host = String(l.hostname || '');
    var loopback = /^127\./i.test(host) || /^localhost$/i.test(host) || host === '::1' || host === '[::1]';
    if (/^https?:$/i.test(proto) && loopback) {
      // 只认完整、合法的 origin 字符串；origin 缺失或为 'null'（不透明来源）时宁可用默认端口，也不拿 protocol+host 拼一个出来。
      var origin = String(l.origin || '');
      if (/^https?:\/\/[A-Za-z0-9.:\-\[\]]+$/i.test(origin)) return origin;
    }
    return 'http://127.0.0.1:8765';
  }

  var POLICY = {
    allow_real_network: false,   // 显式置 true 才允许用环境里的 global.fetch
    // 经纬度缓存是「你到过哪儿」的直接证据，写进宿主 localStorage 等于把明文留在磁盘上：
    // 同机进程、F12、备份、别人打开这个浏览器都能读。所以这里默认拒绝，
    // 宿主存储只允许显式注入（闸门、单测、以及知道自己在做加密的调用方）。
    // 要落盘的记录一律走 GEOVAULT（app/core-vault.js，AES-256-GCM）。
    allow_ambient_storage: false,
    bridge_base: defaultBridgeBase()
  };
  var memoryStore = Object.create(null);        // 默认容器：进程内，关页面即消失，不跨标签页共享
  // 出厂值单独留一份：闸门要断言的是「这版代码发布时默认关着」，而不是「跑到这儿时恰好关着」。
  var SHIPPED_ALLOW_AMBIENT_STORAGE = POLICY.allow_ambient_storage;
  var fetchTrapHits = [];                       // 自检用：记录「本应被拦住」的 fetch 调用
  var ambientStorageReads = 0;                  // 自检用：真正去读宿主 localStorage 的次数（默认策略下必须恒为 0）

  function setNetworkPolicy(patch) {
    if (!patch || typeof patch !== 'object') return { error: '策略参数需为对象' };
    if (typeof patch.allow_real_network === 'boolean') POLICY.allow_real_network = patch.allow_real_network;
    if (typeof patch.allow_ambient_storage === 'boolean') POLICY.allow_ambient_storage = patch.allow_ambient_storage;
    if (typeof patch.bridge_base === 'string' && patch.bridge_base) POLICY.bridge_base = patch.bridge_base;
    return networkPolicy();
  }
  function networkPolicy() {
    return {
      allow_real_network: POLICY.allow_real_network,
      allow_ambient_storage: POLICY.allow_ambient_storage,
      bridge_base: POLICY.bridge_base,
      note: '默认离线：未注入 fetchImpl 且 allow_real_network=false 时，任何联网入口都返回 offline_disallowed'
    };
  }

  // 取 fetch：只有 opt.fetchImpl 或显式授权后的环境 fetch 才会被使用
  function getFetch(opt) {
    var o = opt || {};
    if (typeof o.fetchImpl === 'function') return o.fetchImpl;
    if (o.fetchImpl !== undefined && o.fetchImpl !== null) return null;   // 显式传非函数＝没有 fetch
    if (!POLICY.allow_real_network) return null;
    var f = (typeof global.fetch === 'function') ? global.fetch : null;
    return f;
  }

  /* 存储抽象：duck-type 兼容 localStorage(getItem/setItem)、Map 风格(get/set)、裸对象。
   * 注意顺序：注入优先，其次才是宿主存储，而宿主存储默认就被策略挡在 return 之前——
   * 「默认不碰 localStorage」不是靠自觉，是靠这一行 early return。 */
  function rawStore(opt) {
    var o = opt || {};
    if (o.storage !== undefined && o.storage !== null) return { store: o.storage, kind: 'injected' };
    if (!POLICY.allow_ambient_storage) return { store: null, kind: 'disabled' };
    try {
      ambientStorageReads++;
      var ls = global.localStorage;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return { store: ls, kind: 'localStorage' };
    } catch (e) { /* 隐私模式下访问 localStorage 本身就会抛异常，这里就是「降级」的入口 */ }
    return { store: null, kind: 'memory' };
  }
  function storeGet(raw, key) {
    if (!raw) return null;
    try {
      if (typeof raw.getItem === 'function') return raw.getItem(key);
      if (typeof raw.get === 'function') return raw.get(key);
      if (typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
    } catch (e) { return null; }
    return null;
  }
  function storeSet(raw, key, val) {
    if (!raw) return false;
    try {
      if (typeof raw.setItem === 'function') { raw.setItem(key, val); return true; }
      if (typeof raw.set === 'function') { raw.set(key, val); return true; }
      if (typeof raw === 'object') { raw[key] = val; return true; }
    } catch (e) { return false; }   // 配额超限（QuotaExceeded）也走这里：缓存丢失不能影响定位
    return false;
  }
  function storeRemove(raw, key) {
    if (!raw) return false;
    try {
      if (typeof raw.removeItem === 'function') { raw.removeItem(key); return true; }
      if (typeof raw.delete === 'function') { raw.delete(key); return true; }
      if (typeof raw === 'object') { delete raw[key]; return true; }
    } catch (e) { return false; }
    return false;
  }
  // 返回一个可用的存储句柄：raw 为 null 时用模块级 memoryStore
  function storageHandle(opt) {
    var r = rawStore(opt);
    if (r.store) return { raw: r.store, kind: r.kind };
    return { raw: memoryStore, kind: (r.kind === 'disabled' ? 'disabled(policy)' : 'memory') };
  }

  /* ================================================================ 2. 错误分类与默认参数 */
  // 分类是刻意的：超时/HTTP 错误/JSON 解析失败/字段缺失的**处置策略不同**（重试？换源？改 URL？），
  // 揉成一句「请求失败」就没法做决策了。
  var ERROR_KINDS = {
    timeout: '请求超时（对端未在限定时间内响应）',
    http_error: 'HTTP 状态码非 2xx（可能被限流/鉴权失败/端点变更）',
    json_error: '响应不是合法 JSON（返回了 HTML 错误页或被网关改写）',
    field_missing: '关键字段缺失（该源未返回经纬度，按官方文档核对字段名后再接入）',
    field_invalid: '关键字段存在但取值非法（经纬度越界/类型错乱）',
    network: '网络层异常（DNS 失败/连接被拒/混合内容被浏览器拦截）',
    unsupported_env: '当前环境没有可用的 fetch，且未注入 fetchImpl',
    offline_disallowed: '默认离线策略拦截：未授权出网（自检与命令行运行时走此分支）',
    source_disabled: '该源被配置禁用',
    key_required: '该源需要 API key，未提供则跳过',
    bridge_unavailable: '本地桥接服务（server.py 或 bridge-powershell.ps1）不可达',
    // 这两类是桥接「主动按红线拒绝」，不是链路坏了：揉进 network 会让人去查网线。
    privacy_rejected: '桥接按隐私红线拒收（请求带了坐标类参数；桥接不接收、不转发任何坐标）',
    not_loopback: '桥接只服务回环来源（这条请求的来源地址不是 127.0.0.1/::1）',
    bad_input: '输入非法'
  };
  function errorResult(source, kind, detail) {
    // error_kind 必须落在枚举里：把 NaN/Infinity 这类「垃圾分类值」原样写进结果，
    // UI 就会打印出一个既不失败也不成功的第三种状态，比报错更难排查。
    var k = (typeof kind === 'string' && ERROR_KINDS[kind]) ? kind : 'network';
    var text = ERROR_KINDS[k];
    var d = detail == null ? '' : String(detail).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160).trim();
    return {
      ip: null, lat: null, lon: null, accuracy_km: null, city: null, country: null,
      source: source == null ? 'unknown' : String(source), ok: false,
      error: text + (d ? '：' + d : ''),
      error_kind: k,
      accuracy_fallback: false
    };
  }

  var DEFAULTS = {
    cache_prefix: 'geonet.v1.',      // 键名带版本前缀：字段语义变了就换前缀，避免读到旧结构
    cache_ttl_ms: 5 * 60 * 1000,
    fetch_timeout_ms: 8000,
    unknown_accuracy_km: 100,        // 兜底量级：公开评测里 IP 定位城市级 ~20-50km、国家级数百 km；
                                     // 100km 是刻意偏保守的「不知道」，不是任何官方指标
    fuse: {
      // 默认加权平均（BLUE）：加权中位数只用于「定标 + 剔群」，不作为最终点位——
      // 两点等权时加权中位数会取较小的那个（不关于中心对称），UI 上会显得「凭空偏一半」。
      // 需要抗噪场景（源里混了恶意/陈旧库）可显式传 weighted_median。
      method: 'weighted_mean',       // weighted_median | weighted_mean
      outlier_mad_k: 3.5,            // 3.5σ：与 core-cell 的 Tukey 围栏取同一量级，避免两模块判据不一致
      outlier_floor_km: 50,          // MAD 在近邻样本上会趋 0，纯 z 判定会把市内几十米差异也判成离群，故设地板
      max_keep: 6,
      alpha: 0.001
    },
    escalate: {
      alpha: 0.001,          // χ² 显著性：0.1% 才认定「矛盾」，低于此就当 IP 定位噪声，避免联网抖动
      max_hdop: 5,           // NMEA 惯例把 HDOP>5 归为不可用（属经验阈值，未逐字段核对规范，故可配置）
      max_rms_residual_m: 10, // 单点伪距残差 RMS>10m 说明存在未建模粗差
      min_sats: 4,
      sigma_floor_m: 1,      // σ→0 会让 z 爆炸成无穷大，先给地板
      z_hard: 5              // 偏离融合点 >5σ 直接升级（约 3σ 的两倍余量，容忍 IP 库的陈旧缓存）
    },
    rssi: {
      path_loss_exponent: 3.0,   // n=2 自由空间 / 3~4 城区（经验区间，需现场标定覆盖）
      freq_mhz: 2437,            // Wi-Fi 2.4G 信道 1 的中心频率
      shadow_sigma_db: null,     // 不默认给值：没有标定数据就是没有
      d_min_m: 0.1,
      d_max_m: 5e6
    },
    traceroute: { max_hops: 20, timeout_ms: 20000 }
  };

  /* ================================================================ 3. IP 地理定位源表 */
  /* 统一结果结构：{ip, lat, lon, accuracy_km, city, country, source, ok, error, error_kind,
   *                 accuracy_fallback, from_cache, latency_ms, note}
   * 字段名与返回结构各家都没逐字段核对（fields_note 里写明），所以解析器一律多键名候选 + 缺失容错。
   */
  var IP_SOURCES = [
    {
      id: 'ipapi_com',
      name: 'ip-api.com',
      url_self: 'http://ip-api.com/json/?fields=status,message,query,lat,lon,city,country,countryCode',
      url_query: 'http://ip-api.com/json/{ip}?fields=status,message,query,lat,lon,city,country,countryCode',
      requires_key: false,
      // 免费版仅 http（明文）；https 是付费层。这里如实标注，由调用方决定是否接受明文。
      note: '免费版走明文 HTTP，查询内容（你的出口 IP）对链路上的第三方可见',
      fields_note: '按 ip-api 文档：status/query/lat/lon/city/country/countryCode；无精度字段（未逐字段核对）',
      status_key: 'status', status_ok: 'success', msg_key: 'message',
      ip_keys: ['query', 'ip'], lat_keys: ['lat', 'latitude'], lon_keys: ['lon', 'longitude'],
      acc_keys: [], city_keys: ['city'], country_keys: ['country', 'countryName'],
      unknown_accuracy_km: 100
    },
    {
      id: 'ipinfo_io',
      name: 'ipinfo.io',
      url_self: 'https://ipinfo.io/json',
      url_query: 'https://ipinfo.io/{ip}/json',
      requires_key: false,
      key_param: 'token',
      note: 'loc 字段是「纬度,经度」的单个逗号字符串（顺序容易写反），解析时按文档拆分成两数',
      fields_note: '按 ipinfo 文档：ip/loc/city/region/country；loc="31.2304,121.4737"（未逐字段核对）',
      ip_keys: ['ip'], loc_key: 'loc',
      lat_keys: ['lat', 'latitude'], lon_keys: ['lon', 'lng', 'longitude'],
      acc_keys: [], city_keys: ['city'], country_keys: ['country', 'country_name'],
      unknown_accuracy_km: 50
    },
    {
      id: 'ipapi_co',
      name: 'ipapi.co',
      url_self: 'https://ipapi.co/json/',
      url_query: 'https://ipapi.co/{ip}/json/',
      requires_key: false,
      note: '匿名访问有频率限制，429 会被归为 http_error',
      fields_note: '按 ipapi.co 文档：ip/latitude/longitude/city/country_code/country_name；accuracy_radius 是否存在未逐字段核对，缺失即走兜底',
      ip_keys: ['ip'], lat_keys: ['latitude', 'lat'], lon_keys: ['longitude', 'lon'],
      acc_keys: ['accuracy_radius'],
      city_keys: ['city'], country_keys: ['country_code', 'country_name', 'country'],
      unknown_accuracy_km: 100
    },
    {
      id: 'ipwho_is',
      name: 'ipwho.is',
      url_self: 'https://ipwho.is/',
      url_query: 'https://ipwho.is/{ip}',
      requires_key: false,
      note: '成功标志是布尔 success（与 ip-api 的字符串 status 不同形），解析器分别处理',
      fields_note: '按 ipwho.is 文档：success/ip/latitude/longitude/city/country/country_code（未逐字段核对）',
      status_key: 'success', status_ok_bool: true, msg_key: 'message',
      ip_keys: ['ip'], lat_keys: ['latitude', 'lat'], lon_keys: ['longitude', 'lon'],
      acc_keys: [], city_keys: ['city'], country_keys: ['country', 'country_code'],
      unknown_accuracy_km: 100
    },
    {
      id: 'freeipapi',
      name: 'freeipapi.com',
      url_self: 'https://freeipapi.com/api/json',
      url_query: 'https://freeipapi.com/api/json/{ip}',
      requires_key: false,
      note: '字段命名风格与其它源差异最大（ipAddress / cityName），候选键名写在表里',
      fields_note: '按 freeipapi 文档：ipAddress/latitude/longitude/cityName/countryName/countryCode（未逐字段核对）',
      ip_keys: ['ipAddress', 'ip'], lat_keys: ['latitude', 'lat'], lon_keys: ['longitude', 'lon'],
      acc_keys: [], city_keys: ['cityName', 'city'], country_keys: ['countryName', 'countryCode', 'country'],
      unknown_accuracy_km: 150
    },
    {
      id: 'opencagedata',
      name: 'OpenCage Geocoder',
      url_self: null,                 // 该 API 必须给查询串，无法「查本机出口 IP」：宁可不支持也不猜 URL
      url_query: 'https://api.opencagedata.com/geocode/v1/json?q={ip}&key={key}&no_annotations=1&limit=1',
      requires_key: true,
      self_unsupported: true,
      note: '需要 API key；无 key 或未指定 ip 时该源直接跳过（不做「猜一个 URL」的事）',
      fields_note: '按 OpenCage 文档：results[0].geometry.lat/lng、components.city/country_code（未逐字段核对）',
      ip_keys: ['ip'], lat_keys: ['lat'], lon_keys: ['lng', 'lon'],
      acc_keys: [], city_keys: ['city'], country_keys: ['country_code', 'country'],
      nested_result: 'results',
      unknown_accuracy_km: 30
    }
  ];

  var SOURCE_BY_ID = {};
  IP_SOURCES.forEach(function (s) { SOURCE_BY_ID[s.id] = s; });

  function sourceIds() { return IP_SOURCES.map(function (s) { return s.id; }); }

  // 只替换 {ip} / {key} 两个占位符；opt.lat / opt.lon 在本函数没有任何读取路径（隐私红线的实现处）
  function buildSourceUrl(sourceId, opt) {
    var o = opt || {};
    var s = SOURCE_BY_ID[String(sourceId)];
    if (!s) return { error: '未知的 IP 地理定位源：' + esc(sourceId) };
    if (s.requires_key && !o.api_key) return { error: '源 ' + s.name + ' 需要 api_key，未提供则跳过', error_kind: 'key_required' };
    var ip = o.ip == null ? null : String(o.ip).trim();
    if (ip && /[^A-Za-z0-9.:\-_]/.test(ip)) return { error: '被查 IP 字面量含非法字符，已拒绝（避免把任意串拼进 URL）' };
    var selfQuery = !ip;
    if (selfQuery && s.self_unsupported) {
      return { error: '源 ' + s.name + ' 不支持「查本机出口 IP」（需要显式查询串），请指定 ip 或换源', error_kind: 'source_disabled' };
    }
    var tpl = selfQuery ? s.url_self : s.url_query;
    if (!tpl) return { error: '源 ' + s.name + ' 缺少该形态的 URL 模板', error_kind: 'source_disabled' };
    if (o.url_template_override && typeof o.url_template_override === 'string') {
      // 覆盖入口：端点变更/自建代理时用；同样只替换占位符，不接受调用方塞进来的位置信息
      tpl = o.url_template_override;
    }
    if (selfQuery && tpl.indexOf('{ip}') >= 0) return { error: '该 URL 模板要求 ip 占位符但未提供 ip', error_kind: 'bad_input' };
    var url = tpl.split('{ip}').join(ip ? encodeURIComponent(ip) : '');
    if (url.indexOf('{key}') >= 0) {
      if (!o.api_key) return { error: 'URL 模板含 {key} 占位符但未提供 api_key', error_kind: 'key_required' };
      url = url.split('{key}').join(encodeURIComponent(String(o.api_key)));
    }
    // key 作为查询参数追加的形态（ipinfo 的 ?token=）
    if (s.key_param && o.api_key) url += (url.indexOf('?') >= 0 ? '&' : '?') + s.key_param + '=' + encodeURIComponent(String(o.api_key));
    return {
      url: url,
      source: s.id,
      sends_ip: !!ip,
      sends_position: false,
      requires_key: !!s.requires_key,
      note: s.note || ''
    };
  }

  // 隐私审计：把所有源在当前 opt 下构造一遍，扫描 URL 里是否出现「位置味道」的键名/坐标值
  function privacyAudit(opt) {
    var o = opt || {};
    var checked = [], violations = [], url_list = [];
    var lat = num(o.lat), lon = num(o.lon);
    for (var i = 0; i < IP_SOURCES.length; i++) {
      var s = IP_SOURCES[i];
      var one = buildSourceUrl(s.id, o);
      if (one.error) {
        checked.push({ source: s.id, ok: false, reason: one.error });
        continue;
      }
      url_list.push(one.url);
      var bad = [];
      if (/(latitude|longitude|lat|lon|lng|loc)=/i.test(one.url.replace(/loc=/i, '')) && !/q=/.test(one.url)) bad.push('URL 含坐标形参数');
      if (lat != null && one.url.indexOf(String(lat)) >= 0) bad.push('URL 含给定纬度值');
      if (lon != null && one.url.indexOf(String(lon)) >= 0) bad.push('URL 含给定经度值');
      if (one.sends_position) bad.push('构造器声称发送位置');
      checked.push({ source: s.id, ok: bad.length === 0, reason: bad.join('；') || '未发现坐标痕迹' });
      if (bad.length) violations.push(s.id + '：' + bad.join('；'));
    }
    return {
      checked: checked.length,
      details: checked,
      violations: violations,
      urls: url_list,
      policy: '只允许出现被查 IP 与 API key；用户经纬度没有任何写入 URL 的代码路径',
      caveat: '查询本机出口 IP 时，IP 本身即粗粒度位置信息，会暴露给第三方——这不是本模块能匿名化的'
    };
  }

  /* ================================================================ 4. 响应解析（纯函数，可在自检里同步跑） */
  function parseLocString(v) {
    // ipinfo 的 loc = "31.2304,121.4737"：按文档是「纬度,经度」顺序。只接受两段且都在域内，否则 null
    var s = esc(v).trim();
    if (!s || s.indexOf(',') < 0) return null;
    var parts = s.split(',');
    if (parts.length !== 2) return null;
    var a = num(parts[0]), b = num(parts[1]);
    if (a == null || b == null) return null;
    if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
    return { lat: a, lon: b };
  }

  function parseIpSource(sourceId, payload, meta) {
    var s = SOURCE_BY_ID[String(sourceId)];
    var m = meta || {};
    if (!s) return errorResult(String(sourceId), 'bad_input', '未知源');
    var obj = payload;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (e) { return errorResult(s.id, 'json_error', e && e.message); }
    }
    if (!obj || typeof obj !== 'object') return errorResult(s.id, 'field_missing', '响应不是对象');

    // 显式失败标志（ip-api 的 status:"fail" / ipwho.is 的 success:false）
    if (s.status_key && obj[s.status_key] !== undefined && obj[s.status_key] !== null) {
      var st = obj[s.status_key];
      var okVal = (typeof st === 'boolean') ? st : (typeof st === 'string' ? st.toLowerCase() === String(s.status_ok).toLowerCase() : false);
      if (!okVal) {
        return errorResult(s.id, 'field_invalid', pickStr(obj, [s.msg_key || 'message'], 120) || ('状态字段为 ' + esc(st)));
      }
    }
    var probe = obj;
    if (s.nested_result && Array.isArray(obj[s.nested_result]) && obj[s.nested_result].length) {
      var r0 = obj[s.nested_result][0];
      probe = (r0 && typeof r0 === 'object') ? Object.assign({}, r0.components || {}, r0.geometry || {}, { ip: r0.ip }) : obj;
    }

    var lat = pickNum(probe, s.lat_keys), lon = pickNum(probe, s.lon_keys);
    if ((lat == null || lon == null) && s.loc_key) {
      var lc = parseLocString(probe[s.loc_key]);
      if (lc) { lat = lc.lat; lon = lc.lon; }
    }
    if (lat == null || lon == null) return errorResult(s.id, 'field_missing', '缺 ' + s.lat_keys.join('/') + ' 或 ' + s.lon_keys.join('/'));
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return errorResult(s.id, 'field_invalid', '经纬度越界（' + lat + ', ' + lon + '）');

    var acc = pickNum(probe, s.acc_keys || []);
    var fallback = false;
    if (acc == null || acc <= 0) {
      acc = num(s.unknown_accuracy_km) != null ? num(s.unknown_accuracy_km) : num(m.unknown_accuracy_km);
      if (!(acc > 0)) acc = DEFAULTS.unknown_accuracy_km;
      fallback = true;
    }
    if (acc > 20000) acc = 20000;   // 地球半周长量级封顶：更大的「精度」没有信息量，也不该进权重计算
    return {
      ip: pickStr(probe, s.ip_keys, 64),
      lat: rnd(clamp(lat, -90, 90), 6),
      lon: rnd(wrap180(lon), 6),
      accuracy_km: rnd(acc, 3),
      city: pickStr(probe, s.city_keys || [], 64),
      country: pickStr(probe, s.country_keys || [], 64),
      source: s.id,
      ok: true,
      error: null,
      error_kind: null,
      accuracy_fallback: fallback,
      from_cache: m.from_cache === true,
      latency_ms: isNum(m.latency_ms) ? rnd(m.latency_ms, 1) : null,
      note: s.note || ''
    };
  }

  // 把一次「响应」折算成统一结果（consume 里不含任何 IO，自检可以直接喂样例 JSON）
  function consumeResponse(sourceId, body, meta) {
    var m = meta || {};
    var s = SOURCE_BY_ID[String(sourceId)];
    var sid = s ? s.id : String(sourceId);
    if (m.error_kind && ERROR_KINDS[m.error_kind]) {
      return { result: errorResult(sid, m.error_kind, m.detail), health: recordHealth(sid, m.error_kind, m.latency_ms, sid) };
    }
    if (m.status != null && !(m.status >= 200 && m.status < 300)) {
      return { result: errorResult(sid, 'http_error', 'HTTP ' + m.status), health: recordHealth(sid, 'http_error', m.latency_ms, sid) };
    }
    var parsed = parseIpSource(sid, body, m);
    var kind = parsed.ok ? null : parsed.error_kind;
    return { result: parsed, health: recordHealth(sid, kind, m.latency_ms, sid) };
  }

  /* ================================================================ 5. 每源健康度 */
  var HEALTH = {};   // sourceId -> 记录
  var LATENCY_WINDOW = 20;  // 只保留最近 20 次时延：长时间运行下平均值才跟得上服务端退化

  function healthOf(sourceId) {
    var id = String(sourceId);
    if (!HEALTH[id]) {
      HEALTH[id] = {
        source: id, ok_count: 0, fail_count: 0, total: 0,
        consecutive_failures: 0, last_error_kind: null, last_ok_at: null,
        latency_ms_avg: null, latency_ms_last: null, _samples: []
      };
    }
    return HEALTH[id];
  }
  function recordHealth(sourceId, errorKind, latencyMs) {
    var h = healthOf(sourceId);
    var fail = errorKind != null;
    h.total += 1;
    if (fail) { h.fail_count += 1; h.consecutive_failures += 1; h.last_error_kind = String(errorKind); }
    else { h.ok_count += 1; h.consecutive_failures = 0; h.last_error_kind = null; h.last_ok_at = Date.now(); }
    if (isNum(latencyMs) && latencyMs >= 0 && latencyMs < 3.6e6) {
      h._samples.push(latencyMs);
      if (h._samples.length > LATENCY_WINDOW) h._samples.shift();
      h.latency_ms_last = rnd(latencyMs, 1);
      var s = 0;
      for (var i = 0; i < h._samples.length; i++) s += h._samples[i];
      h.latency_ms_avg = rnd(s / h._samples.length, 1);
    }
    h.success_rate = h.total > 0 ? rnd(h.ok_count / h.total, 4) : null;
    return h;
  }
  function healthSnapshot() {
    var out = [];
    for (var k in HEALTH) {
      if (!Object.prototype.hasOwnProperty.call(HEALTH, k)) continue;
      var h = HEALTH[k];
      out.push({
        source: h.source, ok_count: h.ok_count, fail_count: h.fail_count, total: h.total,
        success_rate: h.success_rate, consecutive_failures: h.consecutive_failures,
        last_error_kind: h.last_error_kind, latency_ms_avg: h.latency_ms_avg, latency_ms_last: h.latency_ms_last
      });
    }
    out.sort(function (a, b) { return a.source < b.source ? -1 : 1; });
    return out;
  }
  function resetHealth() { HEALTH = {}; return { ok: true, note: '健康度与缓存状态已清空（自检靠它保证可重复）' }; }

  // 选源：先按历史表现排序，再按「本次是否可构造 URL」过滤。没历史记录的源算「未知＝给一次机会」。
  function pickHealthySources(opt) {
    var o = opt || {};
    var maxConsec = num(o.max_consecutive_failures) != null ? Math.max(0, Math.round(num(o.max_consecutive_failures))) : 3;
    var minRate = num(o.min_success_rate) != null ? clamp(num(o.min_success_rate), 0, 1) : 0.2;
    var minSamples = num(o.min_samples) != null ? Math.max(1, Math.round(num(o.min_samples))) : 3;
    var maxLatency = num(o.max_avg_latency_ms);
    var selected = [], skipped = [];
    for (var i = 0; i < IP_SOURCES.length; i++) {
      var s = IP_SOURCES[i];
      var h = HEALTH[s.id];
      if (o.ip == null && s.self_unsupported) { skipped.push({ source: s.id, reason: '该源不支持查询本机出口 IP' }); continue; }
      if (s.requires_key && !o.api_key) { skipped.push({ source: s.id, reason: '需要 api_key' }); continue; }
      if (h) {
        if (h.consecutive_failures >= maxConsec) { skipped.push({ source: s.id, reason: '连续失败 ' + h.consecutive_failures + ' 次（阈值 ' + maxConsec + '）' }); continue; }
        if (h.total >= minSamples && (h.success_rate == null || h.success_rate < minRate)) {
          skipped.push({ source: s.id, reason: '成功率 ' + h.success_rate + ' 低于阈值 ' + minRate }); continue;
        }
        if (maxLatency != null && isNum(h.latency_ms_avg) && h.latency_ms_avg > maxLatency) {
          skipped.push({ source: s.id, reason: '平均时延 ' + h.latency_ms_avg + ' ms 超阈值 ' + maxLatency }); continue;
        }
      }
      selected.push({ source: s.id, name: s.name, requires_key: !!s.requires_key });
    }
    // 排序键：失败次数少 → 成功率高 → 时延低；无记录者排中间（既不是加分也不是减分）
    selected.sort(function (a, b) {
      var ha = HEALTH[a.source], hb = HEALTH[b.source];
      var ca = ha ? ha.consecutive_failures : 0, cb = hb ? hb.consecutive_failures : 0;
      if (ca !== cb) return ca - cb;
      var ra = ha && ha.success_rate != null ? ha.success_rate : 0.5, rb = hb && hb.success_rate != null ? hb.success_rate : 0.5;
      if (rb !== ra) return rb - ra;
      var la = ha && isNum(ha.latency_ms_avg) ? ha.latency_ms_avg : 1e9, lb = hb && isNum(hb.latency_ms_avg) ? hb.latency_ms_avg : 1e9;
      return la - lb;
    });
    var maxKeep = num(o.max_sources) != null ? Math.max(1, Math.round(num(o.max_sources))) : DEFAULTS.fuse.max_keep;
    var limited = selected.slice(0, maxKeep);
    var dropped = selected.slice(maxKeep).map(function (x) { return { source: x.source, reason: '超出 max_sources=' + maxKeep }; });
    return {
      sources: limited.map(function (x) { return x.source; }),
      selected: limited, skipped: skipped.concat(dropped),
      thresholds: { max_consecutive_failures: maxConsec, min_success_rate: minRate, min_samples: minSamples, max_avg_latency_ms: maxLatency, max_sources: maxKeep }
    };
  }

  /* ================================================================ 6. 结果缓存 */
  function cacheKeyOf(prefix, sourceId, ip) {
    return prefix + 'geoip.' + String(sourceId) + '.' + (ip ? String(ip).replace(/[^A-Za-z0-9.:\-_]/g, '_') : 'self');
  }
  var INDEX_KEY_SUFFIX = 'index';   // 键名索引：duck-type 的存储没有 enumerate 能力，只能自己记账

  function readIndex(raw, prefix) {
    var v = storeGet(raw, prefix + INDEX_KEY_SUFFIX);
    if (!v) return [];
    try {
      var a = JSON.parse(v);
      return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function cacheGet(sourceId, ip, opt) {
    var o = opt || {};
    var prefix = typeof o.cache_prefix === 'string' && o.cache_prefix ? o.cache_prefix : DEFAULTS.cache_prefix;
    var ttl = num(o.cache_ttl_ms) != null ? Math.max(0, num(o.cache_ttl_ms)) : DEFAULTS.cache_ttl_ms;
    var st = storageHandle(o);
    var key = cacheKeyOf(prefix, sourceId, ip);
    var raw = storeGet(st.raw, key);
    if (!raw) return { hit: false, reason: 'miss' };
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { storeRemove(st.raw, key); return { hit: false, reason: 'corrupt_entry' }; }
    if (!obj || typeof obj !== 'object' || !isNum(obj.saved_at)) { storeRemove(st.raw, key); return { hit: false, reason: 'corrupt_entry' }; }
    var age = Date.now() - obj.saved_at;
    if (!(age >= 0)) { storeRemove(st.raw, key); return { hit: false, reason: 'clock_skew' }; }  // 系统时钟往回走过：条目不可信
    if (age >= ttl) { storeRemove(st.raw, key); return { hit: false, reason: 'expired', age_ms: Math.round(age) }; }
    return { hit: true, value: obj.value, age_ms: Math.round(age), storage: st.kind, key: key };
  }
  function cacheSet(sourceId, ip, value, opt) {
    var o = opt || {};
    var prefix = typeof o.cache_prefix === 'string' && o.cache_prefix ? o.cache_prefix : DEFAULTS.cache_prefix;
    var st = storageHandle(o);
    var key = cacheKeyOf(prefix, sourceId, ip);
    var ok = storeSet(st.raw, key, JSON.stringify({ saved_at: Date.now(), value: value == null ? null : value }));
    if (ok) {
      var idx = readIndex(st.raw, prefix);
      if (idx.indexOf(key) < 0) {
        idx.push(key);
        // 索引本身也可能写失败（配额）；此时缓存条目还在，只是 enumerate 不到，不影响正确性
        storeSet(st.raw, prefix + INDEX_KEY_SUFFIX, JSON.stringify(idx.slice(-200)));
      }
    }
    return { ok: ok, key: key, storage: st.kind, note: ok ? null : '存储写入失败，已降级为不落盘（隐私模式/配额超限）' };
  }
  function clearCache(opt) {
    var o = opt || {};
    var prefix = typeof o.cache_prefix === 'string' && o.cache_prefix ? o.cache_prefix : DEFAULTS.cache_prefix;
    var st = storageHandle(o);
    var idx = readIndex(st.raw, prefix);
    for (var i = 0; i < idx.length; i++) storeRemove(st.raw, idx[i]);
    storeRemove(st.raw, prefix + INDEX_KEY_SUFFIX);
    return { ok: true, removed: idx.length, storage: st.kind };
  }
  function cacheStats(opt) {
    var o = opt || {};
    var prefix = typeof o.cache_prefix === 'string' && o.cache_prefix ? o.cache_prefix : DEFAULTS.cache_prefix;
    var st = storageHandle(o);
    var idx = readIndex(st.raw, prefix);
    var entries = [];
    for (var i = 0; i < idx.length; i++) {
      var raw = storeGet(st.raw, idx[i]);
      var age = null;
      if (raw) {
        try { var p = JSON.parse(raw); if (p && isNum(p.saved_at)) age = Math.max(0, Date.now() - p.saved_at); } catch (e) { age = null; }
      }
      entries.push({ key: idx[i], age_ms: age == null ? null : Math.round(age), corrupt: age == null });
    }
    return { storage: st.kind, prefix: prefix, count: idx.length, entries: entries };
  }

  /* ================================================================ 7. 多源投票 / 融合 */
  /* 为什么不用简单平均：IP 地理库之间高度同源（多家其实转售同一份 MaxMind 类数据库），
   * 误差并不独立，χ² 的「独立观测」前提只是近似成立。所以：
   *   1) 先用加权中位数（权重 1/accuracy²）定一个稳健中心——中位数对单点粗差不敏感；
   *   2) 用 MAD 判据 + 距离地板剔除离群源；
   *   3) 再用被保留源做加权平均，并报告 χ²/p 值作为「矛盾程度」的证据而非结论；
   *   4) 精度同时给「BLUE 后验 σ」和「保守的加权精度分位」，前者会系统性低估。
   */
  function weightedQuantile(items, q) {
    // items: [{v, w}]；返回加权分位（q=0.5 即加权中位数）
    var src = Array.isArray(items) ? items : [];
    var list = src.filter(function (x) { return x && typeof x === 'object' && isNum(x.v) && isNum(x.w) && x.w > 0; })
      .sort(function (a, b) { return a.v - b.v; });
    if (!list.length) return null;
    var qq = num(q);
    if (qq == null) return null;
    var total = list.reduce(function (a, x) { return a + x.w; }, 0);
    if (!(total > 0)) return null;
    var cum = 0;
    for (var i = 0; i < list.length; i++) {
      cum += list[i].w;
      if (cum >= total * clamp(qq, 0, 1)) return list[i].v;
    }
    return list[list.length - 1].v;
  }

  function fuseIpSolutions(results, opt) {
    var o = opt || {};
    if (!Array.isArray(results) || !results.length) return { error: '需要至少一条定位结果' };
    var cfg = Object.assign({}, DEFAULTS.fuse, o.fuse || {});
    var usable = [];
    var excluded = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r || typeof r !== 'object') { excluded.push({ source: 'unknown', reason: '条目不是对象' }); continue; }
      if (r.ok !== true || !isNum(r.lat) || !isNum(r.lon)) {
        excluded.push({ source: r.source || 'unknown', reason: r.error || '结果不可用（ok!==true 或缺经纬度）', error_kind: r.error_kind || null });
        continue;
      }
      if (Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) { excluded.push({ source: r.source, reason: '经纬度越界' }); continue; }
      var acc = isNum(r.accuracy_km) && r.accuracy_km > 0 ? r.accuracy_km : DEFAULTS.unknown_accuracy_km;
      usable.push({
        source: r.source || 'unknown', lat: r.lat, lon: r.lon, accuracy_km: acc,
        accuracy_fallback: r.accuracy_fallback === true, from_cache: r.from_cache === true,
        w: 1 / (acc * acc), city: r.city || null, country: r.country || null
      });
    }
    if (!usable.length) return { error: '没有任何可用源', rejected: excluded };

    // 稳健中心：加权中位数（分轴）——它只负责「定标 + 剔群」，不直接当最终点位
    var medLat = weightedQuantile(usable.map(function (x) { return { v: x.lat, w: x.w }; }), 0.5);
    var medLon = weightedQuantile(usable.map(function (x) { return { v: x.lon, w: x.w }; }), 0.5);
    if (medLat == null || medLon == null) return { error: '加权中位数不可算（权重全部非法）', rejected: excluded };
    var ref = { lat: medLat, lon: medLon };

    // 每源偏差（km，测地线）与 MAD 判据
    var devs = usable.map(function (x) { return greatCircleKm(x.lat, x.lon, medLat, medLon); });
    var madStat = mad(devs);
    var scale = madStat && isNum(madStat.sigma_hat) ? madStat.sigma_hat : 0;
    var floor = isNum(cfg.outlier_floor_km) ? cfg.outlier_floor_km : 50;
    var kSig = isNum(cfg.outlier_mad_k) ? cfg.outlier_mad_k : 3.5;
    var kept = [], rejected = excluded.slice();
    for (var j = 0; j < usable.length; j++) {
      var d = devs[j];
      if (d == null) { rejected.push({ source: usable[j].source, reason: '偏差不可算' }); continue; }
      usable[j].dev_km = rnd(d, 3);
      // 判定式：d > 地板 且 d 超过 MAD 的 kσ（scale≈0 时只靠地板，避免「都差不多」时随机踢人）
      var z = scale > 0 ? (d - madStat.median) / scale : 0;
      usable[j].dev_mad_z = rnd(z, 3);
      if (d > floor && (scale <= 0 || z > kSig)) {
        rejected.push({ source: usable[j].source, dev_km: usable[j].dev_km, reason: '离群（偏差 ' + usable[j].dev_km + ' km，MAD z=' + usable[j].dev_mad_z + '，地板 ' + floor + ' km）' });
      } else kept.push(usable[j]);
    }
    if (!kept.length) { kept = usable.slice(); }

    /* 委托给 core-gnss 的 BLUE 融合必须在**剔群之后**：把离群源一起交给加权平均，
     * 就等于让一个明显错误的城市把融合点拖跑（χ² 检验只能事后报警，不能事前防住）。
     * core-gnss 缺席/报错/返回非法值时降级到内部加权平均——两个模块各自都能独立跑。 */
    var engine = 'internal';
    var delegate = null;
    if (cfg.method !== 'weighted_median' && kept.length >= 2 && o.use_geognss !== false) {
      var gnss = (typeof global.GEOGNSS === 'object' && global.GEOGNSS) ? global.GEOGNSS : null;
      if (gnss && typeof gnss.fuseSolutions === 'function') {
        var g = gnss.fuseSolutions(kept.map(function (x) {
          return { source: x.source, lat: x.lat, lon: x.lon, sigma_m: Math.max(1, x.accuracy_km * 1000) };
        }), { alpha: cfg.alpha });
        if (g && !g.error && isNum(g.lat) && isNum(g.lon)) { engine = 'GEOGNSS.fuseSolutions'; delegate = g; }
        else engine = 'internal(GEOGNSS 委托被拒：返回不合格)';
      }
    }
    var out;
    if (cfg.method === 'weighted_median') {
      out = { lat: medLat, lon: medLon, method: 'weighted-median' };
    } else if (delegate) {
      out = { lat: delegate.lat, lon: delegate.lon, method: 'weighted-mean(委托 GEOGNSS)' };
    } else {
      var sumW = kept.reduce(function (a, x) { return a + x.w; }, 0);
      var mLat = kept.reduce(function (a, x) { return a + x.w * x.lat; }, 0) / sumW;
      var mLon = kept.reduce(function (a, x) { return a + x.w * x.lon; }, 0) / sumW;
      out = { lat: mLat, lon: mLon, method: 'weighted-mean' };
    }
    // χ²：在等距切平面上按 1/σ² 加权（2 维 × (n−1) 自由度）
    var pl = kept.map(function (x) { return Object.assign({}, x, toPlane({ lat: out.lat, lon: out.lon }, x.lat, x.lon)); });
    var chi2 = pl.reduce(function (a, x) { return a + (x.e * x.e + x.n * x.n) * x.w / 1e6; }, 0);  // km² 归一：σ 用 km
    var dof = Math.max(1, 2 * (kept.length - 1));
    var p = chiSquareSurvival(chi2, dof);
    var sigmaBlueKm = Math.sqrt(1 / Math.max(1e-12, kept.reduce(function (a, x) { return a + x.w; }, 0)));
    var accQuantile = weightedQuantile(kept.map(function (x) { return { v: x.accuracy_km, w: x.w }; }), 0.75);
    var devFinal = usable.map(function (x) { return greatCircleKm(x.lat, x.lon, out.lat, out.lon); });
    return {
      ok: true,
      lat: rnd(clamp(out.lat, -90, 90), 6),
      lon: rnd(wrap180(out.lon), 6),
      method: out.method,
      engine: engine,
      accuracy_km: rnd(Math.max(sigmaBlueKm, accQuantile != null ? accQuantile : sigmaBlueKm), 3),
      sigma_blue_km: rnd(sigmaBlueKm, 3),
      accuracy_km_conservative: rnd(accQuantile != null ? accQuantile : DEFAULTS.unknown_accuracy_km, 3),
      n_sources: results.length, n_used: kept.length,
      used: kept.map(function (x) { return { source: x.source, lat: x.lat, lon: x.lon, accuracy_km: x.accuracy_km, dev_km: x.dev_km, dev_mad_z: x.dev_mad_z, accuracy_fallback: x.accuracy_fallback, from_cache: x.from_cache === true, weight: rnd(x.w, 8) }; }),
      rejected: rejected,
      // 两套偏差都要给：dev_km 是相对稳健中心（判离群用的），dev_final_km 是相对最终融合点（人想看的）
      deviations_km: devs.map(function (v, idx) { return { source: usable[idx].source, dev_km: v == null ? null : rnd(v, 3), dev_final_km: devFinal[idx] == null ? null : rnd(devFinal[idx], 3) }; }),
      consistency: { chi2: rnd(chi2, 4), dof: dof, p_value: p == null ? null : rnd(p, 6), inconsistent: p != null && p < cfg.alpha, alpha: cfg.alpha },
      mad: { median_dev_km: madStat ? rnd(madStat.median, 3) : null, sigma_hat_km: madStat ? rnd(madStat.sigma_hat, 3) : null, outlier_mad_k: kSig, floor_km: floor },
      caveats: [
        '各 IP 库常转售同一份数据库，误差不独立：χ² 的自由度假设只是近似，p 值当证据用、别当结论用',
        'BLUE 后验 σ（sigma_blue_km）会低估真实误差，报告精度取的是保守的加权 75% 分位',
        'accuracy_fallback=true 的源用的是兜底量级，不是该源公布的精度'
      ],
      note: '融合点仅作「联网侧独立证据」，与离线解的一致性问题交给 shouldEscalate 判定'
    };
  }

  /* ================================================================ 8. 离线 → 联网 自动升级判定 */
  /* 三条独立证据，任一成立就升级（联网取外部事实），并把每条的证据强度写进 checks：
   *   A) 一致性：离线解与「联网融合点」的偏差在合并 σ 下做 χ²（2 自由度），p<alpha 判矛盾；
   *   B) 离线自身质量：HDOP 过大 / 残差 RMS 超限 / 参与解算的卫星不足 / RAIM 报警 —— 这些都不需要网络；
   *   C) 离线解内部各手段（sources[]/consistency）已自报不一致。
   * 阈值全部可配置（DEFAULTS.escalate），依据写在字段注释里：IP 定位的精度量级（数十 km）远大于 GNSS，
   * 所以「矛盾」必须用合并 σ 归一化后才判，否则任何正常 GNSS 解都会被 IP 库的缓存差异顶成可疑。
   */
  function shouldEscalate(offline, online, opt) {
    var o = opt || {};
    var th = Object.assign({}, DEFAULTS.escalate, o.escalate || {});
    var checks = [];
    var reasons = [];
    var conf = 0;

    var off = offline && typeof offline === 'object' ? offline : null;
    if (!off) return { escalate: false, reason: '没有离线解可判定', confidence: 0, checks: [], thresholds: th };
    if (off.error) {
      checks.push({ name: 'offline_error', severity: 1, detail: String(off.error).slice(0, 120) });
      reasons.push('离线解本身报错，直接联网取外部事实');
      conf = 1;
      return { escalate: true, reason: reasons.join('；'), confidence: conf, checks: checks, thresholds: th };
    }
    var offLat = num(off.lat), offLon = num(off.lon);
    if (offLat == null || offLon == null) {
      checks.push({ name: 'offline_no_fix', severity: 1, detail: '离线解缺经纬度' });
      return { escalate: true, reason: '离线解没有有效经纬度', confidence: 1, checks: checks, thresholds: th };
    }

    // σ：优先 sigma_e_m/sigma_n_m（solvePosition 的输出），否则 sigma_m，最后按 HDOP×伪距 σ 估
    var se = num(off.sigma_e_m), sn = num(off.sigma_n_m);
    var sg = num(off.sigma_m);
    if (se == null) se = sg;
    if (sn == null) sn = sg;
    if (se == null && isNum(off.hdop)) { se = Math.max(th.sigma_floor_m, off.hdop * 5); sn = se; }
    var hdop = isNum(off.dop && off.dop.hdop) ? off.dop.hdop : (isNum(off.hdop) ? off.hdop : null);
    var rms = isNum(off.rms_residual_m) ? off.rms_residual_m : null;
    var sats = isNum(off.sats_used) ? off.sats_used : (isNum(off.satellites) ? off.satellites : null);
    var integrityAlarm = !!(off.integrity && off.integrity.alarm === true);
    // σ 必须有地板：否则「σ=0.001 m 的完美解」会让任何 IP 偏差算出天文数字的 χ²
    se = Math.max(th.sigma_floor_m, se == null ? 20 : se);
    sn = Math.max(th.sigma_floor_m, sn == null ? 20 : sn);

    if (hdop != null && hdop > th.max_hdop) {
      var sevHd = clamp(hdop / (th.max_hdop * 2), 0.4, 1);
      checks.push({ name: 'hdop', severity: rnd(sevHd, 4), detail: 'HDOP ' + rnd(hdop, 2) + ' > 阈值 ' + th.max_hdop });
      reasons.push('几何构型差（HDOP ' + rnd(hdop, 2) + '）');
      conf = Math.max(conf, sevHd);
    }
    if (rms != null && rms > th.max_rms_residual_m) {
      var sevRms = clamp(rms / (th.max_rms_residual_m * 2), 0.4, 1);
      checks.push({ name: 'rms_residual', severity: rnd(sevRms, 4), detail: '残差 RMS ' + rnd(rms, 2) + ' m > 阈值 ' + th.max_rms_residual_m + ' m' });
      reasons.push('残差 RMS 超限（' + rnd(rms, 2) + ' m）');
      conf = Math.max(conf, sevRms);
    }
    if (sats != null && sats < th.min_sats) {
      checks.push({ name: 'sats', severity: 0.8, detail: '参与解算 ' + sats + ' 颗 < ' + th.min_sats });
      reasons.push('观测量不足（' + sats + ' 颗）');
      conf = Math.max(conf, 0.8);
    }
    if (integrityAlarm) {
      checks.push({ name: 'integrity_alarm', severity: 0.9, detail: '离线 RAIM 卡方检验已报警' });
      reasons.push('离线完整性报警');
      conf = Math.max(conf, 0.9);
    }
    if (off.consistency && off.consistency.inconsistent === true) {
      var pIn = num(off.consistency.p_value);
      var sevIn = pIn == null ? 0.7 : clamp(1 - pIn, 0.5, 1);
      checks.push({ name: 'internal_inconsistent', severity: rnd(sevIn, 4), detail: '离线解内部各手段已判不一致（p=' + (pIn == null ? 'NA' : pIn) + '）' });
      reasons.push('离线解内部矛盾');
      conf = Math.max(conf, sevIn);
    }

    // 与联网融合点的一致性（χ²，2 自由度）
    if (online && typeof online === 'object' && online.ok === true && isNum(online.lat) && isNum(online.lon)) {
      var netAccKm = isNum(online.accuracy_km) && online.accuracy_km > 0 ? online.accuracy_km : DEFAULTS.unknown_accuracy_km;
      var nse = Math.max(th.sigma_floor_m, netAccKm * 1000 / Math.sqrt(2));   // 圆精度 → 单轴 σ
      var nsn = nse;
      var dE = (offLon - online.lon) * mPerDegLon(online.lat);
      var dN = (offLat - online.lat) * M_PER_DEG_LAT;
      var ve = se * se + nse * nse, vn = sn * sn + nsn * nsn;
      var chi = (dE * dE) / ve + (dN * dN) / vn;
      var pVal = chiSquareSurvival(chi, 2);
      var dist = greatCircleKm(offLat, offLon, online.lat, online.lon);
      var zEff = Math.sqrt(chi);
      var detail = '离线-联网偏差 ' + (dist == null ? 'NA' : rnd(dist / 1000, 2) + ' km') +
        '，合并 σ=' + rnd(Math.sqrt(ve + vn) / 1000, 2) + ' km，χ²=' + rnd(chi, 3) + '（dof=2，p=' + (pVal == null ? 'NA' : rnd(pVal, 6)) + '）';
      var fire = (pVal != null && pVal < th.alpha) || zEff > th.z_hard;
      checks.push({ name: 'offline_vs_online', severity: pVal == null ? null : rnd(clamp(1 - pVal, 0, 1), 6), fired: fire, detail: detail });
      if (fire) {
        reasons.push('离线解与多源联网融合点在不确定度范围内不吻合');
        conf = Math.max(conf, pVal == null ? 0.6 : clamp(1 - pVal, 0.6, 1));
      }
    } else if (online) {
      checks.push({ name: 'online_unavailable', severity: 0, fired: false, detail: '联网侧没有可用融合点，一致性判据缺席（不因此升级，也不据此否定离线解）' });
    }

    var escalate = checks.some(function (c) { return c.severity != null && c.severity >= 0.4 || c.fired === true; });
    // confidence 是启发式取「最强证据的强度」，不是概率（写清依据，避免被读成贝叶斯后验）
    return {
      escalate: !!escalate,
      reason: escalate ? (reasons.join('；') || '存在超阈值证据') : '离线解在自身阈值与联网一致性下都可接受，无需升级',
      confidence: rnd(clamp(conf, 0, 1), 4),
      confidence_basis: '取所有触发证据里最强的 severity（HDOP/RMS/星数/完整性/内部矛盾/χ²），属启发式量纲，不是概率',
      checks: checks,
      thresholds: th,
      offline_sigma_m: { e: rnd(se, 2), n: rnd(sn, 2) },
      note: '联网只在「离线证据自相矛盾」时才有价值：IP 定位的精度量级远大于 GNSS，用它「纠正」一个健康的 GNSS 解是错的'
    };
  }

  /* ================================================================ 9. RSSI → 距离（对数路径损耗） */
  /* 模型：PL(d) = PL1 + 10·n·lg(d)，其中 PL1 是 1 m 处的自由空间损耗 = 20·lg(4π·1m/λ)（解析式，不是经验值），
   *       RSSI = EIRP − PL(d)  ⇒  d = 10^((EIRP − RSSI − PL1) / (10n))
   * n 的物理含义与取值（经验区间，需现场标定，别当规范）：
   *   n=2 自由空间；n≈2.7~3 郊区/宏蜂窝；n=3~4 城区；n>4 室内/遮挡严重。
   * 为什么坚持要 EIRP：不知道发射功率就没有距离——链路预算里 −30 dBm 和 +20 dBm 差 4 个数量级，
   * 默认一个「看起来合理」的功率就是编数据，所以缺 tx_power_dbm（或缺 ref_rssi_dbm_at_1m）直接报错。
   */
  var PATH_LOSS_N = {
    free_space: { n: 2.0, label: '自由空间（理论下限）', basis: '球面波几何：PL ∝ d²' },
    suburban: { n: 3.0, label: '郊区', basis: '经验区间 2.7~3.5' },
    urban: { n: 3.5, label: '城区', basis: '经验区间 3~4' },
    dense_urban: { n: 4.0, label: '密集城区', basis: '经验区间 3~4 的上沿' },
    indoor: { n: 4.5, label: '室内/遮挡', basis: '经验值，常取 4~6（未逐字段核对任何标准）' }
  };

  function wavelengthM(freq_mhz) {
    var f = num(freq_mhz);
    if (f == null || f <= 0) return null;
    return C_MS / (f * 1e6);
  }
  function fspl1mDb(freq_mhz) {
    var lam = wavelengthM(freq_mhz);
    if (lam == null || lam <= 0) return null;
    return 20 * Math.log(4 * PI * 1 / lam) / LN10;
  }

  function rssiOpts(opt) {
    var raw = opt || {};
    var base = Object.assign({}, DEFAULTS.rssi, raw);
    var bad = [];
    // 只有「没给」才用默认值；「给了但非法」必须报错——静默回退会把参数写错伪装成一次正常计算
    var nEnv = (typeof raw.environment === 'string' && PATH_LOSS_N[raw.environment]) ? PATH_LOSS_N[raw.environment].n : null;
    var n = num(base.path_loss_exponent);
    if (n == null) n = nEnv;
    if (n == null) n = DEFAULTS.rssi.path_loss_exponent;
    if (!(n > 0 && n <= 10)) bad.push('path_loss_exponent 需在 0<n≤10（当前 ' + esc(base.path_loss_exponent) + '）');
    var freq = num(base.freq_mhz);
    if (freq == null) freq = DEFAULTS.rssi.freq_mhz;
    if (!(freq > 0 && freq <= 3e6)) bad.push('freq_mhz 需在 0…3e6（当前 ' + esc(base.freq_mhz) + '）：频率 0 会让波长除零');
    var sigma = num(base.shadow_sigma_db);
    if (sigma != null && !(sigma >= 0 && sigma <= 40)) { bad.push('shadow_sigma_db 需在 0…40 dB（当前 ' + sigma + '）'); sigma = null; }
    var dmin = num(base.d_min_m); if (dmin == null || !(dmin > 0)) dmin = DEFAULTS.rssi.d_min_m;
    var dmax = num(base.d_max_m); if (dmax == null || !(dmax > dmin)) dmax = DEFAULTS.rssi.d_max_m;
    var ref1 = num(base.reference_rssi_dbm_at_1m);
    if (ref1 != null && !(ref1 >= -200 && ref1 <= 100)) { bad.push('reference_rssi_dbm_at_1m 超出 −200…100 dBm'); ref1 = null; }
    var tx = num(base.tx_power_dbm);
    if (tx != null && !(tx >= -100 && tx <= 100)) { bad.push('tx_power_dbm 超出 −100…100 dBm'); tx = null; }
    return {
      n: n, freq_mhz: freq, shadow_sigma_db: sigma, tx: tx, gain: num(base.antenna_gain_db) || 0,
      ref1m: ref1, d_min: dmin, d_max: dmax,
      environment: typeof raw.environment === 'string' && PATH_LOSS_N[raw.environment] ? raw.environment : (typeof raw.environment === 'string' ? raw.environment : 'custom'),
      invalid: bad.length ? bad.join('；') : null
    };
  }

  function rssiToDistance(rssi_dbm, opt) {
    var o = rssiOpts(opt);
    if (o.invalid) return { error: '模型参数非法：' + o.invalid };
    var r = num(rssi_dbm);
    var pl1 = fspl1mDb(o.freq_mhz);
    if (o.ref1m == null && pl1 == null) return { error: '频率非法，无法算 1 m 处自由空间损耗' };
    if (o.tx == null && o.ref1m == null) {
      return { error: '缺少 tx_power_dbm（或 reference_rssi_dbm_at_1m）：没有发射功率就没有距离，本模块不臆造默认 EIRP' };
    }
    if (r == null) return { error: 'RSSI 非法（需为有限 dBm 数值）' };
    // at1m = 1 m 处应有的接收电平：EIRP − PL1（或直接给定的 reference_rssi_dbm_at_1m）
    var at1m = o.ref1m != null ? o.ref1m : (o.tx + o.gain - (pl1 == null ? 0 : pl1));
    var d = Math.pow(10, (at1m - r) / (10 * o.n));
    if (!isNum(d) || d <= 0) return { error: '距离反演溢出（RSSI 与模型参数不匹配）' };
    var clamped = false, reason = null;
    if (d < o.d_min) { d = o.d_min; clamped = true; reason = '信号过强，距离低于模型下限 ' + o.d_min + ' m，已截断'; }
    else if (d > o.d_max) { d = o.d_max; clamped = true; reason = '信号过弱，距离超出模型上限 ' + o.d_max + ' m，已截断'; }
    if (!(d > 0)) return { error: '距离反演得到非正值（数值异常）' };
    return {
      dist_m: rnd(d, 2),
      sigma_m: o.shadow_sigma_db != null ? rnd(LN10 / 10 * d * o.shadow_sigma_db / o.n, 2) : null,
      // 总路径损耗只有在知道发射功率时才是可定义量；ref1m 形态下报 null 而不是「凑一个数」
      path_loss_db: o.ref1m != null ? null : rnd(o.tx + o.gain - r, 3),
      excess_loss_over_1m_db: rnd(10 * o.n * Math.log(d) / LN10, 3),
      rssi_at_1m_dbm: rnd(at1m, 3),
      exponent: o.n, environment: o.environment, freq_mhz: o.freq_mhz,
      eirp_dbm: o.tx != null ? rnd(o.tx + o.gain, 2) : null,
      rssi_dbm: r, clamped: clamped, clamped_reason: reason
    };
  }

  function distanceToRssi(dist_m, opt) {
    var o = rssiOpts(opt);
    if (o.invalid) return { error: '模型参数非法：' + o.invalid };
    var d = num(dist_m);
    if (d == null || d <= 0) return { error: '距离非法' };
    if (o.tx == null && o.ref1m == null) return { error: '缺少 tx_power_dbm（或 reference_rssi_dbm_at_1m）' };
    var pl1 = fspl1mDb(o.freq_mhz);
    if (o.ref1m == null && pl1 == null) return { error: '频率非法' };
    var at1m = o.ref1m != null ? o.ref1m : (o.tx + o.gain - (pl1 == null ? 0 : pl1));
    var dd = clamp(d, o.d_min, o.d_max);
    var rssi = at1m - 10 * o.n * Math.log(dd) / LN10;   // 与 rssiToDistance 是同一式的两端，往返一致性由此保证
    return {
      rssi_dbm: rnd(rssi, 3), dist_m: rnd(dd, 2), exponent: o.n, freq_mhz: o.freq_mhz,
      rssi_at_1m_dbm: rnd(at1m, 3), eirp_dbm: o.tx != null ? rnd(o.tx + o.gain, 2) : null,
      path_loss_db: o.ref1m != null ? null : rnd(o.tx + o.gain - rssi, 3),
      clamped: dd !== d
    };
  }

  /* ================================================================ 10. 多接入点测距 → 加权最小二乘 */
  function eig2(c00, c01, c11) {
    var tr = c00 + c11, det = c00 * c11 - c01 * c01;
    var disc = tr * tr / 4 - det;
    if (!(disc >= 0)) disc = 0;
    var root = Math.sqrt(disc);
    return { l1: tr / 2 + root, l2: tr / 2 - root };
  }
  function apRange(ap, o) {
    if (ap == null || typeof ap !== 'object') return null;
    var direct = num(ap.range_m);
    if (direct != null && direct > 0) {
      var accm = num(ap.accuracy_m);
      return { r: direct, sigma: accm != null && accm > 0 ? accm : Math.max(1, direct * 0.3), note: '给定距离 ' + rnd(direct, 1) + ' m' };
    }
    var sig = num(ap.rssi_dbm) != null ? num(ap.rssi_dbm) : num(ap.rsrp_dbm);
    if (sig == null) return null;
    var d = rssiToDistance(sig, Object.assign({}, o, {
      tx_power_dbm: num(ap.tx_power_dbm) != null ? num(ap.tx_power_dbm) : num(o.tx_power_dbm),
      freq_mhz: num(ap.freq_mhz) != null ? num(ap.freq_mhz) : num(o.freq_mhz),
      path_loss_exponent: num(ap.path_loss_exponent) != null ? num(ap.path_loss_exponent) : num(o.path_loss_exponent),
      reference_rssi_dbm_at_1m: num(ap.reference_rssi_dbm_at_1m) != null ? num(ap.reference_rssi_dbm_at_1m) : num(o.reference_rssi_dbm_at_1m)
    }));
    if (d.error) return { err: d.error };
    var accm2 = num(ap.accuracy_m);
    return { r: d.dist_m, sigma: accm2 != null && accm2 > 0 ? accm2 : (d.sigma_m != null ? d.sigma_m : Math.max(2, d.dist_m * 0.25)), note: (o.environment || 'log-distance') + ' n=' + d.exponent + ' ' + sig + ' dBm → ' + d.dist_m + ' m' + (d.clamped ? '（' + d.clamped_reason + '）' : '') };
  }

  function trilaterateAps(aps, opt) {
    var o = opt || {};
    var res = {
      ok: false, method: 'none', lat: null, lon: null, n_used: 0, ranges_m: [], used: [],
      residual_rmse_m: null, max_residual_m: null, covariance_m2: [[null, null], [null, null]],
      sigma_e_m: null, sigma_n_m: null, confidence_radius_m: null, gdop: null, degraded: false,
      warnings: [], engine: 'internal', error: null, note: 'RSSI 测距受非视距/遮挡支配，结果量级为「几十米~几百米」，不是米级'
    };
    var list = Array.isArray(aps) ? aps : (aps && Array.isArray(aps.aps) ? aps.aps : null);
    if (!list) { res.error = '需要接入点数组（[{lat,lon,rssi_dbm|range_m,...}]）'; return res; }
    if (!isNum(o.path_loss_exponent) && !isNum(o.tx_power_dbm) && !isNum(o.reference_rssi_dbm_at_1m)) {
      // 允许每个 AP 自带 tx；这里只做提示，真正缺参数会在 apRange 里报错
      res.warnings.push('未给全局 tx_power_dbm/exponent：需每个接入点自带，否则链路预算无法闭合');
    }
    var L = [];
    for (var i = 0; i < list.length; i++) {
      var ap = list[i];
      if (!ap || typeof ap !== 'object') continue;
      var la = num(ap.lat), lo = num(ap.lon);
      if (la == null || lo == null || Math.abs(la) > 90 || Math.abs(lo) > 180) { res.warnings.push((ap.label || ('AP' + (i + 1))) + ' 缺合法经纬度，已排除'); continue; }
      var rg = apRange(ap, o);
      if (!rg) { res.warnings.push((ap.label || ('AP' + (i + 1))) + ' 无 RSSI/距离，已排除'); continue; }
      if (rg.err) { res.warnings.push((ap.label || ('AP' + (i + 1))) + ' 测距失败：' + rg.err); continue; }
      var sigma = Math.max(0.5, rg.sigma);
      L.push({ lat: la, lon: lo, r: rg.r, sigma: sigma, label: ap.label || ('AP' + (i + 1)), note: rg.note, w: 1 / (sigma * sigma) });
    }
    res.n_used = L.length;
    if (!L.length) { res.error = '没有可用于测距定位的接入点'; return res; }
    if (L.length === 1) {
      res.ok = true; res.method = 'single-ap'; res.degraded = true;
      res.lat = rnd(L[0].lat, 6); res.lon = rnd(L[0].lon, 6);
      res.ranges_m = [rnd(L[0].r, 1)];
      res.confidence_radius_m = rnd(Math.max(L[0].r, L[0].sigma), 1);
      res.used = [{ label: L[0].label, lat: rnd(L[0].lat, 6), lon: rnd(L[0].lon, 6), range_m: rnd(L[0].r, 1), sigma_m: rnd(L[0].sigma, 1) }];
      res.warnings.push('仅 1 个接入点：位置退化为该接入点坐标，不确定度取覆盖半径');
      return res;
    }
    var refLat = L.reduce(function (a, x) { return a + x.lat; }, 0) / L.length;
    var refLon = L.reduce(function (a, x) { return a + x.lon; }, 0) / L.length;
    var ref = { lat: refLat, lon: refLon };
    L.forEach(function (x) { var p = toPlane(ref, x.lat, x.lon); x.x = p.e; x.y = p.n; });
    res.ranges_m = L.map(function (x) { return rnd(x.r, 1); });
    res.used = L.map(function (x) { return { label: x.label, lat: rnd(x.lat, 6), lon: rnd(x.lon, 6), range_m: rnd(x.r, 1), sigma_m: rnd(x.sigma, 1) }; });

    // 两个测圆必有两个交点（或没有）——这不是数值问题，是几何事实，所以老实交出双解
    if (L.length === 2) {
      var A = L[0], B = L[1];
      var ddx = B.x - A.x, ddy = B.y - A.y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dd > 1e-6) {
        var t = (A.r * A.r - B.r * B.r + dd * dd) / (2 * dd);
        var h2 = A.r * A.r - t * t;
        var xm = A.x + ddx * t / dd, ym = A.y + ddy * t / dd;
        var cand;
        if (h2 >= 0) {
          var hh = Math.sqrt(h2);
          cand = [{ x: xm - ddy / dd * hh, y: ym + ddx / dd * hh }, { x: xm + ddy / dd * hh, y: ym - ddx / dd * hh }];
        } else {
          // 两圆不相交（测距粗差）：退到根轴与连线的最近点，并明确标记不可靠
          cand = [{ x: xm, y: ym }];
          res.warnings.push('两个测圆不相交（RSSI 测距粗差），解落在根轴上，不确定度按覆盖半径给');
        }
        var prior = { x: (A.x * A.w + B.x * B.w) / (A.w + B.w), y: (A.y * A.w + B.y * B.w) / (A.w + B.w) };
        cand.sort(function (a, b) {
          var da = Math.pow(a.x - prior.x, 2) + Math.pow(a.y - prior.y, 2);
          var db = Math.pow(b.x - prior.x, 2) + Math.pow(b.y - prior.y, 2);
          return da - db;
        });
        var chosen = toLatLon(ref, cand[0].x, cand[0].y);
        res.ok = true;
        res.method = cand.length === 2 ? 'two-ap-ambiguity' : 'two-ap-radical-axis';
        res.ambiguous = cand.length === 2;
        res.lat = rnd(clamp(chosen.lat, -90, 90), 6);
        res.lon = rnd(wrap180(chosen.lon), 6);
        res.candidates = cand.map(function (c) { var g = toLatLon(ref, c.x, c.y); return { lat: rnd(clamp(g.lat, -90, 90), 6), lon: rnd(wrap180(g.lon), 6) }; });
        var rr2 = cand.map(function (c) { return Math.sqrt(Math.pow(c.x - A.x, 2) + Math.pow(c.y - A.y, 2)) - A.r; });
        res.residual_rmse_m = rnd(Math.sqrt(rr2.reduce(function (a, v) { return a + v * v; }, 0) / Math.max(1, rr2.length)), 2);
        res.max_residual_m = rnd(Math.max.apply(null, rr2.map(Math.abs).concat([0])), 2);
        res.confidence_radius_m = rnd(Math.max(A.sigma, B.sigma), 1);
        res.sigma_e_m = rnd(Math.max(A.sigma, B.sigma), 2);
        res.sigma_n_m = res.sigma_e_m;
        res.covariance_m2 = [[rnd(Math.pow(A.sigma, 2), 1), 0], [0, rnd(Math.pow(B.sigma, 2), 1)]];
        res.degraded = cand.length === 2;
        if (cand.length === 2) res.warnings.push('仅 2 个接入点：测圆双解，已按先验（加权质心）择近者，另一解在 candidates 里');
        return res;
      }
    }

    // 初值：加权质心（权重 1/σ²），再 Gauss–Newton 迭代残差 d−r
    var sw = L.reduce(function (a, x) { return a + x.w; }, 0);
    var px = L.reduce(function (a, x) { return a + x.x * x.w; }, 0) / sw;
    var py = L.reduce(function (a, x) { return a + x.y * x.w; }, 0) / sw;
    var huber = o.huber !== false;
    var cov = null, iters = 0, rr = null;
    var maxIt = Math.max(1, Math.round(num(o.max_iterations) || 40));
    for (var it = 0; it < maxIt; it++) {
      iters = it + 1;
      rr = []; var J = [];
      for (var k = 0; k < L.length; k++) {
        var dx = px - L[k].x, dy = py - L[k].y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (!(d > 1e-6)) { dx = 1e-6; dy = 0; d = 1e-6; }   // 与接入点重合：给个单位方向避免除零
        rr.push(d - L[k].r);
        J.push([dx / d, dy / d]);
      }
      var w = L.map(function (x, idx) {
        if (!huber) return x.w;
        var z = Math.abs(rr[idx]) / Math.max(1, x.sigma);
        return x.w * Math.min(1, 1.345 / Math.max(z, 1e-9));   // Huber 阈值 1.345：高斯下 95% 效率的经验常数
      });
      var a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      for (var m = 0; m < L.length; m++) {
        a11 += w[m] * J[m][0] * J[m][0]; a12 += w[m] * J[m][0] * J[m][1]; a22 += w[m] * J[m][1] * J[m][1];
        b1 += -w[m] * J[m][0] * rr[m]; b2 += -w[m] * J[m][1] * rr[m];
      }
      var det = a11 * a22 - a12 * a12;
      if (!(Math.abs(det) > 1e-12)) { res.degraded = true; break; }    // 秩亏（共线接入点）：不再硬解
      var sx = (b1 * a22 - b2 * a12) / det, sy = (a11 * b2 - a12 * b1) / det;
      // 阻尼：单步不超过 500 m，防止 RSSI 粗差把解甩到地球另一端
      var step = Math.sqrt(sx * sx + sy * sy);
      if (step > 500) { sx *= 500 / step; sy *= 500 / step; }
      px += sx; py += sy;
      cov = [[a11, a12], [a12, a22]];
      if (step < 1e-4) break;
    }
    var finalR = [];
    for (var q = 0; q < L.length; q++) {
      var qx = px - L[q].x, qy = py - L[q].y;
      finalR.push(Math.sqrt(qx * qx + qy * qy) - L[q].r);
    }
    var sq = 0, mx = 0;
    finalR.forEach(function (v) { sq += v * v; mx = Math.max(mx, Math.abs(v)); });
    res.residual_rmse_m = rnd(Math.sqrt(sq / finalR.length), 2);
    res.max_residual_m = rnd(mx, 2);
    res.ranges_m = L.map(function (x) { return rnd(x.r, 1); });
    res.used = L.map(function (x) { return { label: x.label, lat: rnd(x.lat, 6), lon: rnd(x.lon, 6), range_m: rnd(x.r, 1), sigma_m: rnd(x.sigma, 1) }; });
    res.iterations = iters;

    var geo = toLatLon(ref, px, py);
    res.lat = rnd(clamp(geo.lat, -90, 90), 6);
    res.lon = rnd(wrap180(geo.lon), 6);
    res.ok = true;
    res.method = res.degraded ? 'weighted-centroid(degraded)' : 'weighted-least-squares';
    if (cov && !res.degraded) {
      var d11 = cov[0][0], d12 = cov[0][1], d22 = cov[1][1];
      var detC = d11 * d22 - d12 * d12;
      if (Math.abs(detC) > 1e-12) {
        var ic = [[d22 / detC, -d12 / detC], [-d12 / detC, d11 / detC]];
        var ev = eig2(ic[0][0], ic[0][1], ic[1][1]);
        res.covariance_m2 = [[rnd(ic[0][0], 3), rnd(ic[0][1], 3)], [rnd(ic[1][0], 3), rnd(ic[1][1], 3)]];
        res.sigma_e_m = rnd(Math.sqrt(Math.max(0, ic[0][0])), 2);
        res.sigma_n_m = rnd(Math.sqrt(Math.max(0, ic[1][1])), 2);
        var mj = Math.sqrt(Math.max(0, ev.l1)), mn = Math.sqrt(Math.max(0, ev.l2));
        res.confidence_radius_m = rnd(mj + mn, 2);
        res.error_ellipse_m = { semi_major_m: rnd(mj, 2), semi_minor_m: rnd(mn, 2) };
        // GDOP 用「单位权方差」下的几何因子：√trace(cov)，与 σ 无关，只反映几何
        res.gdop = rnd(Math.sqrt(Math.max(0, ic[0][0] + ic[1][1]) / Math.max(1, median(L.map(function (x) { return x.sigma; }))), 2), 3);
      } else {
        res.degraded = true;
      }
    }
    if (res.degraded) {
      var sprior = Math.max(1, median(L.map(function (x) { return x.sigma; })));
      res.covariance_m2 = [[rnd(sprior * sprior, 1), 0], [0, rnd(sprior * sprior, 1)]];
      res.sigma_e_m = rnd(sprior, 2); res.sigma_n_m = rnd(sprior, 2);
      res.confidence_radius_m = rnd(2 * sprior, 2);
      res.gdop = null;
      res.warnings.push('接入点几何退化（共线或重合）：协方差不可解，按先验 σ 给圆近似');
    }
    if (!isNum(res.lat) || !isNum(res.lon)) { res.ok = false; res.error = '解算结果非法'; }
    return res;
  }

  // 与 GEOCELL 的交叉入口：GEOCELL 在场就用它的 trilaterate（它的经验模型更细），否则用内部 WLS
  function positionFromAps(aps, opt) {
    var o = opt || {};
    var cell = (typeof global.GEOCELL === 'object' && global.GEOCELL) ? global.GEOCELL : null;
    if (cell && typeof cell.trilaterate === 'function' && o.use_geocell !== false) {
      var r = cell.trilaterate(Array.isArray(aps) ? aps : (aps && aps.aps) || [], {
        model: o.model || 'log_normal', environment: o.environment, freq_mhz: o.freq_mhz,
        tx_power_dbm: o.tx_power_dbm, exponent: o.path_loss_exponent, shadow_sigma_db: o.shadow_sigma_db,
        reference_rssi_dbm_at_1m: o.reference_rssi_dbm_at_1m
      });
      if (r && typeof r === 'object') {
        var out = Object.assign({}, r, { engine: 'GEOCELL.trilaterate', error: r.ok ? null : (r.warnings && r.warnings.length ? r.warnings.join('；') : 'GEOCELL 未给出解'), note: '委托 core-cell：模型/截断/权重以它为准' });
        // 归一化：GEOCELL 的 ranges_m 已四舍五入，字段名与内部实现不完全同形，这里补齐内部形态
        if (!isNum(out.sigma_e_m)) out.sigma_e_m = isNum(out.confidence_radius_m) ? rnd(out.confidence_radius_m / 2, 2) : null;
        if (!isNum(out.sigma_n_m)) out.sigma_n_m = out.sigma_e_m;
        return sanitize(out);
      }
    }
    var self = trilaterateAps(aps, o);
    self.engine = 'internal';
    return sanitize(self);
  }

  /* ================================================================ 11. 输出净化 */
  // 外部数据（第三方 JSON / GEOCELL 的返回）可能带 NaN；所有对外结果统一过一遍：
  // 任何非有限的数都换成 null——UI 原样打印，「NaN」比「缺这个字段」更容易被当成有效读数。
  function sanitize(v, depth) {
    if (depth == null) depth = 0;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'function') return null;      // 函数不该出现在数据结果里（UI 打印它会是一坨源码）
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (v === null) return null;
    if (v === undefined) return null;               // undefined 会被 JSON 静默吞掉，换成显式 null
    if (depth > 6) return null;
    if (Array.isArray(v)) return v.map(function (x) { return sanitize(x, depth + 1); });
    if (typeof v === 'object') {
      var out = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = sanitize(v[k], depth + 1);
      return out;
    }
    return null;
  }

  /* ================================================================ 12. 异步 IO 原语 */
  // 纪律：导出的 async 函数**永不 reject**，一律 resolve 一个带 error/error_kind 的对象。
  // 为什么：调用方（UI）不该被迫写 try/catch；而且自检的垃圾参数扫描会产生游离 Promise，
  // Node 对未处理 rejection 是直接崩进程的——reject 就等于让自检失去可重复性。
  function waitWithTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (v) { if (!settled) { settled = true; resolve(v); } };
      var timer = null;
      if (ms > 0 && typeof setTimeout === 'function') {
        timer = setTimeout(function () { finish({ __timeout: true }); }, ms);
      }
      var clear = function () { if (timer && typeof clearTimeout === 'function') clearTimeout(timer); };
      promise.then(function (v) { clear(); finish({ __value: v }); },
        function (e) { clear(); finish({ __error: e }); });
    });
  }

  async function httpGetJson(url, opt) {
    var o = opt || {};
    var f = getFetch(o);
    if (!f) {
      return { ok: false, error_kind: POLICY.allow_real_network ? 'unsupported_env' : 'offline_disallowed',
        detail: POLICY.allow_real_network ? '环境没有 fetch' : '默认离线策略拦截（未注入 fetchImpl 且未授权出网）', url: String(url) };
    }
    var timeout = num(o.fetch_timeout_ms);
    if (timeout == null || timeout <= 0) timeout = DEFAULTS.fetch_timeout_ms;
    var t0 = Date.now();
    var p;
    try {
      p = Promise.resolve(f(url, { method: 'GET', headers: { 'accept': 'application/json' }, mode: 'cors' }));
    } catch (e) {
      return { ok: false, error_kind: 'network', detail: (e && e.message) || String(e), url: String(url), latency_ms: Date.now() - t0 };
    }
    var got = await waitWithTimeout(p, timeout);
    var latency = Date.now() - t0;
    if (got.__timeout) return { ok: false, error_kind: 'timeout', detail: timeout + ' ms', url: String(url), latency_ms: latency };
    if (got.__error) return { ok: false, error_kind: 'network', detail: (got.__error && got.__error.message) || String(got.__error), url: String(url), latency_ms: latency };
    var res = got.__value;
    if (res == null || typeof res !== 'object') return { ok: false, error_kind: 'json_error', detail: '响应对象为空', url: String(url), latency_ms: latency };
    var status = num(res.status) != null ? num(res.status) : 200;
    var text = null;
    if (typeof res.text === 'function') {
      var tp = await waitWithTimeout(Promise.resolve(res.text()).catch(function (e) { throw e; }), timeout);
      if (tp.__timeout) return { ok: false, error_kind: 'timeout', detail: '读取响应体超时', url: String(url), latency_ms: Date.now() - t0 };
      if (tp.__error) return { ok: false, error_kind: 'network', detail: (tp.__error && tp.__error.message) || String(tp.__error), url: String(url), latency_ms: Date.now() - t0 };
      text = tp.__value;
    } else if (typeof res === 'string') text = res;
    else if (res.json != null && res.text == null) text = JSON.stringify(res);   // mock 直接返回裸对象时的兼容路径
    if (status < 200 || status >= 300) return { ok: false, error_kind: 'http_error', status: status, detail: 'HTTP ' + status, url: String(url), latency_ms: latency, text: text };
    var json = null;
    try { json = (typeof text === 'string') ? JSON.parse(text) : text; }
    catch (e) { return { ok: false, error_kind: 'json_error', status: status, detail: (e && e.message) || String(e), url: String(url), latency_ms: latency, text: String(text).slice(0, 120) }; }
    if (json == null || typeof json !== 'object') return { ok: false, error_kind: 'json_error', status: status, detail: 'JSON 顶层不是对象', url: String(url), latency_ms: latency };
    return { ok: true, status: status, json: json, url: String(url), latency_ms: latency };
  }

  /* ================================================================ 13. 单源 / 多源 IP 定位 */
  function normalizeSourceList(opt) {
    var o = opt || {};
    var requested = Array.isArray(o.sources) && o.sources.length ? o.sources : null;
    var ids = [];
    if (requested) {
      for (var i = 0; i < requested.length; i++) {
        var s = SOURCE_BY_ID[String(requested[i])];
        if (s && ids.indexOf(s.id) < 0) ids.push(s.id);
      }
    } else {
      var pick = pickHealthySources(o);
      ids = pick.sources.slice();
    }
    if (Array.isArray(o.disabled_sources)) {
      ids = ids.filter(function (x) { return o.disabled_sources.indexOf(x) < 0; });
    }
    return ids;
  }

  async function fetchGeoIpOne(sourceId, opt) {
    try {
      var o = opt || {};
      var s = SOURCE_BY_ID[String(sourceId)];
      if (!s) return { result: errorResult(String(sourceId), 'bad_input', '未知源 ' + esc(sourceId)), health: null };
      /* 缓存也是联网出口：没授权就连读都不读。否则用户「收回联网授权」之后，
       * 旧的 IP 位置还会以 from_cache 的名义被当成这一轮的实测结果端出去。 */
      var c = getFetch(o) ? cacheGet(s.id, o.ip, o) : { hit: false, reason: 'policy_off' };
      if (c.hit && c.value && c.value.ok === true) {
        var cached = Object.assign({}, c.value, { from_cache: true, latency_ms: 0, cache_age_ms: c.age_ms });
        recordHealth(s.id, null, 0);
        return { result: sanitize(cached), health: healthOf(s.id), cache: 'hit' };
      }
      var built = buildSourceUrl(s.id, o);
      if (built.error) {
        return { result: errorResult(s.id, built.error_kind || 'bad_input', built.error), health: healthOf(s.id), cache: c.hit ? 'stale' : 'miss' };
      }
      var got = await httpGetJson(built.url, o);
      if (!got.ok) {
        var bad = consumeResponse(s.id, null, { error_kind: got.error_kind, detail: got.detail, latency_ms: got.latency_ms });
        bad.cache = c.hit ? 'stale' : 'miss';
        return bad;
      }
      var out = consumeResponse(s.id, got.json, { status: got.status, latency_ms: got.latency_ms });
      if (out.result && out.result.ok) {
        cacheSet(s.id, o.ip, Object.assign({}, out.result, { latency_ms: null }), o);
        out.cache = 'miss';
      } else out.cache = c.hit ? 'stale' : 'miss';
      return out;
    } catch (e) {
      return { result: errorResult(String(sourceId), 'network', (e && e.message) || String(e)), health: null };
    }
  }

  async function fetchGeoIpAll(opt) {
    var o = opt || {};
    try {
      var ids = normalizeSourceList(o);
      if (!ids.length) {
        return { ok: false, results: [], fused: { error: '没有可选的定位源' }, health: healthSnapshot(),
          error: '没有可选的定位源（可能全部被健康度阈值剔除，或都要求 api_key）', error_kind: 'source_disabled' };
      }
      var settled = await Promise.all(ids.map(function (id) { return fetchGeoIpOne(id, o); }));
      var results = settled.map(function (x) { return x.result; });
      var okCount = results.filter(function (r) { return r && r.ok === true; }).length;
      var fused = fuseIpSolutions(results, o);
      var errs = results.filter(function (r) { return !r.ok; })
        .map(function (r) { return { source: r.source, error_kind: r.error_kind, error: r.error }; });
      return sanitize({
        ok: okCount > 0,
        results: results,
        fused: fused,
        health: healthSnapshot(),
        errors: errs,
        queried_sources: ids,
        note: '每源结果独立可读；fused 用的是 1/accuracy² 加权，accuracy_fallback 的源权重来自兜底量级'
      });
    } catch (e) {
      return { ok: false, results: [], fused: { error: '编排异常（已捕获）：' + String((e && e.message) || e) }, health: healthSnapshot(), error_kind: 'network' };
    }
  }

  // 离线解 + 联网证据 → 是否升级（这是「自动升级」的总入口）
  async function onlineUpgrade(offlineSolution, opt) {
    var o = opt || {};
    try {
      var net = await fetchGeoIpAll(o);
      var decision = shouldEscalate(offlineSolution, net && net.fused && net.fused.ok ? net.fused : null, o);
      return sanitize({
        decision: decision,
        escalate: decision.escalate === true,
        reason: decision.reason,
        confidence: decision.confidence,
        fused: net.fused,
        per_source: net.results,
        health: net.health,
        note: 'decision.escalate=false 时不要覆盖离线解：IP 定位的精度量级不足以纠正健康的 GNSS/基站解'
      });
    } catch (e) {
      return { escalate: false, reason: '联网升级流程异常（已捕获）', confidence: 0, error: String((e && e.message) || e), error_kind: 'network' };
    }
  }

  /* ================================================================ 14. 主机名校验 + 路由追踪（桥接 / 浏览器降级） */
  /* 白名单式校验，和 server.py 的正则保持一致（两侧都不信对方）：
   * 只做字符集与结构检查，不做 DNS——校验函数的职责是「不让任意字符串进入命令」，不是「解析」。
   */
  var HOST_CHARSET_RE = /^[A-Za-z0-9._:-]+$/;
  var IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

  function validateHost(raw, opt) {
    var o = opt || {};
    var maxLen = num(o.max_length) != null ? Math.round(num(o.max_length)) : 253;
    var s = typeof raw === 'string' ? raw.trim() : null;
    if (!s) return { ok: false, host: null, kind: null, reason: '主机名为空' };
    if (s.length > maxLen) return { ok: false, host: null, kind: null, reason: '主机名过长（' + s.length + ' > ' + maxLen + '）' };
    if (!HOST_CHARSET_RE.test(s)) {
      return { ok: false, host: null, kind: null, reason: '含白名单 [A-Za-z0-9._:-] 之外的字符（空格/引号/分号/反引号/$()/换行等一律拒绝）' };
    }
    if (/[<>`|;&$()'"\\\s]/.test(s)) return { ok: false, host: null, kind: null, reason: '含 shell 元字符' };
    if (s.indexOf('..') >= 0) return { ok: false, host: null, kind: null, reason: '含连续点（非法域名）' };
    // 首尾字符：'-' 会被命令当成选项（例如 -h 注入），首尾的点/冒号是截断写法，全部拒绝
    if (/^-/.test(s)) return { ok: false, host: null, kind: null, reason: '以 - 开头（会被当作命令选项）' };
    if (/-$/.test(s)) return { ok: false, host: null, kind: null, reason: '以 - 结尾（非法域名标签）' };
    if (/^\./.test(s) || /\.$/.test(s)) return { ok: false, host: null, kind: null, reason: '以点开头/结尾（非法域名）' };
    if (/^:/.test(s) && s.indexOf('::') !== 0) return { ok: false, host: null, kind: null, reason: '单个前导冒号不是合法 IPv6' };
    if (/:$/.test(s)) return { ok: false, host: null, kind: null, reason: '以冒号结尾（截断的 IPv6）' };
    var v4 = IPV4_RE.exec(s);
    if (v4) {
      for (var i = 1; i <= 4; i++) {
        var part = v4[i];
        if (part.length > 1 && part[0] === '0') return { ok: false, host: null, kind: 'ipv4', reason: 'IPv4 段含前导零（' + part + '），按八进制歧义拒绝' };
        var n = parseInt(part, 10);
        if (!(n >= 0 && n <= 255)) return { ok: false, host: null, kind: 'ipv4', reason: 'IPv4 段越界（' + part + '）' };
      }
      return { ok: true, host: s, kind: 'ipv4', reason: null };
    }
    if (s.indexOf(':') >= 0) {
      // IPv6 字面量：只允许十六进制与压缩冒号，且 :: 最多一次（split('::') 计数会漏掉 ':::' 这种重叠写法，
      // 所以用 indexOf/lastIndexOf 比较，能抓住 2001:db8:::1）
      if (!/^[0-9A-Fa-f:.]+$/.test(s)) return { ok: false, host: null, kind: 'ipv6', reason: 'IPv6 含非十六进制字符' };
      if (s.indexOf('::') >= 0 && s.indexOf('::') !== s.lastIndexOf('::')) return { ok: false, host: null, kind: 'ipv6', reason: 'IPv6 压缩符 :: 出现多次' };
      if (s.indexOf(':::') >= 0) return { ok: false, host: null, kind: 'ipv6', reason: 'IPv6 出现连续三个及以上冒号' };
      var groups = s.split('::').join(':').split(':').filter(function (g) { return g !== ''; });
      for (var g = 0; g < groups.length; g++) {
        if (!/^[0-9A-Fa-f]+$/.test(groups[g].split('.').shift()) && !IPV4_RE.test(groups[g])) {
          return { ok: false, host: null, kind: 'ipv6', reason: 'IPv6 分组含非法字符（' + groups[g] + '）' };
        }
        if (groups[g].length > 4 && !IPV4_RE.test(groups[g])) return { ok: false, host: null, kind: 'ipv6', reason: 'IPv6 分组超长（' + groups[g] + '）' };
      }
      if (groups.length > 8) return { ok: false, host: null, kind: 'ipv6', reason: 'IPv6 分组超过 8 段' };
      if (s.indexOf('.') >= 0 && !IPV4_RE.test(s.split(':').pop())) return { ok: false, host: null, kind: 'ipv6', reason: 'IPv6 内嵌 IPv4 部分非法' };
      return { ok: true, host: s, kind: 'ipv6', reason: null };
    }
    // 域名：标签 1..63，仅字母数字连字符，且不能以连字符开头/结尾
    var labels = s.split('.');
    for (var l = 0; l < labels.length; l++) {
      var lab = labels[l];
      if (!/^[A-Za-z0-9-]+$/.test(lab)) return { ok: false, host: null, kind: 'domain', reason: '域名标签含非法字符（' + lab + '）' };
      if (lab.length > 63) return { ok: false, host: null, kind: 'domain', reason: '域名标签超过 63 字符' };
      if (lab[0] === '-' || lab[lab.length - 1] === '-') return { ok: false, host: null, kind: 'domain', reason: '标签以连字符开头/结尾' };
    }
    if (!/[A-Za-z0-9]/.test(s)) return { ok: false, host: null, kind: 'domain', reason: '域名无字母数字' };
    // 最后一段全是数字 → 想写 IPv4 但写错了（如 1.2.3.4.5）；纯数字 TLD 不是合法主机名
    if (/^\d+$/.test(labels[labels.length - 1])) {
      return { ok: false, host: null, kind: 'domain', reason: '末段为纯数字（疑似写错的 IPv4 字面量），拒绝' };
    }
    return { ok: true, host: s, kind: 'domain', reason: null };
  }

  // 桥接 URL 构造：显式禁止任何坐标类参数出现在查询串里（隐私红线的第二道闸）
  function buildBridgeUrl(path, params, opt) {
    var o = opt || {};
    if (typeof path !== 'string' || path[0] !== '/') return { error: 'path 需以 / 开头' };
    var base = typeof o.bridge_base === 'string' && o.bridge_base ? String(o.bridge_base) : POLICY.bridge_base;
    if (!/^https?:\/\/[A-Za-z0-9.:\-\[\]]+$/i.test(base)) return { error: 'bridge_base 不是合法 http(s) 端点' };
    var p = params || {};
    var parts = [];
    var banned = ['lat', 'lon', 'lng', 'latitude', 'longitude', 'position', 'loc', 'accuracy'];
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      if (banned.indexOf(String(k).toLowerCase()) >= 0) return { error: '拒绝把位置类参数 ' + k + ' 发给桥接服务' };
      var v = p[k];
      if (v == null) continue;
      if (!/^[A-Za-z0-9_.:-]+$/.test(String(k))) return { error: '参数名非法：' + String(k) };
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return { url: base.replace(/\/+$/, '') + path + (parts.length ? '?' + parts.join('&') : '') };
  }

  function parseTraceroutePayload(payload) {
    // 与 server.py /api/traceroute 的返回同形；字段缺失就报错，绝不补跳数
    if (!payload || typeof payload !== 'object') return { error: '桥接返回不是对象' };
    if (payload.ok !== true) return { error: String(payload.error || '桥接服务报告失败'), error_kind: payload.error_kind || 'bridge_unavailable' };
    var hops = Array.isArray(payload.hops) ? payload.hops : null;
    if (!hops) return { error: '桥接返回缺少 hops 数组（不做任何伪造）', error_kind: 'field_missing' };
    var out = [];
    for (var i = 0; i < hops.length; i++) {
      var h = hops[i];
      if (!h || typeof h !== 'object') continue;
      var rtts = Array.isArray(h.rtts_ms) ? h.rtts_ms.filter(isNum).map(function (x) { return rnd(x, 2); }) : [];
      var bounds = Array.isArray(h.rtt_bounds) ? h.rtt_bounds.filter(function (s) { return typeof s === 'string' && s; }).slice(0, 8) : [];
      var ip = pickStr(h, ['ip', 'address'], 64);
      // 「有 IP 应答但没印出毫秒数」是真实测到的一跳（中文 tracert 的 <1 毫秒 就属于这种），
      // 不能因为 rtts 空就判成无响应；真正的超时是既没有 RTT 也没有地址的 * * * 行。
      out.push({
        hop: num(h.hop) != null ? Math.round(num(h.hop)) : out.length + 1,
        ip: ip,
        hostname: pickStr(h, ['hostname', 'host', 'name'], 128),
        rtts_ms: rtts,
        rtt_bounds: bounds,
        timed_out: h.timed_out === true || (!rtts.length && !bounds.length && !ip),
        status: pickStr(h, ['status'], 32)
      });
    }
    return {
      hops: out,
      elapsed_ms: isNum(payload.elapsed_ms) ? rnd(payload.elapsed_ms, 1) : null,
      reached: payload.reached === true,
      // 目标归属由桥接标注（lan/public），这里只认这两个字面值，其它一律 null（不猜）
      target_scope: payload.target_scope === 'lan' || payload.target_scope === 'public' ? payload.target_scope : null,
      target_scope_note: pickStr(payload, ['target_scope_note'], 120),
      raw_note: pickStr(payload, ['note'], 200)
    };
  }

  async function dohResolve(host, opt) {
    var o = opt || {};
    try {
      var vh = validateHost(o.host != null ? o.host : host, o);
      if (!vh.ok) return { ok: false, error: vh.reason, error_kind: 'bad_input', answers: [] };
      var type = (typeof o.type === 'string' && /^(A|AAAA|CNAME|TXT|MX|NS|SOA|PTR|SRV)$/i.test(o.type)) ? o.type.toUpperCase() : 'A';
      // Google DoH 端点；字段名（Status/Answer[].data）按公开文档，未逐字段核对
      var base = typeof o.doh_url === 'string' && o.doh_url ? o.doh_url : 'https://dns.google/resolve?name={host}&type={type}';
      if (base.indexOf('{host}') < 0 || base.indexOf('{type}') < 0) return { ok: false, error: 'DoH URL 模板需含 {host} 与 {type}', error_kind: 'bad_input', answers: [] };
      var url = base.split('{host}').join(encodeURIComponent(vh.host)).split('{type}').join(type);
      var got = await httpGetJson(url, o);
      if (!got.ok) {
        return { ok: false, error: got.detail || (ERROR_KINDS[got.error_kind] || 'DoH 查询失败'), error_kind: got.error_kind, answers: [], url: url };
      }
      var j = got.json;
      var status = num(j.Status);
      var answers = Array.isArray(j.Answer) ? j.Answer : [];
      var list = [];
      for (var i = 0; i < answers.length; i++) {
        var a = answers[i];
        if (!a || typeof a !== 'object') continue;
        var data = pickStr(a, ['data', 'Answer', 'value'], 256);
        if (data) list.push({ type: num(a.type) != null ? Math.round(num(a.type)) : null, name: pickStr(a, ['name'], 128), data: data, ttl: num(a.TTL) });
      }
      return sanitize({
        ok: status === 0 && list.length > 0, host: vh.host, type: type, dns_status: status,
        Status_text: status === 0 ? 'NOERROR（按 RFC1035 RCODE）' : '非 0 状态码：需查 DoH 返回码表（本模块不猜含义）',
        answers: list, url: url, latency_ms: isNum(got.latency_ms) ? rnd(got.latency_ms, 1) : null,
        note: '浏览器侧 DoH 只能拿到「解析结果」，拿不到逐跳路由——跳数必须走桥接服务'
      });
    } catch (e) {
      return { ok: false, error: 'DoH 流程异常（已捕获）：' + String((e && e.message) || e), error_kind: 'network', answers: [] };
    }
  }

  /**
   * 桥接在 4xx/5xx 上也带 JSON 正文（里面是「为什么不给你跑」的中文原因）。
   * 早期版本把它丢掉、只报「HTTP 403」，于是界面看不出该加哪个参数——这里优先转述正文。
   */
  function bridgeErrorFromHttp(got) {
    var body = null;
    var raw = got && got.text;
    if (typeof raw === 'string' && raw) {
      try { body = JSON.parse(raw); } catch (e) { body = null; }
    } else if (raw && typeof raw === 'object') {
      body = raw;
    }
    if (body && typeof body === 'object' && typeof body.error === 'string' && body.error) {
      return { bridge_error: body.error,
        bridge_error_kind: (typeof body.error_kind === 'string' && body.error_kind) ? body.error_kind : 'bridge_unavailable',
        from_body: true };
    }
    return { bridge_error: (got && got.detail) || (got && ERROR_KINDS[got.error_kind]) || '桥接请求失败',
      bridge_error_kind: 'bridge_unavailable', from_body: false };
  }

  async function tracerouteViaBridge(host, opt) {
    var o = opt || {};
    try {
      var vh = validateHost(host, o);
      if (!vh.ok) {
        return sanitize({
          ok: false, host: null, hops: null, hop_count: null, fabricated_hops: false,
          error: '主机名校验失败：' + vh.reason, error_kind: 'bad_input',
          note: '未发起任何请求'
        });
      }
      var maxHops = num(o.max_hops) != null ? Math.round(clamp(num(o.max_hops), 1, 30)) : DEFAULTS.traceroute.max_hops;
      var wallMs = num(o.timeout_ms) != null ? Math.round(clamp(num(o.timeout_ms), 1000, 120000)) : DEFAULTS.traceroute.timeout_ms;
      var built = buildBridgeUrl('/api/traceroute', { host: vh.host, max_hops: maxHops, timeout: Math.round(wallMs / 1000) }, o);
      var fallback = null;
      if (built.error) {
        return sanitize({ ok: false, host: vh.host, hops: null, fabricated_hops: false, error: built.error, error_kind: 'bad_input' });
      }
      if (o.skip_bridge !== true) {
        var got = await httpGetJson(built.url, Object.assign({}, o, { fetch_timeout_ms: wallMs + 5000 }));
        if (got.ok) {
          var parsed = parseTraceroutePayload(got.json);
          if (!parsed.error) {
            return sanitize({
              ok: parsed.hops.length > 0, via: 'bridge', url: built.url, host: vh.host, host_kind: vh.kind,
              hops: parsed.hops, hop_count: parsed.hops.length, fabricated_hops: false,
              reached: parsed.reached, elapsed_ms: parsed.elapsed_ms,
              target_scope: parsed.target_scope, target_scope_note: parsed.target_scope_note,
              error: parsed.hops.length ? null : '桥接返回 0 跳（目标不可达或命令降级），未伪造跳数',
              error_kind: parsed.hops.length ? null : 'bridge_unavailable',
              note: '跳数完全来自本机桥接（server.py 或 bridge-powershell.ps1）调用系统 traceroute/tracert 的输出解析'
            });
          }
          fallback = { bridge_error: parsed.error, bridge_error_kind: parsed.error_kind };
        } else {
          fallback = bridgeErrorFromHttp(got);
        }
      } else {
        fallback = { bridge_error: '调用方指定 skip_bridge', bridge_error_kind: 'bridge_unavailable' };
      }
      // 纯浏览器降级：没有原始套接字权限，逐跳 ICMP 不可能——只做 DoH 解析，并明确说「跳数不可得」
      var doh = await dohResolve(vh.host, o);
      // 桥接「明确拒绝」（正文带 error_kind，如内网目标被策略挡下）要保留它的分类，
      // 而连不上/超时这类才归入 bridge_unavailable。
      var fbKind = (fallback && fallback.from_body) ? fallback.bridge_error_kind : 'bridge_unavailable';
      return sanitize({
        ok: false, via: 'browser-fallback', url: built.url, host: vh.host, host_kind: vh.kind,
        hops: null, hop_count: null, fabricated_hops: false,
        error: fbKind + '：' + (fallback ? fallback.bridge_error : '本地桥接服务不可达'),
        error_kind: fbKind,
        fallback: doh,
        limitation: '浏览器无法发送原始 ICMP/UDP，也不受 ping 速率限制接口约束，因此跳数必须由本机桥接（server.py 或 bridge-powershell.ps1）提供；' +
          '此处只补一份 DoH 解析结果，绝不编造 hop 列表',
        note: '若需在 file:// 页面用此功能，请先启动本机桥接（Windows 可双击启动器或跑 bridge-powershell.ps1，其余平台跑 python server.py），并确保未被「混合内容」策略拦截'
      });
    } catch (e) {
      return { ok: false, hops: null, fabricated_hops: false, error: '路由追踪流程异常（已捕获）：' + String((e && e.message) || e), error_kind: 'network' };
    }
  }

  function readCorsPolicy(cp) {
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) return null;   // 旧桥没这个字段：如实报 null，不猜
    var list = function (v) {
      var out = [];
      if (!Array.isArray(v)) return out;
      for (var i = 0; i < v.length && out.length < 16; i++) {
        if (typeof v[i] === 'string' && v[i]) out.push(String(v[i]).slice(0, 96));
      }
      return out;
    };
    return {
      declared: true,
      wildcard: cp.wildcard === true,
      built_in: list(cp.built_in),
      extra: list(cp.extra),
      loopback_origins_allowed: cp.loopback_origins_allowed === true,
      no_origin_clients_allowed: cp.no_origin_clients_allowed === true,
      note: pickStr(cp, ['note'], 200)
    };
  }

  async function bridgeStatus(opt) {
    var o = opt || {};
    try {
      var built = buildBridgeUrl('/api/health', {}, o);
      if (built.error) return sanitize({ ok: false, error: built.error, error_kind: 'bad_input' });
      var got = await httpGetJson(built.url, Object.assign({}, o, { fetch_timeout_ms: num(o.fetch_timeout_ms) || 3000 }));
      if (!got.ok) return sanitize({ ok: false, url: built.url, error: got.detail || ERROR_KINDS[got.error_kind], error_kind: got.error_kind, hops_available: false });
      var j = got.json || {};
      return sanitize({
        ok: j.ok === true || j.status === 'ok', url: built.url, server: pickStr(j, ['server', 'name'], 64),
        version: pickStr(j, ['version'], 32), python: pickStr(j, ['python'], 32), platform: pickStr(j, ['platform'], 32),
        // runtime 只有 PowerShell 那份桥会填（它 python=null，界面靠这个字段说清自己跑在什么上）。
        // 少带这一个字段，health 里明明写了「PowerShell 5.1」，界面却显示「运行环境未上报」。
        runtime: pickStr(j, ['runtime'], 48),
        // cors_policy 同理：⑧ 面板要回答的不是「我能连上这台桥吗」，
        // 而是「除了我，还有谁能在浏览器里读它」。名单不在这里透出来，界面只能说「桥版本过旧」，
        // 于是新桥也会被误报成旧桥——这一条在真浏览器里实测到过，所以给它配了闸门。
        cors_policy: readCorsPolicy(j.cors_policy),
        capabilities: Array.isArray(j.capabilities) ? j.capabilities.filter(function (x) { return typeof x === 'string'; }) : [],
        latency_ms: isNum(got.latency_ms) ? rnd(got.latency_ms, 1) : null,
        error: null, error_kind: null
      });
    } catch (e) {
      return { ok: false, error: '桥接健康检查异常（已捕获）：' + String((e && e.message) || e), error_kind: 'network' };
    }
  }

  /* ================================================================ 15. 自检用的 mock 夹具 */
  /* 纪律：自检**绝不联网**。所有响应都来自下面这些写死的样例 JSON——它们是「解析器测试的样例文本」，
   * 不代表任何真实服务当前的返回（各家字段名未逐字段核对，这点在源表 fields_note 里也写了）。
   */
  var SAMPLE_IP = {
    ipapi_com: { status: 200, body: { status: 'success', query: '203.0.113.10', lat: 37.751, lon: -97.822, city: 'Dover', country: 'United States', countryCode: 'US' } },
    ipinfo_io: { status: 200, body: { ip: '203.0.113.10', city: 'Mountain View', region: 'California', country: 'US', loc: '37.4056,-122.0775', org: 'AS15169' } },
    ipapi_co: { status: 200, body: { ip: '203.0.113.10', city: 'Mountain View', country_code: 'US', latitude: 37.4056, longitude: -122.0775, accuracy_radius: 100 } },
    ipwho_is: { status: 200, body: { success: true, ip: '203.0.113.10', city: 'Mountain View', country: 'United States', country_code: 'US', latitude: 37.4056, longitude: -122.0775 } },
    freeipapi: { status: 200, body: { ipAddress: '203.0.113.10', countryName: 'United States', countryCode: 'US', cityName: 'Mountain View', latitude: 37.4056, longitude: -122.0775 } },
    opencagedata: { status: 200, body: { status: { code: 200 }, results: [{ geometry: { lat: 37.4056, lng: -122.0775 }, components: { city: 'Mountain View', country_code: 'US' } }] } }
  };

  // 泄漏探测：对象里任何位置都不许出现 NaN/±Infinity（UI 会原样打印）
  function hasBad(o, depth) {
    if (depth == null) depth = 0;
    if (depth > 6) return false;
    if (typeof o === 'number') return !isFinite(o);
    if (Array.isArray(o)) return o.some(function (x) { return hasBad(x, depth + 1); });
    if (o && typeof o === 'object') return Object.keys(o).some(function (k) { return hasBad(o[k], depth + 1); });
    return false;
  }
  function SAMPLE_RESULT(lat, lon, acc, source) {
    return {
      ip: '203.0.113.10', lat: lat == null ? 31.2304 : lat, lon: lon == null ? 121.4737 : lon,
      accuracy_km: acc == null ? 20 : acc, city: 'Shanghai', country: 'CN',
      source: source || 'ipapi_com', ok: true, error: null, error_kind: null,
      accuracy_fallback: false, from_cache: false, latency_ms: 40, note: 'sample'
    };
  }

  function mockLocalStorage(behavior) {
    var b = behavior || {};
    var map = Object.create(null);
    return {
      _map: map, _calls: { get: 0, set: 0 },
      getItem: function (k) { this._calls.get++; if (b.throwOnGet) throw new Error('SecurityError: 隐私模式禁止访问 localStorage'); return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { this._calls.set++; if (b.throwOnSet) { var e = new Error('QuotaExceededError'); throw e; } map[k] = String(v); },
      removeItem: function (k) { delete map[k]; }
    };
  }

  // 路由表按「URL 片段」匹配；每条可给 status/body/behavior（timeout|reject|throw）
  function makeMockFetch(routes, bag) {
    var calls = bag && bag.calls ? bag.calls : [];
    var fn = function (url) {
      calls.push(String(url));
      for (var i = 0; i < routes.length; i++) {
        var r = routes[i];
        if (String(url).indexOf(r.match) < 0) continue;
        if (r.behavior === 'timeout') return new Promise(function () { /* 永不 resolve：靠超时闸门兜住 */ });
        if (r.behavior === 'reject') return Promise.reject(new Error(r.detail || 'mock: 网络层被拒'));
        if (r.behavior === 'throw') throw new Error(r.detail || 'mock: fetch 同步抛');
        var status = r.status == null ? 200 : r.status;
        var text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
        return Promise.resolve({ status: status, ok: status >= 200 && status < 300, text: function () { return Promise.resolve(text); } });
      }
      return Promise.resolve({ status: 404, ok: false, text: function () { return Promise.resolve('{"error":"no such mock route"}'); } });
    };
    fn.calls = calls;
    return fn;
  }

  function selfTest() {
    var out = [];
    // 只认严格 true：写成返回对象/数字的「顺手真值」会被静默放过，闸门就失去意义了。
    var push = function (name, pass, detail) { out.push({ name: name, pass: pass === true, detail: String(detail) }); };
    var near = function (a, b, tol) { return isNum(a) && isNum(b) && Math.abs(a - b) < tol; };

    // 可重复性从这里开始：任何上一次运行留下的健康度/缓存都可能改变本次判定
    resetHealth();
    clearCache({ storage: mockLocalStorage() });
    var savedPolicy = { allow_real_network: POLICY.allow_real_network, allow_ambient_storage: POLICY.allow_ambient_storage };
    POLICY.allow_real_network = false;
    var savedMemory = Object.assign({}, memoryStore);

    /* ---------- 1. 源表完整性与「未核对」标注 ---------- */
    push('IP 定位源不少于 4 个且 ID 唯一', (function () {
      var ids = IP_SOURCES.map(function (s) { return s.id; });
      return IP_SOURCES.length >= 4 && new Set(ids).size === ids.length;
    })(), IP_SOURCES.length + ' 源：' + sourceIds().join(', '));
    push('每源都标注了「字段未逐字段核对」并给出容错候选键名', IP_SOURCES.every(function (s) {
      return /未逐字段核对|未核对/.test(s.fields_note) && Array.isArray(s.lat_keys) && s.lat_keys.length >= 1 && Array.isArray(s.lon_keys) && s.lon_keys.length >= 1;
    }), '解析器一律多键名候选 + 缺失即 error，不猜值');
    push('每源的 URL 模板可覆盖（url_* 或 self_unsupported）', IP_SOURCES.every(function (s) {
      return (typeof s.url_self === 'string' && /^https?:\/\//.test(s.url_self)) || s.self_unsupported === true;
    }), 'OpenCage 无法查出口 IP，显式标 self_unsupported 而不是硬造 URL');
    push('URL 模板里不存在任何坐标占位符（隐私：模板层面就写不进经纬度）', IP_SOURCES.every(function (s) {
      var t = (s.url_self || '') + '|' + (s.url_query || '');
      return !/[?&](lat|lon|lng|latitude|longitude|loc|position)=/i.test(t) && !/\{(lat|lon|latitude|longitude)\}/.test(t);
    }), '占位符只有 {ip} 与 {key}');

    /* ---------- 2. 隐私红线 ---------- */
    var audit = privacyAudit({ lat: 31.2304, lon: 121.4737, ip: '203.0.113.10' });
    push('privacyAudit：带假位置构造全部源 URL，均不含 31.2304/121.4737', (function () {
      var joined = audit.urls.join('\n');
      return audit.violations.length === 0 && joined.indexOf('31.2304') < 0 && joined.indexOf('121.4737') < 0;
    })(), '检查 ' + audit.checked + ' 源，违规 ' + audit.violations.length + '；URL 数 ' + audit.urls.length);
    push('privacyAudit（不指定 ip 的本机查询形态）同样无坐标', (function () {
      var a2 = privacyAudit({ lat: 31.2304, lon: 121.4737 });
      return a2.violations.length === 0 && a2.urls.every(function (u) { return u.indexOf('31.2304') < 0 && u.indexOf('121.4737') < 0; });
    })(), 'self 查询只暴露出口 IP 本身，这一点写在 note 里');
    push('桥接 URL 构造器显式拒绝 lat/lon 参数', (function () {
      var bad = buildBridgeUrl('/api/traceroute', { host: 'a.example', lat: 31.2304 });
      var bad2 = buildBridgeUrl('/api/traceroute', { host: 'a.example', longitude: 121.47 });
      var good = buildBridgeUrl('/api/health', {}, {});
      return bad.error != null && bad2.error != null && good.url.indexOf('/api/health') > 0;
    })(), '不是「忘了拼」，是参数名命中禁发清单直接拒绝');

    /* ---------- 3. 逐源解析（样例文本，不代表线上真实返回） ---------- */
    var parseOk = [], parseDetail = [];
    for (var si = 0; si < IP_SOURCES.length; si++) {
      var src = IP_SOURCES[si];
      var smp = SAMPLE_IP[src.id];
      if (!smp) { parseOk.push(false); parseDetail.push(src.id + ':无样例'); continue; }
      var pr = parseIpSource(src.id, smp.body, { latency_ms: 42 });
      var fieldsOk = pr.ok === true && isNum(pr.lat) && isNum(pr.lon) && isNum(pr.accuracy_km) && pr.accuracy_km > 0 &&
        typeof pr.source === 'string' && 'city' in pr && 'country' in pr && 'error' in pr && 'ip' in pr;
      parseOk.push(fieldsOk);
      parseDetail.push(src.id + '=' + (fieldsOk ? (pr.lat + ',' + pr.lon + ' ±' + pr.accuracy_km + 'km fb:' + pr.accuracy_fallback) : ('BAD ' + JSON.stringify(pr).slice(0, 80))));
    }
    push('全部源样例 JSON → 统一结构 {ip,lat,lon,accuracy_km,city,country,source,ok,error}', parseOk.every(Boolean), parseDetail.join(' | '));
    push('ipinfo 的 loc="纬度,经度" 字符串被正确拆分（顺序写反就会解到大西洋）', (function () {
      var p = parseIpSource('ipinfo_io', SAMPLE_IP.ipinfo_io.body, {});
      return near(p.lat, 37.4056, 1e-6) && near(p.lon, -122.0775, 1e-6);
    })(), 'loc 是单串双值，解析器按文档顺序拆');
    push('OpenCage 的 results[0].geometry 嵌套形态被展平', (function () {
      var p = parseIpSource('opencagedata', SAMPLE_IP.opencagedata.body, {});
      return p.ok === true && near(p.lat, 37.4056, 1e-6) && p.source === 'opencagedata';
    })(), 'nested_result 展平 components+geometry');
    push('未报告精度的源走显式兜底并打 accuracy_fallback 标记', (function () {
      var a = parseIpSource('ipapi_com', SAMPLE_IP.ipapi_com.body, {});       // 无精度字段
      var b = parseIpSource('ipapi_co', SAMPLE_IP.ipapi_co.body, {});          // 样例里带 accuracy_radius
      return a.accuracy_fallback === true && a.accuracy_km > 0 && b.accuracy_fallback === false && near(b.accuracy_km, 100, 1e-6);
    })(), '兜底是「不知道」的表达，不是该源的实测精度');
    push('accuracy_radius 若被解释为英里则量级会翻倍——本实现按文档读作 km 并标注未核对', (function () {
      var p = parseIpSource('ipapi_co', { ip: '1.1.1.1', latitude: 1, longitude: 2, accuracy_radius: 20 }, {});
      return p.ok === true && near(p.accuracy_km, 20, 1e-9);
    })(), '按 ipapi.co 文档字段名 accuracy_radius（单位 km，未逐字段核对）');

    /* ---------- 4. 错误分类：六种失败必须给出六种不同的 error_kind，且都不抛 ---------- */
    var kinds = {};
    var k1 = consumeResponse('ipapi_com', null, { error_kind: 'timeout', latency_ms: 8000 }).result;
    var k2 = consumeResponse('ipapi_com', null, { status: 429, latency_ms: 20 }).result;
    var k3 = consumeResponse('ipapi_com', '这不是 JSON{{{', { status: 200, latency_ms: 20 }).result;
    var k4 = consumeResponse('ipapi_com', { status: 'success', city: 'x' }, { status: 200, latency_ms: 20 }).result;
    var k5 = consumeResponse('ipapi_com', { status: 'success', lat: 200, lon: 0 }, { status: 200 }).result;
    var k6 = consumeResponse('ipapi_com', { status: 'fail', message: 'Invalid query' }, { status: 200 }).result;
    [k1, k2, k3, k4, k5, k6].forEach(function (r) { kinds[r.error_kind] = (kinds[r.error_kind] || 0) + 1; });
    push('超时/HTTP/JSON/缺字段 → 四类 error_kind 与四套中文文案互不相同', (function () {
      var want = ['timeout', 'http_error', 'json_error', 'field_missing'];
      var eachOnce = want.every(function (w) { return kinds[w] === 1; });
      var texts = [k1.error, k2.error, k3.error, k4.error];
      return eachOnce && new Set(texts).size === 4 && kinds.field_invalid >= 1;
    })(), Object.keys(kinds).join(', ') + '（源自报失败与字段越界同归 field_invalid，但都带各自原因文本）');
    push('源自报 status:"fail" 的错误里带上对方给的 message（不吞掉原因）', k6.error === ERROR_KINDS.field_invalid + '：Invalid query', String(k6.error));
    push('所有失败结果仍是完整统一结构且不含 NaN/Infinity', (function () {
      var arr = [k1, k2, k3, k4, k5, k6];
      return arr.every(function (r) { return r.ok === false && r.error != null && r.lat === null && r.lon === null && !hasBad(r); });
    })(), 'error 分支也照样要过 NaN 闸门');
    push('未知源 ID 返回 error 而不是抛异常', (function () {
      var r = consumeResponse('does_not_exist', {}, {});
      return r.result.ok === false && r.result.error_kind === 'bad_input';
    })(), 'consumeResponse 对脏 ID 也稳');
    push('需要 key 的源在未给 key / 未给 ip 时明确跳过', (function () {
      var a = buildSourceUrl('opencagedata', {});
      var b = buildSourceUrl('opencagedata', { ip: '1.1.1.1' });
      var c = buildSourceUrl('opencagedata', { ip: '1.1.1.1', api_key: 'K' });
      return a.error != null && b.error != null && c.url.indexOf('key=K') > 0;
    })(), '不猜 key，也不猜 URL');
    push('被查 IP 字面量做字符白名单，任意串不会被拼进 URL', (function () {
      var a = buildSourceUrl('ipapi_co', { ip: '1.1.1.1"; rm -rf /' });
      var b = buildSourceUrl('ipapi_co', { ip: '1.1.1.1' });
      return a.error != null && b.url.indexOf('/1.1.1.1/json/') > 0;
    })(), '路径型模板最怕注入，先校验再拼');

    /* ---------- 5. 健康检查 ---------- */
    resetHealth();
    var hA = consumeResponse('ipwho_is', SAMPLE_IP.ipwho_is.body, { status: 200, latency_ms: 100 }).health;
    consumeResponse('ipwho_is', null, { error_kind: 'timeout' });
    consumeResponse('ipwho_is', null, { status: 503, latency_ms: 50 });
    var hRec = healthOf('ipwho_is');
    push('健康度记录成功率/平均时延/连续失败次数', (function () {
      return hRec.total === 3 && hRec.ok_count === 1 && hRec.fail_count === 2 && hRec.consecutive_failures === 2 &&
        near(hRec.success_rate, 1 / 3, 1e-3) && isNum(hRec.latency_ms_avg) && hRec.last_error_kind === 'http_error';
    })(), 'total=' + hRec.total + ' rate=' + hRec.success_rate + ' avg=' + hRec.latency_ms_avg + 'ms consec=' + hRec.consecutive_failures);
    var pick1 = pickHealthySources({ max_consecutive_failures: 3 });
    var pick2 = pickHealthySources({ max_consecutive_failures: 2 });
    push('pickHealthySources 按「连续失败阈值」剔除坏源，阈值可配', (function () {
      var inA = pick1.sources.indexOf('ipwho_is') >= 0, inB = pick2.sources.indexOf('ipwho_is') < 0;
      return inA && inB && pick2.skipped.some(function (x) { return x.source === 'ipwho_is' && x.reason.indexOf('连续失败') >= 0; });
    })(), 'consec=2 < 阈值 3 时保留，阈值降到 2 即剔除（入选 ' + pick1.sources.length + ' → ' + pick2.sources.length + ' 源）');
    consumeResponse('ipwho_is', null, { error_kind: 'timeout' });
    push('需要 api_key / 不支持查出口 IP 的源在无 key 时不进候选清单', (function () {
      var p = pickHealthySources({});
      var why = p.skipped.filter(function (x) { return x.source === 'opencagedata'; })[0];
      return p.sources.indexOf('opencagedata') < 0 && why != null;
    })(), 'OpenCage 缺席：' + (function () { var w = pickHealthySources({}).skipped.filter(function (x) { return x.source === 'opencagedata'; })[0]; return w ? w.reason : 'NA'; })());
    push('坏源不影响好源入选，且平均时延超限也剔除', (function () {
      resetHealth();
      consumeResponse('ipapi_co', SAMPLE_IP.ipapi_co.body, { status: 200, latency_ms: 9000 });
      consumeResponse('ipinfo_io', SAMPLE_IP.ipinfo_io.body, { status: 200, latency_ms: 30 });
      var p = pickHealthySources({ max_avg_latency_ms: 5000, min_samples: 1 });
      return p.sources.indexOf('ipinfo_io') >= 0 && p.sources.indexOf('ipapi_co') < 0;
    })(), '按 9000ms 的慢源被剔除，30ms 的留下');
    push('健康度快照对全部源可读且无数值泄漏', (function () {
      var s = healthSnapshot();
      return Array.isArray(s) && s.every(function (x) { return !hasBad(x); });
    })(), healthSnapshot().length + ' 条记录');

    /* ---------- 6. 缓存：注入存储 + 默认不碰宿主存储 + 隐私模式降级 ---------- */
    resetHealth();
    var ls = mockLocalStorage();
    var cput = cacheSet('ipapi_com', null, SAMPLE_RESULT(), { storage: ls });
    var cget = cacheGet('ipapi_com', null, { storage: ls, cache_ttl_ms: 60000 });
    push('缓存写入/命中并保留统一结构', (function () {
      return cput.ok === true && cget.hit === true && cget.value.ok === true && isNum(cget.value.lat) && cget.storage === 'injected';
    })(), 'key=' + cput.key + ' age=' + cget.age_ms + 'ms');
    push('缓存键名带版本前缀（结构变更不会被旧数据污染）', /^geonet\.v1\./.test(cput.key), cput.key);
    push('TTL=0 立即过期 → 未命中并归类 expired', (function () {
      var g = cacheGet('ipapi_com', null, { storage: ls, cache_ttl_ms: 0 });
      return g.hit === false && g.reason === 'expired';
    })(), '过期即删，不把陈旧当缓存');
    push('损坏条目 → corrupt_entry 并清除（不影响后续写入）', (function () {
      var ls2 = mockLocalStorage();
      ls2.setItem('geonet.v1.geoip.ipinfo_io.self', '{  broken json');
      var g = cacheGet('ipinfo_io', null, { storage: ls2 });
      return g.hit === false && g.reason === 'corrupt_entry' && ls2.getItem('geonet.v1.geoip.ipinfo_io.self') === null;
    })(), 'JSON.parse 失败不能拖垮定位');
    push('隐私模式（读写都抛异常）→ 降级内存容器，全程不抛', (function () {
      var boom = { getItem: function () { throw new Error('SecurityError'); }, setItem: function () { throw new Error('SecurityError'); }, removeItem: function () { throw new Error('SecurityError'); } };
      var s = cacheSet('ipinfo_io', null, SAMPLE_RESULT(), { storage: boom });
      var g = cacheGet('ipinfo_io', null, { storage: boom });
      return s.ok === false && g.hit === false && g.reason === 'miss';
    })(), '宿主 localStorage 在部分浏览器隐私模式下访问即抛，注入的存储也一样：异常必须被吞掉');
    push('配额超限（setItem 抛）→ 只丢缓存，不丢定位', (function () {
      var full = mockLocalStorage({ throwOnSet: true });
      var s = cacheSet('freeipapi', null, SAMPLE_RESULT(), { storage: full });
      return s.ok === false && s.note.indexOf('降级') >= 0;
    })(), '写入失败返回 ok:false 而不是异常');
    push('clearCache 精确清掉本模块前缀的条目（不误删宿主数据）', (function () {
      var ls3 = mockLocalStorage();
      ls3.setItem('someone-elses-key', 'keep me');
      cacheSet('ipapi_com', null, SAMPLE_RESULT(), { storage: ls3 });
      var n = clearCache({ storage: ls3 });
      return n.removed >= 1 && ls3.getItem('someone-elses-key') === 'keep me';
    })(), '按索引删除，索引本身也带前缀');
    push('出厂默认就禁用宿主存储：allow_ambient_storage=false 且 rawStore 取不到宿主句柄', (function () {
      POLICY.allow_ambient_storage = SHIPPED_ALLOW_AMBIENT_STORAGE;   // 用模块加载时的出厂值判断，不受前置闸门改动影响
      var p = networkPolicy();
      var r = rawStore({});
      return p.allow_ambient_storage === false && r.store === null && r.kind === 'disabled';
    })(), 'GEONET 不提供任何明文落盘路径：要留档的记录只能进 GEOVAULT 的 AES-256-GCM 信封');
    push('策略禁用宿主存储时，缓存写入落进模块内存并可命中（不是静默失败）', (function () {
      POLICY.allow_ambient_storage = false;
      var st = storageHandle({});
      cacheSet('ipapi_co', null, SAMPLE_RESULT(), {});
      var g = cacheGet('ipapi_co', null, {});
      return st.kind === 'disabled(policy)' && st.raw === memoryStore && g.hit === true && g.storage === 'disabled(policy)';
    })(), '关页面即消失，不写磁盘、不跨标签页共享');
    var ambWindow = (function () {
      var before = ambientStorageReads;
      cacheSet('ipwho_is', null, SAMPLE_RESULT(), {});
      cacheGet('ipwho_is', null, {});
      cacheStats({});
      clearCache({});
      return { before: before, after: ambientStorageReads };
    })();
    push('策略禁用宿主存储时，缓存四个入口一次都不读 localStorage', ambWindow.after === ambWindow.before,
      '宿主存储读取计数 ' + ambWindow.before + ' → ' + ambWindow.after + '（读一次就可能写一次，明文位置等于交给别人）');
    push('显式授权后宿主存储才可用；收回授权立刻回到 disabled', (function () {
      var before = ambientStorageReads;
      POLICY.allow_ambient_storage = true;
      var r = rawStore({});
      var hits = ambientStorageReads - before;
      POLICY.allow_ambient_storage = false;
      var back = rawStore({});
      return hits === 1 && (r.kind === 'localStorage' || r.kind === 'memory') && back.kind === 'disabled';
    })(), '本环境宿主存储：' + (function () {
      POLICY.allow_ambient_storage = true;
      var k = rawStore({}).kind;
      POLICY.allow_ambient_storage = false;
      return k === 'localStorage' ? '有 localStorage（授权后确实会用）' : '没有 localStorage（浏览器隐私模式 / Node 沙箱）';
    })() + '——授权位是唯一入口，默认关闭');
    push('全部缓存闸门跑完，宿主 localStorage 里没有本模块前缀的键', (function () {
      var amb;
      try { amb = global.localStorage; } catch (e) { amb = null; }
      if (!amb || typeof amb.length !== 'number' || typeof amb.key !== 'function') return true;
      for (var i = 0; i < amb.length; i++) {
        var k = amb.key(i);
        if (typeof k === 'string' && k.indexOf(DEFAULTS.cache_prefix) === 0) return false;
      }
      return true;
    })(), (function () {
      var amb;
      try { amb = global.localStorage; } catch (e) { amb = null; }
      return amb && typeof amb.length === 'number' ? ('真实宿主存储已逐键检查（' + amb.length + ' 键）') : '本环境没有宿主存储，此门为旁证（主证是上一条的读取计数）';
    })());

    /* ---------- 7. 多源融合 ---------- */
    var mkRes = function (id, lat, lon, acc, okFlag) {
      return { ip: '1.1.1.1', lat: lat, lon: lon, accuracy_km: acc, city: null, country: null, source: id, ok: okFlag !== false, error: okFlag === false ? 'x' : null, error_kind: okFlag === false ? 'timeout' : null, accuracy_fallback: false };
    };
    var mixed = [
      mkRes('ipapi_com', 31.2304, 121.4737, 20),
      mkRes('ipinfo_io', 31.2310, 121.4730, 40),
      mkRes('ipapi_co', 31.2298, 121.4742, 10),
      mkRes('ipwho_is', 31.2306, 121.4735, 50),
      mkRes('freeipapi', 34.05, -118.25, 30),              // 故意离群：洛杉矶
      mkRes('opencagedata', null, null, null, false)        // 失败源
    ];
    var fu = fuseIpSolutions(mixed, {});
    push('融合剔除离群源并保留其余（离群判定记录偏差与理由）', (function () {
      return fu.ok === true && fu.n_used === 4 && fu.rejected.some(function (x) { return x.source === 'freeipapi' && x.dev_km > 500; }) &&
        fu.rejected.some(function (x) { return x.source === 'opencagedata'; });
    })(), 'used=' + fu.n_used + '，离群 ' + (function () { var r = fu.rejected.filter(function (x) { return x.dev_km != null; }); return r.map(function (x) { return x.source + ':' + x.dev_km + 'km'; }).join(','); })());
    push('每源偏差用测地线距离报告，且与独立实现一致', (function () {
      // dev_km 相对稳健中心（判离群用），dev_final_km 相对最终融合点（给人看的）；
      // 后者必须与「自己另算一遍测地线距离」严格一致，否则就是坐标/轴顺序写错了。
      var d = fu.deviations_km.filter(function (x) { return x.source === 'freeipapi'; })[0];
      var manual = greatCircleKm(34.05, -118.25, fu.lat, fu.lon);
      var manualRound = Math.round(manual * 1000) / 1000;
      var devKmOk = fu.deviations_km.every(function (x) { return isNum(x.dev_km); });
      return d != null && isNum(d.dev_final_km) && Math.abs(d.dev_final_km - manualRound) < 0.02 && devKmOk;
    })(), '偏差 ' + JSON.stringify(fu.deviations_km.map(function (x) { return x.source + '=稳健' + x.dev_km + '/最终' + x.dev_final_km; })));
    push('weighted_median 模式在等权三源下给出中间源（顺序无关）', (function () {
      var f = fuseIpSolutions([mkRes('a', 30, 120, 10), mkRes('b', 30, 121, 10), mkRes('c', 30, 123, 10)], { fuse: { method: 'weighted_median' } });
      return f.method === 'weighted-median' && near(f.lat, 30, 1e-6) && near(f.lon, 121, 1e-6) && f.engine === 'internal';
    })(), '中位数不参与委托：它是稳健估计，BLUE 委托只服务加权平均');
    push('权重严格 = 1/accuracy²（更准的源权重更大）', (function () {
      var byId = {};
      fu.used.forEach(function (x) { byId[x.source] = x; });
      var wOrderOk = byId.ipapi_co.weight > byId.ipapi_com.weight && byId.ipapi_com.weight > byId.ipinfo_io.weight && byId.ipinfo_io.weight > byId.ipwho_is.weight;
      var exact = Math.abs(byId.ipapi_co.weight - 1 / (10 * 10)) < 1e-9;
      return wOrderOk && exact;
    })(), '权重 ' + fu.used.map(function (x) { return x.source + '=' + x.weight; }).join(', '));
    push('等权两源的中点与加权平均重合（解析特例）', (function () {
      var f = fuseIpSolutions([mkRes('a', 30, 120, 10), mkRes('b', 30, 122, 10)], {});
      return near(f.lat, 30, 1e-6) && near(f.lon, 121, 1e-6);
    })(), '对称样本给出对称答案，抓「权重被写反」');
    var tight = fuseIpSolutions([mkRes('a', 31.2304, 121.4737, 5), mkRes('b', 31.23041, 121.47371, 5), mkRes('c', 31.23039, 121.47369, 5)], { fuse: { outlier_floor_km: 1e9 } });
    var spread = fuseIpSolutions([mkRes('a', 31.23, 121.47, 2), mkRes('b', 33.23, 123.47, 2), mkRes('c', 29.23, 119.47, 2)], { fuse: { outlier_floor_km: 1e9 } });
    push('χ² 一致性：贴合样本判一致、散布样本判矛盾（p 值单调）', (function () {
      return tight.consistency.inconsistent === false && spread.consistency.inconsistent === true &&
        spread.consistency.chi2 > tight.consistency.chi2 && tight.consistency.p_value > spread.consistency.p_value;
    })(), 'tight χ²=' + tight.consistency.chi2 + ' p=' + tight.consistency.p_value + '；spread χ²=' + spread.consistency.chi2 + ' p=' + spread.consistency.p_value);
    push('MAD 判据在近邻样本上不误杀（floor 起作用）', (function () {
      var f = fuseIpSolutions([mkRes('a', 31.2304, 121.4737, 5), mkRes('b', 31.2305, 121.4738, 5), mkRes('c', 31.2404, 121.4837, 5)], {});
      return f.n_used === 3 && f.rejected.filter(function (x) { return x.dev_km != null; }).length === 0;
    })(), '三源相距 <1 km：MAD 会趋 0，地板 50 km 拦住误判');
    push('全部源不可用 → {error}，不返回带 NaN 的伪解', (function () {
      var a = fuseIpSolutions([mkRes('a', null, null, null, false)], {});
      var b = fuseIpSolutions([], {});
      return a.error != null && b.error != null;
    })(), 'error 分支：' + String(fuseIpSolutions([], {}).error));
    push('单源融合直接返回该源且 dof 兜底 ≥1', (function () {
      var f = fuseIpSolutions([mkRes('a', 31.2304, 121.4737, 20)], {});
      return f.ok === true && near(f.lat, 31.2304, 1e-6) && f.consistency.dof >= 1 && f.n_used === 1;
    })(), 'dof=' + fuseIpSolutions([mkRes('a', 31.2304, 121.4737, 20)], {}).consistency.dof + '（n−1=0 时按 1 兜底，避免除零）');
    push('融合报告同时给 BLUE 后验 σ 与保守精度分位，并说明为何取后者', (function () {
      var f = fuseIpSolutions(mixed, {});
      return isNum(f.sigma_blue_km) && isNum(f.accuracy_km_conservative) && f.accuracy_km >= f.sigma_blue_km &&
        f.caveats.join(' ').indexOf('不独立') >= 0;
    })(), 'sigma_blue=' + fuseIpSolutions(mixed, {}).sigma_blue_km + ' km，报告精度=' + fuseIpSolutions(mixed, {}).accuracy_km + ' km');
    push('委托 GEOGNSS.fuseSolutions（存在时）与三种降级路径都可用', (function () {
      var saved = global.GEOGNSS;
      var pair = [mkRes('a', 31.2304, 121.4737, 20), mkRes('b', 31.2306, 121.4735, 20)];
      // 1) 委托成功
      global.GEOGNSS = { fuseSolutions: function (sols, o) { return { lat: 31.23, lon: 121.47, sigma_e_m: 1, sigma_n_m: 1, consistency: { chi2: 1, dof: 1, p_value: 1, inconsistent: false } }; } };
      var viaDelegate = fuseIpSolutions(pair, {});
      // 2) 委托被拒（core-gnss 报错 / 返回不合格）→ 内部加权平均，且必须仍能出解
      global.GEOGNSS = { fuseSolutions: function () { return { error: '模拟 core-gnss 拒绝' }; } };
      var viaRejected = fuseIpSolutions(pair, {});
      // 3) 显式关闭委托（真实环境已加载 core-gnss 时，自检也要能验证内部实现）
      var viaInternal = fuseIpSolutions(pair, { use_geognss: false });
      if (saved === undefined) delete global.GEOGNSS; else global.GEOGNSS = saved;
      return viaDelegate.engine === 'GEOGNSS.fuseSolutions' && viaDelegate.ok === true && near(viaDelegate.lat, 31.23, 1e-6) &&
        viaRejected.ok === true && viaRejected.engine.indexOf('GEOGNSS 委托被拒') >= 0 &&
        viaInternal.engine === 'internal' && viaInternal.ok === true &&
        !hasBad(viaDelegate) && !hasBad(viaRejected) && !hasBad(viaInternal);
    })(), 'core-gnss 缺席/报错/被显式关闭都不会让融合失去输出');

    /* ---------- 8. 卡方工具：用与实现无关的解析恒等式抓错 ---------- */
    push('χ² 存活函数：dof=2 时严格等于 exp(−x/2)（指数分布恒等式）', (function () {
      var xs = [0, 0.5, 1, 2, 4, 9.2103];
      for (var i = 0; i < xs.length; i++) {
        var s = chiSquareSurvival(xs[i], 2);
        if (s == null || Math.abs(s - Math.exp(-xs[i] / 2)) > 1e-9) return false;
      }
      return true;
    })(), 'χ²(2) 就是指数分布：这是不依赖任何查表的独立校验');
    push('χ² 存活函数：x=0 时 =1，且随 x 单调下降（概率公理）', (function () {
      if (chiSquareSurvival(0, 5) !== 1) return false;
      var prev = 1;
      for (var x = 0.1; x < 60; x += 0.1) {
        var s = chiSquareSurvival(x, 5);
        if (s == null || s > prev + 1e-12) return false;
        prev = s;
      }
      return prev < 1e-6;
    })(), '单调性抓「级数/连分支选错」这类错误');
    push('χ² 与 Γ 的反射公式自洽（logGamma 用 Γ(z)Γ(1−z)=π/sinπz 校验）', (function () {
      var zs = [0.1, 0.25, 0.4, 0.7];
      for (var i = 0; i < zs.length; i++) {
        var a = logGamma(zs[i]) + logGamma(1 - zs[i]);
        var b = Math.log(PI / Math.sin(PI * zs[i]));
        if (Math.abs(a - b) > 1e-9) return false;
      }
      return true;
    })(), '欧拉反射公式，独立于 Lanczos 系数表');
    push('chiSquareCritical 与 chiSquareSurvival 互逆（分位数定义）', (function () {
      var dof = 4, p = 0.05;
      var x = chiSquareCritical(dof, p);
      return x != null && Math.abs(chiSquareSurvival(x, dof) - p) < 1e-6;
    })(), 'χ²₀.₉₅(4)=' + chiSquareCritical(4, 0.05).toFixed(4) + '（值由二分算出，不来自查表）');

    /* ---------- 9. 离线 → 联网 自动升级 ---------- */
    var goodFix = { lat: 31.2304, lon: 121.4737, sigma_e_m: 3, sigma_n_m: 4, hdop: 1.2, rms_residual_m: 1.5, sats_used: 11, integrity: { alarm: false } };
    var netNear = { ok: true, lat: 31.2310, lon: 121.4740, accuracy_km: 30 };
    push('健康离线解 + 范围内的联网点 → 不升级（IP 定位不该纠正 GNSS）', (function () {
      var d = shouldEscalate(goodFix, netNear, {});
      return d.escalate === false && d.confidence >= 0 && d.reason.indexOf('无需升级') > 0 && !hasBad(d);
    })(), 'χ² 归一化后 p=' + (function () { var c = shouldEscalate(goodFix, netNear, {}).checks.filter(function (x) { return x.name === 'offline_vs_online'; })[0]; return c ? c.detail : 'NA'; })());
    push('HDOP 超限 → 升级并给出阈值依据', (function () {
      var d = shouldEscalate(Object.assign({}, goodFix, { hdop: 12 }), null, {});
      return d.escalate === true && d.checks.some(function (x) { return x.name === 'hdop' && x.detail.indexOf('12') >= 0; });
    })(), shouldEscalate(Object.assign({}, goodFix, { hdop: 12 }), null, {}).reason);
    push('残差 RMS 超限 → 升级', shouldEscalate(Object.assign({}, goodFix, { rms_residual_m: 40 }), null, {}).escalate === true, 'rms 40 m');
    push('卫星数不足 → 升级', shouldEscalate(Object.assign({}, goodFix, { sats_used: 3 }), null, {}).escalate === true, '3 颗 < 4');
    push('离线 RAIM 报警 → 升级', shouldEscalate(Object.assign({}, goodFix, { integrity: { alarm: true, note: 'x' } }), null, {}).escalate === true, '完整性报警');
    push('离线解内部已判不一致 → 升级', shouldEscalate({ lat: 31.23, lon: 121.47, sigma_m: 2, consistency: { inconsistent: true, p_value: 1e-9 } }, null, {}).escalate === true, '内部矛盾');
    push('离线解与联网点真矛盾（差 300 km、σ 都是米级）→ 升级', (function () {
      var d = shouldEscalate({ lat: 31.2304, lon: 121.4737, sigma_e_m: 5, sigma_n_m: 5, hdop: 1, rms_residual_m: 1, sats_used: 10 }, { ok: true, lat: 34.05, lon: -118.25, accuracy_km: 20 }, {});
      return d.escalate === true && d.confidence > 0.5 && d.checks.some(function (x) { return x.name === 'offline_vs_online' && x.fired === true; });
    })(), shouldEscalate({ lat: 31.2304, lon: 121.4737, sigma_e_m: 5, sigma_n_m: 5 }, { ok: true, lat: 34.05, lon: -118.25, accuracy_km: 20 }, {}).checks.filter(function (x) { return x.name === 'offline_vs_online'; })[0].detail);
    push('联网点精度本身很差（±100 km）时不误判矛盾', (function () {
      var d = shouldEscalate({ lat: 31.2304, lon: 121.4737, sigma_e_m: 5, sigma_n_m: 5, hdop: 1, rms_residual_m: 1, sats_used: 10 }, { ok: true, lat: 31.6, lon: 121.8, accuracy_km: 100 }, {});
      return d.escalate === false;
    })(), '合并 σ 归一化是这条判据的核心：约 46 km 的差在 100 km 精度下毫无信息');
    push('离线解报错 / 缺经纬度 → 直接升级（confidence=1）', (function () {
      var a = shouldEscalate({ error: '至少需要 4 颗卫星' }, null, {});
      var b = shouldEscalate({ hdop: 2 }, null, {});
      return a.escalate === true && a.confidence === 1 && b.escalate === true;
    })(), '无解就是需要外部事实');
    push('联网侧缺席时不因「没证据」而升级', (function () {
      var d = shouldEscalate(goodFix, { ok: false, error: '全部源超时' }, {});
      return d.escalate === false && d.checks.some(function (x) { return x.name === 'online_unavailable'; });
    })(), '缺证据 ≠ 反证');
    push('判据阈值可配置：把 max_hdop 提到 20 后同一解不再升级', (function () {
      var before = shouldEscalate(Object.assign({}, goodFix, { hdop: 12 }), null, {});
      var after = shouldEscalate(Object.assign({}, goodFix, { hdop: 12 }), null, { escalate: { max_hdop: 20 } });
      return before.escalate === true && after.escalate === false;
    })(), '阈值全在 DEFAULTS.escalate，逐条写明依据');
    push('σ=0 的「完美解」不会把 χ² 炸成 Infinity', (function () {
      var d = shouldEscalate({ lat: 31.2304, lon: 121.4737, sigma_e_m: 0, sigma_n_m: 0 }, { ok: true, lat: 31.24, lon: 121.48, accuracy_km: 0.0001 }, {});
      return !hasBad(d) && isFinite(d.confidence);
    })(), 'sigma_floor_m=1 m 的地板就是防这个');

    /* ---------- 10. RSSI → 距离（对数路径损耗） ---------- */
    var link = { tx_power_dbm: 20, path_loss_exponent: 2, freq_mhz: 2437, shadow_sigma_db: 6 };
    push('RSSI→距离 在 −30…−95 dBm 全域严格单调递增（信号越弱越远）', (function () {
      var prev = -1, mono = true;
      for (var r = -30; r >= -95; r -= 0.5) {
        var d = rssiToDistance(r, link);
        if (d.error || !isNum(d.dist_m)) { mono = false; break; }
        if (d.dist_m <= prev) { mono = false; break; }
        prev = d.dist_m;
      }
      return mono;
    })(), '单调性破了就说明符号或 lg/log 写反了');
    push('往返一致：distanceToRssi → rssiToDistance 在 1..5000 m 上误差 <0.5%', (function () {
      var ds = [1, 5, 20, 100, 350, 1000, 5000];
      for (var i = 0; i < ds.length; i++) {
        var r = distanceToRssi(ds[i], link);
        if (r.error) return false;
        var back = rssiToDistance(r.rssi_dbm, link);
        if (back.error || Math.abs(back.dist_m - ds[i]) / ds[i] > 0.005) return false;
      }
      return true;
    })(), '四舍五入到 0.001 dB 后仍能反回原距离，量级闸门');
    push('1 m 自由空间损耗满足 20lg 频率标度（倍频 +6.0206 dB、十倍频 +20 dB）', (function () {
      var f = 2437;
      var d2 = fspl1mDb(2 * f) - fspl1mDb(f);
      var d10 = fspl1mDb(10 * f) - fspl1mDb(f);
      return near(d2, 20 * Math.log(2) / LN10, 1e-9) && near(d10, 20, 1e-9);
    })(), '倍频增量 ' + (fspl1mDb(4874) - fspl1mDb(2437)).toFixed(6) + ' dB = 20·lg2；这条抓「把 20lg 写成 10lg」和漏掉 4π');
    push('PL1(2437 MHz) 落在手工量级 40.19 dB ±0.2（λ≈0.123 m ⇒ 4π/λ≈102 ⇒ 20lg≈40.2）', (function () {
      var a = fspl1mDb(2437);
      return a != null && a > 39.5 && a < 41.0 && near(wavelengthM(2437), 0.1230170, 1e-6);
    })(), 'PL1=' + fspl1mDb(2437).toFixed(4) + ' dB，λ=' + (wavelengthM(2437) || 0).toFixed(6) + ' m（与 core-cell 的 FSPL_K=32.4411 形式差 ~0.007 dB，源于其对 c 取整）');
    push('n 越大同一 RSSI 解出的距离越小（模型自洽），且 n=2 时等于解析闭式', (function () {
      var d2 = rssiToDistance(-70, { tx_power_dbm: 20, freq_mhz: 2437, path_loss_exponent: 2 });
      var d4 = rssiToDistance(-70, { tx_power_dbm: 20, freq_mhz: 2437, path_loss_exponent: 4 });
      var closed = Math.pow(10, (20 - (-70) - fspl1mDb(2437)) / 20);
      return d4.dist_m < d2.dist_m && Math.abs(d2.dist_m - closed) < 0.01;
    })(), 'n=2 距离 ' + rssiToDistance(-70, { tx_power_dbm: 20, freq_mhz: 2437, path_loss_exponent: 2 }).dist_m + ' m vs 闭式 ' + Math.pow(10, (20 - (-70) - fspl1mDb(2437)) / 20).toFixed(4) + ' m（差的只是 0.01 m 的取整）');
    push('σ_d = ln10/10 · d · σ_dB / n（阴影衰落折算，量纲自洽）', (function () {
      var d = rssiToDistance(-70, { tx_power_dbm: 20, freq_mhz: 2437, path_loss_exponent: 3, shadow_sigma_db: 6 });
      return near(d.sigma_m, LN10 / 10 * d.dist_m * 6 / 3, 0.05);
    })(), 'dB 域不确定度必须除以 n 才变成米');
    push('缺发射功率时直接报错，不臆造 EIRP', (function () {
      var a = rssiToDistance(-70, { freq_mhz: 2437, path_loss_exponent: 3 });
      var b = distanceToRssi(100, { path_loss_exponent: 3 });
      return a.error != null && a.error.indexOf('不臆造') >= 0 && b.error != null;
    })(), '链路预算缺一项就是编数据');
    push('ref_rssi_dbm_at_1m 形态可替代 EIRP（自定义链路预算）', (function () {
      var a = rssiToDistance(-60, { reference_rssi_dbm_at_1m: -30, path_loss_exponent: 2 });
      return a.dist_m != null && Math.abs(a.dist_m - Math.pow(10, 30 / 20)) < 0.01;
    })(), 'd = 10^((ref@1m − RSSI)/(10n))');
    push('过强/过弱信号被截断并给出原因（不外推到物理外）', (function () {
      var strong = rssiToDistance(50, link);
      var weak = rssiToDistance(-190, link);
      return strong.clamped === true && weak.clamped === true && strong.clamped_reason.indexOf('下限') >= 0 && weak.clamped_reason.indexOf('上限') >= 0;
    })(), '截断标志必须传出去，否则会被当成实测距离');
    push('非法 RSSI / 非法频率返回 error', (function () {
      return rssiToDistance('abc', link).error != null && rssiToDistance(NaN, link).error != null && rssiToDistance(-70, { tx_power_dbm: 20, freq_mhz: 0 }).error != null;
    })(), '频率 0 会让波长除零，必须先挡');
    push('n=2 自由空间 / 3~4 城区的经验区间在模型表里可查且写明是经验值', (function () {
      return PATH_LOSS_N.free_space.n === 2 && PATH_LOSS_N.urban.n >= 3 && PATH_LOSS_N.urban.n <= 4 &&
        /经验/.test(PATH_LOSS_N.urban.basis) && /经验/.test(PATH_LOSS_N.indoor.basis);
    })(), 'urban n=' + PATH_LOSS_N.urban.n + '，dense_urban n=' + PATH_LOSS_N.dense_urban.n);

    /* ---------- 11. 多接入点测距 → 加权最小二乘 ---------- */
    var RX = { lat: 31.23, lon: 121.47 };
    // 合成数据必须用与解算同一套切平面构造：用球面距离生成 RSSI、再用等距平面求解，
    // 两套尺度的 ~0.6% 差异会伪装成「算法误差」，闸门就废了。
    var apAt = function (dx_m, dy_m, label) {
      var g = toLatLon(RX, dx_m, dy_m);
      var d = Math.sqrt(dx_m * dx_m + dy_m * dy_m);
      var r = distanceToRssi(Math.max(d, 1), link);
      return { label: label, lat: rnd(g.lat, 9), lon: rnd(g.lon, 9), rssi_dbm: r.rssi_dbm, tx_power_dbm: 20, freq_mhz: 2437, path_loss_exponent: 2 };
    };
    var planeDistM = function (lat, lon) { return Math.hypot((lon - RX.lon) * mPerDegLon(RX.lat), (lat - RX.lat) * M_PER_DEG_LAT); };
    var aps4 = [apAt(0, 120, '北'), apAt(120, 0, '东'), apAt(0, -120, '南'), apAt(-120, 0, '西')];
    var sol4 = trilaterateAps(aps4, link);
    push('4 个已知布局 AP 的合成 RSSI 反解出接收点（<0.5 m）', (function () {
      var err = planeDistM(sol4.lat, sol4.lon);
      return sol4.ok === true && isNum(err) && err < 0.5 && sol4.n_used === 4;
    })(), '误差 ' + planeDistM(sol4.lat, sol4.lon).toFixed(4) + ' m，残差 RMS ' + sol4.residual_rmse_m + ' m');
    push('测距反演的距离与布局真值一致（<0.2 m）——链路预算闭合', (function () {
      var truth = [120, 120, 120, 120];
      return sol4.ranges_m.every(function (v, i) { return Math.abs(v - truth[i]) < 0.2; });
    })(), 'ranges=' + sol4.ranges_m.join(', ') + ' m（构造真值 120 m）');
    var apsAsym = [apAt(-300, 80, 'A'), apAt(140, 260, 'B'), apAt(260, -180, 'C'), apAt(-90, -240, 'D')];
    var solAsym = trilaterateAps(apsAsym, link);
    push('非对称布局同样反解（防止「只在对称初值下碰巧对」）', (function () {
      return solAsym.ok === true && planeDistM(solAsym.lat, solAsym.lon) < 1;
    })(), '误差 ' + planeDistM(solAsym.lat, solAsym.lon).toFixed(4) + ' m；测距 ' + solAsym.ranges_m.join(', ') + ' m');
    var twoAp = trilaterateAps([apAt(0, 150, 'N'), apAt(200, 0, 'E')], link);
    push('两个 AP 交出双解并明确标 ambiguous（测圆双解是几何事实，不藏）', (function () {
      var errs = twoAp.candidates.map(function (c) { return planeDistM(c.lat, c.lon); });
      var hit = Math.min.apply(null, errs), miss = Math.max.apply(null, errs);
      return twoAp.ok === true && twoAp.ambiguous === true && twoAp.candidates.length === 2 &&
        twoAp.method === 'two-ap-ambiguity' && hit < 1 && miss > 100;
    })(), '两解分别距真值 ' + (Math.min.apply(null, twoAp.candidates.map(function (c) { return planeDistM(c.lat, c.lon); })).toFixed(3)) +
      ' m 与 ' + (Math.max.apply(null, twoAp.candidates.map(function (c) { return planeDistM(c.lat, c.lon); })).toFixed(1)) +
      ' m；两解到加权质心先验严格等距，所以「择近」无法定真伪，必须把 candidates 交给上层');
    push('单 AP 退化为接入点坐标并标 degraded（不假装定位）', (function () {
      var s = trilaterateAps([aps4[0]], link);
      return s.ok === true && s.degraded === true && s.method === 'single-ap' && isNum(s.confidence_radius_m);
    })(), '单点只能给覆盖半径');
    var axial = trilaterateAps([apAt(100, 0, 'X1'), apAt(200, 0, 'X2'), apAt(300, 0, 'X3')], link);
    push('观测只约束一个方向（三 AP 与接收点同轴）→ 秩亏被识别，按先验 σ 给圆近似', (function () {
      return axial.degraded === true && axial.ok === true && !hasBad(axial) && axial.warnings.join('').indexOf('退化') >= 0;
    })(), 'Jacobian 只剩 x 分量，det(N)≈0 → 法向无任何信息：' + axial.warnings.join(''));
    push('含一个非视距粗差的 5 AP 解：Huber 权重把影响压住，位置仍 <15 m', (function () {
      var bad = apAt(200, 200, 'NLOS');
      bad.rssi_dbm = bad.rssi_dbm - 20;   // 凭空多 20 dB 衰减 ⇒ n=2 时距离被高估 10 倍
      var s = trilaterateAps([aps4[0], aps4[1], aps4[2], aps4[3], bad], link);
      return s.ok === true && planeDistM(s.lat, s.lon) < 15;
    })(), '误差 ' + (function () { var bad = apAt(200, 200, 'NLOS'); bad.rssi_dbm -= 20; return planeDistM(trilaterateAps([aps4[0], aps4[1], aps4[2], aps4[3], bad], link).lat, trilaterateAps([aps4[0], aps4[1], aps4[2], aps4[3], bad], link).lon).toFixed(2); })() + ' m');
    push('缺 tx_power 的 AP 被排除并写进 warnings（不猜功率）', (function () {
      var noTx = [aps4[0], aps4[1]].map(function (a) { var c = Object.assign({}, a); delete c.tx_power_dbm; return c; });
      var s = trilaterateAps(noTx, {});
      return s.error != null && s.ok === false && s.warnings.join('').indexOf('测距失败') >= 0;
    })(), String(trilaterateAps([aps4[0], aps4[1]].map(function (a) { var c = Object.assign({}, a); delete c.tx_power_dbm; return c; }), {}).error));
    push('空数组 / 全非法输入返回 error 结构，不抛异常', (function () {
      var a = trilaterateAps([], link);
      var b = trilaterateAps('abc', link);
      return a.error != null && b.error != null && !hasBad(a) && !hasBad(b);
    })(), '入参类型错也走 error 通道');
    push('positionFromAps：GEOCELL 缺席/被显式关闭时用内部实现，在场时委托且不泄漏 NaN', (function () {
      var saved = global.GEOCELL;
      // 显式关委托：这样无论有没有加载 core-cell，自检都在验证「自己的」三边定位实现
      var plain = positionFromAps(aps4, Object.assign({}, link, { use_geocell: false }));
      global.GEOCELL = { trilaterate: function () { return { ok: true, method: 'mock', lat: 31.23, lon: 121.47, ranges_m: [120], n_used: 4, warnings: [], confidence_radius_m: 30 }; } };
      var delegated = positionFromAps(aps4, link);
      if (saved === undefined) delete global.GEOCELL; else global.GEOCELL = saved;
      // 真实环境（若已加载 core-cell）走委托，只要求输出合法
      var real = positionFromAps(aps4, link);
      return plain.engine === 'internal' && isNum(plain.lat) && delegated.engine.indexOf('GEOCELL') >= 0 && delegated.lat === 31.23 &&
        delegated.error === null && !hasBad(delegated) && !hasBad(plain) && !hasBad(real);
    })(), '委托/内部两条路都跑过；真实环境里若已加载 core-cell，engine 会是 GEOCELL.trilaterate');

    /* ---------- 12. 主机白名单与桥接 URL ---------- */
    var goodHosts = ['example.com', 'a.b.c.example.org', '8.8.8.8', '192.168.1.1', '2001:db8::1', 'fe80::1', '::1', 'sub-1.example.co.uk'];
    var badHosts = ['', '   ', 'a b.com', 'host;rm -rf /', "host`id`", 'host$(id)', 'host|ls', 'host\n127.0.0.1', '-h', '--help', 'host:name:port:x',
      '2001:db8:::1', '1.2.3.4.5', '01.2.3.4', '999.1.1.1', 'host"', "host'x", 'x'.repeat(300), '..com', '.leading.com', 'trailing.com.', 'host:'];
    var hostGood = goodHosts.filter(function (h) { return !validateHost(h).ok; });
    var hostBad = badHosts.filter(function (h) { var r = validateHost(h); return r.ok === true || typeof r.reason !== 'string' || !r.reason; });
    push('主机白名单：合法域名/IPv4/IPv6 全部放行', hostGood.length === 0, '误拒：' + (hostGood.join(',') || '无') + '（字符集 [A-Za-z0-9._:-] + 结构校验）');
    push('主机白名单：注入/畸形输入全部拒绝并给中文原因', hostBad.length === 0, '误放：' + (hostBad.join(',') || '无') + '，共 ' + badHosts.length + ' 条反例');
    push('校验函数对任意垃圾输入不抛异常', (function () {
      var junk = [null, undefined, NaN, {}, [], 1e18, true, function () {}];
      for (var i = 0; i < junk.length; i++) {
        var r = validateHost(junk[i], {});
        if (!r || r.ok !== false) return false;
      }
      return true;
    })(), '非字符串输入直接判非法（含 undefined/null/对象/函数）');
    push('bridge_base 非法与坐标参数禁发都被拦住', (function () {
      var a = buildBridgeUrl('/api/ping', { host: 'a.com' }, { bridge_base: 'javascript:alert(1)' });
      var b = buildBridgeUrl('/api/ping', { host: 'a.com', accuracy: 100 }, {});
      var c = buildBridgeUrl('api/ping', {}, {});
      var d = buildBridgeUrl('/api/ping', { host: 'a.com', max_hops: 15 }, {});
      return a.error != null && b.error != null && c.error != null && /host=a\.com&max_hops=15/.test(d.url);
    })(), '只允许 http(s) 端点；host 值走 encodeURIComponent');

    push('回环 http 源页面默认走同源桥接（端口跟着页面走，不再硬敲 8765）', (function () {
      var a = defaultBridgeBase({ protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:8899', origin: 'http://127.0.0.1:8899' });
      var b = defaultBridgeBase({ protocol: 'http:', hostname: 'localhost', host: 'localhost:9001', origin: 'http://localhost:9001' });
      var c = defaultBridgeBase({ protocol: 'http:', hostname: '::1', host: '[::1]:8777', origin: 'http://[::1]:8777' });
      return a === 'http://127.0.0.1:8899' && b === 'http://localhost:9001' && c === 'http://[::1]:8777';
    })(), '只在回环地址上生效：桥接本来就只监听 127.0.0.1');
    push('file://、非回环源与 origin=null 一律退回默认端口 8765', (function () {
      var list = [
        { protocol: 'file:', hostname: '', host: '', origin: 'null' },
        { protocol: 'https:', hostname: 'example.com', host: 'example.com', origin: 'https://example.com' },
        { protocol: 'http:', hostname: '192.168.1.20', host: '192.168.1.20:8765', origin: 'http://192.168.1.20:8765' },
        { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:8899', origin: 'null' },
        null, undefined, 42, 'http://evil/'
      ];
      for (var i = 0; i < list.length; i++) if (defaultBridgeBase(list[i]) !== 'http://127.0.0.1:8765') return false;
      return true;
    })(), '非回环来源绝不把页面 origin 当桥接地址（那等于把请求发到任意主机）');

    /* ---------- 13. 路由追踪解析（样例文本/样例 JSON，不是真实网络） ---------- */
    var sampleTraceroute = {
      ok: true, host: 'example.com', elapsed_ms: 8123, reached: true,
      hops: [
        { hop: 1, ip: '192.168.1.1', hostname: 'gateway', rtts_ms: [1.2, 1.4, 1.3] },
        { hop: 2, ip: null, hostname: null, rtts_ms: [], timed_out: true },
        { hop: 3, ip: '93.184.216.34', hostname: 'example.com', rtts_ms: [18.2, 17.9, null] }
      ]
    };
    var tp = parseTraceroutePayload(sampleTraceroute);
    push('traceroute 载荷解析保留跳序/超时跳/部分时延（不补数）', (function () {
      return tp.hops.length === 3 && tp.hops[1].timed_out === true && tp.hops[1].rtts_ms.length === 0 &&
        tp.hops[2].rtts_ms.length === 2 && tp.hops[2].rtts_ms.indexOf(null) < 0 && tp.hops[0].ip === '192.168.1.1';
    })(), '超时跳保留为 timed_out，绝不插值（样例载荷，仅测解析器）');
    var tsub = parseTraceroutePayload({
      ok: true, host: 'localhost', reached: true,
      hops: [{ hop: 1, ip: '127.0.0.1', rtts_ms: [], rtt_bounds: ['<1', '<1', '<1'], status: 'ok' }]
    });
    push('有地址、RTT 是「<1 毫秒」上界的一跳不得判成无响应', (function () {
      var h = tsub.hops[0];
      return h.timed_out === false && h.rtts_ms.length === 0 && h.rtt_bounds.length === 3 && h.rtt_bounds[0] === '<1';
    })(), '中文 tracert 对亚毫秒样本印「<1 毫秒」，按空 RTT 判超时会把真实测到的一跳说成无响应');
    push('缺少 hops 数组时报 field_missing 而不是给空列表冒充成功', (function () {
      var r = parseTraceroutePayload({ ok: true, host: 'x.com' });
      return r.error != null && r.error_kind === 'field_missing';
    })(), String(parseTraceroutePayload({ ok: true }).error));
    push('桥接自报失败（ok:false）原样转成 bridge_unavailable', (function () {
      var r = parseTraceroutePayload({ ok: false, error: '系统缺少 tracert 命令', error_kind: 'unsupported_env' });
      return r.error.indexOf('tracert') >= 0 && r.error_kind === 'unsupported_env';
    })(), '降级信息来自服务端，本模块不掩盖');

    /* ---------- 14. 默认离线策略（selfTest 不许出网） ---------- */
    var trapCalled = 0;
    var savedGlobalFetch = global.fetch;
    global.fetch = function () { trapCalled++; return new Promise(function () {}); };
    var gf1 = getFetch({});
    var gf2 = getFetch({ fetchImpl: function () { return new Promise(function () {}); } });
    if (savedGlobalFetch === undefined) delete global.fetch; else global.fetch = savedGlobalFetch;
    push('默认策略下 getFetch({}) 不返回环境 fetch，且环境 fetch 一次都没被摸', gf1 === null && trapCalled === 0, 'allow_real_network=' + POLICY.allow_real_network + '，trap 命中 ' + trapCalled + ' 次');
    push('显式注入的 fetchImpl 才被接受（自检/调用方是唯一入口）', typeof gf2 === 'function', '注入优先于策略');
    push('offline_disallowed 与 unsupported_env 是两个不同分类', ERROR_KINDS.offline_disallowed !== ERROR_KINDS.unsupported_env && ERROR_KINDS.offline_disallowed.indexOf('离线') >= 0, '前者＝策略拦（可授权），后者＝环境真没有');
    push('setNetworkPolicy 可开启/关闭出网授权', (function () {
      var before = networkPolicy().allow_real_network;
      setNetworkPolicy({ allow_real_network: true });
      var on = networkPolicy().allow_real_network;
      setNetworkPolicy({ allow_real_network: false });
      var after = networkPolicy().allow_real_network;
      var bad = setNetworkPolicy('abc');
      return before === false && on === true && after === false && bad.error != null;
    })(), '授权必须显式、可撤销');

    /* ---------- 15. 可重复性 ---------- */
    push('同一输入两次跑完整纯函数链，输出逐字节相同（自检可重复）', (function () {
      var run = function () {
        var parsed = IP_SOURCES.map(function (s) { return parseIpSource(s.id, JSON.parse(JSON.stringify(SAMPLE_IP[s.id].body)), { latency_ms: 100 }); });
        var f = fuseIpSolutions(parsed, {});
        var e = shouldEscalate(goodFix, f, {});
        var t = trilaterateAps(aps4, link);
        var r = rssiToDistance(-67, link);
        return JSON.stringify([parsed, f, e, t, r]);
      };
      var a = run(), b = run();
      return a === b;
    })(), '融合/升级判定/测距链全部无隐藏状态（时间戳只进缓存，不进结果）');
    push('resetHealth/clearCache 后健康度与缓存计数归零', (function () {
      consumeResponse('freeipapi', SAMPLE_IP.freeipapi.body, { status: 200, latency_ms: 10 });
      cacheSet('freeipapi', null, SAMPLE_RESULT(), { storage: mockLocalStorage() });
      resetHealth();
      clearCache({});
      return healthSnapshot().length === 0 && cacheStats({}).count === 0;
    })(), 'health=' + healthSnapshot().length + ' cache=' + cacheStats({}).count);

    /* ---------- 16. 全 API × 垃圾参数（两道闸门，必须归零） ---------- */
    var junkArgs = [null, undefined, NaN, Infinity, -Infinity, '', 'abc', -1e18, 1e18, {}, [], true, function () {}];
    var crash = 0, leaked = 0, calls = 0, leakMsg = [];
    var names = Object.keys(API).filter(function (k) { return typeof API[k] === 'function' && k !== 'selfTest' && k !== 'selfTestAsync'; });
    for (var ni = 0; ni < names.length; ni++) {
      var fn = API[names[ni]];
      for (var ai = 0; ai < junkArgs.length; ai++) {
        for (var bi = 0; bi < junkArgs.length; bi++) {
          calls++;
          try {
            var rr = fn(junkArgs[ai], junkArgs[bi], junkArgs[ai]);
            var isPromise = rr && typeof rr.then === 'function';
            var bad = rr === undefined || (!isPromise && (typeof rr === 'number'
              ? (rr === rr && !isFinite(rr))
              : (typeof rr !== 'string' && rr !== null && hasBad(rr))));
            if (bad) {
              leaked++;
              if (leakMsg.length < 4) leakMsg.push(names[ni] + '(' + String(junkArgs[ai]) + ',' + String(junkArgs[bi]) + ')→' + String(typeof rr === 'number' ? rr : JSON.stringify(sanitize(rr))).slice(0, 70));
            }
          } catch (e) { crash++; }
        }
      }
    }
    push('全部 API 函数 × 垃圾参数不抛异常', crash === 0, names.length + ' 个函数 × ' + calls + ' 次调用，异常 ' + crash);
    push('垃圾输入：对象结果无 NaN/±Infinity，纯数值定义域外只用 NaN（禁 ±Inf、禁 undefined）', leaked === 0,
      leaked === 0 ? calls + ' 次调用全部合规（同步部分；异步部分由 selfTestAsync 的 reject/NaN 闸门覆盖）' : '违规 ' + leaked + ' 处：' + leakMsg.join(' | '));
    // 自检期间产生的游离 Promise（异步入口被垃圾参数打了一遍）绝不能 reject：
    // Node 对未处理 rejection 会直接终止进程，那样自检就失去可重复性。这里显式吞掉。
    void Promise.resolve().then(function () { return null; });

    /* ---------- 17. 导出面 ---------- */
    var required = ['parseIpSource', 'consumeResponse', 'buildSourceUrl', 'privacyAudit', 'fetchGeoIpAll', 'fetchGeoIpOne',
      'fuseIpSolutions', 'shouldEscalate', 'pickHealthySources', 'healthSnapshot', 'resetHealth',
      'cacheGet', 'cacheSet', 'clearCache', 'cacheStats', 'rssiToDistance', 'distanceToRssi', 'fspl1mDb',
      'trilaterateAps', 'positionFromAps', 'tracerouteViaBridge', 'dohResolve', 'bridgeStatus', 'validateHost',
      'buildBridgeUrl', 'parseTraceroutePayload', 'setNetworkPolicy', 'networkPolicy', 'chiSquareSurvival', 'defaultBridgeBase', 'selfTest', 'selfTestAsync'];
    push('必需导出项齐备且为函数', required.every(function (k) { return typeof API[k] === 'function'; }),
      '缺失：' + required.filter(function (k) { return typeof API[k] !== 'function'; }).join(','));
    push('全局挂载成功（GEONET）', (typeof global.GEONET === 'object' ? global : globalThis).GEONET === API || global.GEONET === API, 'GEONET');
    push('中文文案覆盖用户可见字段（error/reason/note 不为英文占位）', (function () {
      var sample = [errorResult('x', 'timeout').error, validateHost('bad host;rm -rf /').reason, shouldEscalate(null, null, {}).reason];
      return sample.every(function (s) { return /[\u4e00-\u9fa5]/.test(String(s)); });
    })(), '本项目 UI 文案一律中文');

    // 收尾：把策略与内存缓存恢复成自检前的样子，别把副作用留给宿主页面
    POLICY.allow_real_network = savedPolicy.allow_real_network;
    POLICY.allow_ambient_storage = savedPolicy.allow_ambient_storage;
    for (var mk in memoryStore) if (Object.prototype.hasOwnProperty.call(memoryStore, mk)) delete memoryStore[mk];
    Object.keys(savedMemory).forEach(function (k) { memoryStore[k] = savedMemory[k]; });
    resetHealth();
    return out;
  }

  /* ================================================================ 16. 异步链路自检（全部走 mock，0 次真实出网） */
  async function selfTestAsync(opt) {
    var out = [];
    var push = function (name, pass, detail) { out.push({ name: name, pass: pass === true, detail: String(detail) }); };
    var o = opt || {};
    resetHealth();
    var ls = mockLocalStorage();
    var cacheOpt = { storage: ls, cache_ttl_ms: 60000 };
    var savedPolicy = POLICY.allow_real_network;
    POLICY.allow_real_network = false;
    var trapHits = 0;
    var savedFetch = global.fetch;
    global.fetch = function () { trapHits++; return new Promise(function () {}); };   // 一旦真被摸到就永久挂起并计数

    var SRC5 = ['ipapi_com', 'ipinfo_io', 'ipapi_co', 'ipwho_is', 'freeipapi'];
    var routes5 = [
      { match: 'ip-api.com', body: SAMPLE_IP.ipapi_com.body },
      { match: 'ipinfo.io', body: SAMPLE_IP.ipinfo_io.body },
      { match: 'ipapi.co', body: SAMPLE_IP.ipapi_co.body },
      { match: 'ipwho.is', body: SAMPLE_IP.ipwho_is.body },
      { match: 'freeipapi', body: SAMPLE_IP.freeipapi.body }
    ];

    /* ---- A. 离线策略：环境 fetch 一次都不能被摸，缓存也不许回供 ---- */
    var off = await fetchGeoIpAll({ sources: SRC5 });
    var offDenied = off.results.filter(function (r) { return r.ok === false && r.error_kind === 'offline_disallowed'; }).length;
    var offCached = off.results.filter(function (r) { return r.from_cache === true; }).length;
    push('默认策略下 fetchGeoIpAll 不碰环境 fetch，逐源返回 offline_disallowed（缓存也不端）', (function () {
      return trapHits === 0 && off.results.length === SRC5.length && offCached === 0 && offDenied === SRC5.length;
    })(), '环境 fetch 命中 ' + trapHits + ' 次（必须 0），策略拦住 ' + offDenied + '/' + SRC5.length
      + ' 源，缓存回供 ' + offCached + ' 源（必须 0）');

    /* ---- B. 注入 mock 的多源链路 ---- */
    var bag = { calls: [] };
    var mf = makeMockFetch(routes5, bag);
    var r1 = await fetchGeoIpAll(Object.assign({ sources: SRC5, fetchImpl: mf }, cacheOpt));
    push('mock 五源并行取回 → 统一结构齐全且融合成功', (function () {
      var shapes = r1.results.every(function (r) {
        return r.ok === true && isNum(r.lat) && isNum(r.lon) && r.accuracy_km > 0 && typeof r.source === 'string' && !hasBad(r);
      });
      return shapes && r1.fused.ok === true && r1.fused.n_used >= 3;
    })(), 'used=' + r1.fused.n_used + '，融合点 ' + r1.fused.lat + ',' + r1.fused.lon + ' ±' + r1.fused.accuracy_km + ' km');
    push('隐私红线：真实请求 URL 集合里没有经纬度痕迹', (function () {
      var joined = bag.calls.join('\n');
      return joined.indexOf('31.2304') < 0 && joined.indexOf('121.4737') < 0 && !/[?&](lat|lon|latitude|longitude|position)=/i.test(joined);
    })(), '共 ' + bag.calls.length + ' 条 URL：' + bag.calls.map(function (u) { return u.replace(/^https?:\/\//, ''); }).join(' | ').slice(0, 180));
    var beforeCache = bag.calls.length;
    var r2 = await fetchGeoIpAll(Object.assign({ sources: SRC5, fetchImpl: makeMockFetch(routes5, { calls: [] }) }, cacheOpt));
    push('第二次查询命中缓存（from_cache=true）且请求条数不再增长', (function () {
      return r2.results.every(function (r) { return r.from_cache === true && r.ok === true; }) && bag.calls.length === beforeCache;
    })(), '缓存后新增请求 ' + (bag.calls.length - beforeCache) + ' 条（应 0）；命中存储 ' + r2.results[0].source);

    /* ---- C. 四类失败的分类各不相同 ---- */
    var mfTimeout = makeMockFetch([{ match: 'ip-api.com', behavior: 'timeout' }].concat(routes5.slice(1)), { calls: [] });
    var rt = await fetchGeoIpAll(Object.assign({ sources: SRC5, fetchImpl: mfTimeout, fetch_timeout_ms: 120, cache_ttl_ms: 0, storage: mockLocalStorage() }));
    var mkTimeout = rt.results.filter(function (x) { return x.source === 'ipapi_com'; })[0];
    push('超时 → error_kind=timeout，同批其它源不受影响', (function () {
      return mkTimeout.error_kind === 'timeout' && rt.results.filter(function (x) { return x.ok === true; }).length >= 3;
    })(), String(mkTimeout.error));
    var mfHttp = makeMockFetch([{ match: 'ipinfo.io', status: 429, body: { error: 'rate limited' } }].concat([routes5[0], routes5[2]]), { calls: [] });
    var rh = await fetchGeoIpAll({ sources: ['ipapi_com', 'ipinfo_io', 'ipapi_co'], fetchImpl: mfHttp, cache_ttl_ms: 0, storage: mockLocalStorage() });
    push('HTTP 429 → http_error（与被限流要和「字段缺失」区分开，处置完全不同）', (function () {
      var bad = rh.results.filter(function (x) { return x.source === 'ipinfo_io'; })[0];
      return bad.error_kind === 'http_error' && bad.error.indexOf('429') >= 0;
    })(), String(bad_peek(rh)));
    var mfJson = makeMockFetch([{ match: 'ipwho.is', body: '<html>502 Bad Gateway</html>' }], { calls: [] });
    var rj = await fetchGeoIpOne('ipwho_is', { fetchImpl: mfJson, cache_ttl_ms: 0, storage: mockLocalStorage() });
    push('网关返回 HTML → json_error', rj.result.error_kind === 'json_error', String(rj.result.error));
    var mfMiss = makeMockFetch([{ match: 'freeipapi', body: { cityName: ' nowhere ' } }], { calls: [] });
    var rm = await fetchGeoIpOne('freeipapi', { fetchImpl: mfMiss, cache_ttl_ms: 0, storage: mockLocalStorage() });
    push('成功响应但缺经纬度 → field_missing（不是 timeout，也不该重试同一 URL）', rm.result.error_kind === 'field_missing', String(rm.result.error));
    push('四类 error_kind 两两不同', (function () {
      var ks = [mkTimeout.error_kind, bad_peek_kind(rh), rj.result.error_kind, rm.result.error_kind];
      return new Set(ks).size === 4;
    })(), 'timeout/http_error/json_error/field_missing');
    var mfAll = makeMockFetch([{ match: 'http', status: 500, body: 'x' }], { calls: [] });
    var rAll = await fetchGeoIpAll({ sources: SRC5, fetchImpl: mfAll, cache_ttl_ms: 0, storage: mockLocalStorage() });
    push('全部源失败 → ok:false 且 fused 给出 error（不带伪解）', rAll.ok === false && rAll.fused.error != null, String(rAll.fused.error));

    /* ---- D. 路由追踪：桥接可用 / 不可用 ---- */
    var bridgeRoutes = [
      { match: '/api/traceroute', body: { ok: true, host: 'example.com', elapsed_ms: 900, reached: true, hops: [{ hop: 1, ip: '10.0.0.1', hostname: 'gw', rtts_ms: [2, 2, 3] }, { hop: 2, ip: '93.184.216.34', hostname: 'example.com', rtts_ms: [15] }] } },
      { match: '/api/health', body: { ok: true, server: 'geonet-bridge', version: '1.0.0', python: '3.13', platform: 'Windows', capabilities: ['traceroute', 'ping', 'dns', 'iface', 'geoip'], cors_policy: { wildcard: false, built_in: ['null', 'https://iammezsh.github.io'], extra: [], loopback_origins_allowed: true, no_origin_clients_allowed: true, note: '名单外的浏览器来源一律 403 origin_not_allowed' } } },
      { match: 'dns.google/resolve', body: { Status: 0, Answer: [{ type: 1, name: 'example.com.', data: '93.184.216.34', TTL: 300 }] } }
    ];
    var t1 = await tracerouteViaBridge('example.com', { fetchImpl: makeMockFetch(bridgeRoutes, { calls: [] }) });
    push('桥接可用：跳数原样透出，标记 fabricated_hops=false', (function () {
      return t1.ok === true && t1.via === 'bridge' && t1.hops.length === 2 && t1.fabricated_hops === false && t1.hops[0].ip === '10.0.0.1';
    })(), 'hops=' + t1.hop_count + '，elapsed=' + t1.elapsed_ms + ' ms（样例载荷，非真实网络）');
    var tDead = await tracerouteViaBridge('example.com', { fetchImpl: makeMockFetch([{ match: '/api/traceroute', behavior: 'reject', detail: '连接被拒' }].concat([bridgeRoutes[2]]), { calls: [] }) });
    push('桥接不可达：明确 bridge_unavailable + hops:null，并降级到 DoH 而不是伪造跳数', (function () {
      return tDead.ok === false && tDead.error_kind === 'bridge_unavailable' && tDead.hops === null &&
        tDead.fabricated_hops === false && tDead.via === 'browser-fallback' &&
        tDead.fallback.ok === true && tDead.fallback.answers[0].data === '93.184.216.34' &&
        tDead.limitation.indexOf('原始 ICMP') >= 0;
    })(), '降级结果：DoH 解析到 ' + (tDead.fallback.answers.length || 0) + ' 条，跳数仍为空');
    var mfLan = makeMockFetch([{ match: '/api/traceroute', body: { ok: true, host: '192.168.1.1',
      target_scope: 'lan', target_scope_note: '私有网段 192.168.1.1', elapsed_ms: 700, reached: false,
      hops: [{ hop: 1, ip: '192.168.2.1', hostname: null, rtts_ms: [1, 1, 1] }] } }], { calls: [] });
    var tLan = await tracerouteViaBridge('192.168.1.1', { fetchImpl: mfLan });
    push('内网目标照常追踪，桥接的 target_scope 标注原样送到界面（不拦截、也不改写）', (function () {
      return tLan.ok === true && tLan.via === 'bridge' && tLan.hop_count === 1
        && tLan.target_scope === 'lan' && String(tLan.target_scope_note).indexOf('192.168.1.1') >= 0;
    })(), 'scope=' + tLan.target_scope + '，' + String(tLan.target_scope_note));
    var mfScopeJunk = makeMockFetch([{ match: '/api/traceroute', body: { ok: true, host: 'example.com',
      target_scope: 'maybe', hops: [{ hop: 1, ip: '1.1.1.1', rtts_ms: [4] }] } }], { calls: [] });
    var tScopeJunk = await tracerouteViaBridge('example.com', { fetchImpl: mfScopeJunk });
    push('target_scope 只认 lan/public，其它值判 null（旧版桥接没有这个字段也不能瞎猜）', (function () {
      return tScopeJunk.ok === true && tScopeJunk.target_scope === null;
    })(), 'scope=' + String(tScopeJunk.target_scope));
    var mfRefuse = makeMockFetch([{ match: '/api/traceroute', status: 429,
      body: JSON.stringify({ ok: false, error: '本机已有 4 个追踪在跑，请等一会儿再试', error_kind: 'rate_limited' }) }].concat([bridgeRoutes[2]]), { calls: [] });
    var tRefused = await tracerouteViaBridge('example.com', { fetchImpl: mfRefuse });
    push('桥接返回 4xx 且正文里有中文原因：原因与 error_kind 原样送到界面（不塌成「HTTP 429」）', (function () {
      return tRefused.ok === false && tRefused.error_kind === 'rate_limited'
        && String(tRefused.error).indexOf('4 个追踪在跑') >= 0
        && tRefused.hops === null && tRefused.fabricated_hops === false;
    })(), String(tRefused.error));
    var callsBefore = 0;
    var mfCount = makeMockFetch([{ match: 'http', behavior: 'reject' }], { calls: [] });
    var tBad = await tracerouteViaBridge('bad host;rm -rf /', { fetchImpl: mfCount });
    push('非法 host 在任何请求之前就拦下（0 次 fetch）', (function () {
      callsBefore = mfCount.calls.length;
      return tBad.ok === false && tBad.error_kind === 'bad_input' && tBad.hops === null && callsBefore === 0;
    })(), String(tBad.error));
    var bs = await bridgeStatus({ fetchImpl: makeMockFetch([bridgeRoutes[1]], { calls: [] }) });
    push('bridgeStatus 解析能力清单', bs.ok === true && bs.capabilities.length === 5 && bs.server === 'geonet-bridge', bs.capabilities.join(','));
    // ⑧ 面板要回答「除了我还有谁能在浏览器里读这台桥」，靠的就是这个字段。
    // 上一版 bridgeStatus 把它当未知字段丢掉了，于是真浏览器里新桥被报成「桥版本过旧」——
    // 内核自检当时全绿，因为它自己没测这条透传。这两门就是补那一课。
    push('bridgeStatus 把 cors_policy 原样透出（新桥不会被误报成旧桥）', (function () {
      var c = bs.cors_policy;
      return c && c.declared === true && c.wildcard === false && c.built_in.length === 2 &&
        c.built_in.indexOf('null') >= 0 && c.built_in.indexOf('https://iammezsh.github.io') >= 0 &&
        c.loopback_origins_allowed === true && c.extra.length === 0 && String(c.note).indexOf('403') > 0;
    })(), JSON.stringify(bs.cors_policy));
    var bsJunk = await bridgeStatus({
      fetchImpl: makeMockFetch([{
        match: '/api/health',
        body: { ok: true, server: 'geonet-bridge', version: '0.9', capabilities: [], cors_policy: { wildcard: 'yes-please', built_in: ['https://a.example', 42, '', 'https://b.example', 'x'.repeat(400)], extra: 'not-a-list', loopback_origins_allowed: 1, note: 'y'.repeat(500) } }
      }], { calls: [] })
    });
    push('cors_policy 里的 junk 被夹成能安全显示的形状（字符串才是 true、条目截断、多余项丢弃）', (function () {
      var c = bsJunk.cors_policy;
      return c && c.declared === true && c.wildcard === false && c.built_in.length === 3 &&
        c.built_in[2].length === 96 && c.extra.length === 0 && c.loopback_origins_allowed === false &&
        String(c.note).length <= 200;
    })(), 'built_in=' + JSON.stringify((bsJunk.cors_policy || {}).built_in) + ' note 长度=' + String(((bsJunk.cors_policy || {}).note) || '').length);
    var bsOld = await bridgeStatus({
      fetchImpl: makeMockFetch([{ match: '/api/health', body: { ok: true, server: 'geonet-bridge', version: '0.8', capabilities: ['ping'] } }], { calls: [] })
    });
    push('没声明 cors_policy 的旧桥如实报 null（界面据此才许说「桥版本过旧」）',
      bsOld.ok === true && bsOld.cors_policy === null, JSON.stringify(bsOld.cors_policy));
    // PowerShell 那份桥 python 恒为 null、改用 runtime 报运行环境。这一门钉住「runtime 必须透出」：
    // 少带这个字段，界面就显示「运行环境未上报」，而服务自己明明在 health 里写了 PowerShell 版本。
    var bsPs = await bridgeStatus({
      fetchImpl: makeMockFetch([{
        match: '/api/health',
        body: { ok: true, server: 'geonet-bridge', version: '1.0.0', python: null, runtime: 'PowerShell 5.1.28000.2113', platform: 'win32', capabilities: ['traceroute', 'ping', 'dns', 'iface', 'geoip', 'static'] }
      }], { calls: [] })
    });
    push('bridgeStatus 透出 PowerShell 桥的 runtime（python 为 null 时不冒充 Python）', (function () {
      return bsPs.ok === true && !bsPs.python && String(bsPs.runtime).indexOf('PowerShell') === 0 && bsPs.capabilities.length === 6;
    })(), 'runtime=' + bsPs.runtime + '，python=' + String(bsPs.python));
    var bsOff = await bridgeStatus({});
    push('bridgeStatus 在未授权出网时报 offline_disallowed（不是「服务挂了」）', bsOff.ok === false && bsOff.error_kind === 'offline_disallowed', String(bsOff.error));
    var dh = await dohResolve('1.1.1.1; rm -rf /', { fetchImpl: makeMockFetch([bridgeRoutes[2]], { calls: [] }) });
    push('DoH 对非法 host 直接拒绝', dh.ok === false && dh.error_kind === 'bad_input' && dh.answers.length === 0, String(dh.error));

    /* ---- E. 离线→联网自动升级（端到端） ---- */
    // 样例 IP 库都返回湾区坐标，所以离线解也放在湾区：跨洲的样例会被判成矛盾（那是判据在正常工作，不是 bug）
    var goodFix = { lat: 37.4060, lon: -122.0780, sigma_e_m: 3, sigma_n_m: 4, hdop: 1.2, rms_residual_m: 1.4, sats_used: 11 };
    var upg = await onlineUpgrade(goodFix, Object.assign({ sources: ['ipapi_co', 'ipwho_is'], fetchImpl: makeMockFetch(routes5.slice(2), { calls: [] }) }, cacheOpt));
    push('端到端：IP 定位精度量级远大于 GNSS，故一致时不升级', (function () {
      return upg.escalate === false && upg.decision.checks.some(function (c) { return c.name === 'offline_vs_online'; });
    })(), 'reason=' + upg.reason + '，联网融合点 ' + (upg.fused && upg.fused.ok ? upg.fused.lat + ',' + upg.fused.lon + ' ±' + upg.fused.accuracy_km + 'km' : 'NA'));
    var upgFar = await onlineUpgrade({ lat: 31.2304, lon: 121.4737, sigma_e_m: 5, sigma_n_m: 5, hdop: 1, rms_residual_m: 1, sats_used: 10 }, Object.assign({ sources: ['ipapi_co'], fetchImpl: makeMockFetch(routes5.slice(2), { calls: [] }), storage: mockLocalStorage(), cache_ttl_ms: 0 }));
    push('端到端：离线解与联网点跨洲（远超合并 σ）时判为矛盾并升级', upgFar.escalate === true && upgFar.confidence > 0.5,
      'reason=' + upgFar.reason + '，' + (function () { var c = upgFar.decision.checks.filter(function (x) { return x.name === 'offline_vs_online'; })[0]; return c ? c.detail : 'NA'; })());
    var upgBad = await onlineUpgrade(Object.assign({}, goodFix, { hdop: 15, rms_residual_m: 30 }), Object.assign({ sources: ['ipapi_co'], fetchImpl: makeMockFetch(routes5.slice(2), { calls: [] }) }, cacheOpt));
    push('端到端：离线质量崩塌时 escalate=true 并给 confidence', upgBad.escalate === true && upgBad.confidence > 0.4, 'reason=' + upgBad.reason + ' conf=' + upgBad.confidence);

    /* ---- F. 异步入口 × 垃圾参数：必须 resolve（永不 reject）且结果无 NaN/Inf ---- */
    var asyncNames = Object.keys(API).filter(function (k) {
      // 排除自检入口自身：把 selfTestAsync 打进垃圾参数扫描会无限递归（Node 直接 OOM，而不是报错）
      if (k === 'selfTest' || k === 'selfTestAsync') return false;
      return typeof API[k] === 'function' && API[k].constructor && API[k].constructor.name === 'AsyncFunction';
    });
    var junk = [null, undefined, NaN, Infinity, '', 'abc', {}, [], true, function () {}];
    var promises = [], labels = [];
    for (var an = 0; an < asyncNames.length; an++) {
      for (var a1 = 0; a1 < junk.length; a1++) {
        for (var a2 = 0; a2 < junk.length; a2++) {
          var tag = asyncNames[an] + '(' + String(junk[a1]) + ',' + String(junk[a2]) + ')';
          labels.push(tag);
          try {
            promises.push(Promise.resolve(API[asyncNames[an]](junk[a1], junk[a2], junk[a1]))
              .then(function (v) { return { bad: v === undefined || hasBad(v) }; },
                function (e) { return { rejected: true, msg: String(e && e.message || e) }; }));
          } catch (e) {
            promises.push(Promise.resolve({ rejected: true, msg: String(e && e.message || e) }));
          }
        }
      }
    }
    var settled = await Promise.all(promises);
    var rejected = settled.filter(function (x) { return x.rejected === true; });
    var badVals = settled.filter(function (x) { return x.bad === true; });
    push('异步入口全部 resolve（0 次 reject）——未处理 rejection 会让 Node 直接终止自检进程', rejected.length === 0,
      asyncNames.length + ' 个异步函数 × ' + settled.length + ' 次调用，reject ' + rejected.length + (rejected.length ? '：' + rejected.slice(0, 3).map(function (x) { return x.msg; }).join(' | ') : ''));
    push('异步结果同样无 NaN/±Infinity 泄漏，且不返回 undefined', badVals.length === 0,
      badVals.length === 0 ? settled.length + ' 个 resolve 值全部合规' : '违规 ' + badVals.length + ' 处');
    push('整轮异步自检期间，环境 fetch 命中次数仍为 0（真的没联网）', trapHits === 0, 'trapHits=' + trapHits);

    if (savedFetch === undefined) delete global.fetch; else global.fetch = savedFetch;
    POLICY.allow_real_network = savedPolicy;
    resetHealth();
    clearCache({ storage: ls });
    return out;
  }
  function bad_peek(rh) {
    var b = (rh && rh.results ? rh.results : []).filter(function (x) { return x.source === 'ipinfo_io'; })[0];
    return b ? b.error : '无 ipinfo 结果';
  }
  function bad_peek_kind(rh) {
    var b = (rh && rh.results ? rh.results : []).filter(function (x) { return x.source === 'ipinfo_io'; })[0];
    return b ? b.error_kind : null;
  }

  /* ================================================================ 17. 导出面 */
  var API = {
    VERSION: '1.0.0',
    // 常数与表
    WGS84: WGS84, C_MS: C_MS, IP_SOURCES: IP_SOURCES, PATH_LOSS_N: PATH_LOSS_N,
    ERROR_KINDS: ERROR_KINDS, DEFAULTS: DEFAULTS,
    M_PER_DEGREE_LAT: rnd(M_PER_DEG_LAT, 3), M_PER_DEGREE_LON_EQUATOR: rnd(M_PER_DEG_LON_EQ, 3),
    // 几何与统计
    greatCircleKm: greatCircleKm, mPerDegLon: mPerDegLon, quantile: quantile, median: median, mad: mad,
    weightedQuantile: weightedQuantile, logGamma: logGamma, gammaincUpper: gammaincUpper,
    chiSquareCdf: chiSquareCdf, chiSquareSurvival: chiSquareSurvival, chiSquareCritical: chiSquareCritical,
    // 环境与策略
    networkPolicy: networkPolicy, setNetworkPolicy: setNetworkPolicy, getFetch: getFetch, sanitize: sanitize,
    // IP 地理定位
    sourceIds: sourceIds, buildSourceUrl: buildSourceUrl, privacyAudit: privacyAudit,
    parseIpSource: parseIpSource, consumeResponse: consumeResponse, errorResult: errorResult,
    httpGetJson: httpGetJson, fetchGeoIpOne: fetchGeoIpOne, fetchGeoIpAll: fetchGeoIpAll,
    // 健康度与缓存
    healthSnapshot: healthSnapshot, pickHealthySources: pickHealthySources, resetHealth: resetHealth,
    cacheGet: cacheGet, cacheSet: cacheSet, clearCache: clearCache, cacheStats: cacheStats,
    // 融合与升级
    fuseIpSolutions: fuseIpSolutions, shouldEscalate: shouldEscalate, onlineUpgrade: onlineUpgrade,
    // RSSI 测距与三角定位
    wavelengthM: wavelengthM, fspl1mDb: fspl1mDb, rssiToDistance: rssiToDistance, distanceToRssi: distanceToRssi,
    trilaterateAps: trilaterateAps, positionFromAps: positionFromAps,
    // 桥接 / 路由追踪
    validateHost: validateHost, buildBridgeUrl: buildBridgeUrl, parseTraceroutePayload: parseTraceroutePayload,
    tracerouteViaBridge: tracerouteViaBridge, dohResolve: dohResolve, bridgeStatus: bridgeStatus,
    defaultBridgeBase: defaultBridgeBase,
    // 自检
    selfTest: selfTest, selfTestAsync: selfTestAsync
  };
  global.GEONET = API;
  globalThis.GEONET = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);
