/**
 * Local east-north-up frame anchored at a WGS84 point.
 *
 * Everything the analysis does — ray marching, the near-field grid, lip
 * snapping — is metric and local. This is that metric space: x metres true
 * east, y metres true north, origin at the anchor. It is the app's only
 * angular reference, so an azimuth is a TRUE azimuth everywhere; map
 * projections exist only inside a DEM source, as a storage detail.
 *
 * The east scaling is evaluated at the MID-latitude of the offset; dropping
 * that term shears by ~2 m at 5 km. toGeo and fromGeo evaluate it
 * identically, so they are exact inverses of each other — which is what
 * makes a shared URL reproduce the session that wrote it.
 *
 * Known approximation: a line of constant y is a parallel, not a geodesic,
 * so a ray fired at azimuth θ bends away from the great circle by
 * tan(φ)/2N · d² — 4 mm at the 220 m near-field radius, 2.1 m at the 5 km
 * far-field limit. That is 0.02° of azimuth against 5° analysis sectors and
 * a 2 m DEM cell, so it is left alone rather than paid for with an
 * azimuthal-equidistant frame and a numeric inverse.
 */

const A = 6378137.0; // WGS84 semi-major axis, m
const E2 = 6.69437999014e-3; // WGS84 first eccentricity squared
const DEG = Math.PI / 180;

/** Local ENU frame at [lon0, lat0] degrees. */
export function makeFrame(lon0, lat0) {
  const s = Math.sin(lat0 * DEG);
  const w = Math.sqrt(1 - E2 * s * s);
  const M = (A * (1 - E2)) / (w * w * w); // meridian radius of curvature
  const N = A / w; // prime vertical radius of curvature

  /** local metres -> [lon, lat] degrees */
  const toGeo = (x, y) => {
    const dLat = y / M / DEG;
    const latMid = lat0 + dLat / 2;
    return [lon0 + x / (N * Math.cos(latMid * DEG)) / DEG, lat0 + dLat];
  };

  /** [lon, lat] degrees -> {x, y} local metres */
  const fromGeo = (lon, lat) => {
    const latMid = (lat0 + lat) / 2;
    return {
      x: (lon - lon0) * DEG * N * Math.cos(latMid * DEG),
      y: (lat - lat0) * DEG * M,
    };
  };

  return { lon0, lat0, toGeo, fromGeo };
}
