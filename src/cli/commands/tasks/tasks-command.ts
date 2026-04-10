import { ParamID, Struct } from '@abextm/cache2';
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'path';
import { StructService } from '../../../core/services/struct/struct.service';
import { EnumService } from '../../../core/services/enum/enum.service';
import { WikiService } from '../../../core/services/wiki/wiki.service';
import { ScriptAnalysisService } from '../../../core/services/script/script-analysis.service';
import { PARAM_ID } from '../../../core/data/param-ids';
import { ITask, ITaskFull, ITaskSkill } from '../../../core/types/task-mockup.interface';
import { ITaskType } from '../../../core/types/task-type-mockup.interface';
import { IInteractiveTaskExtractResult } from './interactive-task-extract-result.interface';
import { InteractiveTaskService } from './interactive-task.service';
import { InteractivePrompt } from '../../interactive-prompt.util';
import { LEAGUE_5_COLUMNS } from './column-definitions/league-5-columns';

@Injectable()
export class TasksCommand {
  private static readonly TASK_TYPES_URL =
    'https://raw.githubusercontent.com/osrs-reldo/task-json-store/refs/heads/main/task-types.json';

  constructor(
    private structService: StructService,
    private enumService: EnumService,
    private wikiService: WikiService,
    private interactivetaskService: InteractiveTaskService,
    private scriptAnalysisService: ScriptAnalysisService,
  ) {}

  public async handleTaskExtract(options: any): Promise<IInteractiveTaskExtractResult> {
    const results: IInteractiveTaskExtractResult = await this.interactivetaskService.promptTaskExtraction(options);
    if (options.json) {
      mkdirSync('./out', { recursive: true });
      writeFileSync(`./out/${results.taskType.taskJsonName}.json`, JSON.stringify(results.tasks, null, 2));
      writeFileSync(`./out/${results.taskType.taskJsonName}-tasktype.json`, JSON.stringify(results.taskType, null, 2));
    } else {
      console.log(results);
    }
    return results;
  }

  public async handleGenerateFrontendTasks(jsonFilename: string, nameParamId: ParamID, descriptionParamId: ParamID) {
    interface IFrontendTask {
      id: string;
      label: string;
      description: string;
      skillReqs: { skill: string; level: number }[];
      regions: string[];
      difficulty: null; // placeholders
      category: null; // placeholders
      subcategory: null; // placeholders
      prerequisite: null; // placeholders
    }

    const jsonResponse = await axios.get(
      `https://raw.githubusercontent.com/osrs-reldo/task-json-store/refs/heads/main/tasks/${jsonFilename}.min.json`,
    );
    const taskStructData: ITask[] = jsonResponse.data;

    const transformSkills = (taskSkills: ITaskSkill[]): { skill: string; level: number }[] =>
      taskSkills.map((taskSkill) => ({
        skill: taskSkill.skill.charAt(0).toUpperCase() + taskSkill.skill.slice(1).toLowerCase(),
        level: taskSkill.level,
      }));

    const frontendTasks: Record<string, IFrontendTask> = {};
    for (const taskData of taskStructData) {
      const struct: Struct = await this.structService.getStruct(taskData.structId);
      const name: string = struct.params.get(nameParamId).toString();
      const description: string = struct.params.get(descriptionParamId).toString();
      const frontendTask: IFrontendTask = {
        id: String(taskData.sortId),
        label: name,
        description: description,
        skillReqs: taskData.skills ? transformSkills(taskData.skills) : [],
        regions: [],
        difficulty: null,
        category: null,
        subcategory: null,
        prerequisite: null,
      };
      frontendTasks[frontendTask.id] = frontendTask;
    }

    console.log(JSON.stringify(frontendTasks, null, 2));
  }

