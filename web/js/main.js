import { wgs84ToLv95, lv95ToWgs84 } from "./lv95.js";
import { makeProfile, analyzeAzimuth, verdictFor } from "./model.js";
import { Dem } from "./dem.js";
import { TrajectorySurface } from "./surface.js";
import { HeadingDial } from "./dial.js";
import { ProfileChart } from "./profile.js";
import { parseFlySight, segmentJump, extractFlight, fitModel } from "./track.js";
import { TrackTimeline } from "./timeline.js";

const TERRAIN_URL = "https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/";
const WMTS = (layer, fmt, maxLevel) =>
  new Cesium.UrlTemplateImageryProvider({
    url: `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${fmt}`,
    maximumLevel: maxLevel,
    credit: new Cesium.Credit("© swisstopo"),
  });

const AZ_COUNT = 72;
const RAY_STEP = 4;
const VERDICT_CSS = {
  green: "#0ca30c",
  amber: "#fab219",
  red: "#d03b3b",
  nodata: "#5c6f80",
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
function status(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

/* ---------------- state ---------------- */
const dem = new Dem();
let viewer;
let surface;
let dial;
let chart;
let exit = null; // {e, n, alt, anchor: Cartesian3, preparedRadius}
let results = null; // per-azimuth analyzeAzimuth results
let selectedAz = null; // degrees
let armed = false;
let rayEntity = null;
let exitEntity = null;
let ghostEntity = null;
let track = null; // {samples, iExit, iDeploy, flight, fit}
let timeline = null;
let ghostHeading = null; // absolute heading (deg) of the ghost's initial flight direction

// Sliders show km/h; the model and the URL hash work in m/s.
const KPH = 3.6;
const params = () => ({
  v0: parseFloat($("sl-v0").value) / KPH,
  glide: parseFloat($("sl-gl").value),
  vInf: parseFloat($("sl-sp").value) / KPH,
  tRamp: parseFloat($("sl-ramp").value),
  hRange: parseFloat($("sl-hr").value),
  margin: parseFloat($("sl-margin").value), // % sustained-glide derate
});

// The sliders describe the best-estimate flight; verdicts, surface, and the
// primary chart line use the PLANNING profile — sustained glide derated by
// the margin. Safety lives in this visible knob, not inside a skewed fit.
const planningProfile = (p) =>
  makeProfile({ ...p, glide: p.glide * (1 - p.margin / 100) });

/* ---------------- init ---------------- */
async function init() {
  status("loading terrain…", "busy");
  const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL);
  viewer = new Cesium.Viewer("cesium", {
    terrainProvider,
    baseLayer: new Cesium.ImageryLayer(WMTS("ch.swisstopo.swissimage", "jpeg", 20)),
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    fullscreenButton: false,
    // Local-frame surface geometry can't be projected for 2D/Columbus modes
    scene3DOnly: true,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    msaaSamples: 4,
  });
  viewer.scene.globe.depthTestAgainstTerrain = true;
  window.viewer = viewer; // console/debug access
  surface = new TrajectorySurface(viewer);
  dial = new HeadingDial($("dial"), (az) => selectHeading(az));
  chart = new ProfileChart($("profile"), $("profile-tooltip"));
  dial.update({});
  timeline = new TrackTimeline($("timeline"), (iExit, iDeploy) => {
    if (!track) return;
    track.iExit = iExit;
    track.iDeploy = iDeploy;
    recomputeTrack();
  });

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(7.98, 46.72, 7500),
    orientation: {
      heading: Cesium.Math.toRadians(185),
      pitch: Cesium.Math.toRadians(-22),
    },
  });

  const handler = viewer.screenSpaceEventHandler;
  handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  handler.setInputAction(
    (m) => pickExit(m.position),
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
  );
  handler.setInputAction((m) => {
    if (armed) {
      arm(false);
      pickExit(m.position);
    } else {
      const picked = viewer.scene.pick(m.position);
      if (picked && typeof picked.id === "number" && results) {
        selectHeading((picked.id * 360) / AZ_COUNT);
      }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  restoreFromHash();
  if (!exit) status("ready — double-click terrain to set an exit");
}

function arm(on) {
  armed = on;
  $("btn-set").classList.toggle("armed", on);
  $("btn-set").textContent = on ? "Click the terrain…" : "Set exit point";
  viewer.container.style.cursor = on ? "crosshair" : "";
}

/* ---------------- exit placement ---------------- */
function pickExit(windowPos) {
  let cart = viewer.scene.pickPosition(windowPos);
  if (!Cesium.defined(cart)) {
    const ray = viewer.camera.getPickRay(windowPos);
    cart = viewer.scene.globe.pick(ray, viewer.scene);
  }
  if (!Cesium.defined(cart)) return;
  const c = Cesium.Cartographic.fromCartesian(cart);
  setExitAt(
    Cesium.Math.toDegrees(c.longitude),
    Cesium.Math.toDegrees(c.latitude)
  );
}

async function setExitAt(lon, lat, fromHash = false, exactLv95 = null, snapOpts = null) {
  try {
    const p = params();
    // exactLv95 avoids WGS84 round-trip drift when restoring a shared hash —
    // sub-metre shifts genuinely flip verdicts on a knife-edge lip.
    let { e, n } = exactLv95 ?? wgs84ToLv95(lon, lat);
    const radius = neededRadius(p);
    status("fetching swissALTI3D tiles…", "busy");
    await dem.prepare(e, n, radius, (a, b) =>
      status(`fetching swissALTI3D tiles ${a}/${b}…`, "busy")
    );
    await dem.settle();

    let moved = 0;
    if ($("chk-snap").checked && !fromHash) {
      const s = dem.snapToLip(e, n, snapOpts ?? {});
      e = s.e;
      n = s.n;
      moved = s.moved;
    }
    const alt = await dem.elevation05(e, n);
    if (!Number.isFinite(alt)) {
      status("no elevation data here", "error");
      return;
    }

    // Anchor the visuals to the *rendered* terrain at the snapped spot, so
    // the cone apex sits on the mesh the user sees (analysis stays in DEM
    // space — the two heights differ by geoid offset and mesh LOD).
    const [lon2, lat2] = lv95ToWgs84(e, n);
    const cartos = [Cesium.Cartographic.fromDegrees(lon2, lat2)];
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos);
    const anchor = Cesium.Cartesian3.fromDegrees(lon2, lat2, cartos[0].height);

    exit = { e, n, alt, anchor, preparedRadius: radius };
    $("exit-readout").className = "readout";
    $("exit-readout").textContent =
      `${lat2.toFixed(5)}°N ${lon2.toFixed(5)}°E\n` +
      `LV95 ${Math.round(e)} / ${Math.round(n)}\n` +
      `exit alt ${alt.toFixed(1)} m` +
      (moved > 1 ? `  (snapped ${moved.toFixed(0)} m)` : "");

    if (!exitEntity) {
      exitEntity = viewer.entities.add({
        position: anchor,
        point: {
          pixelSize: 8,
          color: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString("#da291c"),
          outlineWidth: 3,
          disableDepthTestDistance: 50,
        },
      });
    } else {
      exitEntity.position = anchor;
    }

    update();
    writeHash();
  } catch (err) {
    console.error(err);
    status(`error: ${err.message}`, "error");
  }
}

function neededRadius(p) {
  // Best-estimate profile reaches further than the derated one — prefetch for it.
  const prof = makeProfile(p);
  return Math.min(Math.max(prof.maxRadius + 150, 1200), 5000);
}

/* ---------------- recompute ---------------- */
let updateTimer = null;
function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(update, 180);
}

