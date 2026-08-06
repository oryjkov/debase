"""Download swisstopo .tif tiles to a local cache directory.

Cache layout: <cache_dir>/<res>/<E>_<N>.tif. Partial writes go to .tmp and are
renamed on success so a crash never leaves a corrupt cached tile.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable

import requests
from tqdm import tqdm

from .urlcsv import Tile, url_for

_CHUNK = 1 << 16  # 64 KiB


def _cache_path(cache_dir: Path, tile: Tile, res: float) -> Path:
    res_str = "0.5" if res == 0.5 else "2"
    return cache_dir / res_str / f"{tile.e_km}_{tile.n_km}.tif"


def _remote_size(url: str, session: requests.Session) -> int | None:
    r = session.head(url, allow_redirects=True, timeout=30)
    if r.status_code != 200:
        return None
    cl = r.headers.get("content-length")
    return int(cl) if cl else None


def fetch(
    tile: Tile,
    res: float,
    cache_dir: Path,
    session: requests.Session | None = None,
) -> Path:
    """Return the local path to `tile` at `res`, downloading if not cached.

    Idempotent: if the cached file already exists and matches the server's
    content-length, it is reused as-is.
    """
    cache_dir = Path(cache_dir)
    dest = _cache_path(cache_dir, tile, res)
    dest.parent.mkdir(parents=True, exist_ok=True)

    url = url_for(tile, res)
    sess = session or requests.Session()

    remote_size = _remote_size(url, sess)
    if remote_size is None:
        raise RuntimeError(f"HEAD failed for {url}")

    if dest.exists() and dest.stat().st_size == remote_size:
        return dest

    tmp = dest.with_suffix(dest.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()

    with sess.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(_CHUNK):
                if chunk:
                    f.write(chunk)

    if tmp.stat().st_size != remote_size:
        tmp.unlink()
        raise RuntimeError(
            f"size mismatch for {url}: got {tmp.stat().st_size}, expected {remote_size}"
        )
    os.replace(tmp, dest)
    return dest


def fetch_many(
    tiles: Iterable[Tile],
    res: float,
    cache_dir: Path,
    workers: int = 6,
    desc: str | None = None,
) -> list[Path]:
    """Download many tiles concurrently. Returns paths in the same order as input."""
    tiles = list(tiles)
    if not tiles:
        return []
    cache_dir = Path(cache_dir)
    paths: list[Path | None] = [None] * len(tiles)
    session = requests.Session()

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {
            ex.submit(fetch, t, res, cache_dir, session): i for i, t in enumerate(tiles)
        }
        bar = tqdm(
            total=len(tiles),
            desc=desc or f"download {res}m",
            unit="tile",
            leave=False,
        )
        try:
            for fut in as_completed(futures):
                i = futures[fut]
                paths[i] = fut.result()
                bar.update(1)
        finally:
            bar.close()

    assert all(p is not None for p in paths)
    return [p for p in paths if p is not None]
