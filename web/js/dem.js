/**
 * swissALTI3D access: STAC tile discovery + COG reads via geotiff.js.
 *
 * Analysis rays sample the 2 m COGs (a 1 km tile is only 500×500 floats, so
 * whole tiles are read once and cached — same resolution the batch scanner
 * uses). The 0.5 m COG is used for the exit elevation, where half a metre of
 * lip position genuinely matters, via a small windowed range-read.
 *
 * COORDINATES. Every public method speaks the caller's local ENU frame
 * (metres east/north of the frame origin, set once via setFrame). LV95
 * (EPSG:2056) is private to this file — it is where these particular tiles
 * happen to be stored, not a fact about the app. Heights are LN02 metres.
 */

import { wgs84ToLv95 } from "./lv95.js";

const STAC_ITEMS =
  "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissalti3d/items";
const NODATA_BELOW = -1000;

/** tile key from LV95 coords */
export const tileKey = (e, n) =>
  `${Math.floor(e / 1000)}-${Math.floor(n / 1000)}`;

/**
 * Axis-aligned bounds of the local square [cx±r, cy±r] under `project`
 * (which returns a [u, v] pair). ALL FOUR corners, always: the local frame
 * is rotated relative to both lon/lat and the tile grid, so folding two
 * diagonal corners under-covers the square by ~r·sin γ — 7.7 m at r = 220
 * and γ = 2°, which is silent nodata at the corners, not an obvious break.
 */
function cornerBounds(cx, cy, r, project) {
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    const [u, v] = project(cx + dx, cy + dy);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  return { u0, u1, v0, v1 };
}

export class Dem {
  constructor() {
    this.items = new Map(); // key -> {href05, href2}
    this.tiles2 = new Map(); // key -> Promise<{data,w,h,e0,n1,res}> (2 m grids)
    this.tiffs = new Map(); // href -> Promise<GeoTIFF>
    this.near = null; // composite 0.5 m grid around the current exit
    this.frame = null;
    this.aff = null; // local -> LV95, calibrated per frame
  }

  /**
   * Anchor sampling to a local ENU frame.
   *
   * Calibrates an affine local→LV95 map from ±2 km baselines about the
   * origin, so sampling costs four transforms per exit instead of a
   * polynomial evaluation per sample. The 2×2 comes out as exactly
   * rotation-by-−γ (meridian convergence) times 1/k, which is why nothing
   * outside this file has to know γ exists.
   *
   * The baselines are CENTRAL differences on purpose. A parallel is not a
   * straight line in a conformal projection — it curves at tan(φ)/2N ≈
   * 8e-8 m⁻¹ — and a one-sided fit straddles that quadratic lopsidedly,
   * costing 40 mm at 220 m and up to 2.9 m asymmetrically at 5 km.
   * Centred, the affine reproduces the frame to first order and what is
   * left is the frame's own curvature: 4 mm at the 220 m near-field radius,
   * 2.1 m at the 5 km far-field limit (0.02° of azimuth — see frame.js).
   */
  setFrame(frame) {
    const B = 2000;
    const at = (x, y) => wgs84ToLv95(...frame.toGeo(x, y));
    const o = at(0, 0);
    const xp = at(B, 0);
    const xm = at(-B, 0);
    const yp = at(0, B);
    const ym = at(0, -B);
    this.frame = frame;
    this.aff = {
      e0: o.e,
      n0: o.n,
      dedx: (xp.e - xm.e) / (2 * B),
      dndx: (xp.n - xm.n) / (2 * B),
      dedy: (yp.e - ym.e) / (2 * B),
      dndy: (yp.n - ym.n) / (2 * B),
    };
    this.near = null; // the fine grid is frame-relative
  }

  /** local metres -> LV95 {e, n} */
  toLv95(x, y) {
    const a = this.aff;
    return {
      e: a.e0 + x * a.dedx + y * a.dedy,
      n: a.n0 + x * a.dndx + y * a.dndy,
    };
  }