  public async handleGenerateFullTasks(taskTypeName: string | undefined): Promise<void> {
    const taskTypesUrl = TasksCommand.TASK_TYPES_URL;

    // 0. If no task type specified, detect the active league from metadata
    if (!taskTypeName) {
      const activeLeague = this.findActiveLeague();
      if (!activeLeague) {
        throw new Error('No active league found in metadata. Provide a task type name explicitly.');
      }
      taskTypeName = activeLeague.taskTypeName;
      console.log(`Auto-detected active league: ${activeLeague.name} (${taskTypeName})`);
    }

    // 1. Fetch task type definition (structural metadata for param/enum maps)
    console.log(`Fetching task-types from ${taskTypesUrl}...`);
    const taskTypesResponse = await axios.get(taskTypesUrl);
    const taskTypes: ITaskType[] = taskTypesResponse.data;
    const taskType = taskTypes.find(
      (tt) => tt.taskJsonName.toLowerCase() === taskTypeName.toLowerCase(),
    );
    if (!taskType) {
      const available = taskTypes.map((tt) => tt.taskJsonName).join(', ');
      throw new Error(`Task type "${taskTypeName}" not found. Available: ${available}`);
    }
    console.log(`Found task type: ${taskType.name} (${taskType.taskJsonName})`);

    // 2. Extract tasks directly from the game cache (no upstream task store dependency)
    const intParamMap = taskType.intParamMap ?? {};
    const stringParamMap = taskType.stringParamMap ?? {};
    const paramMap: Record<string, number> = { ...intParamMap, ...stringParamMap };
    const stringEnumMap: Record<string, number> = taskType.stringEnumMap ?? {};

    const tierParamId = intParamMap['tier'] as ParamID;
    if (!tierParamId) {
      throw new Error(`Task type "${taskTypeName}" has no 'tier' in intParamMap`);
    }

    console.log('Extracting tasks from game cache...');
    const tasks: ITask[] = await this.extractTasksFromCache(tierParamId);
    console.log(`Extracted ${tasks.length} tasks from cache`);

    // 3. Scrape wiki for completionPercent, wikiNotes, skills
    const wikiConfig = this.getWikiConfig(taskTypeName);
    if (wikiConfig) {
      console.log(`Scraping wiki from ${wikiConfig.url}...`);
      const idParamId = intParamMap['id'] as ParamID;
      await this.wikiService.extractAndAppendData(
        tasks,
        wikiConfig.url,
        wikiConfig.taskIdAttribute,
        idParamId,
        wikiConfig.columns,
      );
      const withCompletion = tasks.filter((t) => t.completionPercent != null).length;
      const withWikiNotes = tasks.filter((t) => t.wikiNotes != null).length;
      const withSkills = tasks.filter((t) => t.skills?.length > 0).length;
      console.log(`Wiki data merged: ${withCompletion} with completion%, ${withWikiNotes} with notes, ${withSkills} with skills`);
    } else {
      console.log(`No wiki config for "${taskTypeName}", skipping wiki scrape`);
    }

    // 4. Pre-load all enums we'll need for resolution
    const enumCache = new Map<number, Map<any, any>>();
    for (const [, enumId] of Object.entries(stringEnumMap)) {
      if (!enumCache.has(enumId)) {
        const enumData = await this.enumService.getEnum(enumId);
        enumCache.set(enumId, enumData.map);
      }
    }

    // Build a reverse lookup: paramId number → mapped name (for raw output)
    const paramIdToName = new Map<number, string>();
    for (const [name, id] of Object.entries(paramMap)) {
      paramIdToName.set(id, name);
    }

    // 5. Hydrate each task with resolved params (normalized) and raw params
    console.log('Resolving params and enums for each task...');
    const fullTasks: ITaskFull[] = [];
    const rawTasks: any[] = [];
    for (const task of tasks) {
      const struct: Struct = await this.structService.getStruct(task.structId);

      // --- Raw version: all params with raw values, mapped names where known ---
      const rawParams: Record<string, string | number> = {};
      for (const [paramId, value] of struct.params.entries()) {
        const mappedName = paramIdToName.get(paramId as number);
        if (mappedName) {
          rawParams[mappedName] = value;
        } else {
          rawParams[String(paramId)] = value;
        }
      }

      rawTasks.push({
        structId: task.structId,
        sortId: task.sortId,
        params: rawParams,
      });

      // --- Normalized version: resolved to human-readable values ---
      const name = stringParamMap['name']
        ? struct.params.get(stringParamMap['name'] as any)?.toString() ?? null
        : null;
      const description = stringParamMap['description']
        ? struct.params.get(stringParamMap['description'] as any)?.toString() ?? null
        : null;
      const tierRaw = intParamMap['tier']
        ? (struct.params.get(intParamMap['tier'] as any) as number) ?? null
        : null;

      const resolveEnum = (key: string): string | null => {
        const enumId = stringEnumMap[key];
        const paramId = paramMap[key];
        if (enumId === undefined || paramId === undefined) return null;
        const rawValue = struct.params.get(paramId as any);
        if (rawValue === undefined || rawValue === null) return null;
        const enumMap = enumCache.get(enumId);
        return (enumMap?.get(rawValue) as string) ?? null;
      };

      const fullTask: ITaskFull = {
        structId: task.structId,
        sortId: task.sortId,
        name: name ?? `Unknown (struct ${task.structId})`,
        description: description ?? '',
        area: resolveEnum('area'),
        category: resolveEnum('category'),
        skill: resolveEnum('skill'),
        tier: tierRaw,
        tierName: resolveEnum('tier'),
        completionPercent: task.completionPercent,
        skills: task.skills,
        wikiNotes: task.wikiNotes,
      };
      fullTasks.push(fullTask);
    }

    // 6. Write raw, normalized, and CSV to the correct league subfolder
    const leagueMatch = this.findLeagueByTaskType(taskTypeName);
    const outputDir = leagueMatch ? leagueMatch.dir : './generated';
    mkdirSync(outputDir, { recursive: true });

    const fullFileName = `${taskType.taskJsonName}.full.json`;
    const rawFileName = `${taskType.taskJsonName}.raw.json`;
    const csvFileName = `${taskType.taskJsonName}.csv`;

    writeFileSync(path.join(outputDir, fullFileName), JSON.stringify(fullTasks, null, 2));
    console.log(`Wrote ${fullTasks.length} normalized tasks to ${path.join(outputDir, fullFileName)}`);

    writeFileSync(path.join(outputDir, rawFileName), JSON.stringify(rawTasks, null, 2));
    console.log(`Wrote ${rawTasks.length} raw tasks to ${path.join(outputDir, rawFileName)}`);

    writeFileSync(path.join(outputDir, csvFileName), this.tasksToCsv(fullTasks));
    console.log(`Wrote ${fullTasks.length} tasks to ${path.join(outputDir, csvFileName)}`);

    if (leagueMatch) {
      this.updateLeague(taskTypeName, { taskCount: fullTasks.length, taskFile: fullFileName });
      console.log(`Updated leagues.json for ${taskTypeName}`);
    } else {
      console.log(`No matching league in leagues.json`);
    }
  }

