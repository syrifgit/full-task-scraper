"""
Task location classifier - rule engine version.

Classifies OSRS league tasks as SINGLE (one completion location),
MULTI (multiple locations), or UNCLEAR.

Architecture:
  1. Load rules.json (all classification knowledge in one file)
  2. Load entity data (wiki LocLine index + groot's scenery data as fallback)
  3. For each task:
     a. Check rules by priority (highest first, first match wins per priority tier)
     b. Extract entity name from description
     c. Look up entity in wiki index (location-name based) then groot data (coordinate based)
     d. If no rule or lookup matched -> UNCLEAR
"""

import json
import re
import os
import sys
from collections import defaultdict

# --- Paths ---
# BASE = directory containing this script
# When run from the scraper repo: full-task-scraper/scripts/
# When run from the workspace: Task Location Scraping/Script - Rule Engine Version/
BASE = os.path.dirname(os.path.abspath(__file__))
TASK_LOC_DIR = os.path.dirname(BASE)
WORKSPACE = os.path.dirname(TASK_LOC_DIR)

# Default paths (workspace layout). Overridden by --data-dir / --input flags.
TASK_DUMP = os.path.join(WORKSPACE, "Reference Files", "Task Dump.json")
SCENERY = os.path.join(WORKSPACE, "TaskWebTool", "data_osrs", "scenery.json")
ITEM_SPAWNS = os.path.join(WORKSPACE, "TaskWebTool", "data_osrs", "item_spawns.json")
MONSTERS = os.path.join(WORKSPACE, "TaskWebTool", "data_osrs", "monsters.json")
WIKI_INDEX = os.path.join(TASK_LOC_DIR, "Wiki Cache", "locline_index.json")
OUT_DIR = os.path.join(TASK_LOC_DIR, "Script Output")


def _find_adjacent(filename):
    """Find a file co-located with this script, falling back to the parent directory."""
    path = os.path.join(BASE, filename)
    if os.path.exists(path):
        return path
    return os.path.join(TASK_LOC_DIR, filename)


RULES_FILE = _find_adjacent("rules.json")
CURATED_COORDS = _find_adjacent("curated_coords.json")
SP_LOCATIONS = _find_adjacent("shortest_path_locations.json")

# --- Constants ---
CATEGORY_MAP = {1: "Skill", 2: "Combat", 3: "Quest", 4: "Achievement", 5: "Minigame", 6: "Other"}
AREAS = {
    0:  ("Global",     None),
    1:  ("Misthalin",  "misthalin"),
    2:  ("Karamja",    "karamja"),
    3:  ("Asgarnia",   "asgarnia"),
    4:  ("Kandarin",   "kandarin"),
    5:  ("Morytania",  "morytania"),
    6:  ("Desert",     "desert"),
    7:  ("Tirannwn",   "tirannwn"),
    8:  ("Fremennik",  "fremennik"),
    10: ("Kourend",    "kourend"),
    11: ("Wilderness", "wilderness"),
    21: ("Varlamore",  "varlamore"),
}
AREA_MAP = {k: v[0] for k, v in AREAS.items()}
AREA_TO_REGION = {k: v[1] for k, v in AREAS.items() if v[1]}
TIER_MAP = {1: "Easy", 2: "Medium", 3: "Hard", 4: "Elite", 5: "Master", 6: "Grandmaster"}
CLUSTER_RADIUS = 300


# ============================================================
# Data Loading
# ============================================================

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


CATEGORY_NAME_TO_ID = {
    "Skill": 1, "Combat": 2, "Quest": 3, "Achievement": 4, "Minigame": 5, "Other": 6,
}
AREA_NAME_TO_ID = {
    "Global": 0, "General": 0,
    "Misthalin": 1, "Karamja": 2, "Asgarnia": 3, "Kandarin": 4,
    "Morytania": 5,
    "Desert": 6, "Kharidian Desert": 6,
    "Tirannwn": 7,
    "Fremennik": 8, "Fremennik Province": 8,
    "Kourend": 10, "Kourend & Kebos": 10,
    "Wilderness": 11,
    "Varlamore": 21,
}
TIER_NAME_TO_ID = {
    "Easy": 1, "Medium": 2, "Hard": 3, "Elite": 4, "Master": 5, "Grandmaster": 6,
}


def parse_task(t):
    """Parse a task from either Task Dump format (params dict) or full.json format (flat fields)."""
    if "params" in t:
        # Task Dump format: numeric param keys
        p = t["params"]
        return {
            "structId": t["structId"],
            "name": p.get("874", ""),
            "description": p.get("875", ""),
            "category": p.get("1016", 0),
            "area": p.get("1017", 0),
            "tier": p.get("2044", 0),
        }
    else:
        # full.json format: named fields with string values
        return {
            "structId": t["structId"],
            "name": t.get("name", ""),
            "description": t.get("description", ""),
            "category": CATEGORY_NAME_TO_ID.get(t.get("category"), 0),
            "area": AREA_NAME_TO_ID.get(t.get("area"), 0),
            "tier": TIER_NAME_TO_ID.get(t.get("tierName"), 0),
        }


def build_scenery_region_index(data):
    idx = defaultdict(lambda: defaultdict(set))
    for entry in data:
        name = entry.get("page_name", "").lower().strip()
        for coord in entry.get("coordinates", []):
            if len(coord) >= 2:
                for r in entry.get("leagueregion", []):
                    idx[name][r].add((coord[0], coord[1]))
    return idx


# ============================================================
# Rule Engine
# ============================================================

def compile_rules(rules_data):
    """Pre-compile regex patterns and sort rules by priority."""
    compiled = []
    for rule in rules_data.get("rules", []):
        if "_section" in rule:
            continue
        r = dict(rule)
        if r["type"] == "regex":
            r["_compiled"] = re.compile(r["match"])
        compiled.append(r)
    # Sort by priority descending
    compiled.sort(key=lambda r: r.get("priority", 0), reverse=True)
    return compiled


def match_rule(rule, task):
    """Check if a single rule matches a task. Returns True/False."""
    desc_l = task["description"].lower()
    name_l = task["name"].lower()

    if rule["type"] == "exact":
        return task["structId"] == rule["structId"]
    elif rule["type"] == "substring":
        return rule["match"].lower() in desc_l
    elif rule["type"] == "regex":
        return rule["_compiled"].search(desc_l) is not None
    elif rule["type"] == "verb":
        return desc_l.startswith(rule["match"]) or name_l.startswith(rule["match"])
    return False


