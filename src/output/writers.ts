import { writeFileSync, readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { TaskFull, LocationEntry } from '../types';

/** Write the full normalized task JSON with fields in a human-readable order. */
export function writeFullJson(tasks: TaskFull[], outputDir: string, taskTypeName: string): string {
  const filename = `${taskTypeName}.full.json`;
  const filePath = path.join(outputDir, filename);

  const ordered = tasks.map(t => {
    const o: Record<string, any> = {
      name: t.name,
      description: t.description,
      structId: t.structId,
      sortId: t.sortId,
      area: t.area,
      category: t.category,
      skill: t.skill,
      tier: t.tier,
      tierName: t.tierName,
    };
    if (t.completionPercent != null) o.completionPercent = t.completionPercent;
    if (t.skillRequirements?.length) o.skillRequirements = t.skillRequirements;
    if (t.wikiNotes) o.wikiNotes = t.wikiNotes;
    if (t.wikiNotesHtml) o.wikiNotesHtml = t.wikiNotesHtml;
    if (t.classification) o.classification = t.classification;
    if (t.location) o.location = t.location;
    return o;
  });

  writeFileSync(filePath, JSON.stringify(ordered, null, 2));
  return filePath;
}

/** Write raw task data (unresolved param values) */
export function writeRawJson(rawTasks: any[], outputDir: string, taskTypeName: string): string {
  const filename = `${taskTypeName}.raw.json`;
  const filePath = path.join(outputDir, filename);
  writeFileSync(filePath, JSON.stringify(rawTasks, null, 2));
  return filePath;
}

/** Write CSV export of full tasks */
export function writeCsv(tasks: TaskFull[], outputDir: string, taskTypeName: string): string {
  const filename = `${taskTypeName}.csv`;
  const filePath = path.join(outputDir, filename);

  const headers = ['structId', 'sortId', 'name', 'description', 'area', 'category', 'skill', 'tier', 'tierName', 'completionPercent', 'skillRequirements', 'wikiNotes', 'classification'];

  const escapeCsv = (value: any): string => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = tasks.map(t => {
    const skillsStr = t.skillRequirements?.map(s => `${s.skill} ${s.level}`).join('; ') ?? '';
    return [
      t.structId, t.sortId, t.name, t.description, t.area, t.category,
      t.skill, t.tier, t.tierName, t.completionPercent, skillsStr, t.wikiNotes, t.classification,
    ].map(escapeCsv).join(',');
  });

  writeFileSync(filePath, [headers.join(','), ...rows].join('\n') + '\n');
  return filePath;
}

/**
 * Write the min.json consumed by the plugin's task store.
 * Lean format: only structId, sortId, and optional wiki/location fields.
 * Null/undefined/empty fields are omitted to keep payload small.
 */
export function writeMinJson(tasks: TaskFull[], outputDir: string, taskTypeName: string): string {
  const filename = `${taskTypeName}.min.json`;
  const filePath = path.join(outputDir, filename);

  const minTasks = tasks.map(t => {
    const min: Record<string, any> = {
      structId: t.structId,
      sortId: t.sortId,
    };
    if (t.skillRequirements?.length) min.skills = t.skillRequirements; // "skills" for plugin compat
    if (t.wikiNotes) min.wikiNotes = t.wikiNotes;
    if (t.completionPercent != null) min.completionPercent = t.completionPercent;
    if (t.location) min.location = t.location;
    return min;
  });

  writeFileSync(filePath, JSON.stringify(minTasks, null, 2));
  return filePath;
}

/**
 * Merge classification and location data from a locations.json file into
 * an existing full.json. The locations file is keyed by structId.
 */
export function mergeLocations(fullJsonPath: string, locationsPath: string): { merged: number; withLocation: number } {
  const fullTasks: TaskFull[] = JSON.parse(readFileSync(fullJsonPath, 'utf-8'));
  const locations: Record<string, LocationEntry> = JSON.parse(readFileSync(locationsPath, 'utf-8'));

  let merged = 0;
  let withLocation = 0;
  for (const task of fullTasks) {
    const loc = locations[String(task.structId)];
    if (loc) {
      task.classification = loc.classification;
      if (loc.location) {
        task.location = loc.location;
        withLocation++;
      }
      merged++;
    }
  }

  writeFileSync(fullJsonPath, JSON.stringify(fullTasks, null, 2));
  return { merged, withLocation };
}
