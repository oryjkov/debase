# debase — interactive wingsuit exit evaluation

Live at <https://oryjkov.github.io/debase/>.

Client-only web app: CesiumJS globe with swisstopo 3D terrain, satellite/map
imagery, and swissALTI3D-based clearance analysis. No backend, no API keys —
everything comes straight from swisstopo's open-data endpoints (CORS-enabled).

## Run

```sh
cd web && python3 -m http.server 8123
# open http://localhost:8123
node --test 'web/js/*.test.js'   # from the repo root
```

Any static host works for deployment (GitHub Pages etc.).

## Use

- **Double-click** terrain (or press `E`, then click) to place an exit.
  "Snap to lip" moves the click to the nearby edge — the rendered mesh is
  LOD-simplified, so raw clicks usually land a few metres off the actual
  lip. The search runs on the 0.5 m grid and is built to stay ON the lip:
  the edge-drop reward is capped (so ever-growing drop can't drag the
  point down the face) and candidates with terrain rising above them
  nearby are penalized (standing under the wall, not on top of it).
- Sliders: push speed, sustained glide, sustained speed, lift ramp time,
  modelled height range, and safety margin. Everything recomputes live.
  **Range is a drawing control, not a safety one** — it sets how far the
  surface and chart extend, and moving it does not change a single verdict.
- The flight model is point-mass aerodynamics (gravity + drag + lift,
  RK4-integrated, air density scaling with altitude): sustained glide and
  speed define the drag/lift coefficients; lift ramps in over the first
  seconds (suit pressurization). Validated against a real FlySight jump
  within ~5 m over the first 400 m — the piecewise dive-then-glide model
  it replaced ignored the horizontal acceleration lift produces during
  the dive and was ~50 m wrong there.
- The **margin** slider derates sustained glide for the *planning* profile
  that drives the surface, verdicts, and chart (best-estimate shown dotted
  alongside). Safety is a visible knob, never baked into the fit.
- The translucent surface is the planning trajectory revolved through
  360°; sector colors are verdicts per 5° heading, the worse of two checks.
  Both judge only the **first 500 m of descent** — the part of the flight
  you are committed to. Deeper terrain is a route decision with seconds of
  warning and a suit's worth of options, and letting it condemn a heading
  buries the near-exit signal that matters; the profile chart shades and
  labels everything past the window so it cannot read as judged.
  - **Near field (first 150 m):** vertical clearance is ill-conditioned
    against near-vertical terrain (±0.5 m of DEM registration swings it by
    tens of metres), so close to the exit the check is *perpendicular air*
    between the flight path and a 0.5 m upper-envelope terrain, sampled
    over a distance-growing lateral swath (terrain dilated by position
    uncertainty). Required air grows with altitude lost (1 + 0.08·drop,
    capped 12 m) — clearance must *diverge*, absolute thresholds would
    condemn every big-wall launch. Red under ×1 of needed, amber under ×2.
  - **Far field (to 500 m of drop):** vertical clearance under the planning
    trajectory on the 2 m grid (validated to agree with 0.5 m beyond the lip
    zone): red < 30 m, amber < 100 m.
  The heading readout also shows the measured (model-free) rock drop at
  5/10/20 m out from the 0.5 m envelope.
- Click the dial (or a surface sector) to open the altitude-vs-distance
  profile for that heading, with min-clearance and landing/strike markers.
  Headings are **true** azimuths (`°T`) — subtract your local magnetic
  declination to fly one off a compass.
- The URL hash encodes exit + parameters + selected heading — shareable.
  The exit is WGS84 `lat,lon` at 7 decimals (~1 cm), and since the local
  frame's forward and inverse are exact inverses, the exit *point* restores
  to about that. The analysis around it is very slightly less deterministic:
  a restored session anchors its frame on the snapped exit rather than on
  the original click, so the 0.5 m near-field lattice sits at a different
  phase and interpolates the same rock from differently-placed knots. The
  2 m far field is unaffected; a knife-edge near-field margin can flip.
  Links minted before the coordinate rework carried LV95 eastings and are
  not readable.
- **About** (the `i` in the toolbar, or `about` in the panel footer) opens a
  modal with the data provenance — which swisstopo product each number and
  each pixel comes from — and the disclaimer: rendered mesh ≠ analysed
  terrain, ~0.5 m of positional uncertainty against vertical rock, verdicts
  blind past 500 m of descent, no wind or wires or weather anywhere in the
  model. It is the one place that says plainly that this is a planning aid
  and the risk is the reader's.
- **Coordinates** (the input beside *Set exit point*) take decimal
  lat/lon — `46.5569512,7.9865774`, space-separated, or a paste with
  parentheses/degree marks. Enter flies the camera there and, unlike
  Locate, also places the exit: a typed fix is deliberate and precise.
  Snap-to-lip applies as it would to a click. Outside Swiss coverage it
  only flies, and says so.