  /**
   * Discover tiles for a circle around local (cx, cy) and start loading the
   * 2 m grids. Returns when the item index is complete; onProgress(loaded,
   * total) fires as tile data arrives.
   */
  async prepare(cx, cy, radius, onProgress = () => {}) {
    const pad = 100;
    const r = radius + pad;
    const b = cornerBounds(cx, cy, r, (x, y) => this.frame.toGeo(x, y));
    const bbox = [b.u0, b.v0, b.u1, b.v1].join(",");

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
    const c = this.toLv95(cx, cy);
    const wanted = [];
    for (const key of this.items.keys()) {
      const [ek, nk] = key.split("-").map(Number);
      const de = Math.max(0, Math.max(ek * 1000 - c.e, c.e - (ek + 1) * 1000));
      const dn = Math.max(0, Math.max(nk * 1000 - c.n, c.n - (nk + 1) * 1000));
      if (de * de + dn * dn <= r ** 2) wanted.push(key);
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
   * Synchronous bilinear sample of the 2 m mosaic at local (x, y).
   * Only valid after prepare() resolved (tiles cached). NaN outside/nodata.
   */
  sample(x, y) {
    // Inlined rather than via toLv95: this runs ~90k times per recompute.
    const a = this.aff;
    return this.sample2(
      a.e0 + x * a.dedx + y * a.dedy,
      a.n0 + x * a.dndx + y * a.dndy
    );
  }

  /** Bilinear sample of the 2 m mosaic at LV95 (e, n) — internal. */
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
   * Exit elevation at local (x, y) from the 0.5 m COG (windowed range-read),
   * bilinear. Falls back to the 2 m mosaic when the fine tile is unavailable.
   */
  async elevationFine(x, y) {
    const { e, n } = this.toLv95(x, y);
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
    return this.sample(x, y);
  }

  /**
   * Snap a clicked point to the nearby cliff lip. Cesium's rendered mesh is
   * LOD-simplified, so a click on the visual edge often lands a few metres
   * back on the plateau — where every azimuth reads as an immediate strike.
   * Scores each candidate in a small disc using the 0.5 m grid (when
   * loaded; 2 m fallback). Three terms keep the pick ON the lip instead of
   * down the face:
   *  - immediate drop (probe metres out, any direction), CAPPED — once a
   *    candidate has a real edge, more drop must not pull it further down
   *    the face, where the drop to the base only keeps growing;
   *  - a rise penalty: terrain climbing above the candidate nearby means
   *    it is standing under the wall, not on top of it;
   *  - a mild distance penalty toward the original point.
   * When `targetAlt` is given (e.g. the GPS altitude of a recorded exit),
   * candidates whose ground elevation disagrees with it are penalized —
   * this rescues points whose horizontal GPS error puts them onto the face
   * below the real exit. That altitude is uncertain on two counts: GNSS
   * vertical error, routinely 5-10 m and the dominant term, and a datum gap
   * (the receiver reports MSL through its own coarse geoid model, `z` is
   * LN02) worth a metre or two here and far more once the DEM is not Swiss.
   * ALT_TOL is that combined uncertainty. Inside it the penalty is soft
   * rather than zero: a hard dead zone would stop discriminating entirely,
   * letting a bench a few metres below the exit outrank the true lip on the
   * distance term alone. Outside it the full weight resumes. ALT_TOL must
   * track the vertical uncertainty of whatever DEM source is in use rather
   * than stay pinned to swissALTI3D — and it is a heuristic weight, worth
   * recalibrating against real tracks rather than trusting as tuned.
   * Call after prepare()/settle() (and ideally loadNearField()).
   * Takes and returns local metres: {x, y, moved}.
   */
  snapToLip(x, y, { radius = 14, step = 0.75, probe = 3.5, targetAlt = null } = {}) {
    const DROP_CAP = 60;
    const ALT_TOL = 8; // m of GNSS + datum slack before the full weight bites
    const ALT_SOFT = 0.15; // per m inside ALT_TOL: keeps ties breaking
    const ALT_HARD = 0.6; // per m beyond it
    let best = { x, y, score: -Infinity };
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dy = -radius; dy <= radius; dy += step) {
        const r = Math.hypot(dx, dy);
        if (r > radius) continue;
        const cx = x + dx;
        const cy = y + dy;
        const z = this.nearSample(cx, cy);
        if (!Number.isFinite(z)) continue;
        let drop = 0;
        let rise = 0;
        for (let i = 0; i < 16; i++) {
          const az = (i * 2 * Math.PI) / 16;
          const zp = this.nearSample(cx + Math.sin(az) * probe, cy + Math.cos(az) * probe);
          if (!Number.isFinite(zp)) continue;
          drop = Math.max(drop, z - zp);
          rise = Math.max(rise, zp - z);
        }
        let score =
          Math.min(drop, DROP_CAP) - 2 * Math.max(0, rise - 2) - 0.7 * r;
        if (targetAlt !== null) {
          const dz = Math.abs(z - targetAlt);
          score -= ALT_SOFT * dz + ALT_HARD * Math.max(0, dz - ALT_TOL);
        }
        if (score > best.score) best = { x: cx, y: cy, score };
      }
    }
    return { x: best.x, y: best.y, moved: Math.hypot(best.x - x, best.y - y) };
  }