async function update() {
  if (!exit || !viewer) return;
  const p = params();
  const prof = planningProfile(p);

  surface.build(exit.anchor, prof);
  viewer.scene.requestRender();

  const radius = neededRadius(p);
  if (radius > exit.preparedRadius) {
    status("fetching more tiles…", "busy");
    await dem.prepare(exit.e, exit.n, radius, (a, b) =>
      status(`fetching tiles ${a}/${b}…`, "busy")
    );
    await dem.settle();
    exit.preparedRadius = radius;
  }

  status("analyzing…", "busy");
  const maxDist = Math.min(prof.maxRadius, radius);
  results = [];
  for (let i = 0; i < AZ_COUNT; i++) {
    const az = (i * 2 * Math.PI) / AZ_COUNT;
    const samples = dem.sampleRay(exit.e, exit.n, exit.alt, az, maxDist, RAY_STEP);
    results.push(analyzeAzimuth(prof, samples));
  }

  const colors = results.map((r) => VERDICT_CSS[verdictFor(r.minClearance)]);
  surface.build(exit.anchor, prof, colors);
  viewer.scene.requestRender();
  dial.update({ colors, enabled: true });

  const nGreen = results.filter((r) => verdictFor(r.minClearance) === "green").length;
  const nAmber = results.filter((r) => verdictFor(r.minClearance) === "amber").length;
  status(`${nGreen * 5}° clear, ${nAmber * 5}° tight`);

  if (selectedAz !== null) selectHeading(selectedAz, true);
  writeHash();
}

