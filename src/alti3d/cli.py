"""Command-line entry point for the wingsuit-exit finder."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from tqdm import tqdm

from . import urlcsv
from .dem import merge_tiles, tile_bounds
from .download import fetch_many
from .output import write_csv, write_kml
from .refine import refine_candidates
from .scan import ExitCandidate, ScanParams, merge_candidates, scan


def _add_threshold_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--cliff-top-drop", type=float, default=100.0,
                   help="Min drop in --cliff-top-horiz (vertical/overhang check), m (default 100)")
    p.add_argument("--cliff-top-horiz", type=float, default=2.0,
                   help="Horizontal window for vertical/overhang check, m (default 2 = one 2 m pixel)")
    p.add_argument("--cliff-drop", type=float, default=300.0,
                   help="Min drop within --cliff-horiz (tall-cliff check), m (default 300)")
    p.add_argument("--cliff-horiz", type=float, default=20.0,
                   help="Horizontal window for tall-cliff check, m (default 20)")
    p.add_argument("--glide-drop", type=float, default=500.0,
                   help="Required drop at --glide-horiz, metres (default 500)")
    p.add_argument("--glide-horiz", type=float, default=700.0,
                   help="Glide-line horizontal distance, metres (default 700)")
    p.add_argument("--azimuths", type=int, default=32,
                   help="Number of azimuths to test (default 32)")
    p.add_argument("--dedup-radius", type=float, default=50.0,
                   help="Cluster radius for deduping candidates, metres (default 50)")


def _params_from_args(args: argparse.Namespace) -> ScanParams:
    return ScanParams(
        cliff_top_drop=args.cliff_top_drop,
        cliff_top_horiz=args.cliff_top_horiz,
        cliff_drop=args.cliff_drop,
        cliff_horiz=args.cliff_horiz,
        glide_drop=args.glide_drop,
        glide_horiz=args.glide_horiz,
        azimuths=args.azimuths,
        dedup_radius_m=args.dedup_radius,
    )


def _scan_aoi(
    tiles: list[urlcsv.Tile],
    cache_dir: Path,
    params: ScanParams,
) -> list[ExitCandidate]:
    """Download tiles at 2 m and run the scanner tile-by-tile."""
    tiles_by_key = urlcsv.index_by_key(tiles)
    # Bulk-download everything up front (idempotent).
    fetch_many(tiles, 2.0, cache_dir, desc="2m download")

    all_hits: list[list[ExitCandidate]] = []
    for tile in tqdm(tiles, desc="scan", unit="tile"):
        nbrs = [tile] + list(urlcsv.neighbours(tile, tiles_by_key))
        paths = [
            cache_dir / "2" / f"{t.e_km}_{t.n_km}.tif" for t in nbrs
        ]
        # Build a full 3 km × 3 km mosaic centred on this tile; missing
        # neighbours → NaN. Forces a known interior pixel range.
        bounds = tile_bounds(tile.e_km, tile.n_km, kernel=1)
        dem = merge_tiles(paths, bounds=bounds)
        # At 2 m: each 1 km tile = 500 px. Central tile = rows/cols 500..1000.
        side = int(round(1000.0 / dem.res))
        hits = scan(
            dem,
            params=params,
            interior_row_range=(side, 2 * side),
            interior_col_range=(side, 2 * side),
        )
        if hits:
            all_hits.append(hits)

    return merge_candidates(all_hits, dedup_radius_m=params.dedup_radius_m)


def _candidates_from_csv(path: Path) -> list[ExitCandidate]:
    out: list[ExitCandidate] = []
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            out.append(
                ExitCandidate(
                    e=float(row["lv95_e"]),
                    n=float(row["lv95_n"]),
                    z=float(row["exit_z"]),
                    azimuth_deg=float(row["azimuth_deg"]),
                    cliff_drop_m=float(row["cliff_drop_m"]),
                    glide_drop_m=float(row["glide_drop_m"]),
                    min_clearance_m=float(row["min_clearance_m"]),
                    score=float(row["score"]),
                )
            )
    return out


def cmd_download(args: argparse.Namespace) -> int:
    tiles = urlcsv.parse_csv(args.tiles)
    if not tiles:
        print(f"no tiles parsed from {args.tiles}", file=sys.stderr)
        return 2
    print(f"{len(tiles)} tiles → cache {args.cache} at {args.res} m")
    fetch_many(tiles, args.res, Path(args.cache), desc=f"{args.res}m download")
    return 0


def cmd_scan(args: argparse.Namespace) -> int:
    tiles = urlcsv.parse_csv(args.tiles)
    if not tiles:
        print(f"no tiles parsed from {args.tiles}", file=sys.stderr)
        return 2
    print(f"scan {len(tiles)} tiles @ 2 m")
    params = _params_from_args(args)
    hits = _scan_aoi(tiles, Path(args.cache), params)
    print(f"{len(hits)} candidates after dedup")
    write_csv(args.out, hits)
    if args.kml:
        write_kml(args.kml, hits, params)
    return 0


def cmd_refine(args: argparse.Namespace) -> int:
    coarse = _candidates_from_csv(Path(args.input))
    if args.top is not None:
        coarse = coarse[: args.top]
    tiles = urlcsv.parse_csv(args.tiles) if args.tiles else []
    if not tiles:
        print("refine needs --tiles for the original AOI", file=sys.stderr)
        return 2
    print(f"refine {len(coarse)} hits @ 0.5 m")
    params = _params_from_args(args)
    refined = refine_candidates(coarse, tiles, Path(args.cache), params=params)
    print(f"{len(refined)} refined candidates")
    write_csv(args.out, refined)
    if args.kml:
        write_kml(args.kml, refined, params)
    return 0


def cmd_find(args: argparse.Namespace) -> int:
    tiles = urlcsv.parse_csv(args.tiles)
    if not tiles:
        print(f"no tiles parsed from {args.tiles}", file=sys.stderr)
        return 2
    params = _params_from_args(args)

    print(f"[1/2] scan {len(tiles)} tiles @ 2 m")
    coarse = _scan_aoi(tiles, Path(args.cache), params)
    print(f"      {len(coarse)} coarse candidates")
    if args.out_coarse:
        write_csv(args.out_coarse, coarse)

    top = coarse[: args.refine_top] if args.refine_top else coarse
    print(f"[2/2] refine top {len(top)} @ 0.5 m")
    refined = refine_candidates(top, tiles, Path(args.cache), params=params)
    print(f"      {len(refined)} refined candidates")
    write_csv(args.out, refined)
    if args.kml:
        write_kml(args.kml, refined, params)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="alti3d", description=__doc__)
    p.add_argument("--cache", default="./cache", help="cache directory (default ./cache)")
    sub = p.add_subparsers(dest="cmd", required=True)

    dl = sub.add_parser("download", help="download tiles at given resolution")
    dl.add_argument("--tiles", required=True, help="swisstopo URL CSV")
    dl.add_argument("--res", type=float, choices=[0.5, 2.0], required=True)
    dl.set_defaults(func=cmd_download)

    sc = sub.add_parser("scan", help="scan AOI at 2 m")
    sc.add_argument("--tiles", required=True)
    sc.add_argument("--out", required=True, help="output CSV")
    sc.add_argument("--kml", help="optional output KML")
    _add_threshold_flags(sc)
    sc.set_defaults(func=cmd_scan)

    rf = sub.add_parser("refine", help="re-score coarse hits at 0.5 m")
    rf.add_argument("--in", dest="input", required=True, help="coarse CSV")
    rf.add_argument("--tiles", required=True, help="swisstopo URL CSV (same AOI as scan)")
    rf.add_argument("--out", required=True)
    rf.add_argument("--kml")
    rf.add_argument("--top", type=int, help="only refine the top N coarse hits")
    _add_threshold_flags(rf)
    rf.set_defaults(func=cmd_refine)

    fd = sub.add_parser("find", help="end-to-end: scan + refine + write outputs")
    fd.add_argument("--tiles", required=True)
    fd.add_argument("--out", required=True, help="final (refined) CSV")
    fd.add_argument("--kml", help="final KML")
    fd.add_argument("--out-coarse", help="optional CSV of pre-refine hits")
    fd.add_argument("--refine-top", type=int, default=200,
                    help="refine top N coarse hits (default 200)")
    _add_threshold_flags(fd)
    fd.set_defaults(func=cmd_find)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
