/**
 * swissALTI3D access: STAC tile discovery + COG reads via geotiff.js.
 *
 * Analysis rays sample the 2 m COGs (a 1 km tile is only 500×500 floats, so
 * whole tiles are read once and cached — same resolution the batch scanner
 * uses). The 0.5 m COG is used for the exit elevation, where half a metre of
 * lip position genuinely matters, via a small windowed range-read.
 *
 * All sampling is done in LV95 (EPSG:2056); heights are LN02 metres.
 */

import { lv95ToWgs84 } from "./lv95.js";

const STAC_ITEMS =
  "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items";
const NODATA_BELOW = -1000;

/** tile key from LV95 coords */
export const tileKey = (e, n) =>
  `${Math.floor(e / 1000)}-${Math.floor(n / 1000)}`;

export class Dem {
  constructor() {
    this.items = new Map(); // key -> {href05, href2}
    this.tiles2 = new Map(); // key -> Promise<{data,w,h,e0,n1,res}> (2 m grids)
    this.tiffs = new Map(); // href -> Promise<GeoTIFF>
  }

  /**
   * Discover tiles for a circle around exit (LV95, metres) and start
   * loading the 2 m grids. Returns when the item index is complete;
   * onProgress(loaded, total) fires as tile data arrives.
   */
  async prepare(exitE, exitN, radius, onProgress = () => {}) {
    const pad = 100;
    const corners = [
      lv95ToWgs84(exitE - radius - pad, exitN - radius - pad),
      lv95ToWgs84(exitE + radius + pad, exitN + radius + pad),
    ];
    const bbox = [
      Math.min(corners[0][0], corners[1][0]),
      Math.min(corners[0][1], corners[1][1]),
      Math.max(corners[0][0], corners[1][0]),
      Math.max(corners[0][1], corners[1][1]),
    ].join(",");

    let url = `${STAC_ITEMS}?bbox=${bbox}&limit=100`;
    while (url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`STAC lookup failed: ${resp.status}`);
      const page = await resp.json();
      for (const f of page.features) {
        // id: swissalti3d_<year>_<Ekm>-<Nkm>
        const mId = /_(\d+)-(\d+)$/.exec(f.id);
        if (!mId) continue;
        const key = `${mId[1]}-${mId[2]}`;
        let href05 = null;
        let href2 = null;
        for (const [name, asset] of Object.entries(f.assets ?? {})) {
          if (/_0\.5_\d+_\d+\.tif$/.test(name)) href05 = asset.href;
          else if (/_2_\d+_\d+\.tif$/.test(name)) href2 = asset.href;
        }
        if (href2) this.items.set(key, { href05, href2 });
      }
      const next = (page.links ?? []).find((l) => l.rel === "next");
      url = next ? next.href : null;
    }

