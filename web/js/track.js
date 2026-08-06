/**
 * FlySight track handling: parse → segment → extract → fit.
 *
 * The receiver's logged velocities are Doppler-derived and far cleaner than
 * the positions (which multipath badly against a wall), so segmentation and
 * trajectory shape are computed from velocities; positions serve only as a
 * weak anchor and for the ghost path's absolute placement.
 */

import { simulate } from "./model.js";

/**
 * Parse a FlySight track CSV — both device generations:
 *  - FlySight 1: plain CSV, `time,lat,lon,hMSL,velN,velE,velD,...` header
 *    plus a units row;
 *  - FlySight 2 (TRACK.CSV): `$FLYS`-framed, columns declared by a
 *    `$COL,GNSS,...` line, data rows prefixed `$GNSS,`.
 * Returns samples [{t, lat, lon, h, vn, ve, vd}] with t in seconds from
 * first sample; `samples.epoch` holds the first sample's Unix time (s), so
 * epoch + t recovers the absolute moment of any sample (sun position etc.).
 * Throws on unrecognizable content.
 */
export function parseFlySight(text) {
  const lines = text.split(/\r?\n/);
  const isV2 = (lines[0] ?? "").startsWith("$FLYS");

  // Column layout: names -> field indices within a data row.
  let names;
  let rowStart; // fields consumed before the named columns begin
  let isData;
  if (isV2) {
    const colLine = lines.find((l) => l.startsWith("$COL,GNSS,"));
    if (!colLine) throw new Error("FlySight 2 file has no $COL,GNSS header (is this TRACK.CSV?)");
    names = colLine.split(",").slice(2).map((s) => s.trim());
    rowStart = 1; // fields[0] is the "$GNSS" tag
    isData = (f) => f[0] === "$GNSS";
  } else {
    names = (lines[0] ?? "").split(",").map((s) => s.trim());
    rowStart = 0;
    isData = () => true;
  }
  const col = (name) => {
    const i = names.indexOf(name);
    return i < 0 ? -1 : i + rowStart;
  };
  const iT = col("time");
  const iLat = col("lat");
  const iLon = col("lon");
  const iH = col("hMSL");
  const iVn = col("velN");
  const iVe = col("velE");
  const iVd = col("velD");
  if ([iT, iLat, iLon, iH, iVn, iVe, iVd].some((i) => i < 0)) {
    throw new Error("not a FlySight track (expected time/lat/lon/hMSL/velN/velE/velD columns)");
  }

  const samples = [];
  let t0 = null;
  for (let li = 1; li < lines.length; li++) {
    const f = lines[li].split(",");
    if (f.length <= iVd || !isData(f)) continue;
    const ms = Date.parse(f[iT]);
    if (!Number.isFinite(ms)) continue; // units row, $VAR/$DATA framing, blanks
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
 * Fit the ODE model to the flight's velocity time series.
 *
 * The Doppler velocities are the strongest signal in the file, so the fit
 * runs in the velocity domain: Huber loss (robust — pilot-input segments
 * like a mid-flight dive get downweighted, not chased) on both horizontal
 * speed and sink vs the integrated model. Push speed is read directly from
 * the data. Symmetric best estimate — safety margins are applied
 * explicitly downstream, not baked into the fit.
 *
 * Returns {v0, glide, vInf, tRamp, err} where err ≈ mean velocity misfit.
 */
export function fitModel(samples, iExit, iEnd) {
  const t0 = samples[iExit].t;
  const meas = [];
  for (let i = iExit; i <= iEnd; i++) {
    const s = samples[i];
    meas.push({ t: s.t - t0, vh: Math.hypot(s.vn, s.ve), vd: s.vd });
  }
  const dur = meas[meas.length - 1].t;

  // Push speed straight from the data: median vh over the first 0.6 s.
  const early = meas
    .filter((q) => q.t <= 0.6)
    .map((q) => q.vh)
    .sort((a, b) => a - b);
  const v0 = Math.min(6, early[Math.floor(early.length / 2)] ?? 2.5);

  const huber = (r, d = 3) =>
    Math.abs(r) < d ? 0.5 * r * r : d * (Math.abs(r) - 0.5 * d);

  const loss = (glide, vInf, tRamp, dt) => {
    const sim = simulate(
      { v0, glide, vInf, tRamp, hRange: Infinity },
      { dt, tMax: dur + dt }
    );
    let s = 0;
    for (const q of meas) {
      const i = Math.min(sim.t.length - 1, Math.round(q.t / dt));
      s += huber(q.vh - sim.vx[i]) + huber(q.vd - -sim.vz[i]);
    }
    return s / meas.length;
  };

  // Coarse grid at a large step size, then shrinking local refinement at a
  // fine one (losses at different dt aren't compared with each other).
  let best = { glide: 1.7, vInf: 33, tRamp: 1, err: Infinity };
  for (let glide = 0.7; glide <= 3.45; glide += 0.15) {
    for (let vInf = 24; vInf <= 62; vInf += 2.5) {
      for (const tRamp of [0, 2, 4]) {
        const err = loss(glide, vInf, tRamp, 0.08);
        if (err < best.err) best = { glide, vInf, tRamp, err };
      }
    }
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  best.err = loss(best.glide, best.vInf, best.tRamp, 0.03);
  let step = { glide: 0.1, vInf: 1.5, tRamp: 1 };
  for (let round = 0; round < 10; round++) {
    const b = { ...best };
    for (const dg of [-step.glide, 0, step.glide]) {
      for (const dv of [-step.vInf, 0, step.vInf]) {
        for (const dr of [-step.tRamp, 0, step.tRamp]) {
          if (!dg && !dv && !dr) continue;
          const glide = clamp(b.glide + dg, 0.5, 4);
          const vInf = clamp(b.vInf + dv, 20, 70);
          const tRamp = clamp(b.tRamp + dr, 0, 8);
          const err = loss(glide, vInf, tRamp, 0.03);
          if (err < best.err) best = { glide, vInf, tRamp, err };
        }
      }
    }
    step = { glide: step.glide * 0.7, vInf: step.vInf * 0.7, tRamp: step.tRamp * 0.7 };
  }
  return { v0, ...best };
}
