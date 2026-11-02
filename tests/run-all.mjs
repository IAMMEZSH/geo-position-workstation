/*
 * tests/run-all.mjs — 在 Node 里按浏览器方式加载各内核并跑全部自检闸门。
 * 内核文件是不含 import/export 的 IIFE（挂到 globalThis），所以这里用 vm 建一个沙箱执行，
 * 与浏览器 <script> 的加载语义一致；沙箱里不放 DOM，因此只覆盖内核，不覆盖界面。
 * 沙箱里给 crypto（WebCrypto）：GEOVAULT 的异步闸门要真跑 PBKDF2 + AES-GCM，
 * 不给 localStorage：加密内核必须能在「没有持久层」的环境里如实报告能力，而不是假装写成功。
 *
 *   node tests/run-all.mjs              只跑内核闸门
 *   node tests/run-all.mjs --with-server  再跑一次 server.py --selftest（需要本机有 python）
 *   node tests/run-all.mjs --with-bridge  再跑一次 bridge-powershell.ps1 -SelfTest（仅 Windows）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP = path.join(ROOT, 'app');

const DATA = ['data/data-countries.js', 'data/data-cities.js', 'data/data-land.js'];
const CORE = ['core-geodetic.js', 'core-datums.js', 'core-cell.js', 'core-gnss.js', 'core-astro.js', 'core-net.js', 'core-vault.js'];
const ENGINES = [
  ['GEOVAULT', 'core-vault.js'],
  ['GEOGEO', 'core-geodetic.js'],
  ['GEODATUM', 'core-datums.js'],
  ['GEOCELL', 'core-cell.js'],
  ['GEOGNSS', 'core-gnss.js'],
  ['GEOASTRO', 'core-astro.js'],
  ['GEONET', 'core-net.js'],
];

function load(file) {
  const p = path.join(APP, file);
  if (!fs.existsSync(p)) throw new Error('缺少文件：' + p);
  return fs.readFileSync(p, 'utf8');
}

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: typeof fetch === 'function' ? fetch : undefined,
  URL, TextEncoder, TextDecoder,
  // WebCrypto：GEOVAULT 的异步闸门要在沙箱里真的派生密钥、真的加解密。
  crypto: typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : undefined,
};
const ctx = vm.createContext(sandbox);
for (const f of DATA.concat(CORE)) vm.runInContext(load(f), ctx, { filename: f });

let total = 0;
let failed = 0;
const rows = [];

for (const [name] of ENGINES) {
  if (typeof ctx[name] !== 'object' || typeof ctx[name].selfTest !== 'function') {
    console.error('FAIL  内核 ' + name + ' 未导出 selfTest()');
    process.exit(2);
  }
  const gates = ctx[name].selfTest();
  const bad = gates.filter((g) => !g.pass);
  total += gates.length;
  failed += bad.length;
  rows.push([name, gates.length, bad.length]);
  bad.slice(0, 5).forEach((g) => console.error('  FAIL ' + name + ' · ' + g.name + ' · ' + (g.detail || '')));
}

const asyncGates = await ctx.GEONET.selfTestAsync();
const asyncBad = asyncGates.filter((g) => !g.pass);
total += asyncGates.length;
failed += asyncBad.length;
rows.push(['GEONET async', asyncGates.length, asyncBad.length]);
asyncBad.slice(0, 5).forEach((g) => console.error('  FAIL GEONET async · ' + g.name + ' · ' + (g.detail || '')));

// 加密内核的异步闸门是真的 PBKDF2（25 万次）+ AES-256-GCM 往返，不是读注释；
// 沙箱里必须拿得到 WebCrypto，拿不到就让它红，不许静默「跳过即通过」。
if (typeof ctx.GEOVAULT.selfTestAsync !== 'function') {
  console.error('FAIL  GEOVAULT 未导出 selfTestAsync()');
  process.exit(2);
}
if (!ctx.GEOVAULT.webCryptoReady()) {
  console.error('FAIL  Node 沙箱里没有 WebCrypto（crypto.subtle），GEOVAULT 的加密闸门无法验证');
  process.exit(2);
}
const vaultGates = await ctx.GEOVAULT.selfTestAsync();
const vaultBad = vaultGates.filter((g) => !g.pass);
total += vaultGates.length;
failed += vaultBad.length;
rows.push(['GEOVAULT crypto', vaultGates.length, vaultBad.length]);
vaultBad.slice(0, 8).forEach((g) => console.error('  FAIL GEOVAULT crypto · ' + g.name + ' · ' + (g.detail || '')));

const width = Math.max(...rows.map((r) => r[0].length));
console.log('\n经纬度定位工作站 · 内核闸门（Node 沙箱，与浏览器同一份文件）\n');
for (const [name, n, f] of rows) {
  console.log('  ' + name.padEnd(width) + '  ' + String(n).padStart(4) + ' 门  失败 ' + f + (f ? '' : '  ✓'));
}
console.log('\n  合计 ' + total + ' 门 / ' + failed + ' 失败\n');

let serverFailed = false;
if (process.argv.includes('--with-server')) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(py, [path.join(ROOT, 'server.py'), '--selftest'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\s*项[^0-9]*(\d+)\s*失败/) || out.match(/(\d+)\s*\/\s*(\d+)/);
  console.log('server.py --selftest 退出码 ' + r.status + (m ? '（' + m[0] + '）' : ''));
  console.log(out.split('\n').slice(-12).join('\n'));
  serverFailed = r.status !== 0;
}

let bridgeFailed = false;
if (process.argv.includes('--with-bridge')) {
  // PowerShell 那份桥是「不装 Python 也能用」的那条路，只有 Windows 自带它；
  // 非 Windows 上这一步是明确的跳过，不是悄悄通过——不然 CI 的 ubuntu 作业会让人以为测过了。
  if (process.platform !== 'win32') {
    console.log('bridge-powershell.ps1 -SelfTest：跳过（当前平台 ' + process.platform + '，这份桥只在 Windows 上跑）');
  } else {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'bridge-powershell.ps1'), '-SelfTest',
    ], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/(\d+)\s*项[^0-9]*(\d+)\s*失败/);
    console.log('bridge-powershell.ps1 -SelfTest 退出码 ' + r.status + (m ? '（' + m[0] + '）' : ''));
    console.log(out.split('\n').slice(-8).join('\n'));
    bridgeFailed = r.status !== 0;
  }
}

if (failed || serverFailed || bridgeFailed) {
  console.error('结论：有闸门未通过。');
  process.exit(1);
}
console.log('结论：全部闸门 0 失败。');