- **Locate** (the crosshair in the toolbar) flies the camera to the device's
  position — GPS on a phone, Wi-Fi/IP on a desktop. Camera only: desktop
  geolocation is routinely kilometres off, so it never places an exit; the
  user still clicks that in. Needs a secure context (HTTPS or localhost)
  and the browser's location permission.
- **Relief** (toolbar toggle, on by default) overlays 50 m contour lines
  and a steel-blue tint on slopes steeper than ~50°, on top of either
  base layer (Satellite/Map are the exclusive pair; Relief is additive). Draped imagery
  smears into vertical stripes on cliff faces; these are computed in the
  globe shader from geometry, so walls actually read. (Two Cesium gotchas
  cost this feature a debugging session: custom fabric `source` GLSL and
  any use of `materialInput.slope` silently renders nothing unless the
  terrain provider was created with `requestVertexNormals: true`.)
- **Track calibration:** load (or drag-drop) a FlySight CSV — original
  format or FlySight 2 `TRACK.CSV` (the `$COL,GNSS`-framed one; the other
  session files, SENSOR/EVENT/RAW, aren't needed). Exit and
  deployment are auto-detected from the Doppler velocities (draggable
  markers to adjust), and the ODE model is fitted to the velocity time
  series with a robust Huber loss — pilot-input segments (a mid-flight
  dive) get downweighted rather than chased, and the fit is a symmetric
  best estimate (margins are applied downstream, visibly). "Apply fitted
  model" pushes glide/speed/ramp/push into the sliders; the measured curve
  shows dashed in the profile chart, and a dashed "ghost" of the actual 3D
  path renders over terrain. The **aim** slider sets the ghost's initial flight direction
  (0–359°); it snaps to the heading you pick on the dial, then adjusts
  freely — turns in the track stay rigid, only the whole path rotates.
  "Go to exit" flies to the track's recorded exit, places the evaluation
  exit there and aims the ghost as flown; the snap uses the GPS altitude
  as a hint, because horizontal GPS error routinely drops the reported
  point over the edge onto the face below the real exit. It also sets the
  scene clock to the recorded exit moment and enables globe lighting, so
  sun/moon position and terrain shading match the actual jump conditions.

## Design rules

- **An exit is WGS84 lon/lat; analysis happens in a local ENU frame.** The
  frame is anchored where the exit was requested, x metres true east and y
  metres true north (`js/frame.js`), and it is the app's only angular
  reference — so an azimuth is a true azimuth in the rays, on the dial, on
  the surface, and in a track's Doppler heading, with nothing to convert
  between them. Map projections live inside a DEM source as a storage
  detail: `js/dem.js` calibrates an affine local→LV95 per exit (which comes
  out as rotation by the meridian convergence — −1° to +1.75° across
  Switzerland — times 1/k) and nothing outside it needs to know. Sampling
  the tiles' grid at an angle is also why the 0.5 m near-field composite is
  built in LV95 first and resampled into the frame second: interpolating
  straight into the frame cannot cross a 1 km tile join.
- **Visual terrain ≠ analysis terrain.** The Cesium mesh is for looking;
  all numbers are sampled from swissALTI3D COGs (2 m grid for rays, 0.5 m
  for the exit elevation) in LV95/LN02 via HTTP range requests (geotiff.js).
- The trajectory surface is anchored to the *rendered* terrain height at the
  exit (ellipsoidal), while analysis runs in DEM space — both use drops
  relative to the exit, so the geoid offset cancels. The one place two
  vertical datums are compared directly is the snap's `targetAlt` (a
  receiver's MSL against LN02), and it is compared through a dead zone wide
  enough to swallow the difference rather than be steered by it.
- A trajectory meeting terrain is a **landing** when the local slope is
  < 25° at flying depth, a **strike** otherwise; clearance stats stop at the
  landing (the final flare would otherwise always read as zero clearance).

## Files

- `js/model.js` — aerodynamic ODE flight model + per-azimuth analysis
  (unit-tested headlessly with node)
- `js/frame.js` — local ENU frame at an exit; the app's metric space
- `js/dem.js` — STAC tile discovery, COG reads, lip snapping, ray sampling;
  owns the local→LV95 projection
- `js/lv95.js` — swisstopo approximate WGS84→LV95 formula (~1 m)
- `js/surface.js` — the revolved capture surface (one instance per sector)
- `js/dial.js`, `js/profile.js` — heading dial and profile chart
- `js/track.js` — FlySight parse, jump segmentation, extraction, model fit
- `js/timeline.js` — track timeline with draggable exit/deploy markers
- `js/main.js` — Cesium viewer, UI wiring, hash state
