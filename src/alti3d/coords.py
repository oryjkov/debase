"""LV95 (EPSG:2056) ↔ WGS84 (EPSG:4326) coordinate transforms."""

from __future__ import annotations

import numpy as np
from pyproj import Transformer

_to_wgs84 = Transformer.from_crs(2056, 4326, always_xy=True)
_to_lv95 = Transformer.from_crs(4326, 2056, always_xy=True)


def lv95_to_wgs84(e: float | np.ndarray, n: float | np.ndarray):
    """LV95 easting/northing (m) → (lon, lat) in degrees."""
    return _to_wgs84.transform(e, n)


def wgs84_to_lv95(lon: float | np.ndarray, lat: float | np.ndarray):
    """(lon, lat) degrees → LV95 easting/northing (m)."""
    return _to_lv95.transform(lon, lat)
