/** node --test web/js  */
import test from "node:test";
import assert from "node:assert/strict";
import { makeFrame } from "./frame.js";

const SITES = [
  ["Lauterbrunnen", 7.9965, 46.5784],
  ["equator", 0, 0],
  ["high north", 15.6, 68.4],
  ["southern/western", -72.5, -13.2],
];

test("toGeo/fromGeo are exact inverses", () => {
  for (const [name, lon, lat] of SITES) {
    const f = makeFrame(lon, lat);
    for (const [x, y] of [[0, 0], [5000, 5000], [-5000, 3000], [220, -220]]) {
      const p = f.fromGeo(...f.toGeo(x, y));
      assert.ok(
        Math.hypot(p.x - x, p.y - y) < 1e-6,
        `${name} (${x},${y}) round-trip off by ${Math.hypot(p.x - x, p.y - y)} m`
      );
    }
  }
});

/**
 * Independent check against direct geodesic integration on the ellipsoid:
 * step 1 m at a time along a meridian / parallel using the local radii of
 * curvature, which is a different computation than the frame's closed form.
 */
test("metres are metres, against stepwise geodesic integration", () => {
  const DEG = Math.PI / 180;
  const A = 6378137.0;
  const E2 = 6.69437999014e-3;
  const radii = (lat) => {
    const s = Math.sin(lat * DEG);
    const w = Math.sqrt(1 - E2 * s * s);
    return { M: (A * (1 - E2)) / (w * w * w), N: A / w };
  };

  for (const [name, lon0, lat0] of SITES) {
    const f = makeFrame(lon0, lat0);
    const D = 5000;

    // north: integrate dlat = ds / M
    let lat = lat0;
    for (let i = 0; i < D; i++) lat += 1 / radii(lat).M / DEG;
    const [, latF] = f.toGeo(0, D);
    assert.ok(
      Math.abs(latF - lat) * radii(lat0).M * DEG < 0.05,
      `${name} north 5 km off by ${Math.abs(latF - lat) * radii(lat0).M * DEG} m`
    );

    // east: a parallel is a circle of radius N·cos(lat), lat unchanged
    const { N } = radii(lat0);
    const lonExact = lon0 + D / (N * Math.cos(lat0 * DEG)) / DEG;
    const [lonF] = f.toGeo(D, 0);
    assert.ok(
      Math.abs(lonF - lonExact) * N * Math.cos(lat0 * DEG) * DEG < 0.05,
      `${name} east 5 km off by ${Math.abs(lonF - lonExact) * N * Math.cos(lat0 * DEG) * DEG} m`
    );
  }
});

test("the mid-latitude term is what keeps 5 km honest", () => {
  // A naive frame (east scaled at lat0 instead of the mid-latitude) shears
  // by metres at 5 km — this pins the magnitude the real frame avoids.
  const f = makeFrame(7.9965, 46.5784);
  const DEG = Math.PI / 180;
  const naiveLon = (x, lat0, N) => 7.9965 + x / (N * Math.cos(lat0 * DEG)) / DEG;
  const N = 6389000; // ~prime vertical at 46.6°
  const [lonGood] = f.toGeo(5000, 5000);
  const err = Math.abs(lonGood - naiveLon(5000, 46.5784, N)) * N * Math.cos(46.6 * DEG) * DEG;
  assert.ok(err > 1, `expected the naive form to be metres off, got ${err} m`);
});
