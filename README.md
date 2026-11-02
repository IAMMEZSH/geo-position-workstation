<p align="center">
  <b>Geo Position Workstation</b> · <code>经纬度定位工作站</code><br>
  <sub>An offline-first positioning and surveying workstation: double-click <code>index.html</code> and it runs.
  Seven in-house kernels, 623 self-test gates, zero runtime dependencies, zero telemetry.</sub>
</p>

<p align="center">
  <a href="https://github.com/IAMMEZSH/geo-position-workstation/actions/workflows/ci.yml"><img alt="gates CI" src="https://github.com/IAMMEZSH/geo-position-workstation/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green.svg">
  <img alt="no dependencies" src="https://img.shields.io/badge/runtime%20dependencies-0-blue.svg">
  <img alt="offline first" src="https://img.shields.io/badge/default-offline%20first-orange.svg">
  <img alt="gates" src="https://img.shields.io/badge/self--test%20gates-623%20%2F%200%20failures-brightgreen.svg">
  <img alt="no python needed" src="https://img.shields.io/badge/works%20without%20Python-PowerShell%20bridge-blueviolet.svg">
  <img alt="encrypted storage" src="https://img.shields.io/badge/local%20storage-AES--256--GCM%20vault-yellow.svg">
  <img alt="platforms" src="https://img.shields.io/badge/platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux%20%C2%B7%20Android%20%C2%B7%20iOS-lightgrey.svg">
</p>

---

**This page is only an index.** Every explanation, every measured number, every implementation
convention and every pitfall lives in [**MANUAL.md**](MANUAL.md) — one document, written once, not
split across pages and never repeated in two places. This page answers only "what is it / how do I
open it / which section do I read / where are the pictures".

The interface itself is Chinese; MANUAL §3.0 maps each on-screen label to the panel it belongs to.

## What this is

Eleven panels on one desk: coordinates and formats, datums, cell-station positioning, triangulation,
signal ranging, GNSS, celestial, networking and IP/route tracing, batch export, history and
favourites, kernel self-test. Everything computes in local JavaScript by default, with the city and
land datasets shipped inside the package. Only panel ⑧ may touch the network, and only after you
allow it in that panel. History, favourites, preferences and probes leave RAM for disk only as one
passphrase-locked AES-256-GCM envelope. When a kernel cannot solve something it returns `null` and
the page says so with the missing observation named — no interpolation, no borrowed source, no
city-centre substituted for your position.

Hosted URL (GitHub Pages serves the repository root as a static site, byte-for-byte the same files
you download): **<https://iammezsh.github.io/geo-position-workstation/>**

## How to open it

- **Install nothing** → use the hosted URL above. All seven kernels, the map, the offline data and
  ⑪ run there; only ⑧'s hop-by-hop trace needs a bridge on your own machine.
- **Windows, full ⑧** → double-click `启动-Windows.bat`. It tries Python bridge → PowerShell bridge
  → the bare page, in that order, so **a machine with no Python still gets all eleven panels** using
  the PowerShell that ships with Windows.
- **macOS / Linux / Android / iPhone / iPad** → per-platform wording, the three-level fallback, the
  iSH path, changing the port, and exactly what you lose with no bridge: **MANUAL §2** (§2.7 macOS and
  Linux, §2.8 iPhone/iPad, §2.9 no bridge, §2.10 the five launcher faces and their colour rules).

Open it and go to panel ⑪ (`⑪ 内核自检`), press **`运行全部自检`** (*run the full self-test*):
expect **623 gates / 0 failures** before using anything else.

![Offline vector land with the centre crosshair, city annotations and the readout bar (no tile request is sent)](images/02-crosshair-readout.png)

## Which section answers what

| What you are looking for | In MANUAL.md |
|---|---|
| One-minute start, download and unzip, what to click first | §0 |
| Every file in the package, one line each, and the per-platform packs | §1 (§1.1 packs) |
| Launching per platform; why `server.py` and `bridge-powershell.ps1` are one contract | §2 (2.3 bridges · 2.5 hosted page → local bridge · 2.6 per-request origin guard · 2.7 macOS · 2.8 iOS) |
| Each of the eleven panels: what it eats, what it gives, the numbers measured on the machine | §3 (3.0 label map) |
| Why the ten files under `示例数据/` cross-check against each other | §4 |
| Decimal places, GCJ-02 irreversibility, the conservative accuracy of IP lookup, astronomical time scales | §5 + `docs/img/decision-flow.svg` |
| Layering, how a kernel is written, map layer, network layer, the UI escaping model, the vault layer, the stylesheet, the five mechanism figures, adding a panel | §6 (6.8 vault, 6.10 figures) |
| What may leave the machine, the red lines enforced in code, who may talk to the bridge, where your data physically is | §7 (7.3 origin allowlist · 7.5 storage) |
| How "all green" is re-checked — six independent gate layers (623 / 623 / 110 (+1) / 202 / 41 / 67) and what a single gate looks like | §8 (§8.8 CI, ubuntu and windows jobs) |
| Platform matrix, three things refused by design, panel-by-panel runs, hosted page, clone and ZIP verification | §9 |
| Offline data: sources, SHA-256, trimming constants, how to rebuild it byte-identically | §10 |
| Pitfalls actually hit — the class the kernels cannot see | §11 |
| Questions | §12 |
| Third-party data, licences, attribution obligations | §13 |

## The commands that re-verify this

Zero dependencies: no `npm install`, no `pip install`. `package.json` is only script entries and
metadata.

```bash
node tests/run-all.mjs --with-server --with-bridge   # kernels 623 + Python bridge 110 (+1) + PowerShell bridge 202
python tests/bridge-parity.py                        # two bridges at once, 41 live cases
python tests/check-package.py                        # package inspection, 70 items
```

The sixth layer is panel ⑪ itself, in a real DOM with Leaflet mounted: **623 gates / 0 failures**.
The browser and Node now report the *same* number because the 71 asynchronous gates (network
promises and the PBKDF2/AES round trips) run in both; §8.1 shows the arithmetic per kernel. CI runs
the three commands above on Ubuntu and on Windows for every push (§8.8).

## Pictures

The 15 screenshots are not decoration: each is embedded in MANUAL.md next to the paragraph it
proves, so the number in the text and the number in the image are read together. The files live in
[`images/`](images/), and the five mechanism diagrams — `architecture.svg`, `decision-flow.svg`,
`privacy-boundary.svg`, `apple-launch-paths.svg`, `platform-packs.svg` — in
[`docs/img/`](docs/img/).

## Licence and attribution

MIT (see [LICENSE](LICENSE)). Third-party material is not covered by that grant: GeoNames
`cities15000` (CC BY 4.0, **attribution must be kept when you redistribute**), Natural Earth
`ne_50m_land` (public domain), Leaflet 1.9.4 (BSD-2-Clause), qrcode.js (MIT, Kazuhiko Arase). The
full table, and when © OpenStreetMap contributors (ODbL) applies to the optional online basemap, is
in MANUAL §13.
