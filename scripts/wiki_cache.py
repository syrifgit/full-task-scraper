"""
OSRS Wiki cache and LocLine parser.

Fetches wiki pages via the MediaWiki API, caches raw wikitext locally,
and parses {{LocLine}} templates into a structured JSON index.

Usage:
  python wiki_cache.py                  # Fetch categories + build index
  python wiki_cache.py --force          # Re-fetch all pages
  python wiki_cache.py --parse-only     # Skip fetching, just rebuild index
  python wiki_cache.py --pages "Page1,Page2"  # Fetch specific pages
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE, "Wiki Cache")
INDEX_FILE = os.path.join(CACHE_DIR, "locline_index.json")

API_URL = "https://oldschool.runescape.wiki/api.php"
USER_AGENT = "OSRSTaskLocationScraper/1.0 (task categorization research; github.com/osrs-reldo)"
BATCH_SIZE = 50
REQUEST_DELAY = 0.25  # seconds between API calls


def api_request(params):
    """Make a request to the MediaWiki API."""
    params["format"] = "json"
    url = f"{API_URL}?{urllib.parse.urlencode(params)}"

    req = urllib.request.Request(url)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"  HTTP error {e.code} for {url[:100]}...")
        return None
    except urllib.error.URLError as e:
        print(f"  URL error: {e.reason}")
        return None


def get_category_members(category):
    """Get all page titles in a category (paginated)."""
    titles = []
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": f"Category:{category}",
        "cmlimit": "500",
        "cmtype": "page",
    }

    while True:
        data = api_request(params)
        if not data:
            break

        for member in data.get("query", {}).get("categorymembers", []):
            titles.append(member["title"])

        if "continue" in data:
            params["cmcontinue"] = data["continue"]["cmcontinue"]
            time.sleep(REQUEST_DELAY)
        else:
            break

    return titles


def sanitize_filename(title):
    """Convert a wiki page title to a safe filename."""
    # Replace characters that are invalid in filenames
    safe = title.replace("/", "_SLASH_").replace(":", "_COLON_")
    safe = re.sub(r'[<>"|?*]', "_", safe)
    return safe + ".txt"


def title_from_filename(filename):
    """Reverse of sanitize_filename."""
    title = filename[:-4]  # strip .txt
    title = title.replace("_SLASH_", "/").replace("_COLON_", ":")
    return title


def fetch_pages_batch(titles, force=False):
    """Fetch wikitext for a batch of pages. Returns count of newly fetched."""
    # Filter out already-cached pages unless force
    if not force:
        to_fetch = []
        for t in titles:
            cache_path = os.path.join(CACHE_DIR, sanitize_filename(t))
            if not os.path.exists(cache_path):
                to_fetch.append(t)
        titles = to_fetch

    if not titles:
        return 0

    fetched = 0
    # Process in batches of BATCH_SIZE
    for i in range(0, len(titles), BATCH_SIZE):
        batch = titles[i:i + BATCH_SIZE]
        titles_param = "|".join(batch)

        data = api_request({
            "action": "query",
            "prop": "revisions",
            "rvprop": "content",
            "titles": titles_param,
        })

        if not data:
            continue

        pages = data.get("query", {}).get("pages", {})
        for page_id, page_data in pages.items():
            if int(page_id) < 0:
                # Page doesn't exist
                continue

            title = page_data.get("title", "")
            revisions = page_data.get("revisions", [])
            if not revisions:
                continue

            content = revisions[0].get("*", "")
            cache_path = os.path.join(CACHE_DIR, sanitize_filename(title))
            with open(cache_path, "w", encoding="utf-8") as f:
                f.write(content)
            fetched += 1

        progress = min(i + BATCH_SIZE, len(titles))
        print(f"  Fetched {progress}/{len(titles)} pages...")
        time.sleep(REQUEST_DELAY)

    return fetched


def find_templates(wikitext, template_names):
    """Find all instances of named templates, handling nested braces correctly.

    Returns list of template body strings (the content between {{ and }}).
    """
    results = []
    # Build pattern to match any of the template names
    names_pattern = "|".join(re.escape(n) for n in template_names)
    # Find start positions
    for m in re.finditer(r"\{\{(" + names_pattern + r")\s*\|", wikitext, re.IGNORECASE):
        start = m.start()
        # Walk forward counting braces to find the matching }}
        depth = 0
        i = start
        while i < len(wikitext):
            if wikitext[i:i+2] == "{{":
                depth += 1
                i += 2
            elif wikitext[i:i+2] == "}}":
                depth -= 1
                if depth == 0:
                    body = wikitext[m.end():i]
                    results.append(body)
                    break
                i += 2
            else:
                i += 1
    return results


def strip_templates(value):
    """Remove nested {{...}} templates from a value string."""
    result = []
    depth = 0
    i = 0
    while i < len(value):
        if value[i:i+2] == "{{":
            depth += 1
            i += 2
        elif value[i:i+2] == "}}":
            depth -= 1
            i += 2
        elif depth == 0:
            result.append(value[i])
            i += 1
        else:
            i += 1
    return "".join(result).strip()


def parse_loclines(wikitext):
    """Parse all LocLine/ObjectLocLine templates from wikitext.

    Returns list of dicts with: location, coords, plane, leagueRegion, spawns
    """
    results = []

    bodies = find_templates(wikitext, ["LocLine", "ObjectLocLine"])

    for body in bodies:
        entry = {
            "location": "",
            "coords": [],
            "plane": 0,
            "leagueRegion": "",
            "spawns": 0,
        }

        # Split on top-level | only (not inside nested templates)
        parts = []
        current = []
        depth = 0
        for ch in body:
            if ch == "{":
                depth += 1
                current.append(ch)
            elif ch == "}":
                depth -= 1
                current.append(ch)
            elif ch == "|" and depth == 0:
                parts.append("".join(current))
                current = []
            else:
                current.append(ch)
        if current:
            parts.append("".join(current))

        for part in parts:
            part = part.strip()

            # Named param: key = value
            if "=" in part:
                key, _, value = part.partition("=")
                key = key.strip().lower()
                value = value.strip()

                if key == "location":
                    # Strip <ref>...</ref> tags first (before link parsing)
                    value = re.sub(r"<ref[^>]*>.*?</ref>", "", value, flags=re.DOTALL)
                    value = re.sub(r"<ref[^/]*/\s*>", "", value)
                    # Strip wiki links [[X]] -> X, [[X|Y]] -> Y
                    value = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", value)
                    # Strip nested templates
                    value = strip_templates(value)
                    # Clean up leftover brackets, parens, whitespace
                    value = re.sub(r"\[\[|\]\]", "", value)
                    value = re.sub(r"\(\s*\)", "", value).strip()
                    entry["location"] = value
                elif key == "plane":
                    try:
                        entry["plane"] = int(value)
                    except ValueError:
                        pass
                elif key == "leagueregion":
                    entry["leagueRegion"] = value.lower().strip()

            # Coordinate pair: x:NNN,y:NNN or just NNN,NNN
            coord_match = re.match(r"(?:x:)?(\d+),\s*(?:y:)?(\d+)", part)
            if coord_match:
                entry["coords"].append({
                    "x": int(coord_match.group(1)),
                    "y": int(coord_match.group(2)),
                    "plane": entry["plane"],
                })

        entry["spawns"] = len(entry["coords"])

        # Update plane on all coords (plane param might appear after coords)
        for coord in entry["coords"]:
            coord["plane"] = entry["plane"]

        if entry["location"] or entry["coords"]:
            results.append(entry)

    return results


def parse_map_template(wikitext):
    """Fallback: extract location from {{Map}} templates in Infobox NPC/Object headers.

    Handles two coord formats:
      {{Map|name=X|x=123|y=456|...}}
      {{Map|name=X|mapID=0|plane=0|123,456|...}}

    Returns a single entry list or empty list.
    """
    # Only look in Infobox sections (first ~2000 chars or until first ==heading==)
    header = wikitext[:2000]
    end = header.find("\n==")
    if end > 0:
        header = header[:end]

    # Find Map templates in header
    for m in re.finditer(r"\{\{Map\|([^}]+)\}\}", header):
        body = m.group(1)

        # Try x=N|y=N format
        xm = re.search(r"\bx=(\d+)", body)
        ym = re.search(r"\by=(\d+)", body)
        if xm and ym:
            x, y = int(xm.group(1)), int(ym.group(1))
        else:
            # Try N,N positional format
            cm = re.search(r"(?<!\w)(\d{3,4}),(\d{3,4})(?!\w)", body)
            if cm:
                x, y = int(cm.group(1)), int(cm.group(2))
            else:
                continue

        plane = 0
        pm = re.search(r"\bplane=(\d+)", body)
        if pm:
            plane = int(pm.group(1))

        region = ""
        # Try to get leagueRegion from the infobox
        rm = re.search(r"\|leagueRegion\s*=\s*(\w+)", header, re.I)
        if rm:
            region = rm.group(1).lower().strip()

        location = ""
        lm = re.search(r"\|location\s*=\s*\[\[([^\]|]+)", header)
        if lm:
            location = lm.group(1).strip()

        return [{
            "location": location,
            "coords": [{"x": x, "y": y, "plane": plane}],
            "plane": plane,
            "leagueRegion": region,
            "spawns": 1,
        }]

    return []


def extract_source_refs(wikitext):
    """Extract referenced pages from |spot=, |source= fields in wikitext.

    These point to pages that may have LocLine data (e.g., fishing spot pages).
    Returns list of page titles.
    """
    refs = []
    # |spot = [[Fishing spot (karambwan)]]
    for m in re.finditer(r"\|spot\s*=\s*\[\[([^\]|]+)", wikitext):
        refs.append(m.group(1).strip())
    # |source = [[Something]]
    for m in re.finditer(r"\|source\s*=\s*\[\[([^\]|]+)", wikitext):
        refs.append(m.group(1).strip())
    return refs


def build_index():
    """Parse all cached wikitext files and build the LocLine index.

    Also follows chain references (|spot=, |source=) to inherit LocLine data
    from referenced pages when the source page has none.
    """
    index = {}
    file_count = 0
    loc_count = 0
    # Track pages without LocLine that have source references
    chain_candidates = {}  # title -> [referenced_page_titles]

    for filename in os.listdir(CACHE_DIR):
        if not filename.endswith(".txt"):
            continue

        filepath = os.path.join(CACHE_DIR, filename)
        title = title_from_filename(filename)

        with open(filepath, "r", encoding="utf-8") as f:
            wikitext = f.read()

        loclines = parse_loclines(wikitext)
        key = title.lower()

        if loclines:
            index[key] = loclines
            loc_count += len(loclines)
            file_count += 1
        else:
            # No LocLine - try Map template fallback
            map_entries = parse_map_template(wikitext)
            if map_entries:
                index[key] = map_entries
                loc_count += len(map_entries)
                file_count += 1
            else:
                # No LocLine or Map - check for chain references
                refs = extract_source_refs(wikitext)
                if refs:
                    chain_candidates[key] = refs

    # Resolve chains: inherit LocLine from referenced pages
    chain_count = 0
    for title, refs in chain_candidates.items():
        for ref in refs:
            ref_key = ref.lower()
            if ref_key in index:
                index[title] = index[ref_key]
                loc_count += len(index[ref_key])
                chain_count += 1
                break

    return index, file_count, loc_count, chain_count


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)

    force = "--force" in sys.argv
    parse_only = "--parse-only" in sys.argv
    pages_arg = None
    for i, arg in enumerate(sys.argv):
        if arg == "--pages" and i + 1 < len(sys.argv):
            pages_arg = sys.argv[i + 1]

    if not parse_only:
        all_titles = set()

        if pages_arg:
            # Fetch specific pages
            titles = [t.strip() for t in pages_arg.split(",")]
            all_titles.update(titles)
            print(f"Fetching {len(titles)} specific pages...")
        else:
            # Fetch from categories
            categories = [
                # NPCs/creatures
                "Monsters", "Slayer monsters", "Hunter creatures",
                "Boss monsters", "Demi-boss monsters",
                # Resources/scenery
                "Trees", "Rocks", "Stalls",
            ]

            for cat in categories:
                print(f"Getting pages from Category:{cat}...")
                members = get_category_members(cat)
                print(f"  Found {len(members)} pages")
                all_titles.update(members)
                time.sleep(REQUEST_DELAY)

        print(f"\nTotal unique pages to fetch: {len(all_titles)}")

        # Check how many are already cached
        if not force:
            already_cached = sum(1 for t in all_titles
                                 if os.path.exists(os.path.join(CACHE_DIR, sanitize_filename(t))))
            print(f"Already cached: {already_cached}")
            print(f"Need to fetch: {len(all_titles) - already_cached}")

        fetched = fetch_pages_batch(list(all_titles), force=force)
        print(f"Fetched {fetched} new pages")

    # Build index
    print("\nBuilding LocLine index...")
    index, file_count, loc_count, chain_count = build_index()
    print(f"  Pages with LocLine data: {file_count}")
    print(f"  Chain-resolved pages: {chain_count}")
    print(f"  Total location entries: {loc_count}")

    # Write index
    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
    print(f"  Wrote {INDEX_FILE}")

    # Print some stats
    print("\n--- Sample entries ---")
    for key in list(index.keys())[:5]:
        locations = [e["location"] for e in index[key]]
        regions = [e["leagueRegion"] for e in index[key]]
        print(f"  {key}: {len(index[key])} locations: {locations} regions: {regions}")


if __name__ == "__main__":
    main()