  /**
   * Re-scrapes wiki data and updates the existing full.json without re-extracting from cache.
   * Much faster than a full regeneration -- only hits the wiki, not the game cache.
   */
  public async handleUpdateWikiData(taskTypeName: string | undefined): Promise<void> {
    // Resolve active league if not specified
    if (!taskTypeName) {
      const activeLeague = this.findActiveLeague();
      if (!activeLeague) {
        throw new Error('No active league found in leagues.json. Provide a task type name explicitly.');
      }
      taskTypeName = activeLeague.taskTypeName;
      console.log(`Auto-detected active league: ${activeLeague.name} (${taskTypeName})`);
    }

    // Find the league and its existing full.json
    const leagueMatch = this.findLeagueByTaskType(taskTypeName);
    if (!leagueMatch) {
      throw new Error(`No league entry found for "${taskTypeName}" in leagues.json`);
    }

    const fullFilePath = path.join(leagueMatch.dir, `${taskTypeName}.full.json`);
    if (!existsSync(fullFilePath)) {
      throw new Error(`No existing full.json found at ${fullFilePath}. Run generate-full first.`);
    }

    // Load existing tasks
    const fullTasks: ITaskFull[] = JSON.parse(readFileSync(fullFilePath, 'utf-8'));
    console.log(`Loaded ${fullTasks.length} existing tasks from ${fullFilePath}`);

    // Get wiki config
    const wikiConfig = this.getWikiConfig(taskTypeName);
    if (!wikiConfig) {
      throw new Error(`No wiki config found for "${taskTypeName}". Set wikiUrl in leagues.json.`);
    }

    // We need the id param to match wiki rows to tasks by varbit index
    const taskTypesUrl = TasksCommand.TASK_TYPES_URL;
    const taskTypesResponse = await axios.get(taskTypesUrl);
    const taskTypes: ITaskType[] = taskTypesResponse.data;
    const taskType = taskTypes.find(
      (tt) => tt.taskJsonName.toLowerCase() === taskTypeName.toLowerCase(),
    );
    if (!taskType) {
      throw new Error(`Task type "${taskTypeName}" not found in upstream task-types.json`);
    }
    const idParamId = (taskType.intParamMap ?? {})['id'] as ParamID;

    // Convert fullTasks to ITask[] for the wiki service (it needs structId + sortId)
    const tasksForWiki: ITask[] = fullTasks.map((t) => ({
      structId: t.structId,
      sortId: t.sortId,
    }));

    // Scrape wiki
    console.log(`Scraping wiki from ${wikiConfig.url}...`);
    await this.wikiService.extractAndAppendData(
      tasksForWiki,
      wikiConfig.url,
      wikiConfig.taskIdAttribute,
      idParamId,
      wikiConfig.columns,
    );

    // Merge wiki data back into the full tasks
    let updated = 0;
    for (let i = 0; i < fullTasks.length; i++) {
      const wikiTask = tasksForWiki[i];
      let changed = false;

      if (wikiTask.completionPercent != null && wikiTask.completionPercent !== fullTasks[i].completionPercent) {
        fullTasks[i].completionPercent = wikiTask.completionPercent;
        changed = true;
      }
      if (wikiTask.wikiNotes != null && wikiTask.wikiNotes !== fullTasks[i].wikiNotes) {
        fullTasks[i].wikiNotes = wikiTask.wikiNotes;
        changed = true;
      }
      if (wikiTask.skills?.length > 0) {
        fullTasks[i].skills = wikiTask.skills;
        changed = true;
      }

      if (changed) updated++;
    }

    const withCompletion = fullTasks.filter((t) => t.completionPercent != null).length;
    console.log(`Wiki data merged: ${updated} tasks updated, ${withCompletion} with completion%`);

    // Write back
    writeFileSync(fullFilePath, JSON.stringify(fullTasks, null, 2));
    console.log(`Updated ${fullFilePath}`);
  }

