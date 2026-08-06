import { wgs84ToLv95, lv95ToWgs84 } from "./lv95.js";
import { makeProfile, analyzeAzimuth, verdictFor } from "./model.js";
import { Dem } from "./dem.js";
import { TrajectorySurface } from "./surface.js";
import { HeadingDial } from "./dial.js";
import { ProfileChart } from "./profile.js";

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

const params = () => ({
  v0: parseFloat($("sl-v0").value),
  hTrans: parseFloat($("sl-ht").value),
  glide: parseFloat($("sl-gl").value),
  hRange: parseFloat($("sl-hr").value),
});

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
  surface = new TrajectorySurface(viewer);
  dial = new HeadingDial($("dial"), (az) => selectHeading(az));
  chart = new ProfileChart($("profile"), $("profile-tooltip"));
  dial.update({});

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

async function setExitAt(lon, lat, fromHash = false, exactLv95 = null) {
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
      const s = dem.snapToLip(e, n);
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
  const prof = makeProfile(p);

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
  const prof = makeProfile(p);
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
  chart.update(samples, prof, exit.alt, r, selectedAz);
  if (!keep) writeHash();
}

/* ---------------- share state via hash ---------------- */
function writeHash() {
  if (!exit) return;
  const p = params();
  const parts = [
    exit.e.toFixed(1),
    exit.n.toFixed(1),
    p.v0,
    p.hTrans,
    p.glide,
    p.hRange,
    selectedAz ?? "",
  ];
  history.replaceState(null, "", "#" + parts.join(","));
}

function restoreFromHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const [e, n, v0, ht, gl, hr, az] = h.split(",").map((s) => (s === "" ? null : parseFloat(s)));
  if (!Number.isFinite(e) || !Number.isFinite(n)) return;
  if (Number.isFinite(v0)) $("sl-v0").value = v0;
  if (Number.isFinite(ht)) $("sl-ht").value = ht;
  if (Number.isFinite(gl)) $("sl-gl").value = gl;
  if (Number.isFinite(hr)) $("sl-hr").value = hr;
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
  $("out-v0").textContent = `${parseFloat($("sl-v0").value).toFixed(1)} m/s`;
  $("out-ht").textContent = `${$("sl-ht").value} m`;
  $("out-gl").textContent = parseFloat($("sl-gl").value).toFixed(2);
  $("out-hr").textContent = `${$("sl-hr").value} m`;
}

for (const id of ["sl-v0", "sl-ht", "sl-gl", "sl-hr"]) {
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
  if (ev.key === "Escape") arm(false);
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

$("btn-close-profile").addEventListener("click", () => {
  $("profile-panel").hidden = true;
  selectedAz = null;
  dial.update({ selected: null });
  if (rayEntity) {
    viewer.entities.remove(rayEntity);
    rayEntity = null;
    viewer.scene.requestRender();
  }
  writeHash();
});

init().catch((err) => {
  console.error(err);
  status(`init failed: ${err.message}`, "error");
});
