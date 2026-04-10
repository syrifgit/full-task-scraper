# OSRS League Task Data Scraper

A self-sufficient TypeScript CLI that extracts OSRS league task data directly from the game cache, enriches it with wiki data, classifies tasks by location, and outputs multiple formats. No external task-type definitions needed - discovers everything from the cache.

## What it does

- Extracts task data from OSRS game cache for leagues 1-5 from a single cache file
- Resolves task names, descriptions, areas, categories, skills, and tier info
- Scrapes wiki for completion percentages, skill requirements, and notes
- Classifies tasks by location type (SINGLE/MULTI/UNCLEAR) and resolves GPS coordinates
- Outputs full normalized JSON, raw param values, lean plugin format, and CSV exports
- Manages game cache with auto-download and update commands
- Detects and reports new leagues and irregularities in the cache

## Architecture

Self-contained TypeScript pipeline (~1,100 lines across 10 source files) with no framework dependencies. Python classification pipeline bundled for location categorization.

**Directory structure:**
```
src/              # TypeScript pipeline (extract, hydrate, output, wiki scraping)
classify/         # Python classification + location resolution pipeline
  data/           # Wiki-derived coordinate data (NPCs, scenery, items, spawns)
  rules.json      # 255+ classification rules for SINGLE/MULTI/UNCLEAR
  curated_coords.json  # Hand-verified overrides for problematic tasks
leagues/          # Output per league
  index.json      # League metadata (dates, wiki URLs, task counts)
  league-N-name/  # Per-league output files
osrs-cache/       # Game cache (auto-downloaded, git-ignored)
```

## Installation

```bash
npm install
```