/* ---------------- heading selection ---------------- */
function selectHeading(azDeg, keep = false) {
  if (!exit || !results) return;
  const i = Math.round(azDeg / (360 / AZ_COUNT)) % AZ_COUNT;
  selectedAz = (i * 360) / AZ_COUNT;
  const p = params();
  const prof = planningProfile(p);
  const bestProf = p.margin > 0 ? makeProfile(p) : null;
  const azRad = (selectedAz * Math.PI) / 180;
  const maxDist = Math.min(prof.maxRadius, exit.preparedRadius);
  const samples = dem.sampleRay(exit.e, exit.n, exit.alt, azRad, maxDist, RAY_STEP);
  const r = results[i];

  dial.update({ selected: selectedAz });
  const v = verdictFor(r.minClearance);
  $("heading-stats").className = "readout";
  $("heading-stats").textContent =
    `${String(Math.round(selectedAz)).padStart(3, "0")}°  ${v === "nodata" ? "no data" : v.toUpperCase()}\n` +
    (Number.isFinite(r.minClearance)
      ? `min clearance ${Math.round(r.minClearance)} m @ ${Math.round(r.minClearanceD)} m\n`
      : "") +
    (Number.isFinite(r.requiredGlide)
      ? `required glide ${r.requiredGlide.toFixed(2)}\n`
      : "required glide — blocked\n") +
    (r.impactKind ? `${r.impactKind} at ${Math.round(r.impactD)} m out` : "airborne at range end");

  // 3D trajectory line along the selected heading
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(exit.anchor);
  const pts = [];
  for (let d = 0; d <= maxDist; d += 20) {
    const drop = prof.dropAt(d);
    if (drop > prof.hRange) break;
    pts.push(
      Cesium.Matrix4.multiplyByPoint(
        enu,
        new Cesium.Cartesian3(Math.sin(azRad) * d, Math.cos(azRad) * d, -drop),
        new Cesium.Cartesian3()
      )
    );
  }
  if (rayEntity) viewer.entities.remove(rayEntity);
  rayEntity = viewer.entities.add({
    polyline: { positions: pts, width: 2.5, material: Cesium.Color.WHITE },
  });
  viewer.scene.requestRender();

  $("profile-panel").hidden = false;
  $("profile-title").textContent = `heading ${String(Math.round(selectedAz)).padStart(3, "0")}° · exit ${Math.round(exit.alt)} m`;
  chart.update(samples, prof, exit.alt, r, selectedAz, trackCurve(), bestProf);
  // Snap the ghost aim to an explicit dial/surface selection, but leave a
  // manually adjusted aim alone during recomputes (keep=true).
  if (!keep && track) setGhostHeading(selectedAz);
  else updateGhost();
  if (!keep) writeHash();
}

/* ---------------- FlySight track ---------------- */
const trackCurve = () =>
  track?.flight ? { d: track.flight.d, drop: track.flight.drop } : null;

function loadTrackText(text, name) {
  try {
    const samples = parseFlySight(text);
    const seg = segmentJump(samples);
    if (seg.iExit === null) {
      status("no jump found in track (no sustained descent)", "error");
      return;
    }
    const iDeploy = seg.iDeploy ?? Math.min(samples.length - 1, seg.iLand ?? samples.length - 1);
    track = { samples, iExit: seg.iExit, iDeploy, name };
    $("timeline").hidden = false;
    $("track-actions").hidden = false;
    $("ghost-controls").hidden = false;
    recomputeTrack();
    setGhostHeading(selectedAz ?? track.flight.heading0 ?? 0);
  } catch (err) {
    console.error(err);
    status(`track: ${err.message}`, "error");
  }
}

