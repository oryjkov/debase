"""Parse swisstopo URL-list CSVs and rewrite URLs to (.tif, target resolution)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

_URL_RE = re.compile(
    r"https://data\.geo\.admin\.ch/ch\.swisstopo\.swissalti3d/"
    r"swissalti3d_(?P<year>\d{4})_(?P<e>\d{4})-(?P<n>\d{4})/"
    r"swissalti3d_\d{4}_\d{4}-\d{4}_(?P<res>0\.5|2|5|10)_2056_5728"
    r"\.(?P<ext>tif|xyz\.zip)"
)

_ALLOWED_RES = (0.5, 2)


@dataclass(frozen=True)
class Tile:
    year: int
    e_km: int
    n_km: int
    src_url: str

    @property
    def key(self) -> tuple[int, int]:
        return (self.e_km, self.n_km)


def parse_csv(path: str | Path) -> list[Tile]:
    """Parse a swisstopo URL CSV. Lines that don't match the URL regex are skipped."""
    tiles: list[Tile] = []
    seen: set[tuple[int, int]] = set()
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            m = _URL_RE.match(line)
            if not m:
                continue
            key = (int(m["e"]), int(m["n"]))
            if key in seen:
                continue
            seen.add(key)
            tiles.append(
                Tile(
                    year=int(m["year"]),
                    e_km=key[0],
                    n_km=key[1],
                    src_url=line,
                )
            )
    return tiles


def url_for(tile: Tile, res: float) -> str:
    """Return the .tif URL for `tile` at `res` (0.5 or 2). Always returns a .tif URL.

    The input tile.src_url may use .xyz.zip or .tif and any resolution; both the
    resolution segment and the extension are rewritten.
    """
    if res not in _ALLOWED_RES:
        raise ValueError(
            f"resolution {res} not available from swisstopo; pick one of {_ALLOWED_RES}"
        )
    res_str = ("0.5" if res == 0.5 else "2")
    return (
        f"https://data.geo.admin.ch/ch.swisstopo.swissalti3d/"
        f"swissalti3d_{tile.year}_{tile.e_km}-{tile.n_km}/"
        f"swissalti3d_{tile.year}_{tile.e_km}-{tile.n_km}_{res_str}_2056_5728.tif"
    )


def neighbours(tile: Tile, tiles_by_key: dict[tuple[int, int], Tile]) -> Iterator[Tile]:
    """Yield up to 8 neighbour tiles that exist in the provided index."""
    for de in (-1, 0, 1):
        for dn in (-1, 0, 1):
            if de == 0 and dn == 0:
                continue
            k = (tile.e_km + de, tile.n_km + dn)
            if k in tiles_by_key:
                yield tiles_by_key[k]


def index_by_key(tiles: Iterable[Tile]) -> dict[tuple[int, int], Tile]:
    return {t.key: t for t in tiles}