    // Kick off loads for tiles actually touching the circle.
    const wanted = [];
    for (const key of this.items.keys()) {
      const [ek, nk] = key.split("-").map(Number);
      const de = Math.max(0, Math.max(ek * 1000 - exitE, exitE - (ek + 1) * 1000));
      const dn = Math.max(0, Math.max(nk * 1000 - exitN, exitN - (nk + 1) * 1000));
      if (de * de + dn * dn <= (radius + pad) ** 2) wanted.push(key);
    }
    let loaded = 0;
    onProgress(0, wanted.length);
    await Promise.all(
      wanted.map((key) =>
        this.tile2(key)
          .catch(() => null) // a missing tile becomes a NaN hole, not a failure
          .then(() => onProgress(++loaded, wanted.length))
      )
    );
    return wanted.length;
  }

  _tiff(href) {
    if (!this.tiffs.has(href)) this.tiffs.set(href, GeoTIFF.fromUrl(href));
    return this.tiffs.get(href);
  }

  /** Load (once) the full 2 m grid of one 1 km tile. */
  tile2(key) {
    if (this.tiles2.has(key)) return this.tiles2.get(key);
    const item = this.items.get(key);
    const p = (async () => {
      if (!item) return null;
      const tiff = await this._tiff(item.href2);
      const img = await tiff.getImage(0);
      const [e0, n1] = img.getOrigin(); // top-left corner in LV95
      const res = Math.abs(img.getResolution()[0]);
      const data = await img.readRasters({ interleave: true });
      return { data, w: img.getWidth(), h: img.getHeight(), e0, n1, res };
    })();
    p.then((v) => {
      if (v) p._v = v; // lets sample2() stay synchronous once loaded
    }).catch(() => {});
    this.tiles2.set(key, p);
    return p;
  }

  /**
   * Synchronous bilinear sample of the 2 m mosaic at LV95 (e, n).
   * Only valid after prepare() resolved (tiles cached). NaN outside/nodata.
   */
  sample2(e, n) {
    const p = this.tiles2.get(tileKey(e, n));
    if (!p || !p._v) return NaN;
    const t = p._v;
    const x = (e - t.e0) / t.res - 0.5;
    const y = (t.n1 - n) / t.res - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    let v = 0;
    let wsum = 0;
    for (const [dx, dy, w] of [
      [0, 0, (1 - fx) * (1 - fy)],
      [1, 0, fx * (1 - fy)],
      [0, 1, (1 - fx) * fy],
      [1, 1, fx * fy],
    ]) {
      const xi = x0 + dx;
      const yi = y0 + dy;
      if (xi < 0 || yi < 0 || xi >= t.w || yi >= t.h) continue;
      const z = t.data[yi * t.w + xi];
      if (z < NODATA_BELOW) continue;
      v += z * w;
      wsum += w;
    }
    return wsum > 0.5 ? v / wsum : NaN;
  }

  /** Wait until every started tile load has finished (or failed). */
  async settle() {
    await Promise.all([...this.tiles2.values()].map((p) => p.catch(() => null)));
  }

  /**
   * Exit elevation from the 0.5 m COG (windowed range-read), bilinear.
   * Falls back to the 2 m mosaic when the fine tile is unavailable.
   */
  async elevation05(e, n) {
    const item = this.items.get(tileKey(e, n));
    if (item?.href05) {
      try {
        const tiff = await this._tiff(item.href05);
        const img = await tiff.getImage(0);
        const [e0, n1] = [img.getOrigin()[0], img.getOrigin()[1]];
        const res = Math.abs(img.getResolution()[0]);
        const x = (e - e0) / res - 0.5;
        const y = (n1 - n) / res - 0.5;
        const x0 = Math.max(0, Math.floor(x) - 1);
        const y0 = Math.max(0, Math.floor(y) - 1);
        const win = [x0, y0, Math.min(img.getWidth(), x0 + 4), Math.min(img.getHeight(), y0 + 4)];
        const data = await img.readRasters({ window: win, interleave: true });
        const w = win[2] - win[0];
        const fx = x - Math.floor(x);
        const fy = y - Math.floor(y);
        const gx = Math.floor(x) - x0;
        const gy = Math.floor(y) - y0;
        const z00 = data[gy * w + gx];
        const z10 = data[gy * w + gx + 1];
        const z01 = data[(gy + 1) * w + gx];
        const z11 = data[(gy + 1) * w + gx + 1];
        const zs = [z00, z10, z01, z11];
        if (zs.every((z) => z > NODATA_BELOW)) {
          return (
            z00 * (1 - fx) * (1 - fy) +
            z10 * fx * (1 - fy) +
            z01 * (1 - fx) * fy +
            z11 * fx * fy
          );
        }
      } catch {
        // fall through to 2 m
      }
    }
    await this.settle();
    return this.sample2(e, n);
  }

  /**
   * Snap a clicked point to the nearby cliff lip. Cesium's rendered mesh is
   * LOD-simplified, so a click on the visual edge often lands a few metres
   * back on the plateau — where every azimuth reads as an immediate strike.
   * Scores each candidate in a small disc by its largest immediate drop
   * (probe metres out, any direction) minus a mild distance penalty, so the
   * pick moves to the lip but not to some other feature further away.
   * Call after prepare()/settle(). Returns {e, n, moved}.
   */
  snapToLip(e, n, { radius = 14, step = 1.5, probe = 7 } = {}) {
    let best = { e, n, score: -Infinity };
    for (let de = -radius; de <= radius; de += step) {
      for (let dn = -radius; dn <= radius; dn += step) {
        const r = Math.hypot(de, dn);
        if (r > radius) continue;
        const ce = e + de;
        const cn = n + dn;
        const z = this.sample2(ce, cn);
        if (!Number.isFinite(z)) continue;
        let drop = 0;
        for (let i = 0; i < 16; i++) {
          const az = (i * 2 * Math.PI) / 16;
          const zp = this.sample2(ce + Math.sin(az) * probe, cn + Math.cos(az) * probe);
          if (Number.isFinite(zp)) drop = Math.max(drop, z - zp);
        }
        const score = drop - r * 0.5;
        if (score > best.score) best = { e: ce, n: cn, score };
      }
    }
    return { e: best.e, n: best.n, moved: Math.hypot(best.e - e, best.n - n) };
  }

  /**
   * Terrain drops below exitAlt along one azimuth (radians, clockwise from
   * north). Returns [{d, tDrop}] at `step` m spacing out to maxDist.
   */
  sampleRay(exitE, exitN, exitAlt, azimuth, maxDist, step = 4) {
    const se = Math.sin(azimuth);
    const cn = Math.cos(azimuth);
    const out = [];
    for (let d = step; d <= maxDist; d += step) {
      const z = this.sample2(exitE + se * d, exitN + cn * d);
      out.push({ d, tDrop: exitAlt - z }); // NaN propagates
    }
    return out;
  }
}
