import axios from 'axios';
import * as cheerio from 'cheerio';
import { FlatCacheProvider, Struct, ParamID } from '@abextm/cache2';
import { Task, TaskSkill, WikiColumnConfig, WikiTaskData } from '../types';

/**
 * Scrape wiki data and merge it into tasks.
 *
 * @param cache - Cache provider to look up varbit indices
 * @param tasks - Tasks to enrich (modified in place)
 * @param wikiUrl - URL to the wiki tasks page
 * @param taskIdAttribute - HTML attribute on <tr> elements (e.g., 'data-taskid')
 * @param varbitIndexParamId - ParamID for the varbit index in struct params
 * @param columns - Column positions in the wiki table
 */
export async function scrapeAndMergeWikiData(
  cache: FlatCacheProvider,
  tasks: Task[],
  wikiUrl: string,
  taskIdAttribute: string,
  varbitIndexParamId: ParamID,
  columns: WikiColumnConfig,
): Promise<void> {
  // 1. Build a map of varbitIndex -> task index
  //    For each task, load its struct and get the varbit index param
  const varbitToTaskIndex = new Map<number, number>();
  for (let i = 0; i < tasks.length; i++) {
    const struct = await Struct.load(cache, tasks[i].structId);
    const varbitIndex = struct.params.get(varbitIndexParamId) as number;
    if (varbitIndex !== undefined) {
      varbitToTaskIndex.set(varbitIndex, i);
    }
  }

  // 2. Scrape the wiki page
  const wikiData = await scrapeWikiPage(wikiUrl, taskIdAttribute, columns);
  console.log(`  Scraped ${wikiData.length} rows from wiki`);

  // 3. Merge wiki data into tasks
  let merged = 0;
  for (const row of wikiData) {
    const taskIndex = varbitToTaskIndex.get(row.varbitIndex);
    if (taskIndex === undefined) continue;

    const task = tasks[taskIndex];

    if (row.completionPercent != null) {
      task.completionPercent = row.completionPercent;
    }
    if (row.requirements) {
      task.wikiNotes = task.wikiNotes
        ? task.wikiNotes + '; ' + row.requirements
        : row.requirements;
    }
    if (row.skills.length > 0) {
      task.skills = mergeSkills(task.skills || [], row.skills);
    }
    merged++;
  }
  console.log(`  Merged wiki data into ${merged} tasks`);
}

/**
 * Scrape a wiki page for task data.
 */
async function scrapeWikiPage(
  url: string,
  taskIdAttribute: string,
  columns: WikiColumnConfig,
): Promise<WikiTaskData[]> {
  const response = await axios.get(url);
  const $ = cheerio.load(response.data);
  const results: WikiTaskData[] = [];

  // Find all table rows with the task ID attribute
  $(`tr[${taskIdAttribute}]`).each((_, row) => {
    const $row = $(row);
    const varbitIndex = parseInt($row.attr(taskIdAttribute) || '', 10);
    if (isNaN(varbitIndex)) return;

    const cells = $row.find('td');
    const getCell = (idx: number): string => {
      if (idx < 0 || idx >= cells.length) return '';
      return $(cells[idx]).text().trim();
    };

    // Extract skills from <span class="scp"> elements in the requirements cell
    const skills: TaskSkill[] = [];
    if (
      columns.requirementsColumnId >= 0 &&
      columns.requirementsColumnId < cells.length
    ) {
      $(cells[columns.requirementsColumnId])
        .find('span.scp')
        .each((_, span) => {
          const $span = $(span);
          const skill = $span.attr('data-skill');
          const level = parseInt($span.attr('data-level') || '', 10);
          if (skill && !isNaN(level)) {
            skills.push({ skill: skill.toUpperCase(), level });
          }
        });
    }

    // Parse completion percentage
    let completionPercent: number | undefined;
    if (
      columns.completionColumnId != null &&
      columns.completionColumnId < cells.length
    ) {
      const text = getCell(columns.completionColumnId);
      const match = text.match(/([\d.]+)%?/);
      if (match) {
        completionPercent = parseFloat(match[1]);
      }
    }

    // Clean requirements text (strip skill spans, coin amounts, region buttons)
    let requirements = getCell(columns.requirementsColumnId);
    // Remove the skill span text that we already extracted
    if (
      columns.requirementsColumnId >= 0 &&
      columns.requirementsColumnId < cells.length
    ) {
      const $reqCell = $(cells[columns.requirementsColumnId]);
      // Get text without the scp spans
      const clone = $reqCell.clone();
      clone.find('span.scp').remove();
      requirements = clone.text().trim();
    }

    results.push({
      varbitIndex,
      name: getCell(columns.nameColumnId),
      description: getCell(columns.descriptionColumnId),
      requirements: requirements || undefined,
      points: getCell(columns.pointsColumnId),
      completionPercent,
      skills,
    });
  });

  return results;
}

/**
 * Merge two skill arrays, keeping the highest level per skill. Sorted alphabetically.
 */
function mergeSkills(existing: TaskSkill[], incoming: TaskSkill[]): TaskSkill[] {
  const map = new Map<string, number>();
  for (const s of existing) {
    map.set(s.skill, Math.max(map.get(s.skill) || 0, s.level));
  }
  for (const s of incoming) {
    map.set(s.skill, Math.max(map.get(s.skill) || 0, s.level));
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([skill, level]) => ({ skill, level }));
}