  /**
   * Extract all tasks from the game cache by finding structs with the tier param,
   * then ordering them via tier enums. Replicates InteractiveTaskService.extractTasks()
   * without interactive prompts.
   */
  private async extractTasksFromCache(tierParamId: ParamID): Promise<ITask[]> {
    // Find all structs that have the tier param
    const allTaskStructs: Struct[] = (await this.structService.findByParam(tierParamId)).filter((s) => {
      const tierId: number = s.params.get(tierParamId) as number;
      if (tierId === 100 && tierParamId === PARAM_ID.CA_TIER_ID) {
        // Edge case: christmas achievement struct using combat achievement params
        return false;
      }
      return tierId !== undefined;
    });

    // Group by tier to find the ordering enums
    const tierTaskStructsMap = new Map<number, Struct[]>();
    for (const struct of allTaskStructs) {
      const tierId: number = struct.params.get(tierParamId) as number;
      const structs = tierTaskStructsMap.get(tierId) || [];
      tierTaskStructsMap.set(tierId, [...structs, struct]);
    }

    // For each tier, find the enum that contains all its struct IDs (this gives us ordering)
    let tierEnumIds: number[] = [];
    for (const [tierId, structs] of tierTaskStructsMap.entries()) {
      const sample: Struct = structs[Math.min(5, structs.length - 1)];
      const possibleEnums = await this.enumService.findEnumsByStruct(sample.id);
      const tierStructIds: number[] = structs.map((s) => s.id);
      const filteredEnums = possibleEnums.filter((e) => {
        const enumStructIds: Set<number> = new Set(e.map.values() as IterableIterator<number>);
        for (const tierStructId of tierStructIds) {
          if (tierStructId === 1949 || tierStructId === 5704) {
            continue; // Two odd structs from leagues 4
          }
          if (!enumStructIds.has(tierStructId)) {
            return false;
          }
        }
        return true;
      });
      if (filteredEnums.length === 0) {
        throw new Error(`Could not find ordering enum for tier ${tierId}`);
      }
      if (filteredEnums.length > 1) {
        throw new Error(`Ambiguous: multiple enums match tier ${tierId}`);
      }
      tierEnumIds[tierId] = filteredEnums[0].id;
    }

    // Deduplicate if all tiers share one enum
    const allEqual = tierEnumIds.filter((v) => !!v).every((v) => v === tierEnumIds.find((x) => !!x));
    if (allEqual) {
      tierEnumIds = [tierEnumIds.find((x) => !!x)];
    }

    // Pull struct IDs in order from the enums
    const orderedStructIds: number[] = [];
    for (const enumId of tierEnumIds) {
      if (!enumId) continue;
      const enumData = await this.enumService.getEnum(enumId);
      for (const structId of enumData.map.values()) {
        orderedStructIds.push(structId as number);
      }
    }

    return orderedStructIds.map((structId, i) => ({
      structId,
      sortId: i,
    }));
  }

