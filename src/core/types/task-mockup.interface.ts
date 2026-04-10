//TODO: update this from java
export interface ITask {
  /**
   * Struct id for task data
   */
  structId: number;
  /**
   * Sort id based on the sort order in the game's UI
   */
  sortId: number;
  /**
   * Skills required for the task
   */
  skills?: ITaskSkill[];
  /**
   * Metadata related to the task that isn't represented in the Struct/params
   * May or may not be used for task filters
   * Examples:
   * - notes = extra description like "a magic cabbage is a cabbage picked at Draynor Manor"
   * - category = an extra category type that isn't a param
   */
  metadata?: { [key: string]: string | number };

  wikiNotes?: string;

  completionPercent?: number;
}

export interface ITaskSkill {
  /**
   * The skill
   */
  skill: string;
  /**
   * The level required
   */
  level: number;
}

/**
 * Full task representation with all params resolved to human-readable values.
 * Used by external consumers (e.g., web tools) that don't have a live OSRS client.
 */
export interface ITaskFull extends ITask {
  /** Task name (string param, e.g., param 874 for leagues) */
  name: string;
  /** Task description (string param, e.g., param 875 for leagues) */
  description: string;
  /** Geographic area resolved from stringEnumMap (e.g., "Kandarin") */
  area: string | null;
  /** Task category resolved from stringEnumMap (e.g., "Combat") */
  category: string | null;
  /** Primary skill resolved from stringEnumMap (e.g., "Slayer") */
  skill: string | null;
  /** Tier as raw integer from intParamMap (e.g., 1 = Easy) */
  tier: number | null;
  /** Tier resolved to display name from stringEnumMap (e.g., "Easy") */
  tierName: string | null;
  /** Location classification: SINGLE, MULTI, or UNCLEAR */
  classification?: string;
  /** Coordinate for SINGLE-location tasks */
  location?: { x: number; y: number; plane: number };
}
