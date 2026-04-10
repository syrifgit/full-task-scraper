#!/usr/bin/env node

import { Command } from 'commander';
import { downloadCache, getLatestCommitHash, getLocalCommitHash } from './cache/downloader';
import { generateFull, classifyAndMerge, updateWiki } from './pipeline';
import { mergeLocations } from './output/writers';
import { resolveOutputDir } from './leagues';
import { createCacheProvider } from './cache/provider';
import { runDiscovery, formatReport } from './discover';
import * as path from 'path';

const program = new Command();

program
  .name('task-scraper')
  .description('OSRS league task data pipeline')
  .version('1.0.0');

// ============================================================
// Cache commands
// ============================================================

const cache = program.command('cache').description('Game cache management');

cache
  .command('update')
  .description('Download or update the OSRS game cache')
  .option('-c, --commit <hash>', 'specific commit hash to download')
  .action(async (options) => {
    await downloadCache(options.commit);
    console.log('Cache updated');
  });

cache
  .command('status')
  .description('Show current cache version')
  .action(async () => {
    const local = getLocalCommitHash();
    if (local) {
      console.log(`Local cache: ${local}`);
    } else {
      console.log('No local cache found');
    }
    try {
      const latest = await getLatestCommitHash();
      console.log(`Latest upstream: ${latest}`);
      if (local === latest) {
        console.log('Up to date');
      } else {
        console.log('Update available');
      }
    } catch {
      console.log('Could not fetch upstream version');
    }
  });

// ============================================================
// Task commands
// ============================================================

const tasks = program.command('tasks').description('Task data operations');

tasks
  .command('generate-full')
  .description('Full pipeline: extract from cache, scrape wiki, resolve params, output all formats')
  .argument('[task-type]', 'Task type name (e.g., LEAGUE_5). Auto-detects active league if omitted.')
  .option('--force', 'Allow regenerating ended leagues (overwrites historical data)')
  .action(async (taskType: string | undefined, options: { force?: boolean }) => {
    await generateFull(taskType, options.force);
  });

tasks
  .command('classify')
  .description('Run classification pipeline on existing full.json and merge location data')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_5)')
  .action(async (taskType: string) => {
    await classifyAndMerge(taskType);
  });

tasks
  .command('merge-locations')
  .description('Merge a locations.json into existing full.json')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_5)')
  .requiredOption('--locations <path>', 'Path to locations.json from classify.py')
  .action(async (taskType: string, options: { locations: string }) => {
    const outputDir = resolveOutputDir(taskType);
    const fullJsonPath = path.join(outputDir, `${taskType}.full.json`);
    const { merged, withLocation } = mergeLocations(fullJsonPath, options.locations);
    console.log(`Merged ${merged} classifications (${withLocation} with coordinates) into ${fullJsonPath}`);
  });

tasks
  .command('update-wiki')
  .description('Re-scrape wiki data without re-extracting from cache')
  .argument('[task-type]', 'Task type name. Auto-detects active league if omitted.')
  .action(async (taskType?: string) => {
    await updateWiki(taskType);
  });

tasks
  .command('discover')
  .description('Scan cache for league data, detect new leagues, and report irregularities')
  .option('--wiki <url>', 'Wiki tasks page URL to cross-reference against cache')
  .option('--prev-tier <param>', 'Previous league tier param ID for comparison (default: latest known)', parseInt)
  .action(async (options: { wiki?: string; prevTier?: number }) => {
    const cache = await createCacheProvider();
    const report = await runDiscovery(cache, {
      wikiUrl: options.wiki,
      previousLeagueTier: options.prevTier,
    });
    console.log(formatReport(report));
  });

// ============================================================
// Run
// ============================================================

program.parseAsync(process.argv).catch(err => {
  console.error(err.message);
  process.exit(1);
});
