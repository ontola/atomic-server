"""Fetch a small food-photo fixture set from Wikimedia Commons.

Six dishes, several photos each. The set is chosen to stress the one
discrimination the design doc names: oatmeal vs chili is the same bowl in the
same kitchen, and a surface-feature matcher cannot tell them apart. Cappuccino
vs latte is the same test for drinks. The rest are easy cases that should not
be got wrong.

Fixtures land in scratchpad and are never committed -- Commons files are freely
licensed but individually attributed, and this is a calibration harness, not a
distributed asset.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"

# Wikimedia's robot policy wants a descriptive agent with a contact address and
# a low request rate. Downloading four files as fast as the socket allows earns
# a 429 for the whole run, which is how the first attempt at this failed.
UA = "calorie-tracker-fixtures/0.1 (https://github.com/atomicdata-dev; polle@ontola.io)"
DELAY = 1.5

DISHES = {
    "pizza_margherita": "pizza margherita",
    "oatmeal": "oatmeal porridge bowl",
    "chili_con_carne": "chili con carne bowl",
    "cappuccino": "cappuccino cup",
    "caesar_salad": "caesar salad",
    "cheese_sandwich": "cheese sandwich",
}

PER_DISH = 4


def search(term, limit):
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"{term} filetype:bitmap",
        "gsrnamespace": "6",
        "gsrlimit": str(limit),
        "prop": "imageinfo",
        "iiprop": "url|mime|extmetadata",
        "iiurlwidth": "1024",
    }
    req = urllib.request.Request(
        f"{API}?{urllib.parse.urlencode(params)}", headers={"User-Agent": UA}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    pages = data.get("query", {}).get("pages", {})
    out = []
    for page in pages.values():
        info = page.get("imageinfo", [{}])[0]
        url = info.get("thumburl") or info.get("url")
        if not url or info.get("mime") not in ("image/jpeg", "image/png"):
            continue
        meta = info.get("extmetadata", {})
        out.append(
            {
                "title": page["title"],
                "url": url,
                "license": meta.get("LicenseShortName", {}).get("value", "?"),
                "artist": meta.get("Artist", {}).get("value", "?")[:120],
            }
        )
    return out


def main(dest):
    os.makedirs(dest, exist_ok=True)
    manifest = []
    for dish, term in DISHES.items():
        # Over-fetch: some results are diagrams, logos or restaurant fronts.
        hits = search(term, PER_DISH * 3)
        kept = 0
        for hit in hits:
            if kept >= PER_DISH:
                break
            name = f"{dish}_{kept:02d}.jpg"
            path = os.path.join(dest, name)
            blob = None
            for attempt in range(4):
                time.sleep(DELAY * (2**attempt))
                try:
                    req = urllib.request.Request(hit["url"], headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=90) as r:
                        blob = r.read()
                    break
                except urllib.error.HTTPError as e:
                    if e.code != 429:
                        print(f"  skip {hit['title']}: {e}", file=sys.stderr)
                        break
                except Exception as e:  # noqa: BLE001 - a dead thumb is not fatal
                    print(f"  skip {hit['title']}: {e}", file=sys.stderr)
                    break
            if blob is None:
                continue
            if len(blob) < 20_000:  # icons and placeholders
                continue
            with open(path, "wb") as f:
                f.write(blob)
            manifest.append({"file": name, "dish": dish, **hit})
            kept += 1
        print(f"{dish}: {kept}")
    with open(os.path.join(dest, "MANIFEST.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\n{len(manifest)} files -> {dest}")


if __name__ == "__main__":
    main(sys.argv[1])
