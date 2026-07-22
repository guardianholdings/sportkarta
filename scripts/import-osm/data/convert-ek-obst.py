#!/usr/bin/env python3
"""Convert NSI's ek_obst.xlsx (EKATTE municipality register) to
ekatte-municipalities.csv. Stdlib only — see README.md for provenance.

Usage: python3 convert-ek-obst.py <path-to-ek_obst.xlsx>
"""

import csv
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def main(xlsx_path: str) -> None:
    z = zipfile.ZipFile(xlsx_path)
    shared = [
        "".join(t.text or "" for t in si.iter(f"{{{M}}}t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(f"{{{M}}}si")
    ]
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))

    rows = []
    for row in sheet.iter(f"{{{M}}}row"):
        cells = {}
        for c in row.findall(f"{{{M}}}c"):
            col = re.match(r"[A-Z]+", c.get("r")).group()
            v = c.find(f"{{{M}}}v")
            if v is not None:
                cells[col] = shared[int(v.text)] if c.get("t") == "s" else v.text
        # A = municipality code, D = name_bg, E = official transliteration.
        code = cells.get("A", "")
        if re.fullmatch(r"[A-Z]{3}\d{2}", code):
            rows.append((code, cells.get("D", "").strip(), cells.get("E", "").strip()))

    rows.sort()
    if len(rows) != 265:
        sys.exit(f"expected 265 municipalities, got {len(rows)} — inspect the source file")
    if not all(name_bg and name_en for _, name_bg, name_en in rows):
        sys.exit("blank names found — inspect the source file")

    out = Path(__file__).parent / "ekatte-municipalities.csv"
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ekatte_code", "name_bg", "name_en"])
        w.writerows(rows)
    print(f"wrote {len(rows)} rows to {out}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
