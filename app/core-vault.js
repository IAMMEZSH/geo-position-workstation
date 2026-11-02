/*
 * core-vault.js — 经纬度定位工作站 · 本机存储加密内核（GEOVAULT）
 *
 * 这个内核解决一件事：历史、收藏、偏好里有坐标，有地名，有你自己写下的备注。
 * 以前的写法是 JSON.stringify 之后直接进 localStorage —— 那等于把日记本摊在桌上：
 *   · 同一台机器上的任何程序（浏览器扩展、别的标签页里的脚本、拿管理员权限跑的工具）
 *     都能读走；F12 的 Application 面板一眼就能看见。
 *   · 浏览器自己的同步/备份功能也可能把它带到别处去。
 * 现在磁盘上只有一个信封：AES-256-GCM 的密文 + 派生参数。没有口令，谁打开都只看到 base64。
 *
 * 设计取舍（都写在下面的常量与注释里，可核对，不是口头承诺）：
 *   · 口令只用来派生密钥（PBKDF2-SHA256，25 万次迭代），**任何地方都不存口令本身**，
 *     所以「忘了口令」没有后门：只能重建（wipe），不能找回。
 *   · 每次写入都换新的 salt 和新的 IV，所以同一个明文两次加密得到的信封完全不同，
 *     旁观者连「你改过几次」都数不出来。
 *   · GCM 是认证加密：口令错、信封被篡改、参数被降档（把 iters 改成 1），
 *     都在解密时就失败，不会给你一个「看起来对但被换过」的数据。
 *   · 头字段（版本/KDF/迭代次数/salt）作为 AAD 参与认证，所以改一个字符就解不开。
 *   · 拿不到 WebCrypto、或页面不在安全上下文里 → **拒绝持久化**（fail closed），
 *     而不是退化成明文写盘。数据照样能在本次会话里用，只是不落盘，界面会如实说这一点。
 *   · 口令错的时候不告诉你「哪里错了」，只说「解不开」：不给猜口令的人反馈信号。
 *   · 空闲自动上锁：把密钥句柄和明文镜像一起丢弃，并回调界面重绘 ——
 *     人走开十分钟回来，屏幕上不该还留着你的位置记录。
 *
 * 纯浏览器脚本：无 import/export、无 DOM、无 fetch；Node 沙箱里可直接加载做闸门（需要 WebCrypto）。
 */
