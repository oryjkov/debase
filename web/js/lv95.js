/**
 * WGS84 -> LV95 (EPSG:2056) using swisstopo's approximate formulas.
 * Accuracy ~1 m horizontally across Switzerland — good enough here because
 * the DEM itself is the reference; only tile addressing and sampling use this.
 * Source: swisstopo "Approximate formulas for the transformation between
 * Swiss projection coordinates and WGS84".
 *
 * This is a storage detail of the swissALTI3D tiles, not a coordinate system
 * the app thinks in: exits are WGS84 lon/lat and analysis runs in a local ENU
 * frame (frame.js). Only dem.js — and the readout's LV95 cross-reference
 * line — should ever call this.
 */

/** [lon, lat] degrees -> {e, n} LV95 metres. */
export function wgs84ToLv95(lon, lat) {
  const latA = (lat * 3600 - 169028.66) / 10000;
  const lonA = (lon * 3600 - 26782.5) / 10000;
  const e =
    2600072.37 +
    211455.93 * lonA -
    10938.51 * lonA * latA -
    0.36 * lonA * latA * latA -
    44.54 * lonA * lonA * lonA;
  const n =
    1200147.07 +
    308807.95 * latA +
    3745.25 * lonA * lonA +
    76.63 * latA * latA -
    194.56 * lonA * lonA * latA +
    119.79 * latA * latA * latA;
  return { e, n };
}
