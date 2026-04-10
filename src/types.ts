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
  skills?: TaskSkill[];
  wikiNotes?: string;
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
// Task type definition (fetched from task-json-store)
// ============================================================

export interface TaskTypeDefinition {
  name: string;
  description: string;
  isEnabled: boolean;
  taskJsonName: string;
  intParamMap: Record<string, number>;
  stringParamMap: Record<string, number>;
  intEnumMap: Record<string, number>;
  stringEnumMap: Record<string, number>;
  tierSpriteIdMap: Record<string, number>;
  taskVarps: number[];
  otherVarps: number[];
  varbits: number[];
  taskCompletedScriptId: number;
  filters: FilterConfig[];
}

export interface FilterConfig {
  configKey: string;
  label: string;
  filterType: string;
  valueType: string;
  valueName?: string;
  optionLabelEnum?: string;
  customItems: any[];
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
  requirements?: string;
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
// League metadata (generated/leagues.json)
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
// Wiki column configs per league
// ============================================================

export const WIKI_COLUMNS: Record<string, WikiColumnConfig> = {
  LEAGUE_5: {
    nameColumnId: 1,
    descriptionColumnId: 2,
    requirementsColumnId: 3,
    pointsColumnId: 4,
    completionColumnId: 5,
  },
};