function recomputeTrack() {
  const { samples, iExit, iDeploy } = track;
  track.flight = extractFlight(samples, iExit, iDeploy);
  track.fit = fitModel(samples, iExit, iDeploy);
  timeline.setData(samples, iExit, iDeploy);

  const f = track.flight;
  const fit = track.fit;
  const drift = Math.max(f.checks.horizDriftM, f.checks.dropDriftM);
  $("track-readout").className = "readout";
  $("track-readout").textContent =
    `${f.checks.durationS.toFixed(0)} s flight · ${Math.round(f.d[f.d.length - 1])} m out · ` +
    `${Math.round(f.drop[f.drop.length - 1])} m down\n` +
    `fit: glide ${fit.glide.toFixed(2)} · speed ${Math.round(fit.vInf * KPH)} km/h · ` +
    `ramp ${fit.tRamp.toFixed(1)} s · push ${(fit.v0 * KPH).toFixed(1)} km/h\n` +
    (drift > 20 ? `⚠ GPS/velocity drift ${Math.round(drift)} m — treat with care` : "");

  $("legend-track").hidden = false;
  if (selectedAz !== null && exit) selectHeading(selectedAz, true);
  else updateGhost();
}

function applyFit() {
  if (!track?.fit) return;
  const clamp = (id, v) => {
    const el = $(id);
    el.value = Math.max(+el.min, Math.min(+el.max, v));
  };
  clamp("sl-v0", Math.round(track.fit.v0 * KPH * 2) / 2);
  clamp("sl-gl", Math.round(track.fit.glide * 20) / 20);
  clamp("sl-sp", Math.round(track.fit.vInf * KPH));
  clamp("sl-ramp", Math.round(track.fit.tRamp * 2) / 2);
  syncOutputs();
  scheduleUpdate();
}

function clearTrack() {
  track = null;
  ghostHeading = null;
  $("timeline").hidden = true;
  $("track-actions").hidden = true;
  $("ghost-controls").hidden = true;
  $("legend-track").hidden = true;
  $("track-readout").className = "readout empty";
  $("track-readout").textContent =
    "Load (or drop anywhere) a FlySight CSV — original or FlySight 2 TRACK.CSV. Exit and deployment are detected automatically; drag the markers to adjust.";
  updateGhost();
  if (selectedAz !== null && exit) selectHeading(selectedAz, true);
}

/**
 * Fly to the track's actual (GPS-detected) exit, place the evaluation exit
 * there — snap-to-lip applies if enabled, tidying GPS position error — and
 * aim the ghost as flown, so the real jump is reproduced in place.
 */
async function gotoTrackExit() {
  if (!track) return;
  const s = track.samples[track.iExit];
  const h0 = track.flight.heading0 ?? 0;
  // GPS horizontal error routinely puts the reported point over the edge
  // onto the face below; a wider, altitude-aware snap recovers the lip.
  await setExitAt(s.lon, s.lat, false, null, { radius: 35, targetAlt: s.h });
  if (!exit) return;

  // Camera: behind the exit, opposite the flight direction, looking along
  // it — clamped above the rendered terrain (the backdrop is often a wall).
  const carto = Cesium.Cartographic.fromCartesian(exit.anchor);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const back = 1100;
  const rad = (h0 * Math.PI) / 180;
  const camLat = lat - (Math.cos(rad) * back) / 111320;
  const camLon = lon - (Math.sin(rad) * back) / (111320 * Math.cos((lat * Math.PI) / 180));
  const ground = [Cesium.Cartographic.fromDegrees(camLon, camLat)];
  await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, ground);
  const camH = Math.max(carto.height + 500, (ground[0].height ?? 0) + 150);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(camLon, camLat, camH),
    orientation: {
      heading: Cesium.Math.toRadians(h0),
      pitch: Cesium.Math.toRadians(-25),
    },
    duration: 1.8,
  });

  // Light the scene as it was at the moment of exit (sun/moon position).
  if (Number.isFinite(track.samples.epoch)) {
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(
      new Date((track.samples.epoch + s.t) * 1000)
    );
    viewer.scene.globe.enableLighting = true;
    viewer.scene.requestRender();
  }
  setGhostHeading(h0);
}

/** Set the ghost's aim (deg) and sync the slider without re-firing it. */
function setGhostHeading(deg) {
  ghostHeading = ((Math.round(deg) % 360) + 360) % 360;
  $("sl-aim").value = ghostHeading;
  $("out-aim").textContent = `${String(ghostHeading).padStart(3, "0")}°`;
  updateGhost();
}

/**
 * Ghost: the measured 3D path translated to the chosen exit and rotated so
 * its initial flight direction points at `ghostHeading` (the aim slider;
 * it snaps to the dial selection, then adjusts freely).
 */
