import { ParamID, Struct, Enum as CacheEnum, FlatCacheProvider, ScriptVarType } from '@abextm/cache2';
import { Task, TaskFull, TaskTypeDefinition } from '../types';

export async function getStruct(cache: FlatCacheProvider, id: number): Promise<Struct> {
  return Struct.load(cache, id);
}

async function findStructsByParam(cache: FlatCacheProvider, paramId: ParamID): Promise<Struct[]> {
  const all = await Struct.all(cache);
  return [...all].sort((a, b) => a.id - b.id).filter(s => s.params.get(paramId) !== undefined);
}

async function getEnum(cache: FlatCacheProvider, id: number): Promise<CacheEnum> {
  return CacheEnum.load(cache, id);
}

async function findEnumsByStruct(cache: FlatCacheProvider, structId: number): Promise<CacheEnum[]> {
  const all = await CacheEnum.all(cache);
  return [...all].filter(e => {
    if (e.valueTypeChar !== ScriptVarType.struct.char) return false;
    for (const val of e.map.values()) {
      if (val === structId) return true;
    }
    return false;
  });
}

export async function extractTasksFromCache(
  cache: FlatCacheProvider,
  taskType: TaskTypeDefinition,
): Promise<Task[]> {
  const tierParamId = taskType.intParamMap?.tier as ParamID;
  if (!tierParamId) throw new Error(`Task type has no 'tier' in intParamMap`);

  // Find all structs with the tier param
  const allTaskStructs = (await findStructsByParam(cache, tierParamId)).filter(s => {
    const tierId = s.params.get(tierParamId) as number;
    // Edge case: christmas achievement struct using combat achievement params (tier=100)
    if (tierId === 100 && tierParamId === 1310) return false; // CA_TIER_ID
    return tierId !== undefined;
  });

  // Group by tier
  const tierMap = new Map<number, Struct[]>();
  for (const struct of allTaskStructs) {
    const tierId = struct.params.get(tierParamId) as number;
    const list = tierMap.get(tierId) || [];
    tierMap.set(tierId, [...list, struct]);
  }

  // For each tier, find the ordering enum
  const tierEnumIds: (number | undefined)[] = [];
  for (const [tierId, structs] of tierMap.entries()) {
    const sample = structs[Math.min(5, structs.length - 1)];
    const possibleEnums = await findEnumsByStruct(cache, sample.id);
    const tierStructIds = structs.map(s => s.id);
    const filtered = possibleEnums.filter(e => {
      const enumStructIds = new Set(e.map.values() as IterableIterator<number>);
      for (const id of tierStructIds) {
        if (id === 1949 || id === 5704) continue; // Odd L4 structs
        if (!enumStructIds.has(id)) return false;
      }
      return true;
    });
    if (filtered.length === 0) throw new Error(`No ordering enum for tier ${tierId}`);
    if (filtered.length > 1) throw new Error(`Ambiguous: multiple enums match tier ${tierId}`);
    tierEnumIds[tierId] = filtered[0].id;
  }

  // Deduplicate if all tiers share one enum
  const unique = tierEnumIds.filter(v => v !== undefined);
  if (unique.length > 0 && unique.every(v => v === unique[0])) {
    tierEnumIds.length = 0;
    tierEnumIds[0] = unique[0];
  }

  // Pull struct IDs in order
  const orderedIds: number[] = [];
  for (const enumId of tierEnumIds) {
    if (enumId === undefined) continue;
    const e = await getEnum(cache, enumId);
    for (const structId of e.map.values()) {
      orderedIds.push(structId as number);
    }
  }

  return orderedIds.map((structId, i) => ({ structId, sortId: i }));
}

export async function hydrateTasks(
  cache: FlatCacheProvider,
  tasks: Task[],
  taskType: TaskTypeDefinition,
): Promise<{ fullTasks: TaskFull[]; rawTasks: any[] }> {
  const intParamMap = taskType.intParamMap ?? {};
  const stringParamMap = taskType.stringParamMap ?? {};
  const paramMap: Record<string, number> = { ...intParamMap, ...stringParamMap };
  const stringEnumMap = taskType.stringEnumMap ?? {};

  // Pre-load enums
  const enumCache = new Map<number, Map<any, any>>();
  for (const enumId of Object.values(stringEnumMap)) {
    if (!enumCache.has(enumId)) {
      const e = await getEnum(cache, enumId);
      enumCache.set(enumId, e.map);
    }
  }

  // Reverse lookup: paramId -> mapped name
  const paramIdToName = new Map<number, string>();
  for (const [name, id] of Object.entries(paramMap)) {
    paramIdToName.set(id, name);
  }

  const fullTasks: TaskFull[] = [];
  const rawTasks: any[] = [];

  for (const task of tasks) {
    const struct = await getStruct(cache, task.structId);

    // Raw params
    const rawParams: Record<string, string | number> = {};
    for (const [paramId, value] of struct.params.entries()) {
      const name = paramIdToName.get(paramId as number);
      rawParams[name || String(paramId)] = value;
    }
    rawTasks.push({ structId: task.structId, sortId: task.sortId, params: rawParams });

    // Resolved values
    const resolveEnum = (key: string): string | null => {
      const enumId = stringEnumMap[key];
      const paramId = paramMap[key];
      if (enumId === undefined || paramId === undefined) return null;
      const raw = struct.params.get(paramId as any);
      if (raw === undefined || raw === null) return null;
      return (enumCache.get(enumId)?.get(raw) as string) ?? null;
    };

    const name = stringParamMap['name']
      ? struct.params.get(stringParamMap['name'] as any)?.toString() ?? null
      : null;
    const description = stringParamMap['description']
      ? struct.params.get(stringParamMap['description'] as any)?.toString() ?? null
      : null;
    const tierRaw = intParamMap['tier']
      ? (struct.params.get(intParamMap['tier'] as any) as number) ?? null
      : null;

    fullTasks.push({
      ...task,
      name: name ?? `Unknown (struct ${task.structId})`,
      description: description ?? '',
      area: resolveEnum('area'),
      category: resolveEnum('category'),
      skill: resolveEnum('skill'),
      tier: tierRaw,
      tierName: resolveEnum('tier'),
    });
  }

  return { fullTasks, rawTasks };
}