def check_rules(task, compiled_rules):
    """Run task against all rules. Returns (result, reason) or None."""
    for rule in compiled_rules:
        if match_rule(rule, task):
            return (rule["result"], f"[rule:{rule['type']}] {rule['reason']}")
    return None


# ============================================================
# Entity Name Extraction
# ============================================================

# Prepositions that separate entity names from location/condition qualifiers
_PREPS = r"in|on|at|before|without|whilst|during|after|within|using|from|near|beneath|outside"

# Universal pattern: Verb [article] [quantity] [Name] [preposition Location]
ENTITY_PATTERNS = [
    # Combat
    r"[Dd]efeat (?:a |an |the )?(\d+ )?(.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    r"[Kk]ill (?:a |an |the )?(\d+ )?(.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    # NPCs
    r"[Pp]et ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)$",
    r"[Tt]alk to (.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    r"[Pp]ickpocket (?:a |an |any )?(.+?)(?:\s+for\s+.+)?(?:\s+\d+\s+[Tt]imes)?$",
    r"[Gg]ive (.+?) (?:a |an |some ).+$",
    # Gathering/hunter
    r"[Cc]atch (?:a |an |\d+ )?(.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    r"[Tt]rap (?:a |an )?(.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    r"[Ss]hear (?:a |an )?(.+?)$",
    r"[Mm]ilk (?:a |an )?(.+?)$",
    r"[Cc]apture (?:\d+ )?(.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    # NPC interactions (unusual verbs)
    r"[Mm]ake .+ for ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)",
    r"[Hh]ave (?:the )?([A-Z][a-z]+(?:\s[A-Z][a-z]+)*) ",
    r"[Aa]nger (?:a |an |the )?([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)",
    r"[Ii]nsult ([A-Z][a-z]+(?:\s[A-Za-z]+)*?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    r"[Dd]eliver .+ to ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)",
    # Purchase from NPC/store
    r"[Pp]urchase (?:a |an |the )?(.+?) (?:from|in) .+$",
    # Unlock X with NPC
    r"[Uu]nlock .+ with ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    # Cut specific named objects (trees, etc.)
    r"[Cc]ut (?:a |an |the )?(.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    # Turn in / Hand in / Sell items to NPC
    r"[Tt]urn in .+ to (.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    r"[Hh]and in .+ to (.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    r"[Ss]ell .+ to (.+?)(?:\s+(?:" + _PREPS + r")\s+.+)?$",
    # Objects
    r"[Oo]pen (?:a |an |the |\d+ )?(.+?)(?:\s+(?:" + _PREPS + r"|as)\s+.+)?$",
    r"[Uu]nlock (?:a |an |the )?(.+?)(?:\s+(?:in|at)\s+.+)?$",
]

# Patterns that use re.search (can match mid-sentence)
ENTITY_SEARCH_PATTERNS = [
    # Possessive NPC reference: "at Drew's ...", "in Ali the Tea Seller's ..."
    r"(?:at|in) ([A-Z][a-z]+(?:\s(?:the\s)?[A-Z][a-z]+)*)'s\b",
]

# Skip extraction for these description patterns
EXTRACTION_SKIP_PATTERNS = [
    re.compile(r"\bor\b.*(?:Defeat|Kill)", re.I),
    re.compile(r"\bany (one|type) of\b"),
    re.compile(r"\b(using the|and obtain|and have)\b"),
]


def extract_entity_name(desc):
    """Extract the subject entity name from a task description.

    Returns the entity name string, or None.
    """
    # Skip problematic patterns
    if re.match(r"(Defeat|Kill)", desc) and re.search(r"\bor\b", desc):
        return None
    for skip in EXTRACTION_SKIP_PATTERNS[1:]:
        if skip.search(desc):
            return None

    for pat in ENTITY_PATTERNS:
        m = re.match(pat, desc)
        if not m:
            continue
        # Get the last non-None, non-numeric group
        name = None
        for g in m.groups():
            if g and not re.match(r"^\d+ ?$", g):
                name = g
        if not name:
            continue
        # Clean up
        name = name.strip().rstrip(".")
        name = re.sub(r"\s+\d+\s+times?$", "", name, flags=re.I)
        name = re.sub(r"\s+and\s+.+$", "", name)
        if len(name.split()) > 5:
            return None
        return name

    # Fallback: search-based patterns (match mid-sentence)
    for pat in ENTITY_SEARCH_PATTERNS:
        m = re.search(pat, desc)
        if m:
            name = m.group(1).strip()
            if name and len(name.split()) <= 5:
                return name

    return None


# Resource extraction patterns
RESOURCE_PATTERNS = [
    r"chop (?:\d+ )?(.+?) logs?",
    r"chop (?:a |an |down (?:a |an )?)?(.+?)(?:\s+(?:in|at|on)\s+.+)?$",
    r"mine (?:\d+ )?(.+?)(?:\s+ore|\s+rocks?|\s+bar)?(?:\s+(?:in|at|on)\s+.+)?$",
    r"steal (?:from )?(?:a |the )?(.+? stall)",
    r"thieve (?:a |an )?.+? from (?:a |the )?(.+? stall)",
    r"catch (?:a |an |\d+ )?(.+?)(?:\s+(?:in|at|on)\s+.+)?$",
    r"harvest (?:\d+ )?(.+?)(?:\s+(?:in|at|from)\s+.+)?$",
    r"pick (?:up )?(?:\d+ )?(.+?)(?:\s+(?:in|at|on)\s+.+)?$",
    r"trap (?:a |an )?(.+?)(?:\s+(?:in|at)\s+.+)?$",
]


def extract_resource_name(desc_l):
    """Extract a resource/object name from a gathering task description."""
    for pat in RESOURCE_PATTERNS:
        m = re.match(pat, desc_l)
        if m:
            name = re.sub(r"^\d+ ", "", m.group(1).strip())
            name = re.sub(r" \d+ times?$", "", name)
            name = re.sub(r"^(?:a |an |the |some )", "", name)
            if name and len(name) > 2 and len(name.split()) <= 5:
                return name
    return None


# ============================================================
# Wiki LocLine Lookup
# ============================================================

def build_normalizers(rules_data):
    """Compile location normalizer patterns from rules.json."""
    compiled = []
    for entry in rules_data.get("location_normalizers", []):
        if "_comment" in entry:
            continue
        flags = re.I if entry.get("flags") == "i" else 0
        compiled.append(re.compile(entry["pattern"], flags))
    return compiled


def normalize_location_name(name, normalizers):
    """Normalize wiki location names using compiled patterns from rules.json."""
    for pattern in normalizers:
        name = pattern.sub("", name)
    return name.strip()


def find_in_wiki(name, wiki_index, aliases):
    """Look up an entity name in the wiki index. Returns (entries, matched_key) or (None, None)."""
    name_l = name.lower().strip()

    # Build lookup chain: alias -> exact -> singular -> "raw " prefix (fishing/gathering)
    candidates = [name_l]
    if name_l in aliases:
        candidates.insert(0, aliases[name_l])
    if name_l.endswith("es"):
        candidates.append(name_l[:-2])
    elif name_l.endswith("s"):
        candidates.append(name_l[:-1])
    # "raw " prefix for fishing/gathering items (wiki uses "raw karambwan" not "karambwan")
    if not name_l.startswith("raw "):
        candidates.append("raw " + name_l)
    # Also check aliases for singular
    for c in list(candidates):
        if c in aliases and aliases[c] not in candidates:
            candidates.append(aliases[c])

    # Exact match
    for c in candidates:
        if c in wiki_index:
            return wiki_index[c], c

    # Partial match (word boundary) - skip for short generic names
    is_short_generic = len(name_l.split()) <= 1 and len(name_l) <= 8
    if not is_short_generic:
        for c in set(candidates):
            pattern = re.compile(r"\b" + re.escape(c) + r"\b")
            for key in wiki_index:
                if pattern.search(key):
                    return wiki_index[key], key

    return None, None


def wiki_classify(entity_name, task_region, task_desc, wiki_index, aliases, region_names, normalizers):
    """Classify an entity using wiki LocLine data.

    Uses location names (not coordinate clustering) as primary signal.
    Returns (result, reason) or None.
    """
    entries, matched_key = find_in_wiki(entity_name, wiki_index, aliases)
    if not entries:
        return None

    # If generic page found but no entries in task's region, try variants
    if task_region:
        region_entries = [e for e in entries if e["leagueRegion"] == task_region]
        if not region_entries:
            # Look for variant pages
            name_l = entity_name.lower()
            for key in wiki_index:
                if name_l in key and key != matched_key:
                    variant = [e for e in wiki_index[key] if e["leagueRegion"] == task_region]
                    if variant:
                        entries = wiki_index[key]
                        matched_key = key
                        region_entries = variant
                        break
        if region_entries:
            entries = region_entries

    # Check if task description names a specific wiki location
    loc_match = re.search(r"(?:in|at) (?:the )?(.+?)(?:\s+\d+\s+times?)?$", task_desc, re.I)
    if loc_match:
        named_loc = loc_match.group(1).strip().lower()
        is_region = any(reg in named_loc for reg in region_names)
        if not is_region and len(named_loc) > 3:
            for e in entries:
                if named_loc in e["location"].lower():
                    return ("SINGLE", f"[wiki] '{matched_key}' at specific location: {e['location']}")

    # Count distinct normalized location names
    locations = set()
    for e in entries:
        normalized = normalize_location_name(e["location"], normalizers)
        if normalized:
            locations.add(normalized)

    if len(locations) == 0:
        return None
    elif len(locations) == 1:
        loc = list(locations)[0]
        return ("SINGLE", f"[wiki] '{matched_key}' has 1 location: {loc}")
    else:
        loc_list = ", ".join(sorted(locations)[:3])
        if len(locations) > 3:
            loc_list += f"... (+{len(locations)-3} more)"
        return ("MULTI", f"[wiki] '{matched_key}' has {len(locations)} locations: {loc_list}")


# ============================================================
# Scenery/Resource Lookup (groot's data as fallback)
# ============================================================

def scenery_classify(resource_name, task_region, scenery_idx, item_idx, resource_aliases, region_names, task_desc):
    """Classify a resource using scenery spawn data with region filtering."""
    if not task_region:
        return None

    search_term = resource_aliases.get(resource_name, resource_name)

    locations = set()
    matched_key = None
    for idx in [scenery_idx, item_idx]:
        for key in idx:
            if search_term in key and task_region in idx[key]:
                locations |= idx[key][task_region]
                matched_key = matched_key or key

    if not locations:
        return None

    if len(locations) == 1:
        return ("SINGLE", f"[scenery] '{resource_name}' ({matched_key}) has 1 spawn in {task_region}")

    xs = [c[0] for c in locations]
    ys = [c[1] for c in locations]
    spread = max(max(xs) - min(xs), max(ys) - min(ys))

    if spread <= CLUSTER_RADIUS:
        cx, cy = int(sum(xs)/len(xs)), int(sum(ys)/len(ys))
        return ("SINGLE", f"[scenery] '{resource_name}' ({matched_key}) {len(locations)} spawns within {spread:.0f} tiles (~{cx},{cy})")

    # If task names a specific sub-area, defer to let other logic handle it
    desc_l = task_desc.lower()
    loc_match = re.search(r" in (?:the )?(.+?)$", desc_l)
    if loc_match:
        location = loc_match.group(1).strip()
        if not any(reg in location for reg in region_names):
            return None  # Specific sub-area named, don't call MULTI

    return ("MULTI", f"[scenery] '{resource_name}' ({matched_key}) {len(locations)} spawns, {spread:.0f} tile spread in {task_region}")


# ============================================================
# Structural Classification (category, description patterns)
# ============================================================

def structural_classify(task, rules_data):
    """Handle structural patterns: quests, agility courses, enter/visit, processing verbs."""
    desc = task["description"]
    desc_l = desc.lower()
    cat = task["category"]
    region_names = set(rules_data.get("region_names", []))

    # Quest tasks
    if cat == 3 or re.match(r"complete the .+ quest", desc_l):
        return ("MULTI", "[structural] Quest spans multiple locations")

    # Agility courses
    if re.search(r'\blaps?\b', desc_l):
        for course in rules_data.get("agility_courses", []):
            if course in desc_l:
                return ("SINGLE", f"[structural] Agility course: {course}")

    # "Enter the X" (not POH/Puro Puro)
    m = re.match(r"enter (?:the )?(.+)", desc_l)
    if m:
        target = m.group(1)
        if "player owned house" in target or "puro" in target:
            return ("MULTI", "[structural] Accessible from multiple locations")
        return ("SINGLE", f"[structural] Enter specific location: {target}")

    # "Visit X"
    m = re.match(r"visit (?:the )?(.+)", desc_l)
    if m:
        return ("SINGLE", f"[structural] Visit specific location: {m.group(1)}")

    # "Use the Bank in/on/at X"
    if re.match(r"use the bank (chest )?(in|on|at) ", desc_l):
        return ("SINGLE", "[structural] Specific bank location")

    # Transport tasks
    if re.search(r"charter a ship|take a carpet|take a canoe|take the museum barge|take a charter ship|boats around lake molch", desc_l):
        return ("SINGLE", "[structural] Specific transport route")

    # "Drink a X in the Y" - specific named pub/location
    if re.search(r"drink a .+ in the ", desc_l):
        return ("SINGLE", "[structural] Specific drinking location")

    # "Activate the X in Y"
    if re.match(r"activate the .+ in ", desc_l):
        return ("SINGLE", "[structural] Specific object in named location")

    # "Give X some Y in Z"
    if re.search(r"give .+ in .+", desc_l) and task["area"] != 0:
        return ("SINGLE", "[structural] Specific NPC interaction in named location")

    # Specific staircase
    if re.search(r"use the .+ staircase in .+", desc_l):
        return ("SINGLE", "[structural] Specific staircase in named building")

    # Processing verbs -> MULTI (unless task names a specific location with "at")
    processing_verbs = rules_data.get("processing_verbs", [])
    has_location_qualifier = False
    # Check for "at the [Proper Noun]" or "from [Specific Boss] in [Place]"
    at_match = re.search(r"\bat (?:the )?([A-Z])", desc)
    if at_match:
        loc = re.search(r"\bat (?:the )?(.+?)$", desc_l)
        if loc and not any(reg in loc.group(1) for reg in region_names):
            has_location_qualifier = True
    # "from Zalcano in Prifddinas" style
    from_match = re.search(r"\bfrom ([A-Z]\w+) in ", desc)
    if from_match:
        has_location_qualifier = True

    if not has_location_qualifier:
        for verb in processing_verbs:
            if desc_l.startswith(verb):
                return ("MULTI", f"[structural] Processing verb '{verb}' - can be done anywhere")

    # Global area + gathering verb -> MULTI
    if task["area"] == 0:
        gathering_verbs = rules_data.get("gathering_verbs", [])
        for verb in gathering_verbs:
            if desc_l.startswith(verb):
                return ("MULTI", f"[structural] Global gathering action '{verb}'")

    return None


# ============================================================
# Named Location Detection (last resort)
# ============================================================

def named_location_classify(task, rules_data):
    """Check if the description names a known specific location. Uses rules.json data."""
    desc_l = task["description"].lower()
    region_names = set(rules_data.get("region_names", []))
    named_locations = rules_data.get("named_locations", [])
    false_patterns = rules_data.get("false_location_patterns", [])

    for keyword in named_locations:
        if keyword in desc_l:
            return ("SINGLE", f"[named_location] {keyword}")

    # Fallback: capitalized proper noun at end of description after a preposition
    desc = task["description"]
    m = re.search(r"(?:in|at|on|from|beneath|near|outside|by|via) (?:the )?([A-Z][A-Za-z' -]+?)(?:\s+\d+\s+times?)?$", desc)
    if m:
        location = m.group(1).strip()
        location_l = location.lower()
        if any(reg in location_l for reg in region_names):
            return None
        if any(fp in location_l for fp in false_patterns):
            return None
        if len(location.split()) <= 4 and not location_l.startswith("a "):
            return ("SINGLE", f"[named_location] {location}")

    return None


# ============================================================
# NPC Fallback (groot's data when wiki has no coverage)
# ============================================================

def build_npc_index(monsters):
    locs = defaultdict(set)
    for m in monsters:
        name = m.get("npc_name", m.get("page_name", "")).lower().strip()
        page = m.get("page_name", "").lower().strip()
        for coord in m.get("coordinates", []):
            if len(coord) >= 2:
                locs[name].add((coord[0], coord[1]))
                locs[page].add((coord[0], coord[1]))
    return locs


def _npc_lookup(name_l, npc_locs):
    """Look up an NPC name in the NPC index with progressive matching.

    Tries: exact -> singular -> first word exact -> partial substring.
    First-word matching handles "Aggie the Witch" -> "aggie" before
    partial matching can grab generic "witch".
    """
    singular = name_l[:-2] if name_l.endswith("es") else (name_l[:-1] if name_l.endswith("s") else name_l)

    # Exact match
    for try_name in [name_l, singular]:
        if try_name in npc_locs:
            return npc_locs[try_name]

    # First word as exact match (handles "Aggie the Witch" -> "aggie")
    first_word = name_l.split()[0] if " " in name_l else None
    if first_word and len(first_word) > 3 and first_word in npc_locs:
        return npc_locs[first_word]

    # Partial match (require key to be a substantial portion of the name to avoid
    # short generic NPCs like "guard" matching "grotesque guardians")
    for key in npc_locs:
        if name_l in key:
            return npc_locs[key]
        if key in name_l and len(key) > len(name_l) // 2:
            return npc_locs[key]

    return None


def npc_fallback_classify(entity_name, task, scenery_idx, item_idx, region_names):
    """Fallback NPC lookup using groot's coordinate data."""
    name_l = entity_name.lower().strip()
    npc_locs = task.get("_npc_locs", {})

    locations = _npc_lookup(name_l, npc_locs)

    if not locations:
        return None

    if len(locations) == 1:
        return ("SINGLE", f"[npc_fallback] '{entity_name}' has 1 spawn")

    xs = [c[0] for c in locations]
    ys = [c[1] for c in locations]
    spread = max(max(xs) - min(xs), max(ys) - min(ys))

    if spread <= CLUSTER_RADIUS:
        cx, cy = int(sum(xs)/len(xs)), int(sum(ys)/len(ys))
        return ("SINGLE", f"[npc_fallback] '{entity_name}' {len(locations)} spawns within {spread:.0f} tiles (~{cx},{cy})")

    # Check for sub-area constraint
    desc_l = task["description"].lower()
    loc_match = re.search(r" (?:in|on|at) (?:the )?(.+?)(?:\s+\d+\s+times?)?$", desc_l)
    if loc_match:
        location = loc_match.group(1).strip()
        false_phrases = ["one hit", "seconds", "a row", "kicking", "fire damage", "slayer task", "whilst"]
        if not any(fp in location for fp in false_phrases):
            if not any(reg in location for reg in region_names):
                return ("SINGLE", f"[npc_fallback] '{entity_name}' constrained to: {location}")
            else:
                return ("MULTI", f"[npc_fallback] '{entity_name}' {len(locations)} spawns across {location}")

    if len(locations) > 3:
        return ("MULTI", f"[npc_fallback] '{entity_name}' has {len(locations)} spawn locations")

    return None


# ============================================================
# Coordinate Resolution (--coords mode)
# ============================================================

def centroid(coords):
    """Compute centroid of coords, filtering outliers when a tight majority cluster exists.

    When 3+ coords exist and one is far from the rest, uses the largest
    cluster (within 50 tiles of each other) instead of the full set.
    """
    if not coords:
        return None
    if isinstance(coords[0], dict):
        pts = [(c["x"], c["y"]) for c in coords]
        plane = coords[0].get("plane", 0)
    else:
        pts = [(c[0], c[1]) for c in coords]
        plane = 0

    # Filter outliers for sets of 3+ coords
    if len(pts) >= 3:
        # Find the largest cluster: for each point, count how many others are within 50 tiles
        best_cluster = []
        for p in pts:
            cluster = [q for q in pts if abs(q[0] - p[0]) <= 50 and abs(q[1] - p[1]) <= 50]
            if len(cluster) > len(best_cluster):
                best_cluster = cluster
        # Use the cluster if it's a strict majority but not all points (i.e. outliers exist)
        if len(best_cluster) > len(pts) // 2 and len(best_cluster) < len(pts):
            pts = best_cluster

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return {"x": int(sum(xs) / len(xs)), "y": int(sum(ys) / len(ys)), "plane": plane}


def resolve_coords_wiki(task, wiki_index, aliases, normalizers, region_names,
                        resource_aliases=None):
    """Try to get coords from wiki LocLine data for any SINGLE task.

    Works for wiki-classified tasks (uses reason to find matched key),
    and also tries entity extraction for rule-classified tasks.
    """
    task_region = AREA_TO_REGION.get(task["_parsed"]["area"])
    reason = task.get("reason", "")

    # If wiki-classified, extract the matched key from reason
    if reason.startswith("[wiki]"):
        m = re.search(r"'([^']+)'", reason)
        if m:
            key = m.group(1)
            if key in wiki_index:
                return _coords_from_wiki_entries(wiki_index[key], task_region, normalizers, reason, task["description"])

    # Otherwise try entity extraction
    entity = extract_entity_name(task["description"])
    if entity:
        entries, matched_key = find_in_wiki(entity, wiki_index, aliases)
        if entries:
            return _coords_from_wiki_entries(entries, task_region, normalizers, reason, task["description"])

    # Try resource extraction (uses resource_aliases merged with creature aliases)
    resource = extract_resource_name(task["description"].lower())
    if resource:
        merged = dict(aliases) if aliases else {}
        if resource_aliases:
            merged.update(resource_aliases)
        entries, matched_key = find_in_wiki(resource, wiki_index, merged)
        if entries:
            return _coords_from_wiki_entries(entries, task_region, normalizers, reason, task["description"])

    return None


def _coords_from_wiki_entries(entries, task_region, normalizers, reason, desc=""):
    """Pick the best coordinate from wiki LocLine entries."""
    # Filter to task's region if available
    if task_region:
        region_entries = [e for e in entries if e["leagueRegion"] == task_region]
        if region_entries:
            entries = region_entries

    # If reason mentions a specific location, prefer that
    loc_match = re.search(r"location: (.+?)$", reason)
    if loc_match:
        target_loc = loc_match.group(1).strip().lower()
        for e in entries:
            if target_loc in e["location"].lower() and e.get("coords"):
                return centroid(e["coords"])

    # If task description mentions a wiki location name, prefer that entry
    if desc and len(entries) > 1:
        desc_l = desc.lower()
        for e in entries:
            loc_name = e["location"].lower()
            # Check if any significant word from the wiki location appears in the description
            for word in loc_name.split():
                if len(word) > 4 and re.search(r'\b' + re.escape(word) + r'\b', desc_l) and e.get("coords"):
                    return centroid(e["coords"])

    # If only 1 normalized location, use all its coords
    loc_groups = {}
    for e in entries:
        if not e.get("coords"):
            continue
        normalized = normalize_location_name(e["location"], normalizers)
        if normalized not in loc_groups:
            loc_groups[normalized] = []
        loc_groups[normalized].extend(e["coords"])

    if len(loc_groups) == 1:
        all_coords = list(loc_groups.values())[0]
        return centroid(all_coords)

    # Multiple locations - pick the one with most spawns (most relevant)
    if loc_groups:
        best = max(loc_groups.values(), key=len)
        return centroid(best)

    return None




def resolve_coords_scenery(task, scenery_idx, item_idx, resource_aliases):
    """Get coords from scenery/item spawn data."""
    task_region = AREA_TO_REGION.get(task["_parsed"]["area"])
    if not task_region:
        return None

    # Try entity name
    entity = extract_entity_name(task["description"])
    resource = extract_resource_name(task["description"].lower())

    for name in [entity, resource]:
        if not name:
            continue
        search_term = resource_aliases.get(name.lower(), name.lower())
        for idx in [scenery_idx, item_idx]:
            # Try exact match first
            if search_term in idx and task_region in idx[search_term]:
                coords = list(idx[search_term][task_region])
                if coords:
                    return centroid(coords)
            # Then try word-boundary substring match
            for key in idx:
                if key == search_term:
                    continue  # already tried
                if (key.startswith(search_term + " ") or key.endswith(" " + search_term)
                        or search_term.startswith(key + " ") or search_term.endswith(" " + key)):
                    if task_region in idx[key]:
                        coords = list(idx[key][task_region])
                        if coords:
                            return centroid(coords)
    return None


def resolve_coords_npc(task, npc_locs, curated_locations=None):
    """Get coords from NPC spawn data.

    When spawns are spread wide and the description names a location,
    filter to spawns near that location before computing centroid.
    """
    entity = extract_entity_name(task["description"])
    if not entity:
        return None
    locations = _npc_lookup(entity.lower().strip(), npc_locs)
    if not locations:
        return None

    pts = list(locations)

    # If multiple spawns and description names a location, pick the closest spawn to it.
    # Handles NPCs with the same name in different places (e.g. multiple "Ned" NPCs).
    if len(pts) > 1 and curated_locations:
        loc = _extract_location_from_text(task["description"])
        if loc and loc.lower() in curated_locations:
            ref = curated_locations[loc.lower()]
            rx, ry = ref["x"], ref["y"]
            pts = [min(pts, key=lambda p: (p[0] - rx) ** 2 + (p[1] - ry) ** 2)]

    return centroid(pts)


def _extract_location_from_text(text):
    """Extract a location name from text like 'in/at/on [Location]' at end of string."""
    patterns = [
        # "in/at/on/from the [Location]" at end - stop at secondary prepositions
        # Optional trailing period for L4-style descriptions
        r'(?:in|at|on|from) (?:the )?([A-Z][\w\' -]+?)(?:\s+(?:west|east|north|south|near|outside|for)\s+.+)?\.?$',
        # "Enter the [Location]" - stop at secondary prepositions
        r'^[Ee]nter (?:the )?(.+?)(?:\s+(?:west|east|north|south|near|outside|for)\s+.+)?\.?$',
    ]
    for pat in patterns:
        m = re.search(pat, text)
        if m:
            loc = m.group(1).strip().rstrip(".")
            if loc and len(loc) > 2:
                return loc
    return None


def resolve_coords_by_location_name(task, wiki_index, normalizers, curated_locations, sp_data):
    """Extract a location name from the description/reason and resolve coords directly.

    Catches tasks classified by rules/structural patterns that don't extract entities
    but DO mention a specific place name.
    """
    desc = task["description"]
    reason = task.get("reason", "")

    # Gather candidate location names from multiple sources
    candidates = []

    # 1. From description: "in/at/on [Location]" at end
    loc = _extract_location_from_text(desc)
    if loc:
        candidates.append(loc)

    # 2. From structural reason: "[structural] Enter specific location: X"
    m = re.search(r'Enter specific location: (.+?)$', reason, re.I)
    if m:
        candidates.append(m.group(1).strip())

    # 4. From named_location reason: "[named_location] X"
    m = re.search(r'^\[named_location\] (.+?)$', reason)
    if m:
        candidates.append(m.group(1).strip())

    if not candidates:
        return None

    for location in candidates:
        location_l = location.lower().strip()

        # Try SP data (exact tiles for banks, altars, patches, etc.)
        if sp_data:
            for sp_category in sp_data.values():
                if isinstance(sp_category, dict):
                    for key, coords in sp_category.items():
                        if key.lower() == location_l:
                            return {"x": coords["x"], "y": coords["y"], "plane": coords.get("plane", 0)}

        # Try wiki - search for location name across ALL entity entries
        # Prefer exact matches over prefix matches
        task_region = AREA_TO_REGION.get(task.get("_parsed", {}).get("area"))

        exact_matches = []
        prefix_matches = []
        for entity_entries in wiki_index.values():
            for entry in entity_entries:
                entry_loc = entry["location"].lower()
                if not entry.get("coords"):
                    continue
                if entry_loc == location_l:
                    exact_matches.append(entry)
                elif entry_loc.startswith(location_l + " ") or entry_loc.startswith(location_l + " -"):
                    prefix_matches.append(entry)

        # Pick from exact matches first, then prefix matches
        for match_list in [exact_matches, prefix_matches]:
            if not match_list:
                continue
            # Filter to task region if available
            region_filtered = [e for e in match_list if task_region and e.get("leagueRegion") == task_region]
            candidates_list = region_filtered if region_filtered else match_list
            # For prefix matches, prefer shortest location name (closest to our candidate),
            # then most spawns as tiebreaker. This avoids "Shilo Village mine (underground)"
            # winning over "Shilo Village (location)" just because it has more spawns.
            best = min(candidates_list, key=lambda e: (len(e["location"]), -len(e["coords"])))
            return centroid(best["coords"])

        # Try curated locations (exact match only, not substring)
        if location_l in curated_locations:
            c = curated_locations[location_l]
            return {"x": c["x"], "y": c["y"], "plane": c.get("plane", 0)}

    return None


def resolve_coords_curated_location(task, curated_locations):
    """Match task against curated location names.

    Checks description and rule reason for known location names.
    Returns {x, y, plane} dict or None.
    """
    if not curated_locations:
        return None

    desc_l = task["description"].lower()
    reason_l = task.get("reason", "").lower()

    # Check each curated location name against description and reason
    # Order matters: specific locations (e.g. "party room") should appear
    # before general ones (e.g. "falador") in curated_coords.json
    for loc_name, coords in curated_locations.items():
        if loc_name in desc_l or loc_name in reason_l:
            return {"x": coords["x"], "y": coords["y"], "plane": coords.get("plane", 0)}

    return None


def _sp_lookup(name, sp_dict):
    """Case-insensitive lookup in a shortest-path location dict."""
    name_l = name.lower().strip()
    # Exact match first
    for key in sp_dict:
        if key.lower() == name_l:
            return sp_dict[key]
    # Word-boundary substring match
    for key in sp_dict:
        key_l = key.lower()
        if re.search(r'\b' + re.escape(name_l) + r'\b', key_l) or re.search(r'\b' + re.escape(key_l) + r'\b', name_l):
            return sp_dict[key]
    return None


def resolve_coords_shortestpath(task, sp_data):
    """Resolve coordinates from shortest-path plugin data.

    Matches specific task description patterns to SP location tables:
    - "Use the Bank in/on/at X" -> banks
    - "Open your Bank using the Bank at X" -> banks
    - "Pray/altar in X" -> altars
    - "Take a carpet/charter/canoe from X" -> transport departures
    """
    if not sp_data:
        return None

    desc = task["description"]
    desc_l = desc.lower()

    # Bank: "Use the Bank (chest) in/on/at X" or "Bank using the Bank at X"
    m = re.search(r"use the bank (?:chest )?(?:in|on|at) (?:the )?(.+?)$", desc, re.I)
    if not m:
        m = re.search(r"bank (?:using|at) (?:the )?bank (?:at|in) (.+?)$", desc, re.I)
    if m:
        result = _sp_lookup(m.group(1), sp_data.get("banks", {}))
        if result:
            return {"x": result["x"], "y": result["y"], "plane": result.get("plane", 0)}

    # Altar: "altar/prayer in X" (skip POH)
    if re.search(r"altar|prayer", desc_l):
        m = re.search(r"(?:altar|prayer).+?(?:in|at) (?:the )?([A-Z][\w' -]+)$", desc, re.I)
        if m:
            loc = m.group(1).strip()
            if "player owned" not in loc.lower() and "house" not in loc.lower():
                result = _sp_lookup(loc, sp_data.get("altars", {}))
                if result:
                    return {"x": result["x"], "y": result["y"], "plane": result.get("plane", 0)}

    # Farming patches: "Check the health of X you've grown in Y"
    # Also: "Harvest a/an/any/some X you've grown in/at Y", "Plant a/an X in Y"
    if "check the health" in desc_l or "harvest" in desc_l or "plant a" in desc_l:
        m = re.search(r"(?:grown |grown at |in |at |on )(?:the )?([A-Z][\w' -]+?)$", desc)
        if m:
            result = _sp_lookup(m.group(1).strip(), sp_data.get("farming_patches", {}))
            if result:
                return {"x": result["x"], "y": result["y"], "plane": result.get("plane", 0)}

    # Transport departures: "Take a [carpet/charter/canoe] from X to Y"
    if "from" in desc_l:
        m = re.search(r"from ([A-Z][\w' -]+?)(?:\s+to\s+|\s*$)", desc)
        if m:
            from_name = m.group(1).strip()
            if "carpet" in desc_l:
                source = sp_data.get("carpet_stops", {})
            elif "charter" in desc_l:
                source = sp_data.get("charter_ports", {})
            elif "canoe" in desc_l:
                source = sp_data.get("canoe_stations", {})
            else:
                source = {}
            result = _sp_lookup(from_name, source)
            if result:
                return {"x": result["x"], "y": result["y"], "plane": result.get("plane", 0)}

    return None


def _curated_entity_override(task, curated_locations):
    """Check if the extracted entity name matches a curated location entry.

    Handles bosses/NPCs where the curated coords are more precise than
    wiki centroids (e.g. "cerberus" -> "cerberus' lair" curated coords).
    Only matches entity names, not region names in the description.
    """
    entity = extract_entity_name(task["description"])
    if not entity:
        return None
    entity_l = entity.lower().strip()
    # Try full entity name, then progressively shorter prefixes
    # Handles "Cerberus before she summons souls" -> "cerberus"
    words = entity_l.split()
    candidates = [" ".join(words[:i]) for i in range(len(words), 0, -1)]
    for name in candidates:
        for suffix in ["", "'s lair", "' lair", "'s den", " lair", " dungeon"]:
            key = name + suffix
            if key in curated_locations:
                c = curated_locations[key]
                return {"x": c["x"], "y": c["y"], "plane": c.get("plane", 0)}
    return None


def resolve_coords(task, wiki_index, aliases, normalizers, region_names,
                   scenery_idx, item_idx, resource_aliases, npc_locs,
                   curated_coords, sp_data=None):
    """Resolve coordinates for a SINGLE task. Tries sources in priority order.

    Returns {x, y, plane} dict or None.
    """
    sid = str(task["structId"])
    curated_tasks = curated_coords.get("tasks", {})
    curated_locations = curated_coords.get("locations", {})

    # 1. Curated coords by structId (explicit overrides, highest priority)
    if sid in curated_tasks:
        c = curated_tasks[sid]
        return {"x": c["x"], "y": c["y"], "plane": c.get("plane", 0)}

    # 2. Curated coords by entity name (e.g. "cerberus" -> "cerberus' lair")
    #    Catches bosses/NPCs where hand-verified coords beat wiki centroids.
    #    Only matches entity names, not region names from description.
    result = _curated_entity_override(task, curated_locations)
    if result:
        return result

    # 3. Shortest Path plugin data (walkable tiles for banks, altars, transport departures)
    result = resolve_coords_shortestpath(task, sp_data)
    if result:
        return result

    # 4. Wiki LocLine (named locations with exact coords, entity-name based)
    result = resolve_coords_wiki(task, wiki_index, aliases, normalizers, region_names,
                                 resource_aliases)
    if result:
        return result

    # 5. Scenery/item spawn data (coordinate clusters)
    result = resolve_coords_scenery(task, scenery_idx, item_idx, resource_aliases)
    if result:
        return result

    # 6. NPC spawn data (fallback coordinate clusters)
    result = resolve_coords_npc(task, npc_locs, curated_locations)
    if result:
        return result

    # 6. Curated coords by location name (hand-verified coords for named locations)
    result = resolve_coords_curated_location(task, curated_locations)
    if result:
        return result

    # 7. Location name lookup (extract place name from description/reason, search wiki/SP)
    result = resolve_coords_by_location_name(task, wiki_index, normalizers, curated_locations, sp_data)
    if result:
        return result

    return None


# ============================================================
# Main Classification Pipeline
# ============================================================

def classify_task(task, compiled_rules, wiki_index, scenery_idx, item_idx, rules_data, normalizers,
                  trace=False):
    """Classify a single task. Returns (result, reason)."""
    region_names = set(rules_data.get("region_names", []))
    aliases = rules_data.get("creature_aliases", {})
    resource_aliases = rules_data.get("resource_aliases", {})
    task_region = AREA_TO_REGION.get(task["area"])
    trace_lines = []

    def _trace(msg):
        if trace:
            trace_lines.append(msg)

    def _return(result):
        if trace:
            _trace(f"  -> {result[0]}: {result[1]}")
            print(f"  TRACE [{task['structId']}] {task['description']}")
            for line in trace_lines:
                print(f"    {line}")
        return result

    # 1. Rules (priority-ordered, includes overrides, fixed activities, always-multi patterns)
    rule_result = check_rules(task, compiled_rules)
    if rule_result:
        return _return(rule_result)
    _trace("1. Rules: no match")

    # 2. Structural patterns (quests, agility, enter/visit, processing verbs)
    struct_result = structural_classify(task, rules_data)
    if struct_result:
        return _return(struct_result)
    _trace("2. Structural: no match")

    # 3. Entity lookup (wiki LocLine)
    entity = extract_entity_name(task["description"])
    _trace(f"3. Entity extraction: {entity!r}")
    if entity:
        wiki_result = wiki_classify(entity, task_region, task["description"],
                                     wiki_index, aliases, region_names, normalizers)
        if wiki_result:
            return _return(wiki_result)
        _trace("   Wiki: no match")

    # 4. NPC/scenery fallback (groot's coordinate data)
    if entity:
        npc_result = npc_fallback_classify(entity, task, scenery_idx, item_idx, region_names)
        if npc_result:
            return _return(npc_result)
        _trace("   NPC fallback: no match")

    # 5. Resource lookup (scenery data for trees, rocks, stalls)
    resource = extract_resource_name(task["description"].lower())
    _trace(f"5. Resource extraction: {resource!r}")
    if resource:
        scenery_result = scenery_classify(resource, task_region, scenery_idx, item_idx,
                                           resource_aliases, region_names, task["description"])
        if scenery_result:
            return _return(scenery_result)
        _trace("   Scenery: no match")

    # 6. Named location detection (last resort)
    loc_result = named_location_classify(task, rules_data)
    if loc_result:
        return _return(loc_result)
    _trace("6. Named location: no match")

    # 7. Minigame category fallback
    if task["category"] == 5:
        desc_l = task["description"].lower()
        loc_match = re.search(r"(?:in|at|on) (.+?)$", desc_l)
        if loc_match:
            location = loc_match.group(1)
            if not any(reg in location for reg in region_names):
                return _return(("SINGLE", f"[minigame] at {location}"))
        _trace("7. Minigame fallback: no match")

    return _return(("UNCLEAR", "No rule or lookup matched"))


# ============================================================
# Output
# ============================================================

def task_entry(task, classification, reason, location=None):
    entry = {
        "structId": task["structId"],
        "name": task["name"],
        "description": task["description"],
        "category": CATEGORY_MAP.get(task["category"], str(task["category"])),
        "area": AREA_MAP.get(task["area"], str(task["area"])),
        "tier": TIER_MAP.get(task["tier"], str(task["tier"])),
        "classification": classification,
        "reason": reason,
    }
    if location:
        entry["location"] = location
    return entry


def main():
    global OUT_DIR, WIKI_INDEX, SCENERY, ITEM_SPAWNS, MONSTERS
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    coords_mode = "--coords" in flags
    trace_mode = "--trace" in flags
    input_file = TASK_DUMP
    output_file = None
    data_dir = None
    for f in flags:
        if f.startswith("--input="):
            input_file = f.split("=", 1)[1]
        elif f.startswith("--output="):
            output_file = f.split("=", 1)[1]
        elif f.startswith("--data-dir="):
            data_dir = f.split("=", 1)[1]

    # --data-dir overrides paths for bundled data files
    if data_dir:
        WIKI_INDEX = os.path.join(data_dir, "locline_index.json")
        SCENERY = os.path.join(data_dir, "scenery.json")
        ITEM_SPAWNS = os.path.join(data_dir, "item_spawns.json")
        MONSTERS = os.path.join(data_dir, "monsters.json")

    if args:
        OUT_DIR = args[0]
    os.makedirs(OUT_DIR, exist_ok=True)

    print("Loading data...")
    tasks_raw = load_json(input_file)
    print(f"  Input: {input_file}")
    rules_data = load_json(RULES_FILE)
    compiled_rules = compile_rules(rules_data)
    normalizers = build_normalizers(rules_data)
    print(f"  Rules: {len(compiled_rules)}")
    print(f"  Location normalizers: {len(normalizers)}")

    wiki_index = {}
    if os.path.exists(WIKI_INDEX):
        wiki_index = load_json(WIKI_INDEX)
        print(f"  Wiki index: {len(wiki_index)} entities")

    scenery_idx = build_scenery_region_index(load_json(SCENERY))
    item_idx = build_scenery_region_index(load_json(ITEM_SPAWNS))

    npc_locs = build_npc_index(load_json(MONSTERS))

    # Curated coordinates (manual overrides)
    curated_coords = {}
    if os.path.exists(CURATED_COORDS):
        curated_coords = load_json(CURATED_COORDS)
        num_locs = len([k for k in curated_coords.get("locations", {}) if not k.startswith("_")])
        num_tasks = len([k for k in curated_coords.get("tasks", {}) if not k.startswith("_")])
        print(f"  Curated coords: {num_locs} locations, {num_tasks} tasks")

    # Shortest Path plugin locations (walkable tiles for banks, altars, transports)
    sp_data = {}
    if os.path.exists(SP_LOCATIONS):
        sp_data = load_json(SP_LOCATIONS)
        sp_counts = {k: len(v) for k, v in sp_data.items() if isinstance(v, dict) and k != "_comment"}
        print(f"  Shortest Path: {sum(sp_counts.values())} locations ({', '.join(f'{v} {k}' for k, v in sp_counts.items())})")

    if data_dir:
        print(f"  Data dir: {data_dir}")
    print(f"  Scenery: {len(scenery_idx)} entries")
    print(f"  Items: {len(item_idx)} entries")
    print(f"  NPCs: {len(npc_locs)} entries")
    print(f"  Tasks: {len(tasks_raw)}")

    if coords_mode:
        print("  Mode: --coords (coordinate enrichment enabled)")
    if trace_mode:
        print("  Mode: --trace (classification trace enabled)")

    print("Classifying...")
    single, multi, unclear = [], [], []
    region_names = set(rules_data.get("region_names", []))
    aliases = rules_data.get("creature_aliases", {})
    resource_aliases = rules_data.get("resource_aliases", {})

    for t in tasks_raw:
        task = parse_task(t)
        task["_npc_locs"] = npc_locs  # pass reference for fallback lookups
        classification, reason = classify_task(task, compiled_rules, wiki_index,
                                                scenery_idx, item_idx, rules_data, normalizers,
                                                trace=trace_mode)

        location = None
        if coords_mode and classification == "SINGLE":
            # Build a task-like dict with both parsed fields and output fields for coord resolution
            coord_task = task_entry(task, classification, reason)
            coord_task["_parsed"] = task
            location = resolve_coords(coord_task, wiki_index, aliases, normalizers,
                                       region_names, scenery_idx, item_idx,
                                       resource_aliases, npc_locs, curated_coords,
                                       sp_data)

        entry = task_entry(task, classification, reason, location)
        if classification == "SINGLE":
            single.append(entry)
        elif classification == "MULTI":
            multi.append(entry)
        else:
            unclear.append(entry)

    single.sort(key=lambda x: x["structId"])
    multi.sort(key=lambda x: x["structId"])
    unclear.sort(key=lambda x: x["structId"])

    print(f"\nResults:")
    print(f"  SINGLE: {len(single)}")
    print(f"  MULTI:  {len(multi)}")
    print(f"  UNCLEAR: {len(unclear)}")
    print(f"  Total:  {len(single) + len(multi) + len(unclear)}")

    if coords_mode:
        with_coords = sum(1 for t in single if "location" in t)
        without_coords = len(single) - with_coords
        print(f"\n  Coordinates:")
        print(f"    With coords: {with_coords}")
        print(f"    Without coords: {without_coords}")

    # --output mode: write a single consolidated JSON keyed by structId
    if output_file:
        consolidated = {}
        for entry in single + multi + unclear:
            val = {"classification": entry["classification"], "reason": entry.get("reason", "")}
            if "location" in entry:
                val["location"] = entry["location"]
            consolidated[str(entry["structId"])] = val
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(consolidated, f, indent=2, ensure_ascii=False)
        print(f"  Wrote {output_file} ({len(consolidated)} tasks)")
    else:
        # Default: write separate files per classification
        for filename, data in [
            ("location_single.json", single),
            ("location_multi.json", multi),
            ("location_unclear.json", unclear),
        ]:
            path = os.path.join(OUT_DIR, filename)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            print(f"  Wrote {path} ({len(data)} tasks)")

        # In coords mode, also write a separate file with just tasks missing coordinates
        if coords_mode:
            missing = [t for t in single if "location" not in t]
            if missing:
                path = os.path.join(OUT_DIR, "missing_coords.json")
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(missing, f, indent=2, ensure_ascii=False)
                print(f"  Wrote {path} ({len(missing)} tasks missing coordinates)")


if __name__ == "__main__":
    main()
