/**
 * FlySight track handling: parse → segment → extract → fit.
 *
 * The receiver's logged velocities are Doppler-derived and far cleaner than
 * the positions (which multipath badly against a wall), so segmentation and
 * trajectory shape are computed from velocities; positions serve only as a
 * weak anchor and for the ghost path's absolute placement.
 */

import { makeProfile } from "./model.js";

/**
 * Parse FlySight 1 CSV text.
 * Returns samples [{t, lat, lon, h, vn, ve, vd}] with t in seconds from
 * first sample; `samples.epoch` holds the first sample's Unix time (s), so
 * epoch + t recovers the absolute moment of any sample (sun position etc.).
 * Throws on unrecognizable content.
 */
export function parseFlySight(text) {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((s) => s.trim());
  const col = (name) => header.indexOf(name);
  const iT = col("time");
  const iLat = col("lat");
  const iLon = col("lon");
  const iH = col("hMSL");
  const iVn = col("velN");
  const iVe = col("velE");
  const iVd = col("velD");
  if ([iT, iLat, iLon, iH, iVn, iVe, iVd].some((i) => i < 0)) {
    throw new Error("not a FlySight CSV (expected time/lat/lon/hMSL/velN/velE/velD header)");
  }
  const samples = [];
  let t0 = null;
  for (let li = 1; li < lines.length; li++) {
    const f = lines[li].split(",");
    if (f.length <= iVd) continue;
    const ms = Date.parse(f[iT]);
    if (!Number.isFinite(ms)) continue; // units row, blanks
    const s = {
      t: ms / 1000,
      lat: +f[iLat],
      lon: +f[iLon],
      h: +f[iH],
      vn: +f[iVn],
      ve: +f[iVe],
      vd: +f[iVd],
    };
    if (![s.lat, s.lon, s.h, s.vn, s.ve, s.vd].every(Number.isFinite)) continue;
    if (t0 === null) t0 = s.t;
    s.t -= t0;
    samples.push(s);
  }
  if (samples.length < 50) throw new Error("track too short");
  samples.epoch = t0;
  return samples;
}

const vh = (s) => Math.hypot(s.vn, s.ve);
const v3 = (s) => Math.hypot(s.vn, s.ve, s.vd);

/** Seconds → sample count using the local sampling interval. */
function span(samples, i, seconds) {
  const dt = i > 0 ? Math.max(0.05, samples[i].t - samples[i - 1].t) : 0.2;
  return Math.max(1, Math.round(seconds / dt));
}

/**
 * Detect jump phases. Returns {iExit, iDeploy, iLand} (iDeploy/iLand may be
 * null if the file ends early). Heuristics tuned on real exits; the UI lets
 * the user drag the markers afterwards, so "close" is good enough.
 */
export function segmentJump(samples) {
  // Exit: velD > 8 m/s sustained 2 s, then walk back to descent onset.
  let iExit = null;
  let runStart = null;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].vd > 8) {
      if (runStart === null) runStart = i;
      if (samples[i].t - samples[runStart].t >= 2) {
        let j = runStart;
        while (j > 0 && samples[j].vd > 1.0) j--;
        iExit = j;
        break;
      }
    } else {
      runStart = null;
    }
  }
  if (iExit === null) return { iExit: null, iDeploy: null, iLand: null };

  // Canopy: horizontal speed < 10 m/s AND velD < 10 m/s sustained 3 s,
  // starting after at least 5 s of flight. Deployment = walk back to the
  // last sample still moving like flight (vh > 12), then trim the ~2 s of
  // opening deceleration that precedes the sustained-canopy window.
  let iDeploy = null;
  runStart = null;
  const flightFloor = samples[iExit].t + 5;
  for (let i = iExit; i < samples.length; i++) {
    const s = samples[i];
    if (s.t < flightFloor) continue;
    if (vh(s) < 10 && s.vd < 10) {
      if (runStart === null) runStart = i;
      if (s.t - samples[runStart].t >= 3) {
        let j = runStart;
        while (j > iExit && vh(samples[j]) < 12) j--;
        const cutT = samples[j].t - 2;
        while (j > iExit && samples[j].t > cutT) j--;
        iDeploy = j;
        break;
      }
    } else {
      runStart = null;
    }
  }

  // Landing: 3D speed < 1.5 m/s sustained 3 s after deployment (or exit).
  let iLand = null;
  runStart = null;
  for (let i = iDeploy ?? iExit + span(samples, iExit, 10); i < samples.length; i++) {
    if (v3(samples[i]) < 1.5) {
      if (runStart === null) runStart = i;
      if (samples[i].t - samples[runStart].t >= 3) {
        iLand = runStart;
        break;
      }
    } else {
      runStart = null;
    }
  }
  return { iExit, iDeploy, iLand };
}

