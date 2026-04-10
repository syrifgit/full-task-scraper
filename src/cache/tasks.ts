/**
 * Task extraction and hydration from game cache.
 *
 * Self-sufficient: uses stable param IDs (same across all known leagues)
 * and discovers name resolution enums directly from the cache.
 * No external task-type definitions needed.
 */

import { ParamID, Struct, Enum as CacheEnum, FlatCacheProvider, ScriptVarType } from '@abextm/cache2';
import { Task, TaskFull } from '../types';

const pid = (n: number) => n as any as ParamID;

// Stable across all known leagues (L1-L5)
const PARAMS = {
  VARBIT_INDEX: pid(873),
  NAME: pid(874),
  DESCRIPTION: pid(875),
  CATEGORY: pid(1016),
  AREA: pid(1017),
  SKILL: pid(1018),
};

// Known tier params per league
const KNOWN_TIER_PARAMS = [1849, 1850, 1851, 1852, 2044];

export async function getStruct(cache: FlatCacheProvider, id: number): Promise<Struct> {
  return Struct.load(cache, id);
}

async function loadAllStructs(cache: FlatCacheProvider): Promise<Struct[]> {
  const all = await Struct.all(cache);
  return [...all].sort((a, b) => a.id - b.id);
}

async function loadEnum(cache: FlatCacheProvider, id: number): Promise<CacheEnum> {
  return CacheEnum.load(cache, id);
}

async function findEnumsContainingStruct(cache: FlatCacheProvider, structId: number): Promise<CacheEnum[]> {
  const all = await CacheEnum.all(cache);
  return [...all].filter(e => {
    if (e.valueTypeChar !== ScriptVarType.struct.char) return false;
    for (const val of e.map.values()) {
      if (val === structId) return true;
    }
    return false;
  });
}

/**
 * Discover name resolution enums from the cache by searching for known values.
 */
async function discoverStringEnums(cache: FlatCacheProvider): Promise<{
  area?: CacheEnum;
  category?: CacheEnum;
  tier?: CacheEnum;
  skill?: CacheEnum;
}> {
  const all = await CacheEnum.all(cache);
  const stringEnums = [...all].filter(e => e.valueTypeChar === ScriptVarType.string.char);

  const find = (...terms: string[]) => {
    const matches = stringEnums.filter(e => {
      const vals = [...e.map.values()].map(v => String(v));
      return terms.every(t => vals.includes(t));
    });
    if (matches.length === 0) return undefined;
    // Prefer the smallest enum (data enum, not UI-label enum with -1/All entries)
    return matches.sort((a, b) => a.map.size - b.map.size)[0];
  };

  return {
    area: find('Misthalin', 'Karamja', 'Asgarnia'),
    category: find('Combat', 'Skill', 'Quest', 'Achievement'),
    tier: find('Easy', 'Medium', 'Hard', 'Elite', 'Master'),
    skill: find('Attack', 'Strength', 'Mining', 'Woodcutting'),
  };
}

/**
 * Resolve the tier param for a given task type name.
 * Checks leagues.json metadata first, then known tier params, then scans for unknown.
 */
export function resolveTierParam(taskTypeName: string): number {
  // Map known league names to their tier params
  const map: Record<string, number> = {
    LEAGUE_1: 1849, LEAGUE1: 1849,
    LEAGUE_2: 1850, LEAGUE2: 1850,
    LEAGUE_3: 1851, LEAGUE3: 1851,
    LEAGUE_4: 1852, LEAGUE4: 1852,
    LEAGUE_5: 2044, LEAGUE5: 2044,
  };
  const tierParam = map[taskTypeName.toUpperCase()];
  if (tierParam) return tierParam;
  throw new Error(
    `Unknown league "${taskTypeName}". Known: ${Object.keys(map).join(', ')}. ` +
    `For a new league, run 'tasks discover' to find the tier param, then add it here.`,
  );
}

/**
 * Extract ordered tasks from the cache using a tier param.
 */
