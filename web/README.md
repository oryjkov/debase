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
- Sliders: push speed, dive height (altitude lost before sustained glide),
  sustained glide ratio, modelled height range. Everything recomputes live.
- The translucent surface is the two-phase trajectory (1 g dive → glide)
  revolved through 360°; sector colors are verdicts per 5° heading:
  green ≥ 100 m min clearance, amber 30–100 m, red < 30 m or strike.
- Click the dial (or a surface sector) to open the altitude-vs-distance
  profile for that heading, with min-clearance and landing/strike markers.
- The URL hash encodes exit + parameters + selected heading — shareable.

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

- `js/model.js` — two-phase flight model + per-azimuth analysis (unit-tested
  headlessly with node)
- `js/dem.js` — STAC tile discovery, COG reads, lip snapping, ray sampling
- `js/lv95.js` — swisstopo approximate WGS84↔LV95 formulas (~1 m)
- `js/surface.js` — the revolved capture surface (one instance per sector)
- `js/dial.js`, `js/profile.js` — heading dial and profile chart
- `js/main.js` — Cesium viewer, UI wiring, hash state
