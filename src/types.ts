import { ParamID } from '@abextm/cache2';

// ============================================================
// Task types
// ============================================================

export interface TaskSkill {
  skill: string;
  level: number;
}

/** Minimal task data from cache extraction + wiki enrichment */
export interface Task {
  structId: number;
  sortId: number;
  skillRequirements?: TaskSkill[];
  /** Plain text wiki notes (for plugin) */
  wikiNotes?: string;
  /** HTML wiki notes with formatting preserved (for web tools) */
  wikiNotesHtml?: string;
  completionPercent?: number;
}

/** Full task with all params resolved to human-readable values */
export interface TaskFull extends Task {
  name: string;
  description: string;
  area: string | null;
  category: string | null;
  skill: string | null;
  tier: number | null;
  tierName: string | null;
  /** Location classification: SINGLE, MULTI, or UNCLEAR */
  classification?: string;
  /** Coordinate for SINGLE-location tasks */
  location?: { x: number; y: number; plane: number };
}

// ============================================================
// Wiki scraping
// ============================================================

export interface WikiColumnConfig {
  nameColumnId: number;
  descriptionColumnId: number;
  requirementsColumnId: number;
  pointsColumnId: number;
  completionColumnId: number | null;
}

export interface WikiTaskData {
  varbitIndex: number;
  name?: string;
  description?: string;
  /** Plain text requirements (for plugin min.json) */
  requirements?: string;
  /** HTML requirements with wiki formatting preserved (for web tool full.json) */
  requirementsHtml?: string;
  points?: string;
  completionPercent?: number;
  skills: TaskSkill[];
}

// ============================================================
// Classification output (from classify.py)
// ============================================================

export interface LocationEntry {
  classification: string;
  reason?: string;
  location?: { x: number; y: number; plane: number };
}

// ============================================================
// League metadata (leagues/index.json)
// ============================================================

export interface LeagueMetadata {
  league: number;
  name: string;
  startDate: string;
  endDate: string;
  active: boolean;
  taskTypeName: string;
  wikiUrl?: string;
  taskCount?: number;
  dir: string;
  taskFile?: string;
}

// ============================================================
// Param IDs
// ============================================================

export const PARAM_IDS = {
  LEAGUE_VARBIT_INDEX: 873 as ParamID,
  LEAGUE_NAME: 874 as ParamID,
  LEAGUE_DESCRIPTION: 875 as ParamID,
  LEAGUE_TIER_ID: 2044 as ParamID,
  CA_VARBIT_INDEX: 1306 as ParamID,
  CA_NAME: 1308 as ParamID,
  CA_DESCRIPTION: 1309 as ParamID,
  CA_MONSTER_ID: 1312 as ParamID,
  CA_TIER_ID: 1310 as ParamID,
};

// ============================================================
// Wiki column config
// ============================================================

/** Default wiki table layout. Stable across L4/L5, likely future leagues too. */
export const DEFAULT_WIKI_COLUMNS: WikiColumnConfig = {
  nameColumnId: 1,
  descriptionColumnId: 2,
  requirementsColumnId: 3,
  pointsColumnId: 4,
  completionColumnId: 5,
};