function updateGhost() {
  if (ghostEntity) {
    viewer.entities.remove(ghostEntity);
    ghostEntity = null;
  }
  const on = $("chk-ghost").checked;
  if (!on || !track?.flight || !exit || ghostHeading === null) {
    viewer.scene.requestRender();
    return;
  }
  const f = track.flight;
  const theta = ((ghostHeading - (f.heading0 ?? 0)) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(exit.anchor);
  const pts = [];
  const step = Math.max(1, Math.floor(f.path.length / 400));
  for (let i = 0; i < f.path.length; i += step) {
    const p = f.path[i];
    pts.push(
      Cesium.Matrix4.multiplyByPoint(
        enu,
        new Cesium.Cartesian3(p.e * cos + p.n * sin, -p.e * sin + p.n * cos, p.z),
        new Cesium.Cartesian3()
      )
    );
  }
  ghostEntity = viewer.entities.add({
    polyline: {
      positions: pts,
      width: 2.5,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString("#C77FE8"),
        dashLength: 12,
      }),
    },
  });
  viewer.scene.requestRender();
}

/* ---------------- share state via hash ---------------- */
function writeHash() {
  if (!exit) return;
  const p = params();
  const parts = [
    exit.e.toFixed(1),
    exit.n.toFixed(1),
    +p.v0.toFixed(2), // hash keeps m/s (stable across display-unit changes)
    p.glide,
    +p.vInf.toFixed(2),
    p.tRamp,
    p.hRange,
    p.margin,
    selectedAz ?? "",
  ];
  history.replaceState(null, "", "#" + parts.join(","));
}

function restoreFromHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const f = h.split(",").map((s) => (s === "" ? null : parseFloat(s)));
  if (!Number.isFinite(f[0]) || !Number.isFinite(f[1])) return;
  const [e, n] = f;
  const set = (id, v) => {
    if (Number.isFinite(v)) $(id).value = v;
  };
  let az;
  if (f.length >= 9) {
    set("sl-v0", f[2] * KPH); // hash is m/s, sliders are km/h
    set("sl-gl", f[3]);
    set("sl-sp", f[4] * KPH);
    set("sl-ramp", f[5]);
    set("sl-hr", f[6]);
    set("sl-margin", f[7]);
    az = f[8];
  } else {
    // legacy two-phase hash: e,n,v0,hTrans,glide,hRange,az — dive is gone
    set("sl-v0", f[2] * KPH);
    set("sl-gl", f[4]);
    set("sl-hr", f[5]);
    az = f[6];
  }
  syncOutputs();
  const [lon, lat] = lv95ToWgs84(e, n);
  const anchorView = Cesium.Cartesian3.fromDegrees(lon, lat + 0.018, 3500);
  setExitAt(lon, lat, true, { e, n }).then(() => {
    if (Number.isFinite(az)) selectHeading(az);
  });
  viewer.camera.flyTo({
    destination: anchorView,
    orientation: { heading: Cesium.Math.toRadians(180), pitch: Cesium.Math.toRadians(-20) },
    duration: 0,
  });
}

/* ---------------- UI wiring ---------------- */
function syncOutputs() {
  $("out-v0").textContent = `${parseFloat($("sl-v0").value).toFixed(1)} km/h`;
  $("out-gl").textContent = parseFloat($("sl-gl").value).toFixed(2);
  $("out-sp").textContent = `${$("sl-sp").value} km/h`;
  $("out-ramp").textContent = `${parseFloat($("sl-ramp").value).toFixed(1)} s`;
  $("out-hr").textContent = `${$("sl-hr").value} m`;
  $("out-margin").textContent = `−${$("sl-margin").value} %`;
}

for (const id of ["sl-v0", "sl-gl", "sl-sp", "sl-ramp", "sl-hr", "sl-margin"]) {
  $(id).addEventListener("input", () => {
    syncOutputs();
    scheduleUpdate();
  });
}

$("btn-set").addEventListener("click", () => arm(!armed));
window.addEventListener("keydown", (ev) => {
  if (ev.key === "e" || ev.key === "E") {
    if (document.activeElement?.tagName !== "INPUT") arm(!armed);
  }
  if (ev.key === "Escape") {
    arm(false);
    helpPop.hidden = true;
  }
});