  /**
   * Load a composite 0.5 m grid covering ±radius metres around local
   * (cx, cy), aligned to the local ENU frame. Powers the near-field
   * clearance analysis; call after prepare().
   */
  async loadNearField(cx, cy, radius = 170) {
    const res = 0.5;

    // Pass 1: composite the tiles in their OWN grid, over the bounding box
    // of the (rotated) local square. Compositing here rather than sampling
    // straight into the local grid is what keeps 1 km tile joins seamless —
    // interpolating across a join needs neighbours from two different tile
    // arrays, and would punch a half-metre gutter down every seam.
    // PAD is bilinear reach plus rounding slack — the rotation itself needs
    // none, because cornerBounds already contains the rotated square exactly.
    const PAD = 4;
    const b = cornerBounds(cx, cy, radius, (x, y) => {
      const p = this.toLv95(x, y);
      return [p.e, p.n];
    });
    // Snap the composite to the tiles' OWN lattice: their origins are exact
    // kilometres, hence exact multiples of res, so flooring here makes pass 1
    // an exact integer copy. Left unsnapped, round() displaces the whole
    // composite by up to res/2 per axis from the lattice pass 2 assumes —
    // uniform, invisible, and on a 70° face decimetres of height error right
    // at the lip, where this grid exists to be trusted.
    const e0 = Math.floor((b.u0 - PAD) / res) * res;
    const n1 = Math.ceil((b.v1 + PAD) / res) * res;
    const e1 = b.u1 + PAD;
    const n0 = b.v0 - PAD;
    const sw = Math.ceil((e1 - e0) / res);
    const sh = Math.ceil((n1 - n0) / res);
    const src = new Float32Array(sw * sh).fill(NaN);

    const jobs = [];
    for (let ek = Math.floor(e0 / 1000); ek <= Math.floor(e1 / 1000); ek++) {
      for (let nk = Math.floor(n0 / 1000); nk <= Math.floor(n1 / 1000); nk++) {
        const item = this.items.get(`${ek}-${nk}`);
        if (item?.href05) jobs.push(item.href05);
      }
    }
    await Promise.all(
      jobs.map(async (href) => {
        try {
          const tiff = await this._tiff(href);
          const img = await tiff.getImage(0);
          const [te0, tn1] = img.getOrigin();
          const tres = Math.abs(img.getResolution()[0]);
          // overlap of the composite with this tile, in tile pixels
          const x0 = Math.max(0, Math.floor((e0 - te0) / tres));
          const y0 = Math.max(0, Math.floor((tn1 - n1) / tres));
          const x1 = Math.min(img.getWidth(), Math.ceil((e1 - te0) / tres));
          const y1 = Math.min(img.getHeight(), Math.ceil((tn1 - n0) / tres));
          if (x1 <= x0 || y1 <= y0) return;
          const win = await img.readRasters({ window: [x0, y0, x1, y1], interleave: true });
          const ww = x1 - x0;
          for (let y = y0; y < y1; y++) {
            const gy = Math.round((tn1 - y * tres - n1) / -res);
            if (gy < 0 || gy >= sh) continue;
            for (let x = x0; x < x1; x++) {
              const gx = Math.round((te0 + x * tres - e0) / res);
              if (gx < 0 || gx >= sw) continue;
              const v = win[(y - y0) * ww + (x - x0)];
              if (v > NODATA_BELOW) src[gy * sw + gx] = v;
            }
          }
        } catch {
          // missing fine tile: stays NaN, near-field falls back to no-data
        }
      })
    );

    // Pass 2: resample into the local grid (rotated by the convergence
    // between the tile grid's north and true north — up to ~2° in CH).
    //
    // TWO outputs, because the two consumers want opposite things. `data` is
    // the bilinear blend, which is what nearSample/snapToLip want. `env` is
    // the max over the same source posts, which is what nearMax needs: the
    // near-field check is built on an UPPER envelope of the rock, and a blend
    // is a convex combination, so it always sits at or below the highest post
    // it came from. Feeding blends to nearMax would quietly shave metres off
    // a lip and report the missing rock as air — an error that only ever
    // points toward "looks safer than it is".
    const size = Math.ceil((2 * radius) / res);
    const data = new Float32Array(size * size).fill(NaN);
    const env = new Float32Array(size * size).fill(NaN);
    const xMin = cx - radius;
    const yMax = cy + radius;
    const a = this.aff;
    for (let gy = 0; gy < size; gy++) {
      const ly = yMax - (gy + 0.5) * res;
      for (let gx = 0; gx < size; gx++) {
        const lx = xMin + (gx + 0.5) * res;
        const sx = (a.e0 + lx * a.dedx + ly * a.dedy - e0) / res - 0.5;
        const sy = (n1 - (a.n0 + lx * a.dndx + ly * a.dndy)) / res - 0.5;
        const xi = Math.floor(sx);
        const yi = Math.floor(sy);
        if (xi < 0 || yi < 0 || xi + 1 >= sw || yi + 1 >= sh) continue;
        const fx = sx - xi;
        const fy = sy - yi;
        const z00 = src[yi * sw + xi];
        const z10 = src[yi * sw + xi + 1];
        const z01 = src[(yi + 1) * sw + xi];
        const z11 = src[(yi + 1) * sw + xi + 1];
        // Weighted over the valid corners only, so a nodata hole erodes
        // rather than spreading a cell in every direction.
        let v = 0;
        let wsum = 0;
        let mx = -Infinity;
        if (z00 === z00) { const w = (1 - fx) * (1 - fy); v += z00 * w; wsum += w; if (z00 > mx) mx = z00; }
        if (z10 === z10) { const w = fx * (1 - fy); v += z10 * w; wsum += w; if (z10 > mx) mx = z10; }
        if (z01 === z01) { const w = (1 - fx) * fy; v += z01 * w; wsum += w; if (z01 > mx) mx = z01; }
        if (z11 === z11) { const w = fx * fy; v += z11 * w; wsum += w; if (z11 > mx) mx = z11; }
        if (wsum > 0.5) data[gy * size + gx] = v / wsum;
        if (mx > -Infinity) env[gy * size + gx] = mx;
      }
    }

    this.near = { data, env, size, xMin, yMax, res };
    return this.near;
  }

