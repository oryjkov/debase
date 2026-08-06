/**
 * Wingsuit flight model: point-mass aerodynamics.
 *
 *   accel = gravity + drag(−kd·V·v) + lift(kl·V·v⊥)
 *
 * validated against FlySight Doppler velocities — per-sample coefficient
 * estimates are near-constant through hands-off flight, and the integrated
 * trajectory matches a real jump within ~5 m over the first 400 m (where
 * the old two-phase model was off by ~50 m: it ignored the horizontal
 * acceleration that lift produces during the dive).
 *
 * Parameters are jumper-meaningful: sustained glide L/D and sustained total
 * speed vInf define (kl, kd) via the steady-state balance
 *   sqrt(kl²+kd²)·vInf² = g,   kl/kd = glide.
 * `tRamp` linearly ramps LIFT from 0 to full over the first seconds
 * (suit pressurization / dive-out); drag is present from the start.
 * Coefficients scale with air density as the flight descends (ρ ∝ e^(drop/H)).
 *
 * Everything is expressed as drop-below-exit vs horizontal distance, so it
 * is independent of height datum.
 */

export const G = 9.81;
const RHO_SCALE_H = 8500; // m, exponential atmosphere scale height

export const DEFAULT_PARAMS = {
  v0: 2.5,    // horizontal push speed, m/s
  glide: 1.7, // sustained glide ratio (horizontal / vertical)
  vInf: 33,   // sustained total speed, m/s
  tRamp: 1,   // seconds for lift to build to full
  hRange: 1200, // model the surface down to this many metres below exit
};

/** Steady-state (kl, kd) at exit altitude for given glide/speed targets. */
export function coefficientsFor(glide, vInf) {
  const kd = G / (vInf * vInf * Math.sqrt(1 + glide * glide));
  return { kl: glide * kd, kd };
}

/**
 * Integrate the ODE with RK4. Returns parallel arrays {t, x, drop, vx, vz}.
 * Stops at drop ≥ hRange, t ≥ tMax, or a hard 600 s cap.
 */
export function simulate(params, { dt = 0.02, tMax = Infinity, hRange = null } = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const stopDrop = hRange ?? p.hRange;
  const { kl, kd } = coefficientsFor(p.glide, p.vInf);

  // state: [x, z, vx, vz], z negative below exit
  const deriv = (s, t) => {
    const rho = Math.exp(-s[1] / RHO_SCALE_H); // drop = −z ⇒ ρ grows descending
    const ramp = p.tRamp > 0 ? Math.min(1, t / p.tRamp) : 1;
    const kdE = kd * rho;
    const klE = kl * rho * ramp;
    const V = Math.hypot(s[2], s[3]);
    return [
      s[2],
      s[3],
      -kdE * V * s[2] - klE * V * s[3],
      -G - kdE * V * s[3] + klE * V * s[2],
    ];
  };

  let s = [0, 0, p.v0, 0];
  let t = 0;
  const out = { t: [0], x: [0], drop: [0], vx: [p.v0], vz: [0] };
  while (-s[1] < stopDrop && t < tMax && t < 600) {
    const k1 = deriv(s, t);
    const s2 = s.map((v, i) => v + (dt / 2) * k1[i]);
    const k2 = deriv(s2, t + dt / 2);
    const s3 = s.map((v, i) => v + (dt / 2) * k2[i]);
    const k3 = deriv(s3, t + dt / 2);
    const s4 = s.map((v, i) => v + dt * k3[i]);
    const k4 = deriv(s4, t + dt);
    s = s.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    t += dt;
    out.t.push(t);
    out.x.push(s[0]);
    out.drop.push(-s[1]);
    out.vx.push(s[2]);
    out.vz.push(s[3]);
  }
  return out;
}

/**
 * Build a trajectory profile: integrates once into a lookup table.
 * Returned object keeps the interface analyzeAzimuth/surface expect:
 * dropAt, radiusAt, maxRadius, hTrans (drop where the flight is "flying" —
 * instantaneous L/D reaches 90% of sustained), d1 (distance there), glide.
 */
export function makeProfile(params) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const sim = simulate(p);
  const n = sim.x.length;

  // Monotonic drop table (a strong flare could momentarily climb; flatten
  // it so dropAt/radiusAt stay well-defined).
  const drops = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    m = Math.max(m, sim.drop[i]);
    drops[i] = m;
  }
  const xs = sim.x;

  // Transition point ("established flight"): find the dive bottom (minimum
  // instantaneous glide ratio, ignoring the first moments before sink
  // develops), then the first recovery to 85% of sustained. Anchoring on
  // the dive bottom avoids false-triggering on the push in the first
  // half-second; if recovery never happens inside the modelled range
  // (slick with a short range), the whole range counts as still-diving.
  let iMin = 0;
  let rMin = Infinity;
  for (let i = 0; i < n; i++) {
    const sink = -sim.vz[i];
    if (sink < 3) continue;
    const r = sim.vx[i] / sink;
    if (r < rMin) {
      rMin = r;
      iMin = i;
    }
  }
  let iTrans = n - 1;
  for (let i = iMin; i < n; i++) {
    if (sim.vx[i] / -sim.vz[i] >= 0.85 * p.glide) {
      iTrans = i;
      break;
    }
  }
  const hTrans = drops[iTrans];
  const d1 = xs[iTrans];

  const lastX = xs[n - 1];
  const lastDrop = drops[n - 1];

  const idxFor = (arr, v) => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  /** Drop below exit at horizontal distance d (monotonic, m). */
  function dropAt(d) {
    if (d <= 0) return 0;
    if (d >= lastX) return lastDrop + (d - lastX) / p.glide;
    const i = idxFor(xs, d);
    const f = (d - xs[i]) / Math.max(1e-9, xs[i + 1] - xs[i]);
    return drops[i] + (drops[i + 1] - drops[i]) * f;
  }

  /** Horizontal distance at which the trajectory has dropped h metres. */
  function radiusAt(h) {
    if (h <= 0) return 0;
    if (h >= lastDrop) return lastX + (h - lastDrop) * p.glide;
    const i = idxFor(drops, h);
    const f = (h - drops[i]) / Math.max(1e-9, drops[i + 1] - drops[i]);
    return xs[i] + (xs[i + 1] - xs[i]) * f;
  }

  return {
    ...p,
    hTrans,
    d1,
    dropAt,
    radiusAt,
    maxRadius: radiusAt(p.hRange),
  };
}

