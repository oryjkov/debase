/**
 * WGS84 <-> LV95 (EPSG:2056) using swisstopo's approximate formulas.
 * Accuracy ~1 m horizontally across Switzerland — good enough here because
 * the DEM itself is the reference; only tile addressing and sampling use this.
 * Source: swisstopo "Approximate formulas for the transformation between
 * Swiss projection coordinates and WGS84".
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

/** {e, n} LV95 metres -> [lon, lat] degrees. */
export function lv95ToWgs84(e, n) {
  const y = (e - 2600000) / 1000000;
  const x = (n - 1200000) / 1000000;
  const lonA =
    2.6779094 +
    4.728982 * y +
    0.791484 * y * x +
    0.1306 * y * x * x -
    0.0436 * y * y * y;
  const latA =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.014 * x * x * x;
  return [lonA * 100 / 36, latA * 100 / 36];
}

/**
 * Approximate geoid offset: WGS84 ellipsoidal height minus LN02 height at
 * this location. Used only for cross-checking Cesium picks against the DEM.
 */
export function ellipsoidMinusLn02(e, n) {
  const y = (e - 2600000) / 1000000;
  const x = (n - 1200000) / 1000000;
  return 49.55 - 12.6 * y - 22.64 * x;
}