  private static readonly LEAGUES_JSON = './generated/leagues.json';

  /**
   * Loads all league entries from generated/leagues.json.
   */
  private loadLeagues(): any[] {
    if (!existsSync(TasksCommand.LEAGUES_JSON)) return [];
    return JSON.parse(readFileSync(TasksCommand.LEAGUES_JSON, 'utf-8'));
  }

  /**
   * Saves league entries back to generated/leagues.json.
   */
  private saveLeagues(leagues: any[]): void {
    writeFileSync(TasksCommand.LEAGUES_JSON, JSON.stringify(leagues, null, 2) + '\n');
  }

  /**
   * Returns wiki scraping config for a task type.
   * Uses static config for known column layouts, falls back to leagues.json wikiUrl.
   */
  private getWikiConfig(taskTypeName: string): { url: string; taskIdAttribute: string; columns: any } | null {
    // Static configs for known column layouts
    const configs: Record<string, { url: string; taskIdAttribute: string; columns: any }> = {
      LEAGUE_5: {
        url: 'https://oldschool.runescape.wiki/w/Raging_Echoes_League/Tasks',
        taskIdAttribute: 'data-taskid',
        columns: LEAGUE_5_COLUMNS,
      },
    };

    const staticConfig = configs[taskTypeName.toUpperCase()];
    if (staticConfig) return staticConfig;

    // Fall back to leagues.json wikiUrl with League 5 column layout (modern standard)
    const league = this.loadLeagues().find(
      (l) => l.taskTypeName?.toUpperCase() === taskTypeName.toUpperCase(),
    );
    if (league?.wikiUrl) {
      return {
        url: league.wikiUrl,
        taskIdAttribute: 'data-taskid',
        columns: LEAGUE_5_COLUMNS,
      };
    }

    return null;
  }

  /**
   * Finds the active league from the `active` flag in leagues.json.
   * This flag is manually set when the league is confirmed live with cache + wiki data available.
   */
  private findActiveLeague(): { name: string; taskTypeName: string; dir: string } | null {
    for (const league of this.loadLeagues()) {
      if (league.active && league.taskTypeName) {
        return { name: league.name, taskTypeName: league.taskTypeName, dir: path.join('./generated', league.dir) };
      }
    }

    return null;
  }

  /**
   * Finds the league entry and subfolder path matching a taskTypeName.
   */
  private findLeagueByTaskType(taskTypeName: string): { league: any; dir: string } | null {
    const league = this.loadLeagues().find(
      (l) => l.taskTypeName?.toUpperCase() === taskTypeName.toUpperCase(),
    );
    if (!league) return null;
    return { league, dir: path.join('./generated', league.dir) };
  }

  /**
   * Updates a league's fields in leagues.json.
   */
  private updateLeague(taskTypeName: string, updates: Record<string, any>): void {
    const leagues = this.loadLeagues();
    const league = leagues.find(
      (l) => l.taskTypeName?.toUpperCase() === taskTypeName.toUpperCase(),
    );
    if (league) {
      Object.assign(league, updates);
      this.saveLeagues(leagues);
    }
  }

