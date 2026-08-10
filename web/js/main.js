import { wgs84ToLv95 } from "./lv95.js";
import { makeFrame } from "./frame.js";
import {
  makeProfile,
  analyzeAzimuth,
  analyzeNearField,
  verdictFor,
  nearVerdictFor,
  worseVerdict,
} from "./model.js";
import { Dem } from "./dem.js";
import { TrajectorySurface } from "./surface.js";
import { HeadingDial } from "./dial.js";
import { ProfileChart } from "./profile.js";
import { parseFlySight, segmentJump, extractFlight, fitModel } from "./track.js";
import { TrackTimeline } from "./timeline.js";
import { initPanelChrome, isPhone } from "./panel.js";

const TERRAIN_URL = "https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/";
// swisstopo only serves tiles intersecting Switzerland; without coverage
// bounds Cesium requests world tiles at low zooms and logs a 400 for each.
// Applied on the provider AND the layer — the layer clip is the strict one.
const CH_RECT = () => Cesium.Rectangle.fromDegrees(5.9, 45.7, 10.6, 47.9);
const WMTS = (layer, fmt, maxLevel) =>
  new Cesium.ImageryLayer(
    new Cesium.UrlTemplateImageryProvider({
      url: `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${fmt}`,
      maximumLevel: maxLevel,
      rectangle: CH_RECT(),
      credit: new Cesium.Credit("© swisstopo"),
    }),
    { rectangle: CH_RECT() }
  );

const AZ_COUNT = 72;
const RAY_STEP = 4;
/**
 * Verdicts judge only the first VERDICT_DROP metres of descent.
 *
 * The question a colour answers is "can I leave on this heading", and that is
 * settled early — by the part of the flight you are committed to. Terrain
 * deeper than this is a route decision with seconds of warning and a whole
 * suit's worth of options, and letting it condemn a heading drowns out the
 * near-exit signal that actually kills people. It also decouples the verdicts
 * from the range slider, which now only sets how much is drawn and charted.
 * The profile chart marks where this window ends, because terrain past it is
 * still on screen and must not read as judged.
 */
const VERDICT_DROP = 500;
const VERDICT_CSS = {
  green: "#0ca30c",
  amber: "#fab219",
  red: "#d03b3b",
  nodata: "#5c6f80",
};

const $ = (id) => document.getElementById(id);

// Canvases size themselves from clientWidth at draw time, so anything that
// changes their layout (unfolding a section, rotating the phone) must redraw.
const chrome = initPanelChrome({
  onReveal: (sec) => {
    if (sec.id === "analysis-section") dial?.draw();
    if (sec.id === "track-section") timeline?.draw();
  },
});
window.addEventListener("resize", () => {
  dial?.draw();
  timeline?.draw();
  if (chart?.state) chart.draw();
});

const statusEl = $("status");
function status(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.className = cls;
  busyMsg = cls === "busy" ? msg : null;
  refreshBusy();
}

/* ---------------- busy feedback ----------------
 * The footer status line lives inside the panel — off-screen on a phone with
 * the sheet peeked — and Cesium's tile queue had no readout at all, so any
 * camera move looked like a hang. Two indicators, one source of truth:
 * an ambient corner pill, and a centred card while an exit is computed
 * (seconds of COG range requests on an explicit user action).
 */
const busyEl = $("busy");
const workingEl = $("working");
let busyMsg = null; // our own work, mirrored from status()
let tileActive = 0; // Cesium tile requests in flight right now
let tilesLoading = false; // debounced visibility of the above
let exitWork = false; // setExitAt in flight — the card owns the message
let exitWorkToken = 0; // newest placement wins when two overlap

function refreshBusy() {
  // While the card is up it owns the screen — and only OUR phase text may
  // reach it. The ambient tile count must never leak in ("computing exit"
  // showing a base-map counter), and a momentarily empty busyMsg must not
  // blank it mid-computation, so the label is only ever overwritten, never
  // cleared. One at a time: the card already says what the pill would.
  if (exitWork) {
    if (busyMsg) $("working-label").textContent = busyMsg;
    busyEl.classList.remove("on");
    workingEl.classList.add("on");
    return;
  }
  workingEl.classList.remove("on");
  const label = busyMsg ?? (tilesLoading ? `loading map · ${tileActive}` : null);
  if (label) $("busy-label").textContent = label;
  busyEl.classList.toggle("on", label !== null);
}