/* ---------------- parameter help ---------------- */
const HELP = {
  v0: ["push", "Horizontal speed you leave the rock with. A standing push is ~7 km/h, a strong running exit 15–18. It only matters for the first few seconds — but those are the strike-critical ones."],
  glide: ["glide", "Sustained glide ratio of established flight: metres forward per metre of drop, once the suit is flying steadily. This is the cone's far-field slope. Set it from your suit and your tracks, not from a good day's memory."],
  speed: ["speed", "Sustained total airspeed in established flight. Together with glide it fixes the model's lift and drag coefficients, which shape the whole dive-to-flight curve — not just the far field."],
  ramp: ["ramp", "Seconds for lift to build after exit (suit pressurization and dive-out). Slick ≈ 0, small suits 1–2 s, big suits several. A longer ramp means a deeper dive before the curve bends forward."],
  range: ["range", "How far below the exit the surface and the analysis extend. Terrain deeper than this is not evaluated — headings shown clear may still have obstacles beyond the range."],
  margin: ["margin", "Safety derate: the surface, the heading verdicts and the solid chart line use sustained glide reduced by this percentage. The dotted chart line is the undiluted best estimate. 0 % means planning on your best-day numbers."],
  snap: ["snap to lip", "Clicks land on the rendered 3D mesh, which is metres coarser than the real data — usually a step back from the edge. Snapping moves the exit to the strongest nearby drop; for a track's exit it also matches the GPS altitude, since horizontal GPS error tends to put the point over the edge."],
  ghost: ["ghost", "Shows the recorded flight path, translated to the current exit with its turns preserved. Dashed violet in 3D and in the profile chart."],
  aim: ["aim", "Compass direction of the ghost's initial flight. It snaps to the heading you pick on the dial, then adjusts freely — the whole recorded path rotates rigidly around the exit."],
};
const helpPop = document.createElement("div");
helpPop.id = "help-pop";
helpPop.hidden = true;
document.body.appendChild(helpPop);
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest?.("button.help");
  if (btn) {
    ev.preventDefault(); // inside a <label>: don't activate the control
    const key = btn.dataset.help;
    if (!helpPop.hidden && helpPop.dataset.key === key) {
      helpPop.hidden = true;
      return;
    }
    const [title, text] = HELP[key] ?? [key, ""];
    helpPop.innerHTML = `<b>${title}</b>${text}`;
    helpPop.dataset.key = key;
    helpPop.hidden = false;
    const r = btn.getBoundingClientRect();
    helpPop.style.left = `${Math.min(r.right + 10, window.innerWidth - helpPop.offsetWidth - 12)}px`;
    helpPop.style.top = `${Math.min(r.top - 6, window.innerHeight - helpPop.offsetHeight - 12)}px`;
  } else if (!ev.target.closest?.("#help-pop")) {
    helpPop.hidden = true;
  }
});

$("btn-sat").addEventListener("click", () => setLayer("sat"));
$("btn-map").addEventListener("click", () => setLayer("map"));
function setLayer(which) {
  $("btn-sat").classList.toggle("active", which === "sat");
  $("btn-map").classList.toggle("active", which === "map");
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(
    which === "sat"
      ? WMTS("ch.swisstopo.swissimage", "jpeg", 20)
      : WMTS("ch.swisstopo.pixelkarte-farbe", "jpeg", 18)
  );
  viewer.scene.requestRender();
}

$("btn-track").addEventListener("click", () => $("file-track").click());
$("file-track").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (file) loadTrackText(await file.text(), file.name);
  ev.target.value = "";
});
$("btn-apply-fit").addEventListener("click", applyFit);
$("btn-goto-exit").addEventListener("click", gotoTrackExit);
$("btn-clear-track").addEventListener("click", clearTrack);
$("chk-ghost").addEventListener("change", updateGhost);
$("sl-aim").addEventListener("input", () => setGhostHeading(parseFloat($("sl-aim").value)));

window.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (ev) => {
  if (!ev.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", async (ev) => {
  ev.preventDefault();
  document.body.classList.remove("dragging");
  const file = ev.dataTransfer?.files?.[0];
  if (file) loadTrackText(await file.text(), file.name);
});

$("btn-close-profile").addEventListener("click", () => {
  $("profile-panel").hidden = true;
  selectedAz = null;
  dial.update({ selected: null });
  if (rayEntity) {
    viewer.entities.remove(rayEntity);
    rayEntity = null;
    viewer.scene.requestRender();
  }
  updateGhost();
  writeHash();
});

init().catch((err) => {
  console.error(err);
  status(`init failed: ${err.message}`, "error");
});