export async function extractTasksFromCache(
  cache: FlatCacheProvider,
  tierParam: number,
): Promise<Task[]> {
  const tierParamId = pid(tierParam);

  // Find all structs with the tier param
  const allStructs = await loadAllStructs(cache);
  const taskStructs = allStructs.filter(s => {
    const tier = s.params.get(tierParamId);
    if (tier === undefined) return false;
    if (tier === 100 && tierParam === 1310) return false; // CA edge case
    return true;
  });

  console.log(`  Found ${taskStructs.length} structs with tier param ${tierParam}`);

  // Group by tier to find ordering enums
  const tierMap = new Map<number, Struct[]>();
  for (const s of taskStructs) {
    const tier = s.params.get(tierParamId) as number;
    const list = tierMap.get(tier) || [];
    tierMap.set(tier, [...list, s]);
  }

  // For each tier, find the ordering enum
  const tierEnumIds: (number | undefined)[] = [];
  for (const [tierId, structs] of tierMap.entries()) {
    const sample = structs[Math.min(5, structs.length - 1)];
    const possibleEnums = await findEnumsContainingStruct(cache, sample.id);
    const tierStructIds = new Set(structs.map(s => s.id));
    const filtered = possibleEnums.filter(e => {
      const enumIds = new Set(e.map.values() as IterableIterator<number>);
      for (const id of tierStructIds) {
        if (id === 1949 || id === 5704) continue; // Known L4 oddities
        if (!enumIds.has(id)) return false;
      }
      return true;
    });
    if (filtered.length === 0) throw new Error(`No ordering enum for tier ${tierId}`);
    // Pick the smallest matching enum (most specific to this league)
    filtered.sort((a, b) => a.map.size - b.map.size);
    tierEnumIds[tierId] = filtered[0].id;
  }

  // Deduplicate if all tiers share one enum
  const unique = tierEnumIds.filter(v => v !== undefined);
  if (unique.length > 0 && unique.every(v => v === unique[0])) {
    tierEnumIds.length = 0;
    tierEnumIds[0] = unique[0];
  }

  // Pull struct IDs in order from the enums, filtered to only those with the tier param.
  // The ordering enum may contain structs from multiple leagues (e.g., L1 and L3 share enum 5255).
  const validStructIds = new Set(taskStructs.map(s => s.id));
  const orderedIds: number[] = [];
  for (const enumId of tierEnumIds) {
    if (enumId === undefined) continue;
    const e = await loadEnum(cache, enumId);
    for (const structId of e.map.values()) {
      if (validStructIds.has(structId as any)) {
        orderedIds.push(structId as number);
      }
    }
  }

  return orderedIds.map((structId, i) => ({ structId, sortId: i }));
}

/**
 * Hydrate tasks with resolved params and enum names.
 * Discovers name resolution enums directly from the cache.
 */
export async function hydrateTasks(
  cache: FlatCacheProvider,
  tasks: Task[],
  tierParam: number,
): Promise<{ fullTasks: TaskFull[]; rawTasks: any[] }> {
  // Discover name resolution enums from cache
  const enums = await discoverStringEnums(cache);
  console.log(`  Discovered enums — area: ${enums.area?.id ?? 'none'}, category: ${enums.category?.id ?? 'none'}, tier: ${enums.tier?.id ?? 'none'}, skill: ${enums.skill?.id ?? 'none'}`);

  // All known param IDs for raw output naming
  const paramNames: Record<number, string> = {
    873: 'id', 874: 'name', 875: 'description',
    1016: 'category', 1017: 'area', 1018: 'skill',
    [tierParam]: 'tier',
  };

  const fullTasks: TaskFull[] = [];
  const rawTasks: any[] = [];

  for (const task of tasks) {
    const struct = await getStruct(cache, task.structId);

    // Raw params
    const rawParams: Record<string, string | number> = {};
    for (const [paramId, value] of struct.params.entries()) {
      const name = paramNames[paramId as number];
      rawParams[name || String(paramId)] = value;
    }
    rawTasks.push({ structId: task.structId, sortId: task.sortId, params: rawParams });

    // Resolved values
    const name = struct.params.get(PARAMS.NAME)?.toString() ?? null;
    const description = struct.params.get(PARAMS.DESCRIPTION)?.toString() ?? null;
    const tierRaw = struct.params.get(pid(tierParam)) as number ?? null;
    const areaRaw = struct.params.get(PARAMS.AREA) as number;
    const categoryRaw = struct.params.get(PARAMS.CATEGORY) as number;
    const skillRaw = struct.params.get(PARAMS.SKILL) as number;

    const resolveEnum = (enumDef: CacheEnum | undefined, value: any): string | null => {
      if (!enumDef || value === undefined || value === null) return null;
      return (enumDef.map.get(value) as string) ?? null;
    };

    fullTasks.push({
      ...task,
      name: name ?? `Unknown (struct ${task.structId})`,
      description: description ?? '',
      area: resolveEnum(enums.area, areaRaw),
      category: resolveEnum(enums.category, categoryRaw),
      skill: resolveEnum(enums.skill, skillRaw),
      tier: tierRaw,
      tierName: resolveEnum(enums.tier, tierRaw),
    });
  }

  return { fullTasks, rawTasks };
}
