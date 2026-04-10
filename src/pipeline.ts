/**
 * Main pipeline orchestration.
 *
 * Game cache → extract structs → scrape wiki → resolve params/enums
 *   → classify tasks → resolve coordinates → output
 */

import { mkdirSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import axios from 'axios';
import { createCacheProvider } from './cache/provider';
import { extractTasksFromCache, hydrateTasks } from './cache/tasks';
import { scrapeAndMergeWikiData } from './wiki/scraper';
import { writeFullJson, writeRawJson, writeCsv, mergeLocations } from './output/writers';
import { findActiveLeague, resolveOutputDir, updateLeague, getWikiConfig } from './leagues';
import { TaskTypeDefinition, WIKI_COLUMNS, PARAM_IDS } from './types';

const TASK_TYPES_URL = 'https://raw.githubusercontent.com/osrs-reldo/task-json-store/refs/heads/main/task-types.json';

/**
 * Fetch the task type definition from the task-json-store.
 */
async function fetchTaskType(taskTypeName: string): Promise<TaskTypeDefinition> {
  console.log(`Fetching task-types from ${TASK_TYPES_URL}...`);
  const response = await axios.get(TASK_TYPES_URL);
  const taskTypes: TaskTypeDefinition[] = response.data;
  const taskType = taskTypes.find(
    tt => tt.taskJsonName.toLowerCase() === taskTypeName.toLowerCase(),
  );
  if (!taskType) {
    const available = taskTypes.map(tt => tt.taskJsonName).join(', ');
    throw new Error(`Task type "${taskTypeName}" not found. Available: ${available}`);
  }
  return taskType;
}

/**
 * Full pipeline: extract from cache, scrape wiki, hydrate, classify, output.
 */
export async function generateFull(taskTypeName?: string): Promise<void> {
  // Auto-detect active league if not specified
  if (!taskTypeName) {
    const active = findActiveLeague();
    if (!active) throw new Error('No active league found. Provide a task type name explicitly.');
    taskTypeName = active.taskTypeName;
    console.log(`Auto-detected active league: ${active.name} (${taskTypeName})`);
  }

  // 1. Fetch task type definition
  const taskType = await fetchTaskType(taskTypeName);
  console.log(`Task type: ${taskType.name} (${taskType.taskJsonName})`);

  // 2. Extract tasks from game cache
  const cache = await createCacheProvider();
  console.log('Extracting tasks from game cache...');
  const tasks = await extractTasksFromCache(cache, taskType);
  console.log(`Extracted ${tasks.length} tasks`);

  // 3. Scrape wiki data
  const wikiConfig = getWikiConfig(taskTypeName);
  const columns = WIKI_COLUMNS[taskTypeName.toUpperCase()];
  if (wikiConfig && columns) {
    console.log(`Scraping wiki from ${wikiConfig.url}...`);
    const varbitParamId = (taskType.intParamMap?.id ?? PARAM_IDS.LEAGUE_VARBIT_INDEX);
    await scrapeAndMergeWikiData(
      cache, tasks, wikiConfig.url, wikiConfig.taskIdAttribute,
      varbitParamId as any, columns,
    );
  } else {
    console.log('No wiki config available, skipping wiki scrape');
  }

  // 4. Hydrate with resolved params
  console.log('Resolving params and enums...');
  const { fullTasks, rawTasks } = await hydrateTasks(cache, tasks, taskType);

  // 5. Write outputs
  const outputDir = resolveOutputDir(taskTypeName);
  mkdirSync(outputDir, { recursive: true });

  const fullPath = writeFullJson(fullTasks, outputDir, taskType.taskJsonName);
  console.log(`Wrote ${fullTasks.length} normalized tasks to ${fullPath}`);

  const rawPath = writeRawJson(rawTasks, outputDir, taskType.taskJsonName);
  console.log(`Wrote ${rawTasks.length} raw tasks to ${rawPath}`);

  const csvPath = writeCsv(fullTasks, outputDir, taskType.taskJsonName);
  console.log(`Wrote ${fullTasks.length} tasks to ${csvPath}`);

  // 6. Update leagues.json
  updateLeague(taskTypeName, {
    taskCount: fullTasks.length,
    taskFile: `${taskType.taskJsonName}.full.json`,
  } as any);
  console.log(`Updated leagues.json`);
}

/**
 * Run classification pipeline on existing full.json and merge results.
 */
export async function classifyAndMerge(taskTypeName: string): Promise<void> {
  const outputDir = resolveOutputDir(taskTypeName);
  const fullJsonPath = path.join(outputDir, `${taskTypeName}.full.json`);
  const locationsPath = path.join(outputDir, 'locations.json');

  console.log('Running classification pipeline...');
  const classifyCmd = [
    'python3', 'scripts/classify.py',
    `--input=${fullJsonPath}`,
    '--coords',
    `--output=${locationsPath}`,
    '--data-dir=data/',
  ].join(' ');

  execSync(classifyCmd, { stdio: 'inherit' });

  console.log('Merging locations into full.json...');
  const { merged, withLocation } = mergeLocations(fullJsonPath, locationsPath);
  console.log(`Merged ${merged} classifications (${withLocation} with coordinates)`);
}

/**
 * Re-scrape wiki data without re-extracting from cache.
 */
export async function updateWiki(taskTypeName?: string): Promise<void> {
  if (!taskTypeName) {
    const active = findActiveLeague();
    if (!active) throw new Error('No active league found.');
    taskTypeName = active.taskTypeName;
    console.log(`Auto-detected: ${active.name} (${taskTypeName})`);
  }

  const taskType = await fetchTaskType(taskTypeName);
  const outputDir = resolveOutputDir(taskTypeName);
  const fullPath = path.join(outputDir, `${taskType.taskJsonName}.full.json`);

  const { readFileSync } = await import('fs');
  const fullTasks = JSON.parse(readFileSync(fullPath, 'utf-8'));
  console.log(`Loaded ${fullTasks.length} tasks from ${fullPath}`);

  const wikiConfig = getWikiConfig(taskTypeName);
  const columns = WIKI_COLUMNS[taskTypeName.toUpperCase()];
  if (!wikiConfig || !columns) throw new Error(`No wiki config for "${taskTypeName}"`);

  const cache = await createCacheProvider();
  const varbitParamId = (taskType.intParamMap?.id ?? PARAM_IDS.LEAGUE_VARBIT_INDEX);

  // Convert to Task[] for wiki scraping (needs structId)
  const tasksForWiki = fullTasks.map((t: any) => ({
    structId: t.structId,
    sortId: t.sortId,
  }));

  console.log(`Scraping wiki from ${wikiConfig.url}...`);
  await scrapeAndMergeWikiData(
    cache, tasksForWiki, wikiConfig.url, wikiConfig.taskIdAttribute,
    varbitParamId as any, columns,
  );

  // Merge wiki data back
  let updated = 0;
  for (let i = 0; i < fullTasks.length; i++) {
    const wiki = tasksForWiki[i];
    let changed = false;
    if (wiki.completionPercent != null && wiki.completionPercent !== fullTasks[i].completionPercent) {
      fullTasks[i].completionPercent = wiki.completionPercent;
      changed = true;
    }
    if (wiki.wikiNotes != null && wiki.wikiNotes !== fullTasks[i].wikiNotes) {
      fullTasks[i].wikiNotes = wiki.wikiNotes;
      changed = true;
    }
    if (wiki.skills?.length > 0) {
      fullTasks[i].skills = wiki.skills;
      changed = true;
    }
    if (changed) updated++;
  }

  console.log(`Updated ${updated} tasks with wiki data`);
  const { writeFileSync } = await import('fs');
  writeFileSync(fullPath, JSON.stringify(fullTasks, null, 2));
  console.log(`Wrote ${fullPath}`);
}
