# full-task-scraper

A fork of [osrs-reldo/task-scraper](https://github.com/osrs-reldo/task-scraper) that extends the original scraper to produce self-hosted, fully-resolved task JSON files for all OSRS leagues. The upstream repo does the heavy lifting -- this fork adds a `generate-full` command and hosts the output.

## Credit

The vast majority of this codebase was built by the [osrs-reldo](https://github.com/osrs-reldo) team. This fork adds a thin layer on top for generating and self-hosting full task data. All game cache reading, wiki scraping, struct/enum resolution, and CLI infrastructure comes from the original project.

## Purpose

The upstream scraper produces minimal task JSON (just `structId` + `sortId`) for the [Tasks Tracker RuneLite plugin](https://github.com/osrs-reldo/tasks-tracker-plugin), which resolves names, areas, and tiers from the live OSRS game client at runtime. External tools (like web-based route planners) don't have access to a live game client, so they need a fully-resolved version with human-readable field values.

This fork:
- Generates **normalized** task JSON with all params resolved to strings (`LEAGUE_5.full.json`)
- Generates **raw** task JSON with unresolved integer param values (`LEAGUE_5.raw.json`)
- Hosts historical task data for all leagues in `generated/`, raw + full normalized available for leagues 5 and beyond
- Auto-detects the active league from date metadata

## Requirements

- Node v22.4.0+
- Game cache files auto-download from [abextm/osrs-cache](https://github.com/abextm/osrs-cache) on first run

## Usage

### Generate full task JSON for the current league

```bash
# Auto-detect active league from generated/leagues.json dates
npm run cli -- tasks generate-full

# Or specify explicitly
npm run cli -- tasks generate-full LEAGUE_5
```

This produces three files in the appropriate league subfolder:

| File | Description |
|------|-------------|
| `LEAGUE_5.full.json` | Normalized -- all params resolved to human-readable values |
| `LEAGUE_5.raw.json` | Raw -- integer param values preserved, mapped names where known |
| `LEAGUE_5.csv` | CSV export of normalized data -- for Google Sheets, Excel, etc. |

### Re-scrape wiki data only

During a league, completion percentages change as players progress. This command updates wiki data (completion %, skills, notes) in the existing `full.json` without re-extracting from the game cache -- much faster than a full regeneration.

```bash
# Auto-detect active league
npm run cli -- tasks update-wiki

# Or specify explicitly
npm run cli -- tasks update-wiki LEAGUE_5
```

### Other useful commands

```bash
# Check local game cache status
npm run cli -- cache status

# Update game cache to latest
npm run cli -- cache update

# Interactive task extraction (for discovering new league param maps)
npm run cli -- tasks extract

# Update varps from game scripts
npm run cli -- tasks update-varps --type LEAGUE_5 --json
```

## Consuming this data

The generated JSON files are committed to this repo and can be fetched directly via raw GitHub URLs. This is the intended primary method of consumption -- no need to clone the repo or run the scraper yourself.

```
https://raw.githubusercontent.com/syrifgit/full-task-scraper/main/generated/leagues.json
https://raw.githubusercontent.com/syrifgit/full-task-scraper/main/generated/league-5-raging-echoes/LEAGUE_5.full.json
https://raw.githubusercontent.com/syrifgit/full-task-scraper/main/generated/league-5-raging-echoes/LEAGUE_5.csv
```

**For web tools and other external consumers:**
1. Fetch `leagues.json` to discover available leagues, dates, and file paths
2. Fetch the `*.full.json` for the league you need
3. That's it

**For Google Sheets / Excel:**
A CSV is also available for each league. In Google Sheets, use:
```
=IMPORTDATA("https://raw.githubusercontent.com/syrifgit/full-task-scraper/main/generated/league-5-raging-echoes/LEAGUE_5.csv")
```

### Freshness

During an active league, the generated data is automatically regenerated whenever the [abextm/osrs-cache](https://github.com/abextm/osrs-cache) repo updates. Wiki data (completion %, skill requirements, notes) is re-scraped on a regular cadence during the league to keep percentages current.

## Output structure

```
generated/
  leagues.json                          # Metadata for all leagues (dates, task counts, file paths)
  league-1-twisted/
    LEAGUE1.full.json                   # 495 tasks (from upstream legacy data)
  league-2-trailblazer/
    LEAGUE2.full.json                   # 1020 tasks
  league-3-shattered-relics/
    LEAGUE3.full.json                   # 1260 tasks
  league-4-trailblazer-reloaded/
    LEAGUE4.full.json                   # 1481 tasks
  league-5-raging-echoes/
    LEAGUE_5.full.json                  # 1589 tasks (generated from game cache + wiki)
    LEAGUE_5.raw.json                   # 1589 tasks (raw param values)
    LEAGUE_5.csv                        # 1589 tasks (CSV for spreadsheets)
  league-6-demonic-pacts/               # Awaiting league launch (April 2026)
```

### Normalized task example (`*.full.json`)

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
  "wikiNotes": "70 Ranged,  40 Defence"
}
```

### Raw task example (`*.raw.json`)

```json
{
  "structId": 1918,
  "sortId": 849,
  "params": {
    "id": 425,
    "name": "Equip a Full Black Dragonhide Set",
    "description": "Equip a Black Dragonhide Body, some Black Dragonhide Chaps and some Black Dragonhide Vambraces",
    "category": 2,
    "area": 0,
    "skill": 3,
    "tier": 3,
    "1850": 3,
    "1851": 3,
    "1852": 3
  }
}
```

## leagues.json

Central metadata file tracking all leagues. Used by the `generate-full` command for auto-detection and output routing.

```json
{
  "league": 5,
  "name": "Raging Echoes League",
  "shortName": "Raging Echoes",
  "startDate": "2024-11-27",
  "endDate": "2025-01-22",
  "taskTypeName": "LEAGUE_5",
  "wikiUrl": "https://oldschool.runescape.wiki/w/Raging_Echoes_League/Tasks",
  "taskCount": 1589,
  "dir": "league-5-raging-echoes",
  "taskFile": "LEAGUE_5.full.json"
}
```

## Data sources

| Source | What it provides |
|--------|-----------------|
| [abextm/osrs-cache](https://github.com/abextm/osrs-cache) | Game cache `.flatcache` files (auto-downloaded) |
| [OSRS Wiki](https://oldschool.runescape.wiki) | Completion %, skill requirements, wiki notes (scraped at generation time) |
| [osrs-reldo/task-json-store](https://github.com/osrs-reldo/task-json-store) | `task-types.json` for param/enum map definitions |

## Monitoring

A GitHub Actions workflow (`check-upstream.yml`) runs daily to check if the upstream [osrs-reldo/task-scraper](https://github.com/osrs-reldo/task-scraper) has been updated, and opens an issue if so.