/**
 * Extract the flight segment [iExit..iEnd] as:
 *  - profile: {d, drop} arrays — drop below exit vs along-track horizontal
 *    distance, integrated from Doppler velocities (trapezoid);
 *  - path: [{e, n, z}] ENU metres relative to the exit, also integrated;
 *  - heading0: initial flight heading (deg) once moving > 5 m/s horizontally;
 *  - checks: integration vs GPS-position discrepancy, for display.
 */
export function extractFlight(samples, iExit, iEnd) {
  const d = [0];
  const drop = [0];
  const path = [{ e: 0, n: 0, z: 0 }];
  let e = 0;
  let n = 0;
  let z = 0;
  let dist = 0;
  for (let i = iExit + 1; i <= iEnd; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = Math.min(1, Math.max(0, b.t - a.t));
    e += ((a.ve + b.ve) / 2) * dt;
    n += ((a.vn + b.vn) / 2) * dt;
    z -= ((a.vd + b.vd) / 2) * dt; // vd positive down
    dist += ((vh(a) + vh(b)) / 2) * dt;
    d.push(dist);
    drop.push(-z);
    path.push({ e, n, z });
  }

  let heading0 = null;
  for (let i = iExit; i <= iEnd; i++) {
    if (vh(samples[i]) > 5) {
      heading0 = (Math.atan2(samples[i].ve, samples[i].vn) * 180) / Math.PI;
      if (heading0 < 0) heading0 += 360;
      break;
    }
  }

  // Cross-check integration drift against raw GPS positions.
  const ex = samples[iExit];
  const en = samples[iEnd];
  const R = (6371000 * Math.PI) / 180;
  const gpsN = (en.lat - ex.lat) * R;
  const gpsE = (en.lon - ex.lon) * R * Math.cos((ex.lat * Math.PI) / 180);
  const gpsDrop = ex.h - en.h;
  const checks = {
    horizDriftM: Math.hypot(e - gpsE, n - gpsN),
    dropDriftM: Math.abs(-z - gpsDrop),
    durationS: en.t - ex.t,
  };
  return { d, drop, path, heading0, checks };
}

/**
 * Fit the two-phase model (v0, hTrans, glide) to a measured profile,
 * coarse grid then local refinement. hRange is set to the measured drop so
 * the fit only spans real data.
 *
 * The loss is asymmetric: a model that sits ABOVE the real flight
 * (dropAt < measured) is optimistic about clearance, so those residuals
 * are weighted 25× — the fitted curve hugs the measured one from below.
 */
export function fitModel(d, drop) {
  const hRange = drop[drop.length - 1];
  const OPTIMISM_W = 25;
  const rms = (v0, hTrans, glide) => {
    const prof = makeProfile({ v0, hTrans, glide, hRange });
    let s = 0;
    for (let i = 0; i < d.length; i++) {
      const r = prof.dropAt(d[i]) - drop[i];
      s += r < 0 ? OPTIMISM_W * r * r : r * r;
    }
    return Math.sqrt(s / d.length);
  };

  let best = { v0: 2.5, hTrans: 90, glide: 1.4, err: Infinity };
  const consider = (v0, hTrans, glide) => {
    const err = rms(v0, hTrans, glide);
    if (err < best.err) best = { v0, hTrans, glide, err };
  };
  for (let v0 = 0; v0 <= 5; v0 += 0.5)
    for (let hTrans = 30; hTrans <= Math.min(300, hRange * 0.8); hTrans += 15)
      for (let glide = 0.8; glide <= 3.5; glide += 0.1) consider(v0, hTrans, glide);

  // Local refinement: shrink steps around the best point.
  let step = { v0: 0.25, hTrans: 7.5, glide: 0.05 };
  for (let round = 0; round < 12; round++) {
    const b = { ...best };
    for (const dv of [-step.v0, 0, step.v0])
      for (const dh of [-step.hTrans, 0, step.hTrans])
        for (const dg of [-step.glide, 0, step.glide])
          consider(
            Math.max(0, b.v0 + dv),
            Math.max(20, b.hTrans + dh),
            Math.max(0.5, b.glide + dg)
          );
    step = { v0: step.v0 * 0.7, hTrans: step.hTrans * 0.7, glide: step.glide * 0.7 };
  }
  return best;
}