  /**
   * Bilinear sample of the 0.5 m near-field grid at local (X, Y); falls back
   * to the 2 m mosaic when the fine grid isn't loaded or has no data here.
   */
  nearSample(X, Y) {
    const g = this.near;
    if (g) {
      const x = (X - g.xMin) / g.res - 0.5;
      const y = (g.yMax - Y) / g.res - 0.5;
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      if (xi >= 0 && yi >= 0 && xi + 1 < g.size && yi + 1 < g.size) {
        const fx = x - xi;
        const fy = y - yi;
        const z00 = g.data[yi * g.size + xi];
        const z10 = g.data[yi * g.size + xi + 1];
        const z01 = g.data[(yi + 1) * g.size + xi];
        const z11 = g.data[(yi + 1) * g.size + xi + 1];
        const v =
          z00 * (1 - fx) * (1 - fy) +
          z10 * fx * (1 - fy) +
          z01 * (1 - fx) * fy +
          z11 * fx * fy;
        if (Number.isFinite(v)) return v;
      }
    }
    return this.sample(X, Y);
  }

  /**
   * Upper envelope at local (X, Y): max of the 4 envelope cells around it,
   * each of which is itself the max of the source posts it was built from
   * (see loadNearField). Never a blended value — the near-field verdict
   * depends on this erring high.
   */
  nearMax(X, Y) {
    const g = this.near;
    if (!g) return NaN;
    const x = (X - g.xMin) / g.res - 0.5;
    const y = (g.yMax - Y) / g.res - 0.5;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let mx = -Infinity;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const xx = xi + dx;
      const yy = yi + dy;
      if (xx < 0 || yy < 0 || xx >= g.size || yy >= g.size) continue;
      const v = g.env[yy * g.size + xx];
      if (Number.isFinite(v) && v > mx) mx = v;
    }
    return mx === -Infinity ? NaN : mx;
  }

  /**
   * Near-field terrain profile along one azimuth: envelope over a lateral
   * swath (the terrain dilated by DEM + exit-position uncertainty).
   * Returns [{d, tDrop}] at `step` spacing; tDrop uses the HIGHEST ground
   * found across offsets — conservative by construction.
   */
  nearRay(x, y, exitAlt, azimuth, maxDist = 150, step = 0.5, lateral = [-2.5, 0, 2.5]) {
    const se = Math.sin(azimuth);
    const cn = Math.cos(azimuth);
    const out = [];
    for (let d = step; d <= maxDist; d += step) {
      // The swath widens with distance (an uncertainty cone): right off the
      // lip your lateral position is exact — full-width offsets there would
      // sample the very ridge the exit sits on.
      const grow = Math.min(1, d / 25);
      let hi = -Infinity;
      for (const off0 of lateral) {
        const off = off0 * grow;
        const z = this.nearMax(x + se * d + cn * off, y + cn * d - se * off);
        if (Number.isFinite(z) && z > hi) hi = z;
      }
      out.push({ d, tDrop: hi === -Infinity ? NaN : exitAlt - hi });
    }
    return out;
  }

  /**
   * Terrain drops below exitAlt along one azimuth (radians, clockwise from
   * true north). Returns [{d, tDrop}] at `step` m spacing out to maxDist.
   */
  sampleRay(x, y, exitAlt, azimuth, maxDist, step = 4) {
    const se = Math.sin(azimuth);
    const cn = Math.cos(azimuth);
    const out = [];
    for (let d = step; d <= maxDist; d += step) {
      const z = this.sample(x + se * d, y + cn * d);
      out.push({ d, tDrop: exitAlt - z }); // NaN propagates
    }
    return out;
  }
}
