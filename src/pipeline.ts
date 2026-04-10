/**
 * Main pipeline orchestration.
 *
 * Self-sufficient: extracts tasks from game cache using stable param IDs,
 * discovers enums from cache, scrapes wiki, classifies, outputs.
 * No external task-type definitions needed.
 */

import { mkdirSync } from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import { createCacheProvider } from './cache/provider';
import { extractTasksFromCache, hydrateTasks, resolveTierParam } from './cache/tasks';
import { scrapeAndMergeWikiData } from './wiki/scraper';
import { writeFullJson, writeRawJson, writeMinJson, writeCsv, mergeLocations } from './output/writers';
import { findActiveLeague, resolveOutputDir, updateLeague, getWikiConfig, isLeagueEnded } from './leagues';
import { DEFAULT_WIKI_COLUMNS, PARAM_IDS } from './types';

/**
 * Full pipeline: extract from cache, scrape wiki, hydrate, classify, output.
 */
export async function generateFull(taskTypeName?: string, force = false): Promise<void> {
  // Auto-detect active league if not specified
  if (!taskTypeName) {
    const active = findActiveLeague();
    if (!active) throw new Error('No active league found. Provide a task type name explicitly.');
    taskTypeName = active.taskTypeName;
    console.log(`Auto-detected active league: ${active.name} (${taskTypeName})`);
  }

  // Guard: don't overwrite historical league data unless forced
  if (isLeagueEnded(taskTypeName) && !force) {
    throw new Error(
      `${taskTypeName} has ended. Its generated data is historical and should not be overwritten.\n` +
      `Use --force to regenerate anyway (e.g., for initial backfill).`,
    );
  }

  // 1. Resolve tier param from league name
  const tierParam = resolveTierParam(taskTypeName);
  console.log(`League: ${taskTypeName} (tier param: ${tierParam})`);

  // 2. Extract tasks from game cache
  const cache = await createCacheProvider();
  console.log('Extracting tasks from game cache...');
  const tasks = await extractTasksFromCache(cache, tierParam);
  console.log(`Extracted ${tasks.length} tasks`);

  // 3. Scrape wiki data (if URL configured in leagues.json)
  const wikiConfig = getWikiConfig(taskTypeName);
  if (wikiConfig) {
    console.log(`Scraping wiki from ${wikiConfig.url}...`);
    await scrapeAndMergeWikiData(
      cache, tasks, wikiConfig.url, wikiConfig.taskIdAttribute,
      PARAM_IDS.LEAGUE_VARBIT_INDEX, DEFAULT_WIKI_COLUMNS,
    );
  } else {
    console.log('No wiki URL in leagues.json, skipping wiki scrape');
  }

  // 4. Hydrate with resolved params (discovers enums from cache)
  console.log('Resolving params and enums...');
  const { fullTasks, rawTasks } = await hydrateTasks(cache, tasks, tierParam);

  // 5. Write outputs
  const outputDir = resolveOutputDir(taskTypeName);
  mkdirSync(outputDir, { recursive: true });

  const fullPath = writeFullJson(fullTasks, outputDir, taskTypeName);
  console.log(`Wrote ${fullTasks.length} normalized tasks to ${fullPath}`);

  const rawPath = writeRawJson(rawTasks, outputDir, taskTypeName);
  console.log(`Wrote ${rawTasks.length} raw tasks to ${rawPath}`);

  const csvPath = writeCsv(fullTasks, outputDir, taskTypeName);
  console.log(`Wrote ${fullTasks.length} tasks to ${csvPath}`);

  const minPath = writeMinJson(fullTasks, outputDir, taskTypeName);
  console.log(`Wrote ${fullTasks.length} tasks to ${minPath}`);

  // 6. Update leagues.json
  updateLeague(taskTypeName, {
    taskCount: fullTasks.length,
    taskFile: `${taskTypeName}.full.json`,
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
    'python3', 'classify/classify.py',
    `--input=${fullJsonPath}`,
    '--coords',
    `--output=${locationsPath}`,
    '--data-dir=classify/data/',
  ].join(' ');

  execSync(classifyCmd, { stdio: 'inherit' });

  console.log('Merging locations into full.json...');
  const { merged, withLocation } = mergeLocations(fullJsonPath, locationsPath);
  console.log(`Merged ${merged} classifications (${withLocation} with coordinates)`);

  // Regenerate min.json with location data included
  const { readFileSync } = await import('fs');
  const enrichedTasks = JSON.parse(readFileSync(fullJsonPath, 'utf-8'));
  const minPath = writeMinJson(enrichedTasks, outputDir, taskTypeName);
  console.log(`Wrote ${enrichedTasks.length} tasks to ${minPath}`);
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

  const outputDir = resolveOutputDir(taskTypeName);
  const fullPath = path.join(outputDir, `${taskTypeName}.full.json`);

  const { readFileSync } = await import('fs');
  const fullTasks = JSON.parse(readFileSync(fullPath, 'utf-8'));
  console.log(`Loaded ${fullTasks.length} tasks from ${fullPath}`);

  const wikiConfig = getWikiConfig(taskTypeName);
  if (!wikiConfig) throw new Error(`No wiki URL for "${taskTypeName}" in leagues.json`);

  const cache = await createCacheProvider();

  // Convert to Task[] for wiki scraping (needs structId)
  const tasksForWiki = fullTasks.map((t: any) => ({
    structId: t.structId,
    sortId: t.sortId,
  }));

  console.log(`Scraping wiki from ${wikiConfig.url}...`);
  await scrapeAndMergeWikiData(
    cache, tasksForWiki, wikiConfig.url, wikiConfig.taskIdAttribute,
    PARAM_IDS.LEAGUE_VARBIT_INDEX, DEFAULT_WIKI_COLUMNS,
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
    if (wiki.skillRequirements?.length > 0) {
      fullTasks[i].skillRequirements = wiki.skillRequirements;
      changed = true;
    }
    if (changed) updated++;
  }

  console.log(`Updated ${updated} tasks with wiki data`);
  const { writeFileSync } = await import('fs');
  writeFileSync(fullPath, JSON.stringify(fullTasks, null, 2));
  console.log(`Wrote ${fullPath}`);
}