(function (global) {
  'use strict';

  /* ============================================================== 0. 常量 */
  var VERSION = '1.0.0';
  var ENVELOPE_KEY = 'llgz.vault.v1';     // 磁盘上唯一的一个键
  var SCHEMA = 1;                          // 信封格式版本；改格式要能识别旧信封
  var KDF_NAME = 'PBKDF2-SHA256';
  var KDF_HASH = 'SHA-256';
  var MIN_ITERATIONS = 250000;             // 只许变多不许变少（OWASP 2023 对 PBKDF2-SHA256 的建议量级）
  var KEY_BITS = 256;
  var CIPHER = 'AES-GCM';
  var IV_BYTES = 12;                       // GCM 的标准 96 bit nonce
  var SALT_BYTES = 16;
  var MIN_PASSPHRASE = 8;
  var MAX_PASSPHRASE = 512;                // 再长也只是多算一点，但别让恶意输入把派生拖死
  var AUTO_LOCK_DEFAULT_MS = 10 * 60 * 1000;   // 十分钟不动就锁
  var AUTO_LOCK_MIN_MS = 30 * 1000;
  var AUTO_LOCK_MAX_MS = 8 * 60 * 60 * 1000;
  var FLUSH_DEBOUNCE_MS = 250;             // 连着改十次只加密一次
  var LEGACY_KEYS = ['llgz.history.v1', 'llgz.fav.v1', 'llgz.prefs.v1', 'llgz.probe.v1', 'llgz.probe.v2'];
  // 逻辑键名（界面用的是这些，不再直接碰 localStorage）
  var STORED_KEYS = ['hist', 'fav', 'prefs', 'probe'];

  var B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /* ============================================================== 1. 小工具 */
  function isStr(v) { return typeof v === 'string'; }
  function cut(text, cap) {
    var s = text == null ? '' : String(text);
    return s.length <= cap ? s : s.slice(0, cap) + '…';
  }

  // 自己写 base64：不依赖 btoa/atob（iSH、Termux 的精简环境里它们不一定在），
  // 也不依赖 Buffer（那是 Node 的东西）。编出来的串与标准 base64 逐字节相同。
  function b64encode(bytes) {
    var out = '', i, b0, b1, b2;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      b0 = bytes[i]; b1 = bytes[i + 1]; b2 = bytes[i + 2];
      out += B64A[b0 >> 2] + B64A[((b0 & 3) << 4) | (b1 >> 4)] +
        B64A[((b1 & 15) << 2) | (b2 >> 6)] + B64A[b2 & 63];
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      b0 = bytes[i];
      out += B64A[b0 >> 2] + B64A[(b0 & 3) << 4] + '==';
    } else if (rem === 2) {
      b0 = bytes[i]; b1 = bytes[i + 1];
      out += B64A[b0 >> 2] + B64A[((b0 & 3) << 4) | (b1 >> 4)] + B64A[(b1 & 15) << 2] + '=';
    }
    return out;
  }

  var B64R = (function () {
    var m = {};
    for (var i = 0; i < B64A.length; i++) m[B64A.charAt(i)] = i;
    return m;
  })();

  function b64decode(text) {
    // 严格解码：字符不在表里、长度不是 4 的倍数、填充位置不对，一律返回 null。
    // 宽松解码会把「被改过的信封」解成另一串字节，那正是我们不想看到的（改一个字符必须失败）。
    if (!isStr(text) || text.length === 0 || text.length % 4 !== 0) return null;
    var pad = 0;
    if (text.charAt(text.length - 1) === '=') pad++;
    if (text.charAt(text.length - 2) === '=') pad++;
    var bytes = [], acc = 0, bits = 0, body = text.length - pad;
    for (var i = 0; i < body; i++) {
      var c = text.charAt(i), v = B64R[c];
      if (v === undefined) return null;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
    }
    if (bits >= 8) return null;                       // 残余比特凑不出整字节 → 长度不合法
    if (pad === 1 && (bytes.length % 3) !== 2) return null;
    if (pad === 2 && (bytes.length % 3) !== 1) return null;
    return new Uint8Array(bytes);
  }

  function utf8(bytes) {
    if (typeof TextDecoder === 'function') {
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { /* 退化到手写 */ }
    }
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 0x80) s += String.fromCharCode(b);
      else if (b < 0xe0) { s += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63)); }
      else if (b < 0xf0) s += String.fromCharCode(((b & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63));
      else {
        var cp = (((b & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63)) - 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      }
    }
    return s;
  }

  function toUtf8(str) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
    // 手写 UTF-8 编码（只在没有 TextEncoder 的环境里走到这里）
    var out = [], s = String(str == null ? '' : str);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
        var cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function randBytes(n) {
    var out = new Uint8Array(n);
    var c = subtle();
    if (c && c.getRandomValues) { c.getRandomValues(out); return out; }
    if (global.crypto && global.crypto.getRandomValues) { global.crypto.getRandomValues(out); return out; }
    // 没有安全随机数就宁可不干：Math.random 做出来的 salt/IV 是可以预测的，
    // 那等于把「每次写入都换一个信封」这个性质也一起丢掉了。
    return null;
  }

  function subtle() {
    var c = global.crypto;
    if (c && c.subtle) return c.subtle;
    if (global.webcrypto && global.webcrypto.subtle) return global.webcrypto.subtle;
    return null;
  }

  /* ============================================================== 2. 环境能力 */
  function webCryptoReady() { return subtle() !== null; }

  function secureContext() {
    // 非安全上下文里 WebCrypto 本来就是 undefined，所以这一层主要用来把原因说清楚。
    var loc = global.location;
    if (!loc) return { ok: true, kind: 'node', reason: '' };           // Node 沙箱：闸门跑在这里
    var proto = String(loc.protocol || '').toLowerCase();
    var host = String(loc.hostname || '').toLowerCase();
    if (proto === 'https:' || proto === 'file:' || proto === 'data:') return { ok: true, kind: proto, reason: '' };
    if (proto === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '')) {
      return { ok: true, kind: proto, reason: '回环 http 浏览器按可信来源处理' };
    }
    return { ok: false, kind: proto, reason: '页面不在安全上下文（' + proto + '://' + host + '），浏览器不给 WebCrypto' };
  }

  function storageHandle() {
    // 优先注入的替身（闸门与隐私模式回退），其次真 localStorage，都没有就返回 null（内存模式）。
    if (injectedStorage) return injectedStorage;
    try {
      var ls = global.localStorage;
      if (!ls) return null;
      var probe = '__geovault_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (e) {
      // Safari 无痕模式下访问 localStorage 会直接抛异常；隐私模式与 file:// 也可能没有。
      return null;
    }
  }

  function capability() {
    var wc = webCryptoReady(), sc = secureContext(), st = storageHandle();
    return {
      ok: wc && sc.ok && !!st,
      webcrypto: wc,
      secure_context: sc.ok,
      secure_context_kind: sc.kind,
      storage: st ? 'localStorage' : 'memory',
      reason: !wc ? '这个环境没有 WebCrypto（crypto.subtle），做不到加密落盘' :
        (!sc.ok ? sc.reason : (!st ? 'localStorage 不可用（隐私模式、被策略禁用或 file:// 限制）' : ''))
    };
  }

  /* ============================================================== 3. 信封：封与解 */
  function headerText(saltB64, iters) {
    // 这段文字同时当 AAD：字段顺序写死，少一个字符就认证失败。
    return '{"v":' + SCHEMA + ',"kdf":"' + KDF_NAME + '","iters":' + iters + ',"salt":"' + saltB64 + '"}';
  }

  function deriveKey(passphrase, saltBytes, iters) {
    var c = subtle();
    if (!c) return Promise.reject(new Error('no_webcrypto'));
    var base;
    try {
      base = c.importKey('raw', toUtf8(passphrase), 'PBKDF2', false, ['deriveKey']);
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve(base).then(function (km) {
      return c.deriveKey({ name: 'PBKDF2', salt: saltBytes, iterations: iters, hash: KDF_HASH },
        km, { name: CIPHER, length: KEY_BITS }, false, ['encrypt', 'decrypt']);
    });
  }

  function seal(plaintextText, passphrase, iters) {
    // 返回一个信封对象（字段都是可 JSON 化的 base64 / 整数）。
    var c = subtle();
    if (!c) return Promise.reject(new Error('no_webcrypto'));
    var iter = Math.max(MIN_ITERATIONS, Math.floor(iters || MIN_ITERATIONS));
    var salt = randBytes(SALT_BYTES), iv = randBytes(IV_BYTES);
    if (!salt || !iv) return Promise.reject(new Error('no_random'));
    return deriveKey(passphrase, salt, iter).then(function (key) {
      return c.encrypt({ name: CIPHER, iv: iv, additionalData: toUtf8(headerText(b64encode(salt), iter)) },
        key, toUtf8(plaintextText)).then(function (ctBuf) {
          return {
            v: SCHEMA, kdf: KDF_NAME, hash: KDF_HASH, iters: iter,
            salt: b64encode(salt), iv: b64encode(iv),
            ct: b64encode(new Uint8Array(ctBuf)),
            alg: CIPHER + '-' + KEY_BITS
          };
        });
    });
  }

  function open(envelope, passphrase) {
    var c = subtle();
    if (!c) return Promise.resolve({ ok: false, reason: 'no_webcrypto' });
    if (!envelope || typeof envelope !== 'object') return Promise.resolve({ ok: false, reason: 'bad_envelope' });
    if (envelope.v !== SCHEMA) return Promise.resolve({ ok: false, reason: 'schema_mismatch' });
    if (envelope.kdf !== KDF_NAME || envelope.alg !== CIPHER + '-' + KEY_BITS ||
      String(envelope.hash || '').toUpperCase() !== KDF_HASH) {
      return Promise.resolve({ ok: false, reason: 'kdf_or_alg_mismatch' });
    }
    var iters = Number(envelope.iters);
    if (!isFinite(iters) || iters < MIN_ITERATIONS) return Promise.resolve({ ok: false, reason: 'iterations_below_floor' });
    var salt = b64decode(envelope.salt), iv = b64decode(envelope.iv), ct = b64decode(envelope.ct);
    if (!salt || !iv || !ct) return Promise.resolve({ ok: false, reason: 'not_base64' });
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) return Promise.resolve({ ok: false, reason: 'wrong_salt_or_iv_length' });
    return deriveKey(passphrase, salt, iters).then(function (key) {
      return c.decrypt({ name: CIPHER, iv: iv, additionalData: toUtf8(headerText(envelope.salt, iters)) }, key, ct)
        .then(function (buf) { return { ok: true, text: utf8(new Uint8Array(buf)) }; })
        .catch(function () { return { ok: false, reason: 'wrong_passphrase' }; });   // GCM 认证失败：口令错或被篡改
    }).catch(function () { return { ok: false, reason: 'derive_failed' }; });
  }

  /* ============================================================== 4. 口令强度 */
  function strength(passphrase) {
    var s = passphrase == null ? '' : String(passphrase);
    if (s.length > MAX_PASSPHRASE) s = s.slice(0, MAX_PASSPHRASE);
    var classes = 0, sets = [];
    if (/[a-z]/.test(s)) { classes++; sets.push(26); }
    if (/[A-Z]/.test(s)) { classes++; sets.push(26); }
    if (/[0-9]/.test(s)) { classes++; sets.push(10); }
    if (/[^a-zA-Z0-9]/.test(s)) { classes++; sets.push(33); }
    var pool = sets.reduce(function (a, b) { return a + b; }, 0);
    // 熵估计：log2(pool) × 长度。中文/emoji 不计入 pool（长度本身就是主要贡献者），
    // 但按每字符 8 bit 兜一下，免得把「口令句」估成纸糊的。
    var bits = pool > 0 ? s.length * Math.log(pool) / Math.log(2) : 0;
    var nonAscii = /[^\x00-\x7f]/.test(s);
    if (nonAscii) bits = Math.max(bits, s.length * 8);
    var weak = /^(?:[a-z]+|[0-9]+|[A-Z]+|password|qwerty|114514|87654321)/i.test(s) && s.length < 12;
    if (weak) bits *= 0.4;
    if (s.length < MIN_PASSPHRASE) bits = Math.min(bits, 40);
    var score = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : bits < 110 ? 3 : 4;
    var label = ['不够用', '偏弱', '可以', '很好', '很强'][score];
    var hints = [];
    if (s.length < 12) hints.push('长一点比复杂一点管用：一句只有你自己记得住的话最好');
    if (classes < 3) hints.push('混用大小写、数字、符号中的至少三类');
    if (classes <= 1 && s.length > 0) hints.push('整串只有一类字符，最好掺进数字或符号');
    if (/^(?:password|passwd|qwerty|iloveyou|admin|114514|87654321|123456)/i.test(s)) hints.push('开头是常见弱口令串，换掉它');
    return {
      bits: Math.round(bits * 10) / 10, score: score, label: label,
      length: s.length, classes: classes, non_ascii: nonAscii,
      acceptable: s.length >= MIN_PASSPHRASE && score >= 1 && !weak,
      too_short: s.length < MIN_PASSPHRASE, hints: hints
    };
  }

  /* ============================================================== 5. 会话状态 */
  var data = {};                    // 解密后的明文镜像（锁上就丢弃）
  var key = null;                   // 当前 CryptoKey（派生参数留在 meta 里）
  var meta = null;                  // {salt, iters}：重加密时要复用同一把派生参数
  var unlockedAt = 0;
  var lastTouch = 0;
  var dirty = false;
  var flushTimer = null;
  var flushChain = Promise.resolve();
  var autoLockMs = AUTO_LOCK_DEFAULT_MS;
  var onLockHandler = null;
  var injectedStorage = null;
  var lockReason = 'cold';          // cold | locked | auto | wiped | unsupported
  var lastWrite = { ok: false, reason: '还没写过', at: 0 };

  function touch() { lastTouch = Date.now(); }

  // 「作废令牌」：一次写入在排队时就定好要写什么、用哪把密钥，并记下当时的代数。
  // wipe() 会把代数推进，于是排在它后面的那次写盘自己认输 —— 否则刚删掉的信封会被复活。
  var writeGen = 0;

  function captureForWrite() {
    var g = writeGen, k = key, m = meta, text;
    try { text = JSON.stringify(data); } catch (e) { text = null; }
    return function () {
      if (g !== writeGen) return Promise.resolve(lastWrite);
      if (typeof text !== 'string' || !k || !m) return persistNow();
      return persistNow(text, k, m);
    };
  }

  function dropSecrets() {
    key = null; meta = null; data = {}; dirty = false; unlockedAt = 0;
    if (flushTimer !== null) {
      try { (global.clearTimeout || clearTimeout)(flushTimer); } catch (e) { }
      flushTimer = null;
    }
  }

  function lock(reason) {
    // 锁上之前先把待写的改动排进加密落盘：不然「记下最后一条位置就走开」正好会丢掉那一条
    // （debounce 还没到点，密钥就被丢了）。captureForWrite 在丢弃之前就把明文和密钥抓进闭包。
    if (dirty && key) {
      var w = captureForWrite();
      flushChain = flushChain.then(w, w);
    }
    dropSecrets();
    lockReason = reason || 'locked';
    var cb = onLockHandler;
    if (cb) { try { cb({ reason: lockReason, auto: lockReason === 'auto' }); } catch (e) { /* 界面回调坏了不该把锁卡住 */ } }
    return { ok: true, reason: lockReason };
  }

  function readEnvelope() {
    var st = storageHandle();
    if (!st) return null;
    var raw = null;
    try { raw = st.getItem(ENVELOPE_KEY); } catch (e) { return null; }
    if (raw == null || raw === '') return null;
    try {
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) { return null; }     // 不是 JSON 就当作没有：绝不让坏数据把界面卡死
  }

  function writeEnvelope(env) {
    var st = storageHandle();
    if (!st) return { ok: false, reason: 'storage_unavailable' };
    try {
      st.setItem(ENVELOPE_KEY, JSON.stringify(env));
      return { ok: true, bytes: JSON.stringify(env).length };
    } catch (e) {
      // 配额满 / 隐私模式中途失效：说清楚，别让用户以为历史存住了。
      return { ok: false, reason: 'storage_write_failed', detail: cut(e && e.message || e, 120) };
    }
  }

  function persistNow(withText, withKey, withMeta) {
    // 真正的一次「加密 → 落盘」。没解锁 / 没能力 → 不写，并且如实报告原因。
    // withText/withKey/withMeta 是给 lock() 用的：它要在丢弃密钥之前把最后一版明文交出去。
    var useKey = withKey === undefined ? key : withKey;
    var useMeta = withMeta === undefined ? meta : withMeta;
    if (!useKey || !useMeta) {
      lastWrite = { ok: false, reason: unlocked() ? '内部状态不一致' : '锁着：不解锁不写盘', at: Date.now() };
      return Promise.resolve(lastWrite);
    }
    var cap = capability();
    if (!cap.ok) {
      lastWrite = { ok: false, reason: 'capability_lost：' + cap.reason, at: Date.now() };
      return Promise.resolve(lastWrite);
    }
    var text;
    if (typeof withText === 'string') {
      text = withText;
    } else {
      try { text = JSON.stringify(data); } catch (e) {
        lastWrite = { ok: false, reason: '镜像里有循环引用，没写成', at: Date.now() };
        return Promise.resolve(lastWrite);
      }
    }
    // 口令在解锁时用过一次就不留句柄了，重加密要用「当前密钥」而不是重新派生：
    // 所以这里用 key + 新 IV，salt/iters 沿用 meta（同一条口令对应同一个派生参数，
    // 但每次的 IV 都换，所以密文仍然每次都不同）。
    var c = subtle();
    if (!c) { lastWrite = { ok: false, reason: 'capability_lost：WebCrypto 没了', at: Date.now() }; return Promise.resolve(lastWrite); }
    var iv = randBytes(IV_BYTES);
    if (!iv) { lastWrite = { ok: false, reason: '没有安全随机数，拒绝写盘', at: Date.now() }; return Promise.resolve(lastWrite); }
    return c.encrypt({ name: CIPHER, iv: iv, additionalData: toUtf8(headerText(useMeta.salt, useMeta.iters)) }, useKey, toUtf8(text))
      .then(function (buf) {
        var env = {
          v: SCHEMA, kdf: KDF_NAME, hash: KDF_HASH, iters: useMeta.iters,
          salt: useMeta.salt, iv: b64encode(iv), ct: b64encode(new Uint8Array(buf)),
          alg: CIPHER + '-' + KEY_BITS
        };
        var w = writeEnvelope(env);
        lastWrite = { ok: w.ok, reason: w.ok ? ('已加密落盘 ' + w.bytes + ' 字节') : (w.reason + (w.detail ? '：' + w.detail : '')), at: Date.now() };
        if (w.ok) dirty = false;
        return lastWrite;
      })
      .catch(function (e) {
        lastWrite = { ok: false, reason: '加密失败：' + cut(e && e.message || e, 120), at: Date.now() };
        return lastWrite;
      });
  }

  function scheduleFlush() {
    dirty = true;
    if (!unlocked()) return Promise.resolve({ ok: false, reason: '锁着：改动只留在本次会话的内存里', at: Date.now() });
    if (flushTimer !== null) { try { (global.clearTimeout || clearTimeout)(flushTimer); } catch (e) { } }
    var wait = Math.max(0, autoLockMs - (Date.now() - lastTouch));
    var fireAfter = Math.min(FLUSH_DEBOUNCE_MS, Math.max(0, wait - 1000));
    return new Promise(function (resolve) {
      var done = function () {
        flushTimer = null;
        var w = captureForWrite();
        flushChain = flushChain.then(w, w);
        resolve(flushChain);
      };
      if (fireAfter <= 0) done();
      else flushTimer = (global.setTimeout || setTimeout)(done, fireAfter);
    });
  }

  function flush() {
    if (flushTimer !== null) { try { (global.clearTimeout || clearTimeout)(flushTimer); } catch (e) { } flushTimer = null; }
    if (!dirty) return Promise.resolve({ ok: true, reason: '没有待写的改动', at: Date.now() });
    var w = captureForWrite();
    flushChain = flushChain.then(w, w);
    return flushChain;
  }

  function unlocked() { return key !== null; }

  function install(passphrase, iters) {
    // 解锁成功后把派生结果装进会话：salt 用信封里的那份（口令不变，参数不变），IV 每次写新。
    var env = readEnvelope();
    meta = { salt: env.salt, iters: Math.max(MIN_ITERATIONS, Number(env.iters) || MIN_ITERATIONS) };
    key = null;
    return deriveKey(passphrase, b64decode(env.salt), meta.iters).then(function (k) {
      key = k; unlockedAt = Date.now(); touch();
      return { ok: true };
    });
  }

  /* ============================================================== 6. 对外动作 */
  function unlock(passphrase) {
    var cap = capability();
    if (!cap.webcrypto) return Promise.resolve({ ok: false, reason: 'no_webcrypto', detail: cap.reason });
    var env = readEnvelope();
    if (!env) return Promise.resolve({ ok: false, reason: 'no_envelope' });
    var p = passphrase == null ? '' : String(passphrase);
    if (p.length === 0) return Promise.resolve({ ok: false, reason: 'empty_passphrase' });
    return open(env, p).then(function (r) {
      if (!r.ok) return { ok: false, reason: r.reason, detail: r.reason === 'wrong_passphrase' ? '口令不对（或者这个信封被改过）' : r.reason };
      var parsed;
      try { parsed = JSON.parse(r.text); } catch (e) { return { ok: false, reason: 'plaintext_not_json' }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'plaintext_not_object' };
      data = parsed;
      touch();
      return install(passphrase).then(function () {
        lockReason = 'unlocked';
        return { ok: true, keys: Object.keys(data).length, unlocked_at: unlockedAt };
      });
    });
  }

  function createNew(passphrase, opts) {
    // 新建/覆盖式重建：口令合格才建；建完立刻写一个空信封，此后才有东西可解。
    var stg = strength(passphrase);
    if (!stg.acceptable) {
      return Promise.resolve({ ok: false, reason: stg.too_short ? 'too_short' : 'weak_passphrase', detail: stg });
    }
    var cap = capability();
    if (!cap.webcrypto) return Promise.resolve({ ok: false, reason: 'no_webcrypto', detail: cap.reason });
    var keep = (opts && opts.keep && typeof opts.keep === 'object') ? opts.keep : {};
    data = keep;
    return seal(JSON.stringify(keep), passphrase, (opts && opts.iters) || MIN_ITERATIONS).then(function (env) {
      var w = writeEnvelope(env);
      if (!w.ok) return { ok: false, reason: w.reason, detail: w.detail || '' };
      touch();
      return install(passphrase).then(function () {
        lockReason = 'unlocked';
        return { ok: true, created: true, bytes: w.bytes, keys: Object.keys(keep).length };
      });
    }).catch(function (e) {
      return { ok: false, reason: 'seal_failed', detail: cut(e && e.message || e, 120) };
    });
  }

  function changePassphrase(oldPass, newPass) {
    var env = readEnvelope();
    if (!env) return Promise.resolve({ ok: false, reason: 'no_envelope' });
    if (!unlocked()) {
      // 不解锁也能改？不行：必须先证明知道旧口令，否则等于给了一个绕过口令的写入口。
      return open(env, oldPass == null ? '' : String(oldPass)).then(function (r) {
        return r.ok ? { ok: false, reason: 'locked' } : { ok: false, reason: 'wrong_passphrase' };
      });
    }
    var stg = strength(newPass);
    if (!stg.acceptable) return Promise.resolve({ ok: false, reason: stg.too_short ? 'too_short' : 'weak_passphrase', detail: stg });
    return open(env, oldPass == null ? '' : String(oldPass)).then(function (r) {
      if (!r.ok) return { ok: false, reason: 'wrong_passphrase', detail: '旧口令验证没过，什么都没改' };
      return createNew(newPass, { keep: data });
    }).then(function (res) {
      if (res && res.ok) return { ok: true, reason: 'changed', keys: Object.keys(data).length };
      return res;
    });
  }

  function wipe() {
    // 「把这台机器上的我忘掉」：删信封 + 丢弃内存 + 顺手清掉可能存在的旧明文静置键。
    writeGen++;                 // 排队中的写盘全部作废，否则删完又被写回来
    dirty = false;              // 也不让 lock() 在擦除前补写最后一次改动
    var st = storageHandle();
    var removed = [];
    if (st) {
      try { st.removeItem(ENVELOPE_KEY); removed.push(ENVELOPE_KEY); } catch (e) { }
      LEGACY_KEYS.forEach(function (k) {
        try { if (st.getItem(k) !== null) { st.removeItem(k); removed.push(k); } } catch (e) { }
      });
    }
    lock('wiped');
    return { ok: true, removed: removed, note: '信封与旧明文键都已删除；这个动作没有回收站' };
  }

  /* 读写镜像：界面用这两个同步口，落盘由内核在背后做。
   * get() 刻意不续空闲钟——界面每 2 秒重画一次保险柜状态，每次都读两遍镜像；
   * 如果读也算「动过手」，「1 分钟不动就锁」永远不会发生，屏幕会一直亮着记录。
   * 空闲只认真实操作：写、删、解锁，以及界面显式调用的 activity()。 */
  function get(keyName, dflt) {
    if (!Object.prototype.hasOwnProperty.call(data, keyName)) return dflt;
    var v = data[keyName];
    return v === undefined || v === null ? dflt : v;
  }

  function put(keyName, value) {
    if (STORED_KEYS.indexOf(keyName) < 0 && !/^[a-z][a-z0-9_]{0,23}$/.test(String(keyName))) {
      return { ok: false, reason: 'bad_key_name', key: keyName };
    }
    data[keyName] = value;
    touch();
    scheduleFlush();
    return { ok: true, key: keyName, pending: !unlocked() };
  }

  function remove(keyName) {
    var had = Object.prototype.hasOwnProperty.call(data, keyName);
    delete data[keyName];
    touch();
    scheduleFlush();
    return { ok: true, removed: had };
  }

  function keys() { return Object.keys(data); }
  function mirrorSize() { try { return JSON.stringify(data).length; } catch (e) { return -1; } }

  function absorbLegacy() {
    // 收编旧版明文键：读出来 → 塞进内存镜像 → 触发一次加密写 → 删除明文键。
    // 这一步只可能发生在「已经解锁」之后，否则等于凭空造出一份没加密的数据。
    if (!unlocked()) return Promise.resolve({ ok: false, reason: 'locked' });
    var st = storageHandle();
    if (!st) return Promise.resolve({ ok: false, reason: 'storage_unavailable' });
    var moved = [];
    var map = { 'llgz.history.v1': 'hist', 'llgz.fav.v1': 'fav', 'llgz.prefs.v1': 'prefs', 'llgz.probe.v1': 'probe', 'llgz.probe.v2': 'probe' };
    LEGACY_KEYS.forEach(function (lk) {
      var raw = null;
      try { raw = st.getItem(lk); } catch (e) { return; }
      if (raw == null) return;
      try {
        var v = JSON.parse(raw);
        if (v !== null && v !== undefined) {
          var name = map[lk] || 'prefs';
          // 已经有密文里的那份就不覆盖：谁的来源更可信不重要，重要的是不要把用户刚设的结构冲掉。
          if (!Object.prototype.hasOwnProperty.call(data, name)) data[name] = v;
          moved.push(lk);
        }
      } catch (e) { moved.push(lk); }        // 解析失败也删：留在磁盘上只是一份读不出来的明文垃圾
      try { st.removeItem(lk); } catch (e) { }
    });
    if (!moved.length) return Promise.resolve({ ok: true, moved: [], note: '磁盘上没有待收编的旧明文键' });
    return persistNow().then(function (w) {
      return { ok: w.ok, moved: moved, write: w, note: w.ok ? '已收编进加密信封，旧明文键已删除' : w.reason };
    });
  }

  function legacyPlaintextPresent() {
    var st = storageHandle();
    if (!st) return [];
    var found = [];
    LEGACY_KEYS.forEach(function (k) {
      try { if (st.getItem(k) != null) found.push(k); } catch (e) { }
    });
    return found;
  }

  function status() {
    var env = readEnvelope();
    var cap = capability();
    var idle = lastTouch ? Date.now() - lastTouch : -1;
    return {
      ok: true,
      version: VERSION,
      supported: cap.ok,
      capability: cap,
      has_vault: !!env,
      unlocked: unlocked(),
      lock_reason: unlocked() ? 'unlocked' : lockReason,
      envelope_bytes: env ? JSON.stringify(env).length : 0,
      envelope_meta: env ? { v: env.v, kdf: env.kdf, iters: env.iters, alg: env.alg, has_ct: !!env.ct } : null,
      keys: unlocked() ? keys() : [],
      key_count: unlocked() ? keys().length : 0,
      mirror_bytes: unlocked() ? mirrorSize() : 0,
      pending_write: dirty,
      last_write: lastWrite,
      auto_lock_ms: autoLockMs,
      idle_ms: idle,
      auto_lock_in_ms: unlocked() ? Math.max(0, autoLockMs - idle) : null,
      legacy_plaintext_keys: legacyPlaintextPresent(),
      note: '磁盘上只有 AES-256-GCM 的信封；口令不落盘，忘了只能重建'
    };
  }

  function setAutoLock(ms) {
    var v = Number(ms);
    if (!isFinite(v)) return { ok: false, reason: 'bad_value', auto_lock_ms: autoLockMs };
    v = Math.round(v);
    if (v === 0) { autoLockMs = AUTO_LOCK_MAX_MS * 4; return { ok: true, auto_lock_ms: autoLockMs, manual_only: true }; }
    autoLockMs = Math.min(AUTO_LOCK_MAX_MS, Math.max(AUTO_LOCK_MIN_MS, v));
    touch();
    return { ok: true, auto_lock_ms: autoLockMs };
  }

  // 自动上锁：不用后台计时器去「到点就清」，而是每次探测时比较空闲时长。
  // 理由：浏览器在后台标签页里会把 setInterval 降到 1 次/分钟甚至冻结，
  // 靠计时器到点执行会出现「已经超时但还没锁」的窗口；比较时间戳不会。
  function checkAutoLock() {
    if (!unlocked()) return { locked: false };
    if (Date.now() - lastTouch > autoLockMs) { lock('auto'); return { locked: true, reason: 'auto' }; }
    return { locked: false, idle_ms: Date.now() - lastTouch, in_ms: autoLockMs - (Date.now() - lastTouch) };
  }

  function onLock(fn) { onLockHandler = (typeof fn === 'function') ? fn : null; return { ok: true }; }

  function setStorageHandle(sh) {
    injectedStorage = (sh && typeof sh.getItem === 'function' && typeof sh.setItem === 'function') ? sh : null;
    return { ok: true, kind: injectedStorage ? 'injected' : (storageHandle() ? 'localStorage' : 'memory') };
  }

  /* ============================================================== 7. 闸门 */
  // 闸门断言的是「冷启动/锁着」的行为，所以进来先把会话真的丢掉：
  // 在浏览器里点自检时用户多半是解锁状态，不隔离就会把「已解锁」当成冷启动——
  // 那几门会在真浏览器里失败、却在 Node 沙箱里假通过（同一份代码，两种结果，必须钉平）。
  function isolateSession() {
    dropSecrets();                       // key/meta/镜像/dirty/待写计时器
    lastWrite = { ok: false, reason: '还没写过', at: 0 };
    lockReason = 'cold';
    lastTouch = Date.now();
  }

  function sessionSnapshot() {
    return {
      data: data, key: key, meta: meta, unlockedAt: unlockedAt, lastTouch: lastTouch, dirty: dirty,
      lockReason: lockReason, lastWrite: lastWrite, autoLockMs: autoLockMs,
      onLockHandler: onLockHandler, injectedStorage: injectedStorage, flushTimer: flushTimer
    };
  }

  // 自检要在真的存储替身上「建锁—解锁—改口令—擦除」走一遍，所以进出都要把会话原样接上：
  // 用户点开诊断面板不该把自己的解锁状态、待写的历史或界面回调一起清掉。
  function sessionRestore(snap) {    if (!snap) return;
    if (flushTimer !== null && flushTimer !== snap.flushTimer) {
      try { (global.clearTimeout || clearTimeout)(flushTimer); } catch (e) { }
    }
    data = snap.data; key = snap.key; meta = snap.meta; unlockedAt = snap.unlockedAt;
    lastTouch = snap.lastTouch; dirty = snap.dirty; lockReason = snap.lockReason;
    lastWrite = snap.lastWrite; autoLockMs = snap.autoLockMs; onLockHandler = snap.onLockHandler;
    injectedStorage = snap.injectedStorage; flushTimer = snap.flushTimer;
    if (dirty && key && flushTimer === null) scheduleFlush();   // 待写的 debounce 不能因为自检而丢掉
  }

  function selfTest() {
    var out = [];
    var snap = sessionSnapshot();
    onLockHandler = null;      // 自检里的 lock 不该惊动界面
    isolateSession();
    var push = function (name, pass, detail) { out.push({ name: name, pass: pass === true, detail: String(detail) }); };

    /* --- base64 与 UTF-8 往返 --- */
    var rt = [], i;
    for (i = 0; i < 256; i++) rt.push(i);
    var allBytes = new Uint8Array(rt);
    var enc = b64encode(allBytes), dec = b64decode(enc);
    push('base64 覆盖 0..255 全部字节且往返相同（256 字节）',
      !!dec && dec.length === 256 && (function () { for (var k = 0; k < 256; k++) if (dec[k] !== k) return false; return true; })(),
      enc.length + ' 字符');
    push('base64 三种余数长度都能往返', (() => {
      for (var n = 1; n <= 9; n++) {
        var b = new Uint8Array(n); for (var k = 0; k < n; k++) b[k] = (k * 37 + 11) & 255;
        var d = b64decode(b64encode(b));
        if (!d || d.length !== n) return false;
        for (var j = 0; j < n; j++) if (d[j] !== b[j]) return false;
      }
      return true;
    })(), '长度 1..9 逐一试过');
    push('base64 严格解码：非法字符/长度/填充一律拒绝',
      b64decode('AAAA!') === null && b64decode('AA') === null && b64decode('A===') === null &&
      b64decode('') === null && b64decode('////') !== null,
      '返回 null 才算拒（宽松解码会把篡改过的信封解成另一串字节）');
    var cn = '上海·北京「测试」🙂 123';
    push('UTF-8 往返含 CJK 与 emoji（4 字节序列）', utf8(toUtf8(cn)) === cn, cut(cn, 20));
    push('UTF-8 编码长度与 TextEncoder 一致', toUtf8(cn).length === (typeof TextEncoder === 'function' ? new TextEncoder().encode(cn).length : toUtf8(cn).length), toUtf8(cn).length + ' 字节');

    /* --- 口令强度 --- */
    var s1 = strength('a');
    push('口令短于 ' + MIN_PASSPHRASE + ' 位直接不合格', s1.too_short === true && s1.acceptable === false, '长度 ' + s1.length);
    var s2 = strength('correct horse battery staple');
    push('四个随机词的熵按 ≥ 每字符 8 bit 估（不按 26 字母表压低）',
      s2.bits > 8 * s2.length * 0.5 && s2.acceptable === true && s2.score >= 3, s2.bits + ' bit，评分 ' + s2.score);
    var s3 = strength('aaaaaaaa');
    push('八个同一小写字母被判弱', s3.acceptable === false && s3.score <= 1, s3.bits + ' bit，' + s3.label);
    var s4 = strength('Tr0ub4dor&3xyz');
    push('混合类长口令判可接受，且不再对着没毛病的一条口令啰嗦',
      s4.acceptable === true && s4.score >= 2 && s4.hints.length === 0, s4.bits + ' bit，' + s4.label + '，提示 ' + s4.hints.length + ' 条');
    var s5 = strength('password12345678');
    push('常见弱串开头会被点名（长度够也照说）', s5.hints.some(function (h) { return h.indexOf('常见弱口令') >= 0; }), s5.hints.join('；'));
    push('整串单类字符会拿到「掺一类进去」的建议', strength('abcdefghijkl').hints.some(function (h) { return h.indexOf('一类字符') >= 0; }), '');
    push('强度函数不接受 null/undefined 而不抛', strength(null).acceptable === false && strength(undefined).too_short === true, '');
    push('口令上限生效（超长只截不断）', strength(new Array(600).join('a')).length === MAX_PASSPHRASE, '上限 ' + MAX_PASSPHRASE);

    /* --- 常量与红线 --- */
    push('迭代次数下限写死为 ' + MIN_ITERATIONS + '，且没有「降档」入口',
      MIN_ITERATIONS >= 210000 && Number.isFinite(MIN_ITERATIONS), MIN_ITERATIONS + ' 次 PBKDF2-SHA256');
    push('密钥长度 256 bit、IV 96 bit、salt 128 bit（都是 GCM 的标准取法）',
      KEY_BITS === 256 && IV_BYTES === 12 && SALT_BYTES === 16, 'AES-256-GCM');
    push('LEGACY 明文键清单覆盖旧版用过的每一个名字',
      LEGACY_KEYS.length === 5 && LEGACY_KEYS.indexOf('llgz.history.v1') >= 0 && LEGACY_KEYS.indexOf('llgz.probe.v2') >= 0,
      LEGACY_KEYS.join(' / '));
    push('磁盘上只占一个键名（历史/收藏/偏好/探测都在同一个信封里）',
      ENVELOPE_KEY === 'llgz.vault.v1' && STORED_KEYS.length === 4, ENVELOPE_KEY);
    push('界面要的两个口都导出了：unlocked() 判定锁态、activity() 把真实操作喂给空闲计时',
      typeof api.unlocked === 'function' && typeof api.activity === 'function', '缺一个就会退回「靠 status 猜」');
    push('自动上锁默认十分钟，且有上下限（不许设成一秒或永远不锁）',
      AUTO_LOCK_DEFAULT_MS === 600000 && AUTO_LOCK_MIN_MS === 30000 && AUTO_LOCK_MAX_MS === 28800000,
      (AUTO_LOCK_DEFAULT_MS / 60000) + ' 分钟');

    /* --- 状态机（不需要 WebCrypto 也能测的部分）--- */
    setStorageHandle({
      store: {},
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem: function (k, v) { this.store[k] = String(v); },
      removeItem: function (k) { delete this.store[k]; }
    });
    push('闸门从真·冷启动开始（解锁状态下点自检也走同一条路径）',
      unlocked() === false && Object.keys(data).length === 0 && dirty === false &&
      lastWrite.ok === false && flushTimer === null,
      'isolate 之后：密钥句柄已丢弃、镜像为空、无待写、debounce 计时器已清');
    push('未解锁时 status().unlocked 为 false，且 get 只能拿到默认值',
      status().unlocked === false && get('hist', ['x'])[0] === 'x', '冷启动');
    push('锁着的时候 put 不写盘、只标 pending（改动留在内存）',
      put('hist', [{ lat: 1 }]).pending === true && status().has_vault === false && status().last_write.ok === false,
      JSON.stringify(status().last_write));
    push('wipe 在无存储内容时也不报错（幂等）', wipe().ok === true, '');
    var st = status();
    push('status 的字段够界面用（能力/信封大小/待写/auto-lock 余量）',
      ['supported', 'has_vault', 'unlocked', 'envelope_bytes', 'pending_write', 'auto_lock_ms', 'idle_ms',
        'legacy_plaintext_keys', 'capability', 'note'].every(function (k) { return Object.prototype.hasOwnProperty.call(st, k); }),
      Object.keys(st).length + ' 个字段');
    push('setAutoLock 夹紧范围，非法值不改现状',
      setAutoLock(1000).auto_lock_ms === AUTO_LOCK_MIN_MS && setAutoLock('abc').ok === false &&
      setAutoLock(99999999999).auto_lock_ms === AUTO_LOCK_MAX_MS, '30 秒 ~ 8 小时');
    push('checkAutoLock 在没解锁时什么都不做', checkAutoLock().locked === false, '');
    push('onLock 能注册与注销（界面销毁时不留下回调）',
      onLock(function () { }).ok === true && onLock(null).ok === true, '');
    push('put 拒绝畸形键名（信封里不许塞任意键）',
      put('Bad-Key', 1).ok === false && put('ok_key', 1).ok === true && put('', 1).ok === false, '');
    push('remove 对不存在的键也只报告不抛', remove('nope').ok === true && remove('nope').removed === false, '');
    push('能力查询如实报告注入存储（闸门跑在这里，不在浏览器里）',
      capability().storage === 'localStorage' && capability().webcrypto === webCryptoReady(),
      JSON.stringify({ ok: capability().ok, storage: capability().storage }) + ' wc=' + capability().webcrypto);

    /* --- 头字段与 AAD 的绑定关系（可离线核对的部分）--- */
    var h1 = headerText('c2FsdHNhbHRzYWx0c2ExMg==', 250000);
    push('AAD 头文本包含版本/KDF/迭代次数/salt 四个字段',
      h1.indexOf('"v":1') === 1 && h1.indexOf('"kdf":"PBKDF2-SHA256"') > 0 &&
      h1.indexOf('"iters":250000') > 0 && h1.indexOf('c2FsdHNhbHRzYWx0c2ExMg==') > 0, cut(h1, 96));
    push('AAD 与密文分开：改 iters 数字会得到不同的 AAD（降档攻击当场解不开）',
      headerText('c2FsdHNhbHRzYWx0c2ExMg==', 250000) !== headerText('c2FsdHNhbHRzYWx0c2ExMg==', 1), '两条头文本不同');

    /* 需要 await 的分支全部放在 selfTestAsync：同步闸门才能和别的内核一样直接取数组。 */
    push('自检结束时把会话与存储接回原样（点自检不会把你锁上）',
      (function () { sessionRestore(snap); return injectedStorage === snap.injectedStorage && onLockHandler === snap.onLockHandler; })(),
      'restore ok');
    return out;
  }

  /* ------------------------------------------------------- 7b. 异步闸门（真跑 WebCrypto）
   * 这一节是「加密」这件事唯一有意义的验证方式：不是读注释，是把同一个口令的两次加密
   * 摆在一起看它们不一样、把错的口令摆上去看它解不开、把改过一个字符的信封摆上去看它失败。
   */
  async function selfTestAsync() {
    var out = [];
    var snap = sessionSnapshot();
    onLockHandler = null;
    isolateSession();          // 与同步闸门同一口径：先真的锁上，再演「建锁—解锁—改口令—擦除」
    var push = function (name, pass, detail) { out.push({ name: name, pass: pass === true, detail: String(detail) }); };
    var tick = function (ms) {
      return new Promise(function (r) { (global.setTimeout || setTimeout)(r, ms); });
    };
    var cap = capability();
    if (!cap.webcrypto) {
      push('这个环境没有 WebCrypto，异步闸门跳过（不是通过）', true, 'crypto.subtle 不存在');
      sessionRestore(snap);
      return out;
    }
    var PASS = '上海南京东路 12 号·2026', WRONG = '上海南京东路 12 号·2027';
    var store = { hist: [{ lat: 31.2304, lon: 121.4737, label: '外滩' }], prefs: { theme: 'dark' } };
    var text = JSON.stringify(store);

    var e1 = await seal(text, PASS);
    var e2 = await seal(text, PASS);
    push('信封字段齐全（v/kdf/hash/iters/salt/iv/ct/alg）',
      ['v', 'kdf', 'hash', 'iters', 'salt', 'iv', 'ct', 'alg'].every(function (k) { return e1[k] !== undefined; }),
      Object.keys(e1).join(','));
    push('salt 与 IV 每次都是新的（同一条明文两次加密结果完全不同）',
      e1.salt !== e2.salt && e1.iv !== e2.iv && e1.ct !== e2.ct,
      'salt ' + e1.salt.slice(0, 8) + '→' + e2.salt.slice(0, 8) + '，密文长度 ' + e1.ct.length + '/' + e2.ct.length);
    push('salt 128 bit、IV 96 bit（解码后长度对得上）',
      b64decode(e1.salt).length === SALT_BYTES && b64decode(e1.iv).length === IV_BYTES, e1.salt.length + '/' + e1.iv.length + ' 字符');
    push('迭代次数取下限值并写进信封（可核对，不是嘴上说的）',
      e1.iters === MIN_ITERATIONS && typeof e1.iters === 'number', e1.iters + ' 次');
    push('密文里看不见明文（坐标数字与地名都不出现）',
      e1.ct.indexOf('31.2304') < 0 && e1.ct.indexOf('外滩') < 0 && JSON.stringify(e1).indexOf('31.2304') < 0,
      '整封信封 ' + JSON.stringify(e1).length + ' 字符');

    var o1 = await open(e1, PASS);
    push('正确口令解回逐字节相同的 JSON',
      o1.ok === true && o1.text === text, o1.ok ? '往返一致' : o1.reason);
    var o2 = await open(e1, WRONG);
    push('错一个字符的口令 → wrong_passphrase（不是空数据、不是半解）',
      o2.ok === false && o2.reason === 'wrong_passphrase', o2.reason);
    var tamperCt = JSON.parse(JSON.stringify(e1));
    tamperCt.ct = tamperCt.ct.slice(0, -4) + (tamperCt.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    var o3 = await open(tamperCt, PASS);
    push('改一个密文字符 → 认证失败（GCM 不只是加密，还管完整性）',
      o3.ok === false && o3.reason === 'wrong_passphrase', o3.reason);
    var tamperIter = JSON.parse(JSON.stringify(e1));
    tamperIter.iters = 1;
    var o4 = await open(tamperIter, PASS);
    push('把迭代次数降档（iters:1）→ 直接拒，不重新派生去配合攻击者',
      o4.ok === false && o4.reason === 'iterations_below_floor', o4.reason);
    var tamperSaltB64 = JSON.parse(JSON.stringify(e1));
    tamperSaltB64.salt = tamperSaltB64.salt.slice(0, -2) + 'AA';
    var o5 = await open(tamperSaltB64, PASS);
    push('改 salt → AAD 与派生参数同时错位，解不开（头字段参与认证）',
      o5.ok === false, o5.reason);
    var o6 = await open(JSON.parse(JSON.stringify(e1)), '');
    push('空口令不会「碰巧解开」', o6.ok === false, o6.reason);

    var badEnv = [null, { v: 99 }, {}, 'x'];
    var badRes = await Promise.all(badEnv.map(function (e) { return open(e, PASS); }));
    push('缺信封/版本不对/字段缺失 → 各有各的拒绝原因，不抛异常',
      badRes.every(function (r) { return r && r.ok === false && !!r.reason; }),
      badRes.map(function (r) { return r.reason; }).join(' / '));
    var cbc = await open({ v: 1, kdf: 'PBKDF2-SHA256', hash: 'SHA-256', alg: 'AES-CBC-256', iters: MIN_ITERATIONS, salt: e1.salt, iv: e1.iv, ct: e1.ct }, PASS);
    push('信封里把算法换成 AES-CBC 也不跟着走（拒绝执行未登记的参数组合）',
      cbc.ok === false && cbc.reason === 'kdf_or_alg_mismatch', cbc.reason);
    var nb = await open({ v: 1, kdf: 'PBKDF2-SHA256', hash: 'SHA-256', alg: 'AES-GCM-256', iters: MIN_ITERATIONS, salt: '!!', iv: '!!', ct: '!!' }, PASS);
    push('salt/iv/ct 不是合法 base64 → 拒（严格解码没解出字节）',
      nb.ok === false && (nb.reason === 'not_base64' || nb.reason === 'wrong_salt_or_iv_length'), nb.reason);

    /* --- 全流程：createNew → 写盘 → lock → unlock → 改动 → flush --- */
    var fake = {
      store: {},
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem: function (k, v) { this.store[k] = String(v); },
      removeItem: function (k) { delete this.store[k]; }
    };
    setStorageHandle(fake);
    var created = await createNew(PASS, { keep: store });
    push('createNew 写下的信封里没有任何明文（磁盘侧看得到的是 base64）',
      created.ok === true && fake.store[ENVELOPE_KEY].indexOf('31.2304') < 0 && fake.store[ENVELOPE_KEY].indexOf('外滩') < 0,
      '信封 ' + fake.store[ENVELOPE_KEY].length + ' 字符');
    push('createNew 之后是解锁状态，get 能读到收进来的历史',
      status().unlocked === true && get('hist', []).length === 1 && get('hist', [])[0].label === '外滩', JSON.stringify(keys()));
    var envA = JSON.parse(fake.store[ENVELOPE_KEY]);
    put('hist', [{ lat: 39.9042, lon: 116.4074, label: '国贸' }]);
    var wrote = await flush();
    push('改动会真的落盘（flush 之后信封变了，且状态不再 pending）',
      wrote.ok === true && JSON.parse(fake.store[ENVELOPE_KEY]).ct !== envA.ct && status().pending_write === false,
      wrote.reason);
    var envB = JSON.parse(fake.store[ENVELOPE_KEY]);
    push('两次落盘复用同一条派生参数（salt/iters 不变）但每次换 IV，所以密文必不同',
      envB.salt === envA.salt && envB.iters === envA.iters && envB.iv !== envA.iv && envB.ct !== envA.ct,
      'salt 复用、IV ' + envA.iv.slice(0, 6) + '…→' + envB.iv.slice(0, 6) + '…');
    lock('manual');
    push('锁上之后 get 只能拿默认值、keys 变空、内存镜像丢弃',
      status().unlocked === false && get('hist', []).length === 0 && keys().length === 0 && mirrorSize() === 2,
      '镜像 ' + mirrorSize() + ' 字节（空对象）');
    var re = await unlock(PASS);
    push('重新用口令解锁后读回锁前那一份数据',
      re.ok === true && get('hist', [])[0].label === '国贸' && re.keys === 2, JSON.stringify(re));
    var reWrong = await unlock('随手猜的一个口令123');
    push('已解锁时试错口令：失败，磁盘信封一字节都没动',
      reWrong.ok === false && reWrong.reason === 'wrong_passphrase' &&
      fake.store[ENVELOPE_KEY] === JSON.stringify(envB), reWrong.reason);
    lock('manual');
    var coldWrong = await unlock('再猜一个还是错的口令456');
    push('锁着时试错口令：当场失败且不会解到一半留密钥',
      coldWrong.ok === false && coldWrong.reason === 'wrong_passphrase' &&
      status().unlocked === false && keys().length === 0, coldWrong.reason);
    var re2 = await unlock(PASS);
    push('猜错口令不会把锁弄坏或消耗掉（正确口令照样解得开）',
      re2.ok === true && get('hist', [])[0].label === '国贸', JSON.stringify(re2));
    var chg = await changePassphrase('不对的旧口令', '新的口令要够长才行42');
    push('改口令必须先证明知道旧口令', chg.ok === false && chg.reason === 'wrong_passphrase', chg.reason);
    var chg2 = await changePassphrase(PASS, '新的口令要够长才行42');
    var oldAfter = await unlock(PASS);
    push('改口令成功：新信封可解、旧口令当场失效（不是只改了个标签）',
      chg2.ok === true && oldAfter.ok === false && oldAfter.reason === 'wrong_passphrase',
      chg2.reason + ' / 旧口令现在 ' + oldAfter.reason);
    var env3 = JSON.parse(fake.store[ENVELOPE_KEY]);
    var openOld = await open(env3, PASS);
    var openNew = await open(env3, '新的口令要够长才行42');
    push('改过之后磁盘上的信封只有新口令能解（旧口令当场 wrong_passphrase）',
      openOld.ok === false && openNew.ok === true, openOld.reason + ' / ' + openNew.reason);
    var tooWeak = await createNew('abc', { keep: {} });
    push('弱口令建不了新锁（不给你一把纸糊的锁）',
      tooWeak.ok === false && (tooWeak.reason === 'too_short' || tooWeak.reason === 'weak_passphrase'), tooWeak.reason);

    /* --- 旧明文收编：先摆两个明文键，收编后必须一个都不剩 --- */
    var absorb = {
      store: { 'llgz.history.v1': JSON.stringify([{ lat: 1, lon: 2 }]), 'llgz.prefs.v1': JSON.stringify({ a: 1 }), 'llgz.probe.v1': '3' },
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem: function (k, v) { this.store[k] = String(v); },
      removeItem: function (k) { delete this.store[k]; }
    };
    setStorageHandle(absorb);
    lock('manual');
    var early = await absorbLegacy();
    push('没解锁时拒绝收编（不然等于把明文搬来搬去）', early.ok === false && early.reason === 'locked', early.reason);
    push('收编前先看得见旧明文键（界面要据此提示）', legacyPlaintextPresent().length === 3, legacyPlaintextPresent().join(','));
    var made = await createNew(PASS, { keep: {} });
    push('重建空锁也能成功（收编要在解锁之后进行）', made.ok === true, JSON.stringify(made));
    var ab = await absorbLegacy();
    push('收编把三份明文键搬进密文并删除原键',
      ab.ok === true && ab.moved.length === 3 && legacyPlaintextPresent().length === 0, JSON.stringify(ab.moved));
    push('收编后 hist/prefs 读得到、probe 也进了镜像',
      get('hist', []).length === 1 && get('prefs', {}).a === 1 && get('probe', null) === 3,
      JSON.stringify(keys()));
    var disk = absorb.store[ENVELOPE_KEY] || '';
    push('收编之后那份存储里只剩一个键（旧明文键一个都不留）',
      Object.keys(absorb.store).length === 1 && disk.indexOf('"lat"') < 0 && disk.length > 100,
      Object.keys(absorb.store).join(','));

    /* --- 自动上锁：靠时间戳比较，不靠计时器到点 --- */
    var fired = null;
    onLock(function (e) { fired = e; });
    setAutoLock(AUTO_LOCK_MIN_MS);
    var envPreLock = absorb.store[ENVELOPE_KEY];
    put('probe', 9);
    push('刚动过手时不会被自动锁误伤', checkAutoLock().locked === false, 'idle ' + status().idle_ms + 'ms');
    var readStamp = lastTouch;
    get('hist', []); get('prefs', {}); keys(); status();
    push('纯读不给空闲钟续命（界面每 2 秒刷新一次状态，读两遍不能永远不锁）',
      lastTouch === readStamp && checkAutoLock().locked === false,
      '读前读后 lastTouch 同为 ' + readStamp + '，idle ' + status().idle_ms + 'ms');
    lastTouch = Date.now() - (AUTO_LOCK_MIN_MS + 5000);
    var chk = checkAutoLock();
    push('超过空闲上限后 checkAutoLock 当场锁上并回调界面',
      chk.locked === true && fired && fired.auto === true && status().unlocked === false, JSON.stringify(chk));
    await tick(60);
    push('走开前的最后一条改动不会丢：锁上的同时补写盘，磁盘上的信封确实换了',
      !!absorb.store[ENVELOPE_KEY] && absorb.store[ENVELOPE_KEY] !== envPreLock,
      '信封 ' + String(absorb.store[ENVELOPE_KEY]).length + ' 字符（原 ' + String(envPreLock).length + '）');
    var reProbe = await unlock(PASS);
    push('补写的那一条回来还读得到（probe 的新值落进了密文）',
      reProbe.ok === true && get('probe') === 9, 'probe=' + JSON.stringify(get('probe', null)));
    onLock(null);

    /* --- wipe：删掉的东西不能被排队中的写盘复活 --- */
    put('hist', [{ lat: 31.2, lon: 121.4 }]);
    var queued = flush();                       // 写盘已经排进链里，还没执行
    absorb.store['llgz.history.v1'] = JSON.stringify([{ lat: 1, lon: 2 }]);   // 再摆一个旧明文键：wipe 必须连它一起删
    var memOnly = wipe();                       // 同一次同步块里立刻擦除
    await queued;
    await tick(30);
    push('wipe 一次带走信封与所有旧明文键（幂等，且没有回收站）',
      memOnly.ok === true && Object.keys(absorb.store).length === 0 &&
      memOnly.removed.indexOf(ENVELOPE_KEY) >= 0 && memOnly.removed.indexOf('llgz.history.v1') >= 0,
      JSON.stringify(memOnly.removed));
    push('wipe 之后那次已排队的写盘自己作废（删掉的信封不会复活）',
      !absorb.store[ENVELOPE_KEY] && Object.keys(absorb.store).length === 0,
      Object.keys(absorb.store).join(',') || '（那份存储已经完全空了）');
    setStorageHandle(null);
    push('撤掉注入存储后回到真实环境（闸门不留下副作用）',
      capability().storage === (global.localStorage ? 'localStorage' : 'memory'), capability().storage);
    sessionRestore(snap);
    var after = status();
    push('异步自检走完也不改变用户那一份会话（进来时锁着就还是锁着、auto-lock 设置与待写标记原样）',
      after.unlocked === (snap.key !== null) && after.lock_reason === snap.lockReason &&
      after.auto_lock_ms === snap.autoLockMs && after.pending_write === snap.dirty,
      'unlocked=' + after.unlocked + ' reason=' + after.lock_reason + ' pending=' + after.pending_write +
      ' auto=' + after.auto_lock_ms);
    return out;
  }

  var api = {
    VERSION: VERSION,
    ENVELOPE_KEY: ENVELOPE_KEY, SCHEMA: SCHEMA, KDF: KDF_NAME, HASH: KDF_HASH, CIPHER: CIPHER + '-' + KEY_BITS,
    MIN_ITERATIONS: MIN_ITERATIONS, IV_BYTES: IV_BYTES, SALT_BYTES: SALT_BYTES,
    MIN_PASSPHRASE: MIN_PASSPHRASE, MAX_PASSPHRASE: MAX_PASSPHRASE,
    AUTO_LOCK_DEFAULT_MS: AUTO_LOCK_DEFAULT_MS, AUTO_LOCK_MIN_MS: AUTO_LOCK_MIN_MS, AUTO_LOCK_MAX_MS: AUTO_LOCK_MAX_MS,
    FLUSH_DEBOUNCE_MS: FLUSH_DEBOUNCE_MS, LEGACY_KEYS: LEGACY_KEYS.slice(), STORED_KEYS: STORED_KEYS.slice(),
    capability: capability, webCryptoReady: webCryptoReady, secureContext: secureContext,
    status: status, get: get, put: put, remove: remove, keys: keys, mirrorSize: mirrorSize,
    unlocked: unlocked, activity: touch,
    unlock: unlock, createNew: createNew, lock: lock, changePassphrase: changePassphrase, wipe: wipe,
    setAutoLock: setAutoLock, checkAutoLock: checkAutoLock, onLock: onLock,
    flush: flush, absorbLegacy: absorbLegacy, legacyPlaintextPresent: legacyPlaintextPresent,
    strength: strength, b64encode: b64encode, b64decode: b64decode,
    seal: seal, open: open, setStorageHandle: setStorageHandle,
    selfTest: selfTest, selfTestAsync: selfTestAsync
  };
  global.GEOVAULT = api;
  globalThis.GEOVAULT = api;
})(globalThis);
