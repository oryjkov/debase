"""Read cached SwissALTI3D .tif tiles via rasterio.

The scanner operates on a numpy DEM array plus an affine transform. We
deliberately keep all reads local: paths point at files in the cache directory
that the downloader has fully fetched.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import rasterio
from rasterio.merge import merge as rio_merge
from rasterio.transform import Affine


@dataclass
class Dem:
    """A north-up DEM mosaic in LV95 (EPSG:2056) units (metres)."""

    z: np.ndarray        # shape (H, W), float32, NaN for NoData/missing
    transform: Affine    # rasterio affine: world = transform * (col, row)
    res: float           # pixel size in metres (square pixels)

    @property
    def shape(self) -> tuple[int, int]:
        return self.z.shape  # type: ignore[return-value]

    @property
    def origin_xy(self) -> tuple[float, float]:
        # transform * (0, 0) is the top-left pixel corner in LV95.
        return self.transform.c, self.transform.f

    def world_xy(self, row: np.ndarray, col: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Return LV95 (E, N) at pixel centres (row, col)."""
        a = self.transform
        e = a.a * (col + 0.5) + a.b * (row + 0.5) + a.c
        n = a.d * (col + 0.5) + a.e * (row + 0.5) + a.f
        return e, n


def _read_one(path: Path) -> tuple[np.ndarray, Affine, float | None]:
    with rasterio.open(path) as src:
        z = src.read(1, masked=False).astype(np.float32)
        nodata = src.nodata
        if nodata is not None:
            z = np.where(z == nodata, np.float32("nan"), z)
        return z, src.transform, nodata


def read_full(path: str | Path) -> Dem:
    z, transform, _ = _read_one(Path(path))
    return Dem(z=z, transform=transform, res=float(abs(transform.a)))


def merge_tiles(
    paths: Sequence[str | Path],
    bounds: tuple[float, float, float, float] | None = None,
) -> Dem:
    """Mosaic the given tiles into a single north-up DEM. NoData → NaN.

    All tiles must share the same resolution and CRS (true for swisstopo
    sibling tiles). When `bounds=(left, bottom, right, top)` is given the
    output covers exactly that LV95 area; pixels not backed by any input
    tile come out as NaN.
    """
    if not paths:
        raise ValueError("merge_tiles called with no paths")

    datasets = [rasterio.open(str(p)) for p in paths]
    try:
        mosaic, transform = rio_merge(datasets, bounds=bounds)
        z = mosaic[0].astype(np.float32)
        nodata = datasets[0].nodata
        if nodata is not None:
            z = np.where(z == nodata, np.float32("nan"), z)
        res = float(abs(transform.a))
        return Dem(z=z, transform=transform, res=res)
    finally:
        for ds in datasets:
            ds.close()


def tile_bounds(e_km: int, n_km: int, kernel: int = 1) -> tuple[float, float, float, float]:
    """LV95 (left, bottom, right, top) for the (2*kernel+1)² tile mosaic centred
    on `(e_km, n_km)`. `kernel=1` ⇒ 3×3 tiles ⇒ 3 km × 3 km.
    """
    half = kernel
    return (
        (e_km - half) * 1000.0,
        (n_km - half) * 1000.0,
        (e_km + half + 1) * 1000.0,
        (n_km + half + 1) * 1000.0,
    )