**Requirements:**
- Node v22.4.0+
- Python 3 (for classification pipeline)
- Game cache auto-downloads on first run from [abextm/osrs-cache](https://github.com/abextm/osrs-cache)

## CLI Commands

### Full pipeline

```bash
# Generate everything: extract from cache, scrape wiki, classify, add locations
npm run cli -- tasks generate-full [LEAGUE_N]

# Specify league explicitly (e.g., LEAGUE_5, LEAGUE_4)
npm run cli -- tasks generate-full LEAGUE_5
```

Produces `*.full.json` (fully resolved), `*.min.json` (plugin format), `*.raw.json` (raw params), and `*.csv` (spreadsheet).

### Classification and location resolution

```bash
# Run classification pipeline + merge locations into full.json
npm run cli -- tasks classify LEAGUE_N

# Merge only a locations.json without re-running classification
npm run cli -- tasks merge-locations LEAGUE_N --locations=<path>
```

### Wiki updates

```bash
# Re-scrape wiki without re-extracting from cache (much faster)
npm run cli -- tasks update-wiki [LEAGUE_N]
```

### Discovery and diagnosis

```bash
# Scan cache for leagues, detect new ones, report inconsistencies
npm run cli -- tasks discover [--wiki <url>] [--prev-tier <param>]
```

### Cache management

```bash
# Check cache status (version, size, last updated)
npm run cli -- cache status

# Download/update game cache to latest
npm run cli -- cache update
```

## Output formats per league

All outputs in `leagues/league-N-name/`:

| File | Description |
|------|-------------|
| `LEAGUE_N.full.json` | Everything resolved: name, description, area, category, skill, tier, wiki notes (plain + HTML), skill requirements, classification (SINGLE/MULTI/UNCLEAR), location (x, y, plane for single-location tasks) |
| `LEAGUE_N.min.json` | Lean plugin format: structId, sortId, skills array, wikiNotes, completionPercent, location |
| `LEAGUE_N.raw.json` | Raw param values from cache with integer IDs |
| `LEAGUE_N.csv` | Spreadsheet export (Google Sheets, Excel) |

### Full format example

```json
{
  "structId": 1918,
  "sortId": 849,
  "name": "Equip a Full Black Dragonhide Set",
  "description": "Equip a Black Dragonhide Body, some Black Dragonhide Chaps and some Black Dragonhide Vambraces",
  "area": "Global",
  "category": "Combat",
  "skill": "Artisan",
  "tier": 3,
  "tierName": "Hard",
  "completionPercent": 29.1,
  "skills": [
    { "skill": "DEFENCE", "level": 40 },
    { "skill": "RANGED", "level": 70 }
  ],
  "wikiNotes": "70 Ranged, 40 Defence",
  "classification": "SINGLE",
  "location": {
    "x": 2445,
    "y": 3202,
    "plane": 0
  }
}
```

### Minimal plugin format example

```json
{
  "structId": 1918,
  "sortId": 849,
  "skills": [
    { "skill": "DEFENCE", "level": 40 },
    { "skill": "RANGED", "level": 70 }
  ],
  "wikiNotes": "70 Ranged, 40 Defence",
  "completionPercent": 29.1,
  "location": {
    "x": 2445,
    "y": 3202,
    "plane": 0
  }
}
```

## Self-sufficient design

The scraper discovers everything needed from the game cache:

- **Stable param IDs** (873-875, 1016-1018) are identical across all leagues
  - 873 = varbit index, 874 = name, 875 = description
  - 1016 = category, 1017 = area, 1018 = skill
- **Tier param varies per league** (1849, 1850, 1851, 1852, 2044)
- **Name resolution enums** discovered automatically from cache
- **No dependency on external task-types.json** - everything is in the game cache

## Classification pipeline

Bundled Python pipeline (stdlib only, no pip dependencies) for categorizing tasks:

- **255+ classification rules** for determining SINGLE vs MULTI vs UNCLEAR locations
- **Location resolution** for SINGLE-location tasks using bundled wiki data
- **Curated overrides** for problematic tasks (bosses, minigames, entity-name conflicts)
- **623 L5 tasks with GPS coordinates** verified against wiki spawn data

Coordinate data bundled includes:
- NPC locations (Shortest Path plugin export)
- Scenery coordinates (wiki cache)
- Item spawns (wiki cache)
- Minigame/boss overrides

## Historical data protection

Ended leagues are read-only:

```bash
# Refuses to overwrite L1-L4 without explicit force flag
npm run cli -- tasks generate-full LEAGUE_4
# Error: League 4 ended. Use --force to regenerate.

npm run cli -- tasks generate-full LEAGUE_4 --force
```

## Current league data

| League | Tasks | Wiki Coverage | Classification |
|--------|-------|---|---|
| L1 Twisted | 188 | No | No |
| L2 Trailblazer | 942 | Yes (695 matched) | No |
| L3 Shattered Relics | 1169 | Yes (905 matched) | No |
| L4 Trailblazer Reloaded | 1472 | Yes (1091 matched) | No |
| L5 Raging Echoes | 1589 | Yes (1589 matched) | Yes (623 with GPS coords) |

## Using the generated data

The output files are committed to this repo and available via raw GitHub URLs - the intended primary consumption method. No need to clone or run the scraper yourself.

### For web tools

```bash
# Get all available leagues
https://raw.githubusercontent.com/osrs-reldo/full-task-scraper/main/leagues/index.json

# Get full task data for a league
https://raw.githubusercontent.com/osrs-reldo/full-task-scraper/main/leagues/league-5-raging-echoes/LEAGUE_5.full.json

# Get minimal plugin format
https://raw.githubusercontent.com/osrs-reldo/full-task-scraper/main/leagues/league-5-raging-echoes/LEAGUE_5.min.json
```

Workflow:
1. Fetch `leagues/index.json` to discover available leagues and file paths
2. Fetch the `*.full.json` or `*.min.json` for your league
3. Done

### For spreadsheets

CSV exports work directly in Google Sheets and Excel:

```
=IMPORTDATA("https://raw.githubusercontent.com/osrs-reldo/full-task-scraper/main/leagues/league-5-raging-echoes/LEAGUE_5.csv")
```

## Data sources

| Source | Provides |
|--------|----------|
| [abextm/osrs-cache](https://github.com/abextm/osrs-cache) | Game cache `.flatcache` files |
| [OSRS Wiki](https://oldschool.runescape.wiki) | Completion %, skill requirements, notes |
| Bundled classification data | Wiki spawn coords, NPC locations, curated overrides |

## Credit

Original codebase built by the [osrs-reldo](https://github.com/osrs-reldo) team. This is a rebuilt fork that extends the scraper with a self-hosted, fully-resolved task JSON pipeline and location classification.