/** Show the exit card; returns the finisher to call in a `finally`. */
function beginExitWork() {
  const token = ++exitWorkToken;
  exitWork = true;
  setProgress(null);
  $("working-label").textContent = "computing exit…"; // never a stale phase
  refreshBusy();
  // Placements can overlap — a second double-click lands long before the
  // first multi-second COG fetch resolves. Only the newest owns the card, so
  // a superseded one finishing first can't tear it down under the live one.
  return () => {
    if (token !== exitWorkToken) return;
    exitWork = false;
    refreshBusy();
  };
}

/** Tile-fetch progress as a determinate bar; null → indeterminate phase. */
function setProgress(a, b) {
  const bar = $("working-bar");
  const known = Number.isFinite(a) && b > 0;
  bar.hidden = !known;
  if (known) bar.style.setProperty("--progress", `${Math.round((a / b) * 100)}%`);
}

// Flips are delayed both ways: the spinner must not flash for tiles that
// resolve in two frames, nor blink off between batches while a pan settles.
// A pending timer's target is always !tilesLoading (it is only scheduled when
// they differ, and tilesLoading changes only in the callback), so the timer's
// existence IS the state — nothing else to track.
let tileFlipTimer = null;
function setTilesLoading(v, delay) {
  if (v === tilesLoading) {
    clearTimeout(tileFlipTimer); // a flip away is no longer wanted
    tileFlipTimer = null;
    return;
  }
  if (tileFlipTimer) return; // flip already scheduled
  tileFlipTimer = setTimeout(() => {
    tileFlipTimer = null;
    tilesLoading = v;
    refreshBusy();
  }, delay);
}

/**
 * Yield long enough for a paint — the ray loop below blocks the thread.
 *
 * The timer races the frame because a hidden tab never fires
 * requestAnimationFrame at all, and these yields sit inside the exit
 * placement: on a phone, backgrounding the browser during a minute of COG
 * fetches is the normal case, not the edge one, and awaiting a frame that
 * cannot arrive stalls the placement until the user comes back. Resolving a
 * promise twice is a no-op, so whichever fires first wins and the visible
 * case still yields a real frame.
 */
const nextPaint = () =>
  new Promise((r) => {
    requestAnimationFrame(() => setTimeout(r, 0));
    setTimeout(r, 100);
  });

let tilePoll = null; // interval handle; null whenever the network is settled

/**
 * dem.prepare + settle around local (x, y), reporting the phase and a
 * determinate bar. `isCurrent` gates the reporting only: a superseded caller
 * still wants its tiles cached, but must not narrate over the live one's
 * label — the card it would be writing into belongs to somebody else.
 */
async function fetchTiles(x, y, radius, label, isCurrent = () => true) {
  if (isCurrent()) status(`${label}…`, "busy");
  await dem.prepare(x, y, radius, (a, b) => {
    if (!isCurrent()) return;
    status(`${label} ${a}/${b}…`, "busy");
    setProgress(a, b);
  });
  if (isCurrent()) setProgress(null); // the phases after this have no count
  await dem.settle();
}

