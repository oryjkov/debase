"""Re-score coarse 2 m candidates at 0.5 m within a small window each."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Iterable

from .dem import merge_tiles
from .download import fetch_many
from .scan import ExitCandidate, ScanParams, scan, merge_candidates
from .urlcsv import Tile, index_by_key, neighbours


def refine_candidates(
    coarse: list[ExitCandidate],
    tiles: Iterable[Tile],
    cache_dir: Path,
    *,
    params: ScanParams | None = None,
    window_m: float = 100.0,
) -> list[ExitCandidate]:
    """Re-run the scanner at 0.5 m around each coarse hit.

    Tiles that contain a hit, plus their immediate neighbours (for ray
    continuity), are downloaded into `cache_dir/0.5/`. Neighbours not in
    the input AOI are silently skipped — rays pointing into the gap will
    simply fail the full-ray check.

    Returns a deduplicated, score-sorted list of refined candidates.
    """
    p = params or ScanParams()
    tiles_by_key = index_by_key(tiles)

    # Group coarse hits by the 1 km tile that contains them.
    by_tile: dict[tuple[int, int], list[ExitCandidate]] = defaultdict(list)
    for c in coarse:
        key = (int(c.e // 1000), int(c.n // 1000))
        by_tile[key].append(c)

    refined: list[ExitCandidate] = []
    for tile_key, group in by_tile.items():
        center = tiles_by_key.get(tile_key)
        if center is None:
            # The coarse hit is on a tile we don't have a URL for; skip.
            continue
        needed = [center] + list(neighbours(center, tiles_by_key))
        paths = fetch_many(
            needed, 0.5, cache_dir, desc=f"0.5m {tile_key[0]}-{tile_key[1]}"
        )
        dem = merge_tiles(paths)

        # Affine: world = transform * (col, row). Invert for (row, col).
        a = dem.transform
        # rasterio.merge produces a north-up transform: a.a > 0, a.e < 0.
        # col = (e - a.c) / a.a; row = (n - a.f) / a.e
        for c in group:
            col_f = (c.e - a.c) / a.a
            row_f = (c.n - a.f) / a.e
            row_i = int(round(row_f - 0.5))
            col_j = int(round(col_f - 0.5))
            w_pix = max(1, int(round(window_m / dem.res)))
            i_lo = max(0, row_i - w_pix)
            i_hi = min(dem.shape[0], row_i + w_pix + 1)
            j_lo = max(0, col_j - w_pix)
            j_hi = min(dem.shape[1], col_j + w_pix + 1)
            if i_hi <= i_lo or j_hi <= j_lo:
                continue
            hits = scan(
                dem,
                params=p,
                interior_row_range=(i_lo, i_hi),
                interior_col_range=(j_lo, j_hi),
            )
            if hits:
                refined.append(hits[0])

    return merge_candidates([refined], dedup_radius_m=p.dedup_radius_m)
