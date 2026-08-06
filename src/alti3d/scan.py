"""Wingsuit-exit scanner: per-cell ray-cast against a north-up DEM mosaic.

For each candidate cell we test 32 azimuths. A cell qualifies in direction θ when:

  - "cliff":   max drop within `CLIFF_HORIZ` metres ≥ `CLIFF_DROP_MIN`
  - "glide":   at every sample out to `GLIDE_HORIZ`, ground ≤ glide line, where
               glide line at distance d is exit_z - d * (GLIDE_DROP_MIN/GLIDE_HORIZ)
  - "final":   drop at `GLIDE_HORIZ` ≥ `GLIDE_DROP_MIN`

The cell is reported if ANY azimuth qualifies. The recorded `azimuth_deg` is
the one with the highest `cliff_drop + min_clearance` score.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .dem import Dem


@dataclass
class ScanParams:
    # "Rock-drop" check — at the very next pixel along the ray, the drop must
    # already be ≥ `cliff_top_drop`. With cliff_top_horiz = 2 m at 2 m DEM
    # this is "next pixel is ≥ 100 m below me" → effectively a vertical or
    # overhanging face. The DEM cannot represent overhangs directly, so this
    # check is one-sided: overhanging walls always pass; truly vertical walls
    # *may* pass depending on lip-vs-pixel alignment. The 0.5 m refinement
    # step resolves the alignment ambiguity.
    cliff_top_drop: float = 100.0
    cliff_top_horiz: float = 2.0
    # "Tall-cliff" check — within `cliff_horiz`, total drop must be ≥ `cliff_drop`.
    # Defaults: 300 m in 20 m horizontal ⇒ arctan(300/20) ≈ 86° average across
    # the full cliff height.
    cliff_drop: float = 300.0
    cliff_horiz: float = 20.0
    glide_drop: float = 500.0
    glide_horiz: float = 700.0
    azimuths: int = 32
    dedup_radius_m: float = 50.0


@dataclass
class ExitCandidate:
    e: float
    n: float
    z: float
    azimuth_deg: float
    cliff_drop_m: float
    glide_drop_m: float
    min_clearance_m: float
    score: float


def scan(
    dem: Dem,
    *,
    params: ScanParams | None = None,
    interior_row_range: tuple[int, int] | None = None,
    interior_col_range: tuple[int, int] | None = None,
) -> list[ExitCandidate]:
    """Find exit candidates inside `dem`.

    By default the whole DEM is scanned. To scan only the central tile of a
    3×3 mosaic, pass `interior_row_range=(500, 1000)` and the matching
    `interior_col_range` (in pixels) so rays don't run off the loaded area.
    """
    p = params or ScanParams()
    z = dem.z
    H, W = z.shape
    res = dem.res

    i_lo, i_hi = interior_row_range or (0, H)
    j_lo, j_hi = interior_col_range or (0, W)
    Hc, Wc = i_hi - i_lo, j_hi - j_lo
    if Hc <= 0 or Wc <= 0:
        return []

    exit_z = z[i_lo:i_hi, j_lo:j_hi][:, :, None].astype(np.float32)  # (Hc, Wc, 1)

    L = int(round(p.glide_horiz / res)) + 1
    dists = np.arange(L, dtype=np.float32) * res                   # (L,)
    glide_line_drop = dists * (p.glide_drop / p.glide_horiz)       # (L,)
    cliff_pix = max(2, int(round(p.cliff_horiz / res)) + 1)
    cliff_top_pix = max(2, int(round(p.cliff_top_horiz / res)) + 1)

    # Tracking arrays for the best azimuth per cell.
    best_score = np.full((Hc, Wc), -np.inf, dtype=np.float32)
    best_az_k = np.full((Hc, Wc), -1, dtype=np.int16)
    best_cliff_drop = np.zeros((Hc, Wc), dtype=np.float32)
    best_final_drop = np.zeros((Hc, Wc), dtype=np.float32)
    best_min_clear = np.zeros((Hc, Wc), dtype=np.float32)
    any_valid = np.zeros((Hc, Wc), dtype=bool)

    rows_c = np.arange(i_lo, i_hi, dtype=np.int32)[:, None, None]   # (Hc,1,1)
    cols_c = np.arange(j_lo, j_hi, dtype=np.int32)[None, :, None]   # (1,Wc,1)

    azimuth_rad = 2 * np.pi * np.arange(p.azimuths) / p.azimuths

    for k, theta in enumerate(azimuth_rad):
        # Compass azimuth: 0 = north, increases clockwise. dx is east, dy is
        # north (world). On a north-up DEM, north corresponds to *decreasing*
        # row index.
        dE = float(np.sin(theta))
        dN = float(np.cos(theta))
        drow = np.rint(-dists * dN / res).astype(np.int32)          # (L,)
        dcol = np.rint(dists * dE / res).astype(np.int32)           # (L,)

        sr = rows_c + drow[None, None, :]                            # (Hc,Wc,L)
        sc = cols_c + dcol[None, None, :]
        on_grid = (sr >= 0) & (sr < H) & (sc >= 0) & (sc < W)
        sr = np.clip(sr, 0, H - 1)
        sc = np.clip(sc, 0, W - 1)
        rays = z[sr, sc]                                             # (Hc,Wc,L)
        rays = np.where(on_grid, rays, np.float32("nan"))

        drops = exit_z - rays                                        # (Hc,Wc,L)

        # Two cliff checks: a tiny window enforcing vertical/overhang at the
        # very top, and a wider window enforcing the full cliff height.
        cliff_top = np.nanmax(drops[:, :, :cliff_top_pix], axis=-1)
        cliff_top = np.where(np.isnan(cliff_top), -np.inf, cliff_top)
        cliff = np.nanmax(drops[:, :, :cliff_pix], axis=-1)
        cliff = np.where(np.isnan(cliff), -np.inf, cliff)

        # Glide-line clearance at every sample.
        clearance = drops - glide_line_drop                          # (Hc,Wc,L)
        min_clear = np.nanmin(clearance, axis=-1)
        min_clear = np.where(np.isnan(min_clear), -np.inf, min_clear)

        final = drops[:, :, -1]
        final = np.where(np.isnan(final), -np.inf, final)

        # Entire ray must lie inside the mosaic — no NaN samples allowed.
        full_ray = ~np.any(np.isnan(rays), axis=-1)

        valid = (
            (cliff_top >= p.cliff_top_drop)
            & (cliff >= p.cliff_drop)
            & (min_clear >= 0.0)
            & (final >= p.glide_drop)
            & full_ray
        )

        score = np.where(valid, cliff + min_clear, -np.inf)
        better = score > best_score
        best_score = np.where(better, score, best_score)
        best_az_k = np.where(better, k, best_az_k)
        best_cliff_drop = np.where(better, cliff, best_cliff_drop)
        best_final_drop = np.where(better, final, best_final_drop)
        best_min_clear = np.where(better, min_clear, best_min_clear)
        any_valid |= valid

    if not any_valid.any():
        return []

    # Dedup with a grid-bin: keep the highest-elevation hit per bin.
    bin_pix = max(1, int(round(p.dedup_radius_m / res)))
    hit_rows, hit_cols = np.where(any_valid)
    hit_z = z[hit_rows + i_lo, hit_cols + j_lo]

    bin_key = (hit_rows // bin_pix).astype(np.int64) * (W // bin_pix + 2) + (
        hit_cols // bin_pix
    )
    order = np.argsort(bin_key, kind="stable")
    bin_key = bin_key[order]
    hit_rows = hit_rows[order]
    hit_cols = hit_cols[order]
    hit_z = hit_z[order]

    keep_idx: list[int] = []
    i = 0
    n = len(bin_key)
    while i < n:
        j = i
        while j < n and bin_key[j] == bin_key[i]:
            j += 1
        # within [i, j) pick the highest z
        local = np.arange(i, j)
        keep_idx.append(int(local[np.argmax(hit_z[i:j])]))
        i = j

    keep_idx_arr = np.asarray(keep_idx, dtype=np.int64)
    sel_rows = hit_rows[keep_idx_arr] + i_lo
    sel_cols = hit_cols[keep_idx_arr] + j_lo

    e_world, n_world = dem.world_xy(sel_rows, sel_cols)

    az_k = best_az_k[hit_rows[keep_idx_arr], hit_cols[keep_idx_arr]]
    azimuth_deg = az_k.astype(np.float32) * (360.0 / p.azimuths)
    cliff_drop_m = best_cliff_drop[hit_rows[keep_idx_arr], hit_cols[keep_idx_arr]]
    final_drop_m = best_final_drop[hit_rows[keep_idx_arr], hit_cols[keep_idx_arr]]
    min_clear_m = best_min_clear[hit_rows[keep_idx_arr], hit_cols[keep_idx_arr]]
    scores = best_score[hit_rows[keep_idx_arr], hit_cols[keep_idx_arr]]
    z_exit = z[sel_rows, sel_cols]

    out: list[ExitCandidate] = []
    for i_out in range(len(sel_rows)):
        out.append(
            ExitCandidate(
                e=float(e_world[i_out]),
                n=float(n_world[i_out]),
                z=float(z_exit[i_out]),
                azimuth_deg=float(azimuth_deg[i_out]),
                cliff_drop_m=float(cliff_drop_m[i_out]),
                glide_drop_m=float(final_drop_m[i_out]),
                min_clearance_m=float(min_clear_m[i_out]),
                score=float(scores[i_out]),
            )
        )
    out.sort(key=lambda c: c.score, reverse=True)
    return out


def merge_candidates(
    groups: Sequence[Sequence[ExitCandidate]],
    dedup_radius_m: float = 50.0,
) -> list[ExitCandidate]:
    """Merge candidate lists from multiple tile scans, deduplicating overlaps."""
    everything: list[ExitCandidate] = [c for g in groups for c in g]
    if not everything:
        return []
    # bin in LV95 metres
    bin_size = dedup_radius_m
    by_bin: dict[tuple[int, int], ExitCandidate] = {}
    for c in everything:
        key = (int(c.e // bin_size), int(c.n // bin_size))
        cur = by_bin.get(key)
        if cur is None or c.z > cur.z:
            by_bin[key] = c
    out = list(by_bin.values())
    out.sort(key=lambda c: c.score, reverse=True)
    return out