/* ---------------- state ---------------- */
const dem = new Dem();
let viewer;
let surface;
let dial;
let chart;
// {lon, lat, alt, frame, local: {x, y}, anchor: Cartesian3, preparedRadius}
// lon/lat is the exit's identity — what the hash carries and what a shared
// link reproduces. `frame` is the local ENU frame the DEM is sampled in and
// `local` the exit's place in it, which is the origin until snapping moves
// it; the frame stays anchored where the exit was requested so the
// near-field grid built around that point stays valid.
let exit = null;
let results = null; // per-azimuth analyzeAzimuth results
let selectedAz = null; // degrees
let armed = false;
let suppressClick = false; // eat the tap that ends a fired long-press
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
  // Vertex normals power the slope term of the Terrain material (and
  // better lighting); swisstopo's tileset serves the octvertexnormals
  // extension but it must be requested explicitly.
  const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL, {
    requestVertexNormals: true,
  });
  viewer = new Cesium.Viewer("cesium", {
    terrainProvider,
    baseLayer: WMTS("ch.swisstopo.swissimage", "jpeg", 20),
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
  // Tiles streaming in after a camera move are the most common "is it stuck?"
  // moment. Keyed on requests actually in flight, NOT globe.tilesLoaded /
  // tileLoadProgressEvent: in wide oblique views tiles park in the load queue
  // permanently (measured 100–150 of them, zero requests, hundreds of
  // thousands of refused scheduling attempts), so tilesLoaded never goes true
  // and an indicator keyed on it sticks on forever. In-flight count also gives
  // an honest readout — the queue length has no denominator to make a % from.
  // Polled, not driven off postRender: under requestRenderMode the render loop
  // is the very thing that stops when the scene goes quiet. `?? 0` matters —
  // if a Cesium upgrade moves this counter the pill goes dark rather than stuck.
  // Sampled only while something might be in flight, never as a permanent
  // heartbeat: a 4 Hz wakeup for the tab's whole life is real battery on the
  // phones this targets, and foreground tabs are not throttled. The queue
  // event is a trigger to start watching, NOT the truth about being busy —
  // that's the counter it stalls on.
  const sampleTiles = () => {
    tileActive = Cesium.RequestScheduler?.statistics?.numberOfActiveRequests ?? 0;
    // slower to clear than to appear: requests arrive in bursts with brief
    // gaps, and a blinking pill is worse than a slightly lingering one
    setTilesLoading(tileActive > 0, tileActive > 0 ? 400 : 800);
    // Live count while working, but never repaint it as "· 0" during the
    // linger — the pill would announce it is loading nothing.
    if (tilesLoading && tileActive > 0) refreshBusy();
    if (tileActive === 0 && !tilesLoading) {
      clearInterval(tilePoll); // settled: stop until something stirs again
      tilePoll = null;
    }
  };
  const watchTiles = () => {
    if (!tilePoll) tilePoll = setInterval(sampleTiles, 250);
  };
  viewer.camera.moveStart.addEventListener(watchTiles);
  viewer.scene.globe.tileLoadProgressEvent.addEventListener((n) => {
    if (n > 0) watchTiles();
  });
  watchTiles(); // the initial view streams tiles before any interaction
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

  setRelief(true); // contours + slope tint on by default

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
    // the finger-lift after a fired long-press also arrives here — swallow it
    if (suppressClick) {
      suppressClick = false;
      return;
    }
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

  // Long-press places the exit on touch — double-tap reads as "zoom" there
  // and is never discovered. A still finger held ~½ s is the map-pin idiom.
  const canvas = viewer.canvas;
  let pressTimer = null;
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  canvas.addEventListener("pointerdown", (ev) => {
    cancelPress(); // a second finger (pinch) must not fire the pending press
    if (ev.pointerType !== "touch" || !ev.isPrimary) return;
    const sx = ev.clientX;
    const sy = ev.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      arm(false);
      navigator.vibrate?.(30);
      const r = canvas.getBoundingClientRect();
      pickExit(new Cesium.Cartesian2(sx - r.left, sy - r.top));
    }, 550);
    const move = (e) => {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 12) end();
    };
    const end = () => {
      cancelPress();
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", end);
      canvas.removeEventListener("pointercancel", end);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  });

  restoreFromHash();
  if (!exit)
    status(
      matchMedia("(pointer: coarse)").matches
        ? "ready — press & hold terrain to set an exit"
        : "ready — double-click terrain to set an exit"
    );
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

/**
 * Placement generation. `dem` carries ONE frame at a time, so a placement
 * that is still awaiting tiles when the next one starts must not finish: its
 * continuation would snap, measure and publish using local coordinates read
 * against somebody else's frame — a different mountain, silently. Every
 * resumption point checks whether it is still the current placement.
 */
let exitGen = 0;

/**
 * Put `dem` back on the live exit's frame after a failed placement, which
 * leaves it anchored on the point that failed. Without this the old exit
 * survives while every sample around it is taken somewhere else entirely.
 */
