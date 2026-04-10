/**
 * League discovery and validation tool.
 *
 * Scans the game cache for task data, detects new leagues, cross-references
 * wiki data, and reports irregularities for human review.
 */

import { FlatCacheProvider, Struct, Enum as CacheEnum, ScriptVarType, ParamID, StructID } from '@abextm/cache2';

// Helper to cast numeric IDs to branded types
const pid = (n: number) => n as any as ParamID;
const sid = (n: number) => n as any as StructID;
import axios from 'axios';
import * as cheerio from 'cheerio';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';

// Stable across all known leagues
const STABLE_PARAMS = {
  VARBIT_INDEX: 873,
  NAME: 874,
  DESCRIPTION: 875,
  CATEGORY: 1016,
  AREA: 1017,
  SKILL: 1018,
};

// Known tier params per league, ordered chronologically
const KNOWN_TIER_PARAMS: { param: number; league: string; year: number; expectedCount: number }[] = [
  { param: 1849, league: 'League 1 - Twisted', year: 2019, expectedCount: 495 },
  { param: 1850, league: 'League 2 - Trailblazer', year: 2020, expectedCount: 1020 },
  { param: 1851, league: 'League 3 - Shattered Relics', year: 2022, expectedCount: 1260 },
  { param: 1852, league: 'League 4 - Trailblazer Reloaded', year: 2023, expectedCount: 1481 },
  { param: 2044, league: 'League 5 - Raging Echoes', year: 2024, expectedCount: 1589 },
];

// Params to exclude when scanning for unknown tier params
const EXCLUDE_PARAMS = new Set([
  ...Object.values(STABLE_PARAMS),
  ...KNOWN_TIER_PARAMS.map(t => t.param),
]);

interface DiscoveryReport {
  sections: ReportSection[];
}

interface ReportSection {
  title: string;
  lines: string[];
  severity: 'info' | 'warning' | 'action';
}

function section(title: string, severity: 'info' | 'warning' | 'action' = 'info'): ReportSection {
  return { title, lines: [], severity };
}

/**
 * Run full discovery scan and produce a report.
 */