  /**
   * Converts normalized tasks to CSV format.
   */
  private tasksToCsv(tasks: ITaskFull[]): string {
    const headers = ['structId', 'sortId', 'name', 'description', 'area', 'category', 'skill', 'tier', 'tierName', 'completionPercent', 'skills', 'wikiNotes'];

    const escapeCsv = (value: any): string => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = tasks.map((t) => {
      const skillsStr = t.skills?.map((s) => `${s.skill} ${s.level}`).join('; ') ?? '';
      return [
        t.structId,
        t.sortId,
        t.name,
        t.description,
        t.area,
        t.category,
        t.skill,
        t.tier,
        t.tierName,
        t.completionPercent,
        skillsStr,
        t.wikiNotes,
      ].map(escapeCsv).join(',');
    });

    return [headers.join(','), ...rows].join('\n') + '\n';
  }

  public async handleUpdateVarps(options: any): Promise<ITaskType> {
    console.log('🔧 Updating task varps...');
    
    const taskTypesUrl = TasksCommand.TASK_TYPES_URL;
    
    // Load task-type definitions from GitHub
    console.log(`📡 Fetching task-types from ${taskTypesUrl}...`);
    const response = await axios.get(taskTypesUrl);
    const taskTypes: ITaskType[] = response.data;
    
    let taskTypeDefinition: ITaskType | undefined;
    
    // If --type provided, find it. Otherwise, show interactive selection
    if (options.type) {
      taskTypeDefinition = taskTypes.find(tt => 
        tt.taskJsonName.toLowerCase() === options.type.toLowerCase() ||
        tt.name.toLowerCase() === options.type.toLowerCase()
      );
      
      if (!taskTypeDefinition) {
        console.error(`❌ Could not find task-type matching "${options.type}"`);
        console.log(`Available task types: ${taskTypes.map(tt => tt.taskJsonName).join(', ')}`);
        throw new Error(`Task type "${options.type}" not found`);
      }
    } else {
      // Interactive selection
      const choices = taskTypes
        .filter(tt => tt.taskCompletedScriptId) // Only show task types with a script ID
        .map(tt => ({
          name: `${tt.name} (${tt.taskJsonName}) - Script ${tt.taskCompletedScriptId}`,
          value: tt,
        }));
      
      if (choices.length === 0) {
        throw new Error('No task types with taskCompletedScriptId found');
      }
      
      taskTypeDefinition = await InteractivePrompt.select(
        'Select a task type to update:',
        choices
      );
    }
    
    console.log(`📄 Selected task-type: "${taskTypeDefinition.name}" (${taskTypeDefinition.taskJsonName})`);
    
    if (!taskTypeDefinition.taskCompletedScriptId) {
      throw new Error(`Task type "${taskTypeDefinition.name}" does not have a taskCompletedScriptId defined`);
    }
    
    const taskCompletedScriptId = taskTypeDefinition.taskCompletedScriptId;
    console.log(`📊 Analyzing script ${taskCompletedScriptId} to extract task varps...`);
    
    // Use ScriptAnalysisService to automatically extract varps
    const taskVarps = await this.scriptAnalysisService.generateTaskVarps(taskCompletedScriptId);
    console.log(`✅ Extracted ${taskVarps.length} task varps: ${taskVarps.slice(0, 5).join(', ')}${taskVarps.length > 5 ? '...' : ''}`);
    
    // Update the taskVarps with freshly extracted ones
    const oldVarpsCount = taskTypeDefinition.taskVarps.length;
    taskTypeDefinition.taskVarps = taskVarps;
    
    console.log(`🔄 Updated taskVarps: ${oldVarpsCount} → ${taskVarps.length} varps`);
    
    if (options.json) {
      // Ensure out directory exists
      mkdirSync('./out', { recursive: true });
      const filename = `./out/${taskTypeDefinition.taskJsonName.toLowerCase()}-tasktype.json`;
      writeFileSync(filename, JSON.stringify(taskTypeDefinition, null, 2));
      console.log(`💾 Updated task-type written to ${filename}`);
    } else {
      console.log(JSON.stringify(taskTypeDefinition, null, 2));
    }

    console.log('✨ Task varp update complete!');
    return taskTypeDefinition;
  }
}
