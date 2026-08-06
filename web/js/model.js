/**
 * Two-phase wingsuit exit model.
 *
 * Phase 1 — dive: horizontal push at v0, vertical 1 g ballistic drop until
 *   `hTrans` metres of altitude have been lost (the "height to start flying").
 * Phase 2 — glide: constant sustained glide ratio `glide` (horizontal per
 *   vertical) from the end of the dive.
 *
 * Everything is expressed as drop-below-exit (metres) vs horizontal distance
 * from the exit (metres), so it is independent of height datum.
 */

export const G = 9.81;

export const DEFAULT_PARAMS = {
  v0: 2.5,      // horizontal push speed, m/s
  hTrans: 90,   // altitude lost before sustained glide, m
  glide: 1.4,   // sustained glide ratio (horizontal / vertical)
  hRange: 1200, // model the surface down to this many metres below exit
};

/** Build a trajectory profile from params. */
export function makeProfile(params) {
  const { v0, hTrans, glide, hRange } = { ...DEFAULT_PARAMS, ...params };
  const t1 = Math.sqrt((2 * hTrans) / G);
  const d1 = v0 * t1; // horizontal distance covered during the dive

  /** Drop below exit at horizontal distance d (monotonic, m). */
  function dropAt(d) {
    if (d <= 0) return 0;
    if (d < d1) {
      const t = d / v0;
      return (G / 2) * t * t;
    }
    return hTrans + (d - d1) / glide;
  }

  /** Horizontal distance at which the trajectory has dropped h metres. */
  function radiusAt(h) {
    if (h <= 0) return 0;
    if (h < hTrans) return v0 * Math.sqrt((2 * h) / G);
    return d1 + (h - hTrans) * glide;
  }

  return { v0, hTrans, glide, hRange, t1, d1, dropAt, radiusAt, maxRadius: radiusAt(hRange) };
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
      // Terrain above the ballistic dive curve: no glide ratio can help.
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