export async function runDiscovery(
  cache: FlatCacheProvider,
  options: { wikiUrl?: string; previousLeagueTier?: number } = {},
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = { sections: [] };

  const allStructs = [...(await Struct.all(cache))].sort((a, b) => a.id - b.id);
  const allEnums = await CacheEnum.all(cache);
  const structEnums = [...allEnums].filter(e => e.valueTypeChar === ScriptVarType.struct.char);
  const stringEnums = [...allEnums].filter(e => e.valueTypeChar === ScriptVarType.string.char);

  // Find all task structs (have name param)
  const taskStructs = allStructs.filter(s => s.params.get(pid(STABLE_PARAMS.NAME)) !== undefined);

  // ============================================================
  // 1. Cache overview
  // ============================================================
  const overview = section('Cache Overview');
  overview.lines.push(`Total structs in cache: ${allStructs.length}`);
  overview.lines.push(`Structs with name param (874): ${taskStructs.length}`);
  report.sections.push(overview);

  // ============================================================
  // 2. Known league scan
  // ============================================================
  const knownLeagues = section('Known League Tier Params');

  const tierResults: { param: number; label: string; structs: Struct[]; enumId?: number; enumSize?: number }[] = [];

  for (const known of KNOWN_TIER_PARAMS) {
    const matching = taskStructs.filter(s => s.params.get(pid(known.param)) !== undefined);
    const enumInfo = await findOrderingEnum(matching, structEnums);
    tierResults.push({
      param: known.param,
      label: known.league,
      structs: matching,
      enumId: enumInfo?.id,
      enumSize: enumInfo?.size,
    });
    const enumNote = enumInfo ? `enum ${enumInfo.id} (${enumInfo.size} entries)` : 'no ordering enum found';
    knownLeagues.lines.push(
      `  ${known.league}: param ${known.param} → ${matching.length} structs [${enumNote}]`,
    );
    if (Math.abs(matching.length - known.expectedCount) > 10 && matching.length > 0) {
      knownLeagues.lines.push(
        `    ⚠ Expected ~${known.expectedCount} tasks, found ${matching.length}`,
      );
    }
  }
  report.sections.push(knownLeagues);

  // ============================================================
  // 3. Scan for unknown tier params (new league detection)
  // ============================================================
  const newLeague = section('New League Detection', 'action');
  const candidates = scanForUnknownTierParams(taskStructs);

  if (candidates.length === 0) {
    newLeague.lines.push('No unknown tier-like params detected');
  } else {
    for (const c of candidates) {
      const enumInfo = await findOrderingEnum(
        taskStructs.filter(s => s.params.get(pid(c.param)) !== undefined),
        structEnums,
      );
      newLeague.lines.push(
        `  ★ Param ${c.param}: found on ${c.count} task structs, values ${JSON.stringify(c.values)}`,
      );
      if (enumInfo) {
        newLeague.lines.push(`    Ordering enum: ${enumInfo.id} (${enumInfo.size} entries)`);
      }
      newLeague.lines.push(`    → Likely a new league tier param`);
    }
  }
  report.sections.push(newLeague);

  // ============================================================
  // 4. Orphan structs (name but no tier)
  // ============================================================
  const allKnownTiers = [...KNOWN_TIER_PARAMS.map(t => t.param), ...candidates.map(c => c.param)];
  const orphans = taskStructs.filter(s =>
    !allKnownTiers.some(p => s.params.get(pid(p)) !== undefined),
  );

  if (orphans.length > 0) {
    const orphanSection = section('Orphan Structs', 'warning');
    orphanSection.lines.push(`${orphans.length} structs have name param but no known tier param:`);
    for (const s of orphans.slice(0, 10)) {
      orphanSection.lines.push(`  id=${s.id} name="${s.params.get(pid(STABLE_PARAMS.NAME))}"`);
    }
    if (orphans.length > 10) orphanSection.lines.push(`  ... and ${orphans.length - 10} more`);
    report.sections.push(orphanSection);
  }

  // ============================================================
  // 5. StructId overlap between leagues
  // ============================================================
  const prevTier = options.previousLeagueTier ?? KNOWN_TIER_PARAMS[KNOWN_TIER_PARAMS.length - 1].param;
  // Find the newest detected league (highest count candidate or latest known)
  const newestTier = candidates.length > 0
    ? candidates.reduce((a, b) => a.count > b.count ? a : b).param
    : KNOWN_TIER_PARAMS[KNOWN_TIER_PARAMS.length - 1].param;

  if (newestTier !== prevTier) {
    const overlapSection = section('StructId Stability');
    const prevStructs = new Set(
      taskStructs.filter(s => s.params.get(pid(prevTier)) !== undefined).map(s => s.id),
    );
    const newStructs = new Set(
      taskStructs.filter(s => s.params.get(pid(newestTier)) !== undefined).map(s => s.id),
    );
    const shared = [...newStructs].filter(id => prevStructs.has(id));
    const onlyNew = [...newStructs].filter(id => !prevStructs.has(id));
    const onlyOld = [...prevStructs].filter(id => !newStructs.has(id));

    overlapSection.lines.push(`Previous league (param ${prevTier}): ${prevStructs.size} structs`);
    overlapSection.lines.push(`New league (param ${newestTier}): ${newStructs.size} structs`);
    overlapSection.lines.push(`Shared structIds: ${shared.length} (${pct(shared.length, newStructs.size)})`);
    overlapSection.lines.push(`New-only structIds: ${onlyNew.length}`);
    overlapSection.lines.push(`Retired structIds: ${onlyOld.length}`);

    if (shared.length === 0) {
      overlapSection.lines.push(`⚠ Complete structId reset - ALL structId-based overrides will need updating`);
      overlapSection.severity = 'warning';
    } else if (shared.length < newStructs.size * 0.5) {
      overlapSection.lines.push(`⚠ Major structId changes - many overrides may need updating`);
      overlapSection.severity = 'warning';
    }

    // Re-tiered tasks
    const retiered: { id: number; name: string; oldTier: number; newTier: number }[] = [];
    for (const id of shared) {
      const s = allStructs.find(st => st.id === id)!;
      const oldT = s.params.get(pid(prevTier)) as number;
      const newT = s.params.get(pid(newestTier)) as number;
      if (oldT !== newT) {
        retiered.push({ id, name: s.params.get(pid(STABLE_PARAMS.NAME)) as string, oldTier: oldT, newTier: newT });
      }
    }
    if (retiered.length > 0) {
      overlapSection.lines.push(`Re-tiered tasks: ${retiered.length}`);
      for (const t of retiered.slice(0, 5)) {
        overlapSection.lines.push(`  ${t.name}: tier ${t.oldTier} → ${t.newTier}`);
      }
      if (retiered.length > 5) overlapSection.lines.push(`  ... and ${retiered.length - 5} more`);
    }
    report.sections.push(overlapSection);
  }

  // ============================================================
  // 6. Name resolution enums
  // ============================================================
  const enumSection = section('Name Resolution Enums');
  const areaEnum = findEnumContaining(stringEnums, 'Misthalin', 'Karamja', 'Asgarnia');
  const categoryEnum = findEnumContaining(stringEnums, 'Combat', 'Skill', 'Quest');
  const tierEnum = findEnumContaining(stringEnums, 'Easy', 'Medium', 'Hard', 'Elite', 'Master');

  if (areaEnum) {
    const entries = [...areaEnum.map.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
    enumSection.lines.push(`Area: enum ${areaEnum.id} (${areaEnum.map.size} entries) — ${entries}`);
  } else {
    enumSection.lines.push('⚠ No area enum found');
    enumSection.severity = 'warning';
  }
  if (categoryEnum) {
    const entries = [...categoryEnum.map.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
    enumSection.lines.push(`Category: enum ${categoryEnum.id} (${categoryEnum.map.size} entries) — ${entries}`);
  }
  if (tierEnum) {
    const entries = [...tierEnum.map.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
    enumSection.lines.push(`Tier: enum ${tierEnum.id} (${tierEnum.map.size} entries) — ${entries}`);
  }

  // Check for new areas not in previous league
  if (areaEnum && newestTier !== prevTier) {
    const newTaskStructs = taskStructs.filter(s => s.params.get(pid(newestTier)) !== undefined);
    const prevTaskStructs = taskStructs.filter(s => s.params.get(pid(prevTier)) !== undefined);
    const newAreas = new Set(newTaskStructs.map(s => s.params.get(pid(STABLE_PARAMS.AREA)) as number));
    const prevAreas = new Set(prevTaskStructs.map(s => s.params.get(pid(STABLE_PARAMS.AREA)) as number));
    const addedAreas = [...newAreas].filter(a => !prevAreas.has(a));
    if (addedAreas.length > 0) {
      const names = addedAreas.map(a => `${a} (${areaEnum.map.get(a) ?? 'unknown'})`);
      enumSection.lines.push(`New area codes: ${names.join(', ')}`);
    }
  }
  report.sections.push(enumSection);

  // ============================================================
  // 7. Classification rule audit
  // ============================================================
  const rulesPath = path.join('classify', 'rules.json');
  const curatedPath = path.join('classify', 'curated_coords.json');

  if (existsSync(rulesPath) && newestTier !== prevTier) {
    const ruleAudit = section('Classification Rule Audit', 'action');
    const rulesData = JSON.parse(readFileSync(rulesPath, 'utf-8'));
    const curatedData = existsSync(curatedPath) ? JSON.parse(readFileSync(curatedPath, 'utf-8')) : {};

    const newStructIds = new Set(
      taskStructs.filter(s => s.params.get(pid(newestTier)) !== undefined).map(s => s.id),
    );

    // Check structId-based rules
    const structIdRules = (rulesData.rules || []).filter(
      (r: any) => r.type === 'exact' && r.structId != null,
    );
    const brokenRules = structIdRules.filter((r: any) => !newStructIds.has(r.structId));
    const validRules = structIdRules.filter((r: any) => newStructIds.has(r.structId));

    ruleAudit.lines.push(`StructId rules: ${structIdRules.length} total`);
    ruleAudit.lines.push(`  Valid (structId in new league): ${validRules.length}`);
    ruleAudit.lines.push(`  Broken (structId missing): ${brokenRules.length}`);
    if (brokenRules.length > 0) {
      for (const r of brokenRules.slice(0, 5)) {
        ruleAudit.lines.push(`    structId ${r.structId}: ${r.match} → ${r.result}`);
      }
      if (brokenRules.length > 5) ruleAudit.lines.push(`    ... and ${brokenRules.length - 5} more`);
    }

    // Check curated coord structId overrides
    const curatedTasks = curatedData.tasks || {};
    const curatedIds = Object.keys(curatedTasks).filter(k => !k.startsWith('_')).map(Number);
    const brokenCurated = curatedIds.filter(id => !newStructIds.has(sid(id)));
    if (curatedIds.length > 0) {
      ruleAudit.lines.push(`Curated coord structId overrides: ${curatedIds.length} total`);
      ruleAudit.lines.push(`  Broken (structId missing): ${brokenCurated.length}`);
      if (brokenCurated.length > 0) {
        for (const id of brokenCurated.slice(0, 5)) {
          ruleAudit.lines.push(`    structId ${id}`);
        }
      }
    }

    // Count pattern-based rules (these survive league transitions)
    const patternRules = (rulesData.rules || []).filter(
      (r: any) => !r._section && r.type !== 'exact',
    );
    ruleAudit.lines.push(`Pattern-based rules (portable): ${patternRules.length}`);
    ruleAudit.lines.push(`Entity-name curated overrides (portable): ${
      Object.keys(curatedData.locations || {}).filter(k => !k.startsWith('_')).length
    }`);

    report.sections.push(ruleAudit);
  }

  // ============================================================
  // 8. Wiki cross-reference (if URL provided)
  // ============================================================
  if (options.wikiUrl) {
    const wikiSection = section('Wiki Cross-Reference');
    try {
      const response = await axios.get(options.wikiUrl);
      const $ = cheerio.load(response.data);
      const wikiRows = $('tr[data-taskid]');
      const wikiCount = wikiRows.length;

      // Extract task names from wiki
      const wikiNames = new Set<string>();
      wikiRows.each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length > 1) {
          wikiNames.add($(cells[1]).text().trim());
        }
      });

      // Compare wiki against the newest league's task set, not all cache structs
      const cacheCount = taskStructs.filter(s => s.params.get(pid(newestTier)) !== undefined).length;

      wikiSection.lines.push(`Wiki tasks (${options.wikiUrl}):`);
      wikiSection.lines.push(`  Wiki rows: ${wikiCount}`);
      wikiSection.lines.push(`  Cache structs: ${cacheCount}`);

      if (wikiCount !== cacheCount) {
        wikiSection.lines.push(`  ⚠ Count mismatch: wiki has ${wikiCount}, cache has ${cacheCount}`);
        wikiSection.severity = 'warning';
      } else {
        wikiSection.lines.push(`  ✓ Counts match`);
      }

      // Name matching
      const cacheNames = new Set<string>();
      const targetStructs = taskStructs.filter(s => s.params.get(pid(newestTier)) !== undefined);
      for (const s of targetStructs) {
        const name = s.params.get(pid(STABLE_PARAMS.NAME)) as string;
        if (name) cacheNames.add(name);
      }

      const inWikiNotCache = [...wikiNames].filter(n => !cacheNames.has(n));
      const inCacheNotWiki = [...cacheNames].filter(n => !wikiNames.has(n));

      if (inWikiNotCache.length > 0) {
        wikiSection.lines.push(`  Tasks in wiki but not cache: ${inWikiNotCache.length}`);
        for (const n of inWikiNotCache.slice(0, 5)) wikiSection.lines.push(`    "${n}"`);
        if (inWikiNotCache.length > 5) wikiSection.lines.push(`    ... and ${inWikiNotCache.length - 5} more`);
        wikiSection.severity = 'warning';
      }
      if (inCacheNotWiki.length > 0) {
        wikiSection.lines.push(`  Tasks in cache but not wiki: ${inCacheNotWiki.length}`);
        for (const n of inCacheNotWiki.slice(0, 5)) wikiSection.lines.push(`    "${n}"`);
        if (inCacheNotWiki.length > 5) wikiSection.lines.push(`    ... and ${inCacheNotWiki.length - 5} more`);
        wikiSection.severity = 'warning';
      }
      if (inWikiNotCache.length === 0 && inCacheNotWiki.length === 0) {
        wikiSection.lines.push(`  ✓ All task names match`);
      }

      // Check column layout
      const firstRow = wikiRows.first();
      const colCount = firstRow.find('td').length;
      wikiSection.lines.push(`  Wiki table columns: ${colCount}`);
      if (colCount === 6) {
        wikiSection.lines.push(`  ✓ Column layout matches League 5 format`);
      } else {
        wikiSection.lines.push(`  ⚠ Column count differs from League 5 (6) - check column config`);
        wikiSection.severity = 'warning';
      }
    } catch (err: any) {
      wikiSection.lines.push(`Failed to fetch wiki: ${err.message}`);
      wikiSection.severity = 'warning';
    }
    report.sections.push(wikiSection);
  }

  return report;
}

