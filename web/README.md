# exit check — interactive wingsuit exit evaluation

Client-only web app: CesiumJS globe with swisstopo 3D terrain, satellite/map
imagery, and swissALTI3D-based clearance analysis. No backend, no API keys —
everything comes straight from swisstopo's open-data endpoints (CORS-enabled).

## Run

```sh
cd web && python3 -m http.server 8123
# open http://localhost:8123
```

Any static host works for deployment (GitHub Pages etc.).

## Use

- **Double-click** terrain (or press `E`, then click) to place an exit.
  "Snap to lip" moves the click to the strongest nearby edge — the rendered
  mesh is LOD-simplified, so raw clicks usually land a few metres back
  from the actual lip.
- Sliders: push speed, sustained glide, sustained speed, lift ramp time,
  modelled height range, and safety margin. Everything recomputes live.
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
  360°; sector colors are verdicts per 5° heading, the worse of two checks:
  - **Near field (first 150 m):** vertical clearance is ill-conditioned
    against near-vertical terrain (±0.5 m of DEM registration swings it by
    tens of metres), so close to the exit the check is *perpendicular air*
    between the flight path and a 0.5 m upper-envelope terrain, sampled
    over a distance-growing lateral swath (terrain dilated by position
    uncertainty). Required air grows with altitude lost (1 + 0.08·drop,
    capped 12 m) — clearance must *diverge*, absolute thresholds would
    condemn every big-wall launch. Red under ×1 of needed, amber under ×2.
  - **Far field:** vertical clearance under the planning trajectory on the
    2 m grid (validated to agree with 0.5 m beyond the lip zone): red
    < 30 m, amber < 100 m.
  The heading readout also shows the measured (model-free) rock drop at
  5/10/20 m out from the 0.5 m envelope.
- Click the dial (or a surface sector) to open the altitude-vs-distance
  profile for that heading, with min-clearance and landing/strike markers.
- The URL hash encodes exit + parameters + selected heading — shareable.
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

- **Visual terrain ≠ analysis terrain.** The Cesium mesh is for looking;
  all numbers are sampled from swissALTI3D COGs (2 m grid for rays, 0.5 m
  for the exit elevation) in LV95/LN02 via HTTP range requests (geotiff.js).
- The trajectory surface is anchored to the *rendered* terrain height at the
  exit (ellipsoidal), while analysis runs in DEM space — both use drops
  relative to the exit, so the geoid offset cancels.
- A trajectory meeting terrain is a **landing** when the local slope is
  < 25° at flying depth, a **strike** otherwise; clearance stats stop at the
  landing (the final flare would otherwise always read as zero clearance).

## Files

- `js/model.js` — aerodynamic ODE flight model + per-azimuth analysis
  (unit-tested headlessly with node)
- `js/dem.js` — STAC tile discovery, COG reads, lip snapping, ray sampling
- `js/lv95.js` — swisstopo approximate WGS84↔LV95 formulas (~1 m)
- `js/surface.js` — the revolved capture surface (one instance per sector)
- `js/dial.js`, `js/profile.js` — heading dial and profile chart
- `js/track.js` — FlySight parse, jump segmentation, extraction, model fit
- `js/timeline.js` — track timeline with draggable exit/deploy markers
- `js/main.js` — Cesium viewer, UI wiring, hash state
