"""CSV and KML writers for exit candidates."""

from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Iterable, Sequence
from xml.sax.saxutils import escape

from .coords import lv95_to_wgs84
from .scan import ExitCandidate, ScanParams

_CSV_COLUMNS = [
    "lv95_e",
    "lv95_n",
    "exit_z",
    "lat",
    "lon",
    "azimuth_deg",
    "cliff_drop_m",
    "glide_drop_m",
    "min_clearance_m",
    "score",
]


def write_csv(path: str | Path, candidates: Sequence[ExitCandidate]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(_CSV_COLUMNS)
        for c in candidates:
            lon, lat = lv95_to_wgs84(c.e, c.n)
            w.writerow(
                [
                    f"{c.e:.2f}",
                    f"{c.n:.2f}",
                    f"{c.z:.2f}",
                    f"{lat:.7f}",
                    f"{lon:.7f}",
                    f"{c.azimuth_deg:.1f}",
                    f"{c.cliff_drop_m:.1f}",
                    f"{c.glide_drop_m:.1f}",
                    f"{c.min_clearance_m:.1f}",
                    f"{c.score:.1f}",
                ]
            )


def _placemark(
    name: str,
    lat: float,
    lon: float,
    z: float,
    azimuth_deg: float,
    description: str,
    line_length_m: float,
) -> str:
    # End point of the azimuth indicator (rough WGS84 step, good enough for viz).
    az = math.radians(azimuth_deg)
    # 1 deg lat ≈ 111_320 m everywhere; 1 deg lon scales by cos(lat).
    d_lat = (line_length_m * math.cos(az)) / 111_320.0
    d_lon = (line_length_m * math.sin(az)) / (111_320.0 * max(0.01, math.cos(math.radians(lat))))
    end_lat = lat + d_lat
    end_lon = lon + d_lon
    return f"""    <Placemark>
      <name>{escape(name)}</name>
      <description><![CDATA[{description}]]></description>
      <styleUrl>#exit</styleUrl>
      <Point>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>{lon:.7f},{lat:.7f},{z:.1f}</coordinates>
      </Point>
    </Placemark>
    <Placemark>
      <name>{escape(name)} → {azimuth_deg:.0f}°</name>
      <styleUrl>#azline</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>
          {lon:.7f},{lat:.7f},{z:.1f}
          {end_lon:.7f},{end_lat:.7f},{z:.1f}
        </coordinates>
      </LineString>
    </Placemark>
"""


def write_kml(
    path: str | Path,
    candidates: Sequence[ExitCandidate],
    params: ScanParams,
    folder_name: str = "Wingsuit exit candidates",
) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    parts: list[str] = []
    parts.append("""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>""" + escape(folder_name) + """</name>
  <Style id="exit">
    <IconStyle>
      <color>ff0000ff</color>
      <scale>1.0</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/triangle.png</href></Icon>
    </IconStyle>
  </Style>
  <Style id="azline">
    <LineStyle>
      <color>ffffaa00</color>
      <width>2</width>
    </LineStyle>
  </Style>
""")
    for idx, c in enumerate(candidates):
        lon, lat = lv95_to_wgs84(c.e, c.n)
        desc = (
            f"exit_z = {c.z:.0f} m\n"
            f"azimuth = {c.azimuth_deg:.1f}°\n"
            f"cliff: ≥{params.cliff_top_drop:.0f} m drop in {params.cliff_top_horiz:.0f} m"
            f" (vert/overhang) and ≥{params.cliff_drop:.0f} m drop in"
            f" {params.cliff_horiz:.0f} m; reached {c.cliff_drop_m:.0f} m\n"
            f"drop @ {params.glide_horiz:.0f} m = {c.glide_drop_m:.0f} m\n"
            f"min clearance vs glide line = {c.min_clearance_m:.0f} m\n"
            f"score = {c.score:.0f}\n"
            f"LV95 = ({c.e:.0f}, {c.n:.0f})"
        )
        parts.append(
            _placemark(
                name=f"E{idx + 1} ({c.z:.0f} m)",
                lat=lat,
                lon=lon,
                z=c.z,
                azimuth_deg=c.azimuth_deg,
                description=desc,
                line_length_m=params.glide_horiz,
            )
        )
    parts.append("</Document></kml>\n")
    Path(path).write_text("".join(parts), encoding="utf-8")