/**
 * Evaluate one azimuth against terrain samples.
 *
 * The trajectory always meets terrain eventually — that is landing, not a
 * crash. The first point where the trajectory dips below terrain is
 * classified by the local terrain slope: shallower than `landingSlopeDeg`
 * (and far enough below the exit to be flying, not still diving) counts as a
 * landing and ends the ray; anything steeper is a strike. Clearance and
 * required glide are evaluated only before the landing, and the final
 * approach (where clearance tends to 0 by definition) is excluded.
 *
 * @param profile  result of makeProfile()
 * @param samples  [{d, tDrop}] terrain drop below exit altitude at distance d,
 *                 ordered by d ascending. tDrop may be NaN (no data).
 * @param opts     {dMin} ignore samples closer than dMin (the exit lip itself
 *                 always has ~0 clearance and would drown the signal).
 * @returns {minClearance, minClearanceD, requiredGlide, impactD, impactKind}
 *   minClearance  smallest (terrain drop − trajectory drop) before landing, m.
 *                 Negative means the trajectory is inside the terrain.
 *   requiredGlide smallest sustained glide ratio (same dive phase) that
 *                 clears every sample before landing; Infinity if terrain
 *                 blocks the dive phase or sits above dive-end altitude.
 *   impactKind    'landing' | 'strike' | null (null = still airborne at the
 *                 end of the modelled height range).
 */
export function analyzeAzimuth(profile, samples, opts = {}) {
  const dMin = opts.dMin ?? 4;
  const landingSlopeDeg = opts.landingSlopeDeg ?? 25;
  const landingSlope = Math.tan((landingSlopeDeg * Math.PI) / 180);
  // Below this drop, meeting terrain is never a "landing" — still in/near the dive.
  const minLandingDrop = profile.hTrans + 60;

  // Pass 1: find the first trajectory/terrain crossing and classify it.
  let impactD = null;
  let impactKind = null;
  let prev = null;
  for (const s of samples) {
    if (s.d < dMin || !Number.isFinite(s.tDrop)) continue;
    const c = s.tDrop - profile.dropAt(s.d);
    if (c < 0) {
      impactD = s.d;
      const slope =
        prev && s.d > prev.d ? (s.tDrop - prev.tDrop) / (s.d - prev.d) : 0;
      // Terrain drop *increasing* with d means downhill; a landing needs
      // near-flat or gently falling ground (|slope| small) at flying depth.
      impactKind =
        Math.abs(slope) < landingSlope && s.tDrop >= minLandingDrop
          ? "landing"
          : "strike";
      break;
    }
    prev = s;
  }

  // Evaluation window: stop before the landing flare, where clearance tends
  // to 0 by definition (the last ~60 m of descent before touchdown).
  let dEval = Infinity;
  if (impactKind === "landing") dEval = impactD - 60 * profile.glide;

  let minClearance = Infinity;
  let minClearanceD = null;
  let requiredGlide = 0;

  for (const { d, tDrop } of samples) {
    if (d < dMin || d >= dEval || !Number.isFinite(tDrop)) continue;
    const c = tDrop - profile.dropAt(d);
    // After a strike the ray is inside the mountain — clearance there is
    // meaningless, but required glide keeps scanning so it reflects the full
    // height of the blocking obstacle (conservative for long flat runouts).
    if (
      (impactKind !== "strike" || d <= impactD) &&
      c < minClearance
    ) {
      minClearance = c;
      minClearanceD = d;
    }
    if (d <= profile.d1) {
      // Terrain above the dive curve: no glide ratio can help.
      if (c < 0) requiredGlide = Infinity;
    } else if (tDrop <= profile.hTrans) {
      // Terrain at/above the dive-end altitude beyond the dive: unreachable.
      requiredGlide = Infinity;
    } else if (requiredGlide !== Infinity) {
      const need = (d - profile.d1) / (tDrop - profile.hTrans);
      if (need > requiredGlide) requiredGlide = need;
    }
  }

  if (minClearance === Infinity) {
    // No usable samples on this ray.
    return { minClearance: NaN, minClearanceD: null, requiredGlide: NaN, impactD, impactKind };
  }
  return { minClearance, minClearanceD, requiredGlide, impactD, impactKind };
}

/** Verdict thresholds (metres of minimum clearance). */
export const VERDICT = { red: 30, amber: 100 };

export function verdictFor(minClearance) {
  if (!Number.isFinite(minClearance)) return "nodata";
  if (minClearance < VERDICT.red) return "red";
  if (minClearance < VERDICT.amber) return "amber";
  return "green";
}
