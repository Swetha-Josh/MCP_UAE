#!/usr/bin/env python3
"""
Builds datasets.json from the FCSC deep-links spreadsheet.

One-off build step: re-run whenever the spreadsheet changes.
    python3 scripts/build-manifest.py "/path/to/FCSC- MOBILE APP- Deep links.xlsx"

Column layout in the sheet (row 2 is the header):
    B Main Topic | C Sub Topic | D KPI | E Dataset Link | F Dataset Name
    G Structure query | H SDMX flavour (Flat) | I SDMX flavour (Time series)

The sheet has known defects, so we don't trust column H blindly:
  - row 18 (DF_POP) is shifted one column right
  - 19 rows carry the flat URL in the time-series column
We therefore scan G/H/I for the first /rest/data/ URL and normalise it into the
flat flavour ourselves.
"""
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

FLAT_PARAM = "dimensionAtObservation=AllDimensions"
DATA_RE = re.compile(r"https://[^\s<>]*?/rest/data/([A-Za-z0-9_]+),([A-Z0-9_]+),([\d.]+)/([^?\s<>]*)(\?[^\s<>]*)?")


def col_index(ref):
    letters = re.match(r"([A-Z]+)", ref).group(1)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_sheet(path):
    """Yield (row_number, {col_index: cell_text}) including hyperlink targets."""
    z = zipfile.ZipFile(path)

    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(NS + "t")))

    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheet = wb.find(NS + "sheets")[0]
    target = rels[sheet.get(RNS + "id")].lstrip("/")
    if not target.startswith("xl/"):
        target = "xl/" + target

    root = ET.fromstring(z.read(target))

    links = {}
    rel_path = target.replace("worksheets/", "worksheets/_rels/") + ".rels"
    if rel_path in z.namelist():
        hrels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read(rel_path))}
        for h in root.iter(NS + "hyperlink"):
            links[h.get("ref")] = hrels.get(h.get(RNS + "id"), "")

    for row in root.iter(NS + "row"):
        cells = {}
        for c in row.findall(NS + "c"):
            ref, ctype = c.get("r"), c.get("t")
            v, inline = c.find(NS + "v"), c.find(NS + "is")
            if ctype == "s" and v is not None:
                text = shared[int(v.text)]
            elif inline is not None:
                text = "".join(t.text or "" for t in inline.iter(NS + "t"))
            else:
                text = v.text if v is not None else ""
            text = (text or "").strip()
            # A cell may render as "Click Here" while the real URL lives in the
            # hyperlink relationship — prefer the target when the text isn't one.
            if ref in links and not text.startswith("http"):
                text = links[ref]
            if text:
                cells[col_index(ref)] = text
        if cells:
            yield int(row.get("r")), cells


def to_flat(url):
    """Normalise any /rest/data/ URL into the flat (AllDimensions) flavour."""
    base, _, query = url.partition("?")
    params = [p for p in query.split("&") if p and not p.startswith("dimensionAtObservation=")]
    params.append(FLAT_PARAM)
    return base + "?" + "&".join(params)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else \
        "/home/ssltp12030/Downloads/FCSC- MOBILE APP- Deep links (1).xlsx"

    datasets = {}
    skipped = []
    main_topic = sub_topic = ""

    for rownum, cells in read_sheet(src):
        get = lambda i: cells.get(i, "")
        if get(1) == "Main Topic":
            continue
        main_topic = get(1) or main_topic
        sub_topic = get(2) or sub_topic
        kpi, name = get(3), get(5)

        # Scan the three URL columns rather than trusting column H.
        match = next((m for col in (6, 7, 8) for m in [DATA_RE.search(get(col))] if m), None)
        if not match:
            if kpi or name:
                skipped.append((rownum, f"{sub_topic} / {kpi or name}"))
            continue

        agency, flow, version, key, query = match.groups()
        flat = to_flat(match.group(0))
        start = re.search(r"startPeriod=([^&]+)", query or "")

        entry = datasets.setdefault(flow, {
            "id": flow,
            "name": name or kpi,
            "mainTopic": main_topic,
            "subTopic": sub_topic,
            "kpis": [],
            "agency": agency,
            "version": version,
            "key": key,
            "defaultStartPeriod": start.group(1) if start else None,
            "flatUrl": flat,
        })
        if kpi and kpi not in entry["kpis"]:
            entry["kpis"].append(kpi)

    out = {
        "source": src.split("/")[-1],
        "baseUrl": "https://releaseeuaestat.fcsc.gov.ae/rest",
        "datasets": sorted(datasets.values(), key=lambda d: (d["mainTopic"], d["subTopic"], d["id"])),
    }

    dest = __file__.rsplit("/", 2)[0] + "/datasets.json"
    with open(dest, "w") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)

    print(f"wrote {dest}: {len(out['datasets'])} datasets")
    for rownum, label in skipped:
        print(f"  SKIPPED row {rownum}: {label} — no data URL in the sheet")


if __name__ == "__main__":
    main()