async function reanchorToExit(gen) {
  if (!exit || gen !== exitGen) return;
  dem.setFrame(exit.frame);
  try {
    await dem.prepare(exit.local.x, exit.local.y, exit.preparedRadius);
    await dem.settle();
    if (gen !== exitGen) return;
    await dem.loadNearField(0, 0, 220);
  } catch (err) {
    console.error(err); // the frame guard in update() keeps this from lying
  }
}

/** Resolves true when this call is the one that placed the exit. */
async function setExitAt(lon, lat, fromHash = false, snapOpts = null) {
  const gen = ++exitGen;
  const superseded = () => gen !== exitGen;
  const endExitWork = beginExitWork();
  try {
    const p = params();
    const frame = makeFrame(lon, lat);
    dem.setFrame(frame);
    const radius = neededRadius(p);
    await fetchTiles(0, 0, radius, "fetching swissALTI3D tiles", () => !superseded());
    if (superseded()) return false;

    // 0.5 m grid loads first: the snap searches on it, and the widened
    // radius keeps 150 m near-field rays inside even after a 35 m snap.
    status("loading 0.5 m near-field…", "busy");
    await nextPaint(); // snapToLip below is a long synchronous search
    await dem.loadNearField(0, 0, 220);
    if (superseded()) return false;
    let x = 0;
    let y = 0;
    let moved = 0;
    if ($("chk-snap").checked && !fromHash) {
      const s = dem.snapToLip(0, 0, snapOpts ?? {});
      x = s.x;
      y = s.y;
      moved = s.moved;
    }
    const alt = await dem.elevationFine(x, y);
    if (superseded()) return false;
    if (!Number.isFinite(alt)) {
      status("no elevation data here", "error");
      await reanchorToExit(gen);
      return false;
    }

    // Anchor the visuals to the *rendered* terrain at the snapped spot, so
    // the cone apex sits on the mesh the user sees (analysis stays in DEM
    // space — the two heights differ by geoid offset and mesh LOD).
    const [lon2, lat2] = frame.toGeo(x, y);
    const cartos = [Cesium.Cartographic.fromDegrees(lon2, lat2)];
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos);
    if (superseded()) return false;
    const anchor = Cesium.Cartesian3.fromDegrees(lon2, lat2, cartos[0].height);

    exit = { lon: lon2, lat: lat2, alt, frame, local: { x, y }, anchor, preparedRadius: radius };
    const lv95 = wgs84ToLv95(lon2, lat2); // display only — swisstopo cross-reference
    $("exit-readout").className = "readout";
    $("exit-readout").textContent =
      `${Math.abs(lat2).toFixed(5)}°${lat2 < 0 ? "S" : "N"} ` +
      `${Math.abs(lon2).toFixed(5)}°${lon2 < 0 ? "W" : "E"}\n` +
      `LV95 ${Math.round(lv95.e)} / ${Math.round(lv95.n)}\n` +
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

    await update();
    writeHash();
    chrome.openSection("analysis-section");
    return true;
  } catch (err) {
    console.error(err);
    if (superseded()) return false;
    status(`error: ${err.message}`, "error");
    await reanchorToExit(gen);
    return false;
  } finally {
    endExitWork();
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

/**
 * True when `dem` is anchored on the frame the live exit's local coordinates
 * belong to. False while a placement is in flight or after a failed one — and
 * then sampling would silently read another mountain, so callers must bail.
 * Orthogonal to `updateGen` below: that one keeps a stale RESULT from being
 * written, this one keeps a sample from being taken in the wrong place.
 */
const demMatchesExit = () => !!exit && dem.frame === exit.frame;

/**
 * Recompute everything for the current sliders. Reports its own failures:
 * scheduleUpdate fires it as a bare timer callback, so an unhandled rejection
 * here would strand the last "busy" status — leaving the indicator spinning
 * on a frozen label forever, the exact hang this is all meant to remove.
 * `gen` drops superseded runs: every await is a chance for a newer update to
 * start and finish first, and the loser must not write stale results back.
 */
let updateGen = 0;
async function update() {
  if (!exit || !viewer || !demMatchesExit()) return;
  const gen = ++updateGen;
  const current = () => gen === updateGen && demMatchesExit();
  try {
    const p = params();
    const prof = planningProfile(p);

    surface.build(exit.anchor, prof);
    viewer.scene.requestRender();

    const radius = neededRadius(p);
    if (radius > exit.preparedRadius) {
      await fetchTiles(exit.local.x, exit.local.y, radius, "fetching more tiles", current);
      // Guard BEFORE the bookkeeping: the tiles really are cached, but if a
      // placement landed while we fetched then `exit` is a different object
      // in a different frame, and this radius was never prepared for it.
      if (!current()) return;
      exit.preparedRadius = radius;
    }

    status("analyzing…", "busy");
    // The 72-azimuth loop below blocks the thread; without a frame here the
    // indicator would only appear once the work it announces is already done.
    await nextPaint();
    if (!current()) return;
    // Clamped to the modelled range, which the slider can take below the
    // window — past hRange the profile is extrapolated, not simulated.
    const verdictDrop = Math.min(VERDICT_DROP, p.hRange);
    const maxDist = Math.min(prof.radiusAt(verdictDrop), radius);
    results = [];
    for (let i = 0; i < AZ_COUNT; i++) {
      const az = (i * 2 * Math.PI) / AZ_COUNT;
      // Near field: 0.5 m envelope + perpendicular clearance (first 150 m).
      // Far field: 2 m vertical clearance, starting where the near field ends.
      const near = analyzeNearField(prof, dem.nearRay(exit.local.x, exit.local.y, exit.alt, az));
      const samples = dem.sampleRay(exit.local.x, exit.local.y, exit.alt, az, maxDist, RAY_STEP);
      const far = analyzeAzimuth(prof, samples, { dMin: 140 });
      far.near = near;
      far.verdictDrop = verdictDrop; // the chart draws where judging stopped
      far.verdictD = maxDist;
      far.verdict = worseVerdict(nearVerdictFor(near), verdictFor(far.minClearance));
      results.push(far);
    }

    const colors = results.map((r) => VERDICT_CSS[r.verdict]);
    surface.build(exit.anchor, prof, colors, verdictDrop);
    viewer.scene.requestRender();
    dial.update({ colors, enabled: true });

    const nGreen = results.filter((r) => r.verdict === "green").length;
    const nAmber = results.filter((r) => r.verdict === "amber").length;
    status(`${nGreen * 5}° clear, ${nAmber * 5}° tight`);

    if (selectedAz !== null) selectHeading(selectedAz, true);
    writeHash();
  } catch (err) {
    console.error(err);
    status(`error: ${err.message}`, "error");
  }
}

/* ---------------- heading selection ---------------- */
function selectHeading(azDeg, keep = false) {
  if (!exit || !results || !demMatchesExit()) return;
  const i = Math.round(azDeg / (360 / AZ_COUNT)) % AZ_COUNT;
  selectedAz = (i * 360) / AZ_COUNT;
  const p = params();
  const prof = planningProfile(p);
  const bestProf = p.margin > 0 ? makeProfile(p) : null;
  const azRad = (selectedAz * Math.PI) / 180;
  const maxDist = Math.min(prof.maxRadius, exit.preparedRadius);
  const samples = dem.sampleRay(exit.local.x, exit.local.y, exit.alt, azRad, maxDist, RAY_STEP);
  const r = results[i];

  dial.update({ selected: selectedAz });
  const v = r.verdict ?? verdictFor(r.minClearance);
  const near = r.near;
  // measured rock drop from the 0.5 m envelope, model-free
  const nearSamples = dem.nearRay(exit.local.x, exit.local.y, exit.alt, azRad, 25);
  const dropAtOut = (dd) => {
    const s = nearSamples.find((q) => q.d >= dd);
    return s && Number.isFinite(s.tDrop) ? Math.round(s.tDrop) : "–";
  };
  let nearLine;
  if (near?.strike) nearLine = `wall strike ~${Math.round(near.strikeD)} m out\n`;
  else if (near && Number.isFinite(near.minRatio))
    nearLine = `air ${near.minAir.toFixed(1)} m @ ${Math.round(near.minAirD)} m out (×${near.minRatio.toFixed(1)} of needed)\n`;
  else nearLine = "";
  $("heading-stats").className = "readout";
  $("heading-stats").textContent =
    `${String(Math.round(selectedAz)).padStart(3, "0")}°T  ${v === "nodata" ? "no data" : v.toUpperCase()}\n` +
    nearLine +
    `drop @5/10/20 m out: ${dropAtOut(5)}/${dropAtOut(10)}/${dropAtOut(20)} m\n` +
    (Number.isFinite(r.minClearance)
      ? `min clearance ${Math.round(r.minClearance)} m @ ${Math.round(r.minClearanceD)} m\n`
      : "") +
    (Number.isFinite(r.requiredGlide)
      ? `required glide ${r.requiredGlide.toFixed(2)}\n`
      : "required glide — blocked\n") +
    (r.impactKind
      ? `${r.impactKind} at ${Math.round(r.impactD)} m out`
      : `airborne through ${Math.round(r.verdictDrop ?? VERDICT_DROP)} m of drop`);

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

  // On a phone the chart docks above the peeked sheet — drop the sheet the
  // first time the profile opens so chart and map are both visible.
  if ($("profile-panel").hidden && isPhone()) chrome.setSheet("peek");
  $("profile-panel").hidden = false;
  $("profile-title").textContent = `heading ${String(Math.round(selectedAz)).padStart(3, "0")}°T · exit ${Math.round(exit.alt)} m`;
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
    chrome.openSection("track-section");
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
  // Test the placement, not `exit`: a track exiting outside DEM coverage
  // leaves the PREVIOUS exit standing, and flying to it would frame a
  // different mountain with every confidence.
  if (!(await setExitAt(s.lon, s.lat, false, { radius: 35, targetAlt: s.h }))) return;

  // Camera: behind the exit, opposite the flight direction, looking along
  // it — clamped above the rendered terrain (the backdrop is often a wall).
  const carto = Cesium.Cartographic.fromCartesian(exit.anchor);
  const back = 1100;
  const rad = (h0 * Math.PI) / 180;
  const [camLon, camLat] = exit.frame.toGeo(
    exit.local.x - Math.sin(rad) * back,
    exit.local.y - Math.cos(rad) * back
  );
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
    // 7 decimals ≈ 1 cm, and the frame's toGeo/fromGeo are exact inverses,
    // so the EXIT POINT reproduces to about a centimetre. The analysis
    // around it does not reproduce quite that exactly: a restored session
    // anchors its frame on the snapped point rather than on the original
    // click, so the 0.5 m near-field lattice lands at a different phase and
    // samples the same rock through differently-placed interpolation knots.
    // Far field is unaffected; a knife-edge near-field margin can still
    // land on the other side between writer and reader.
    exit.lat.toFixed(7),
    exit.lon.toFixed(7),
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
  if (f.length < 9) return;
  const [lat, lon] = f;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  const set = (id, v) => {
    if (Number.isFinite(v)) $(id).value = v;
  };
  set("sl-v0", f[2] * KPH); // hash is m/s, sliders are km/h
  set("sl-gl", f[3]);
  set("sl-sp", f[4] * KPH);
  set("sl-ramp", f[5]);
  set("sl-hr", f[6]);
  set("sl-margin", f[7]);
  const az = f[8];
  syncOutputs();
  const anchorView = Cesium.Cartesian3.fromDegrees(lon, lat + 0.018, 3500);
  setExitAt(lon, lat, true).then((ok) => {
    if (ok && Number.isFinite(az)) selectHeading(az);
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
  if (aboutDialog.open) return; // the modal owns the keyboard; Esc closes it natively
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
  range: ["range", "How far below the exit the surface and the profile chart extend. This is a drawing control, not a safety one: verdicts always judge the first 500 m of descent and nothing deeper, whatever the range is set to. Raise it to see where a flight ends up, lower it to declutter."],
  margin: ["margin", "Safety derate: the surface, the heading verdicts and the solid chart line use sustained glide reduced by this percentage. The dotted chart line is the undiluted best estimate. 0 % means planning on your best-day numbers."],
  snap: ["snap to lip", "Clicks land on the rendered 3D mesh, which is metres coarser than the real data — usually a step back from the edge. Snapping moves the exit to the strongest nearby drop; for a track's exit it also matches the GPS altitude, since horizontal GPS error tends to put the point over the edge."],
  ghost: ["ghost", "Shows the recorded flight path, translated to the current exit with its turns preserved. Dashed violet in 3D and in the profile chart."],
  aim: ["aim", "True direction (°T) of the ghost's initial flight, taken straight from the track's Doppler velocities. It snaps to the heading you pick on the dial, then adjusts freely — the whole recorded path rotates rigidly around the exit."],
  verdicts: ["heading verdicts", "Headings are TRUE azimuths (°T) — north is true north, not grid or magnetic north; subtract your local declination to fly one off a compass. Verdicts judge the first 500 m of descent only — the part of the flight you are committed to — so terrain deeper than that never colours a heading; the profile chart marks where judging stops. Each 5° heading combines two checks and shows the worse. Near the exit (first 150 m, 0.5 m terrain dilated by position uncertainty): metres of air between the flight path and rock, which must grow as the flight develops — red under ×1 of needed, amber under ×2. Further out (2 m terrain): vertical clearance under the planning trajectory — red below 30 m, amber below 100 m."],
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

/* ---------------- about ---------------- */
const aboutDialog = $("about-dialog");
function openAbout() {
  helpPop.hidden = true;
  if (!aboutDialog.open) aboutDialog.showModal();
}
$("btn-about").addEventListener("click", openAbout);
$("lnk-about").addEventListener("click", openAbout);
$("btn-close-about").addEventListener("click", () => aboutDialog.close());
// clicking the backdrop lands on the dialog itself — its children fill it
aboutDialog.addEventListener("click", (ev) => {
  if (ev.target === aboutDialog) aboutDialog.close();
});

$("btn-sat").addEventListener("click", () => setLayer("sat"));
$("btn-map").addEventListener("click", () => setLayer("map"));

/**
 * Terrain view: 50 m contour lines + steep-slope tint rendered by the
 * globe material shader — geometry-true, unlike draped imagery, which
 * smears into vertical stripes on cliff faces. Combines with either base
 * layer and costs nothing (no extra data).
 */
let terrainMaterial = null;
function makeTerrainMaterial() {
  // Single custom-source globe material: 50 m contour lines + steep-slope
  // tint. NOTE Cesium does not auto-inject fabric uniforms into a custom
  // `source` — the GLSL must declare them itself (omitting them fails
  // silently). materialInput.slope is radians: 0.87 ≈ 50°, 1.35 ≈ 77°.
  const source = `
uniform vec4 lineColor;
uniform vec4 steepColor;
uniform float spacing;
uniform float width;
czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  float distanceToContour = mod(materialInput.height, spacing);
  float dxc = abs(dFdx(materialInput.height));
  float dyc = abs(dFdy(materialInput.height));
  float dF = max(dxc, dyc) * czm_pixelRatio * width;
  float lineA = ((distanceToContour < dF) ? 1.0 : 0.0) * lineColor.a;
  float steepA = steepColor.a * smoothstep(0.87, 1.35, materialInput.slope);
  material.diffuse = lineA >= steepA ? lineColor.rgb : steepColor.rgb;
  material.alpha = max(lineA, steepA);
  return material;
}`;
  return new Cesium.Material({
    fabric: {
      type: "DebaseTerrain",
      uniforms: {
        lineColor: Cesium.Color.fromCssColorString("#10161e").withAlpha(0.6),
        steepColor: new Cesium.Color(0.37, 0.55, 0.75, 0.5),
        spacing: 50,
        width: 1.5,
      },
      source,
    },
  });
}

function setRelief(on) {
  $("btn-terrain").classList.toggle("active", on);
  if (on && !terrainMaterial) terrainMaterial = makeTerrainMaterial();
  viewer.scene.globe.material = on ? terrainMaterial : undefined;
  viewer.scene.requestRender();
}
$("btn-terrain").addEventListener("click", () =>
  setRelief(!$("btn-terrain").classList.contains("active"))
);
function setLayer(which) {
  $("btn-sat").classList.toggle("active", which === "sat");
  $("btn-map").classList.toggle("active", which === "map");
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.add(
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