// ============================================================
// Helpers
// ============================================================

function scanForUnknownTierParams(taskStructs: Struct[]): { param: number; count: number; values: number[] }[] {
  // Collect all integer params across task structs, count occurrences
  const paramCounts = new Map<number, Map<number, number>>(); // param -> value -> count

  for (const s of taskStructs) {
    for (const [paramId, value] of s.params.entries()) {
      if (EXCLUDE_PARAMS.has(paramId as number)) continue;
      if (typeof value !== 'number') continue;
      if (value < 1 || value > 10) continue; // Tier-like values

      if (!paramCounts.has(paramId as number)) paramCounts.set(paramId as number, new Map());
      const valMap = paramCounts.get(paramId as number)!;
      valMap.set(value, (valMap.get(value) || 0) + 1);
    }
  }

  // Filter for params that look like tier params:
  // - Present on 500+ structs
  // - Values in range 1-6
  // - At least 3 distinct values
  const candidates: { param: number; count: number; values: number[] }[] = [];
  for (const [param, valMap] of paramCounts.entries()) {
    const total = [...valMap.values()].reduce((a, b) => a + b, 0);
    const values = [...valMap.keys()].sort((a, b) => a - b);
    if (total >= 500 && values.length >= 3 && values.every(v => v >= 1 && v <= 6)) {
      candidates.push({ param, count: total, values });
    }
  }

  return candidates.sort((a, b) => b.count - a.count);
}

