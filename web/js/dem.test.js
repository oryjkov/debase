/** node --test 'web/js/*.test.js'  — no network: setFrame is pure math. */
import test from "node:test";
import assert from "node:assert/strict";
import { Dem } from "./dem.js";
import { makeFrame } from "./frame.js";
import { wgs84ToLv95 } from "./lv95.js";

const SITES = [
  ["Geneva", 6.15, 46.2],
  ["Lauterbrunnen", 7.9965, 46.5784],
  ["St. Moritz", 9.84, 46.5],
];

/** Worst gap between the calibrated affine and the exact projection, on a ring. */
function worstOnRing(dem, frame, r) {
  let worst = 0;
  for (let i = 0; i < 72; i++) {
    const th = (i * Math.PI) / 36;
    const x = Math.sin(th) * r;
    const y = Math.cos(th) * r;
    const exact = wgs84ToLv95(...frame.toGeo(x, y));
    const got = dem.toLv95(x, y);
    worst = Math.max(worst, Math.hypot(got.e - exact.e, got.n - exact.n));
  }
  return worst;
}

test("the local→LV95 affine tracks the exact projection", () => {
  for (const [name, lon, lat] of SITES) {
    const frame = makeFrame(lon, lat);
    const dem = new Dem();
    dem.setFrame(frame);

    // 220 m: the near-field radius, sampled on a 0.5 m grid — must be well
    // inside a cell. 5000 m: the far-field limit on a 2 m grid.
    const near = worstOnRing(dem, frame, 220);
    const far = worstOnRing(dem, frame, 5000);
    assert.ok(near < 0.02, `${name} near-field affine error ${near} m`);
    assert.ok(far < 2.5, `${name} far-field affine error ${far} m`);
  }
});

test("the affine is a rotation by the meridian convergence, times 1/k", () => {
  // Grid north drifts from true north by ~−1° at Geneva to ~+1.75° in the
  // Engadin; that rotation is the whole reason analysis and rendering used
  // to disagree, and it must show up in the affine rather than anywhere else.
  const expect = { Geneva: -0.94, Lauterbrunnen: 0.41, "St. Moritz": 1.75 };
  for (const [name, lon, lat] of SITES) {
    const dem = new Dem();
    dem.setFrame(makeFrame(lon, lat));
    const { dedy, dndy } = dem.aff;
    const gamma = (-Math.atan2(dedy, dndy) * 180) / Math.PI;
    assert.ok(
      Math.abs(gamma - expect[name]) < 0.02,
      `${name} convergence ${gamma}°, expected ~${expect[name]}°`
    );
    // Scale: a local metre is a projected metre to within 1 mm.
    assert.ok(Math.abs(Math.hypot(dedy, dndy) - 1) < 1e-3);
  }
});

/**
 * A Dem backed by a synthetic 0.5 m tile holding a vertical wall: every post
 * is exactly WALL_TOP or WALL_FOOT, nothing in between. That is the whole
 * trick — any value strictly between the two can only have come from
 * interpolation, so "is this an envelope or a blend?" becomes decidable
 * rather than a judgement call about metres.
 */
const WALL_TOP = 2600;
const WALL_FOOT = 2400;
const RES = 0.5;

function walledDem(lon, lat) {
  const dem = new Dem();
  dem.setFrame(makeFrame(lon, lat));
  const o = dem.toLv95(0, 0);
  const stepE = o.e; // wall runs north-south through the frame origin
  const ek0 = Math.floor(o.e / 1000);
  const nk0 = Math.floor(o.n / 1000);
  for (let ek = ek0 - 1; ek <= ek0 + 1; ek++) {
    for (let nk = nk0 - 1; nk <= nk0 + 1; nk++) {
      dem.items.set(`${ek}-${nk}`, { href05: `${ek}-${nk}`, href2: null });
    }
  }
  dem._tiff = (href) => {
    const [ek, nk] = href.split("-").map(Number);
    const te0 = ek * 1000;
    const tn1 = (nk + 1) * 1000;
    const img = {
      getOrigin: () => [te0, tn1],
      getResolution: () => [RES, -RES],
      getWidth: () => 2000,
      getHeight: () => 2000,
      readRasters: ({ window: [x0, y0, x1, y1] }) => {
        const w = x1 - x0;
        const out = new Float32Array(w * (y1 - y0));
        for (let y = 0; y < y1 - y0; y++) {
          for (let x = 0; x < w; x++) {
            const e = te0 + (x0 + x + 0.5) * RES; // pixel centre
            out[y * w + x] = e < stepE ? WALL_TOP : WALL_FOOT;
          }
        }
        return out;
      },
    };
    return Promise.resolve({ getImage: () => Promise.resolve(img) });
  };
  return dem;
}

test("nearMax is an upper envelope of raw posts, never a blend of them", async () => {
  const dem = walledDem(7.9965115, 46.5784336);
  await dem.loadNearField(0, 0, 20);
  const g = dem.near;

  // Max over the BLENDED array — what nearMax read before the envelope was
  // split out, and what a future refactor might collapse back to.
  const maxOverBlend = (X, Y) => {
    const x = (X - g.xMin) / g.res - 0.5;
    const y = (g.yMax - Y) / g.res - 0.5;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let mx = -Infinity;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const xx = xi + dx;
      const yy = yi + dy;
      if (xx < 0 || yy < 0 || xx >= g.size || yy >= g.size) continue;
      const v = g.data[yy * g.size + xx];
      if (Number.isFinite(v) && v > mx) mx = v;
    }
    return mx === -Infinity ? NaN : mx;
  };

  let sawTop = 0;
  let sawFoot = 0;
  let blendedWorst = 0;
  for (let x = -12; x <= 12; x += 0.25) {
    for (let y = -12; y <= 12; y += 0.25) {
      const v = dem.nearMax(x, y);
      if (!Number.isFinite(v)) continue;
      assert.ok(
        v === WALL_TOP || v === WALL_FOOT,
        `nearMax(${x}, ${y}) = ${v}: an interpolated value, so the envelope is a blend`
      );
      if (v === WALL_TOP) sawTop++;
      else sawFoot++;
      const b = maxOverBlend(x, y);
      if (Number.isFinite(b)) blendedWorst = Math.max(blendedWorst, v - b);
    }
  }

  // The wall has to actually be in frame, or the assertion above is vacuous.
  assert.ok(sawTop > 100 && sawFoot > 100, `probes: ${sawTop} top / ${sawFoot} foot`);
  // And the blend has to actually differ here, or the test cannot fail.
  assert.ok(
    blendedWorst > 20,
    `blending only cost ${blendedWorst} m — test no longer exercises the regression`
  );
});

test("the near-field envelope never sits below the blend it accompanies", async () => {
  const dem = walledDem(7.9965115, 46.5784336);
  await dem.loadNearField(0, 0, 20);
  const { data, env } = dem.near;
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i]) || !Number.isFinite(env[i])) continue;
    assert.ok(env[i] >= data[i] - 1e-9, `cell ${i}: env ${env[i]} < data ${data[i]}`);
  }
});

test("setFrame drops a near-field grid built for the old frame", () => {
  const dem = new Dem();
  dem.setFrame(makeFrame(7.9965, 46.5784));
  dem.near = { size: 1 };
  dem.setFrame(makeFrame(9.84, 46.5));
  assert.equal(dem.near, null);
});