async function findOrderingEnum(
  structs: Struct[],
  structEnums: CacheEnum[],
): Promise<{ id: number; size: number } | null> {
  if (structs.length === 0) return null;

  // Pick a sample struct and find enums containing it
  const sample = structs[Math.min(5, structs.length - 1)];
  const containing = structEnums.filter(e => {
    for (const val of e.map.values()) {
      if (val === sample.id) return true;
    }
    return false;
  });

  // Find the enum that contains ALL structs
  const structIds = new Set(structs.map(s => s.id));
  for (const e of containing) {
    const enumIds = new Set(e.map.values() as IterableIterator<number>);
    let allMatch = true;
    for (const id of structIds) {
      if (id === 1949 || id === 5704) continue; // Known L4 oddities
      if (!enumIds.has(id)) { allMatch = false; break; }
    }
    if (allMatch) return { id: e.id, size: e.map.size };
  }

  return null;
}

function findEnumContaining(enums: CacheEnum[], ...mustContain: string[]): CacheEnum | null {
  // Find the enum with the fewest entries that contains all required strings
  // (avoids picking UI-label enums with -1/All entries when data enums are available)
  const matches = enums.filter(e => {
    const vals = [...e.map.values()].map(v => String(v));
    return mustContain.every(s => vals.includes(s));
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => a.map.size - b.map.size)[0];
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return (n / total * 100).toFixed(1) + '%';
}

/**
 * Format the report for console output.
 */
export function formatReport(report: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════');
  lines.push('  LEAGUE DISCOVERY REPORT');
  lines.push('═══════════════════════════════════════════════════');
  lines.push('');

  for (const s of report.sections) {
    const icon = s.severity === 'warning' ? '⚠' : s.severity === 'action' ? '★' : '•';
    lines.push(`${icon} ${s.title}`);
    lines.push('─'.repeat(50));
    for (const line of s.lines) lines.push(line);
    lines.push('');
  }

  // Summary
  const warnings = report.sections.filter(s => s.severity === 'warning');
  const actions = report.sections.filter(s => s.severity === 'action');
  if (warnings.length > 0 || actions.length > 0) {
    lines.push('═══════════════════════════════════════════════════');
    lines.push('  ITEMS FOR REVIEW');
    lines.push('═══════════════════════════════════════════════════');
    for (const s of [...actions, ...warnings]) {
      lines.push(`  [${s.severity.toUpperCase()}] ${s.title}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
