import { ParamID, Struct } from '@abextm/cache2';
import { Injectable } from '@nestjs/common';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PARAM_ID } from '../../../core/data/param-ids';
import { replacer } from '../../../core/json-replacer';
import { CombatSkillRequirementsService } from '../../../core/services/combat/combat-skill-requirements.service';
import { EnumService } from '../../../core/services/enum/enum.service';
import { StructService } from '../../../core/services/struct/struct.service';
import { WikiService } from '../../../core/services/wiki/wiki.service';
import { ITask } from '../../../core/types/task-mockup.interface';
import { COMBAT_COLUMNS } from '../tasks/column-definitions/combat-columns';

@Injectable()
export class CombatCommand {
  constructor(
    private structService: StructService,
    private enumService: EnumService,
    private wikiService: WikiService,
    private combatSkillRequirementsService: CombatSkillRequirementsService,
  ) {}

  public async handleCombatTasks(options: any): Promise<ITask[]> {
    const orderedStructIds: number[] = [];

    const difficultyEnums: number[] = [3981, 3982, 3983, 3984, 3985, 3986];
    for (const enumId of difficultyEnums) {
      const orderedDifficultyStructIds: Map<number, string | number> = (await this.enumService.getEnum(enumId)).map;
      for (const structId of orderedDifficultyStructIds.values()) {
        orderedStructIds.push(structId as number);
      }
    }

    const allTaskStructs: Struct[] = [];
    for (const structId of orderedStructIds) {
      const taskStruct: Struct = await this.structService.getStruct(structId);
      allTaskStructs.push(taskStruct);
    }

    const allTasksFormatted: ITask[] = allTaskStructs.map((s, i) => ({
      structId: s.id,
      sortId: i,
    }));

    if (options.json) {
      this.writeToFile(allTasksFormatted, 'combat.json');
    } else {
      console.log(JSON.stringify(allTasksFormatted, replacer));
    }
    return allTasksFormatted;
  }

  public async handleApplyCombatWiki(options: any) {
    const wikiUrl = 'https://oldschool.runescape.wiki/w/Combat_Achievements/All_tasks';
    const taskIdAttribute = 'data-ca-task-id';
    const varbitIndexParamId: ParamID = PARAM_ID.CA_VARBIT_INDEX;

    console.log('Using hardcoded combat achievement settings:');
    console.log(`  Wiki URL: ${wikiUrl}`);
    console.log(`  Task ID attribute: ${taskIdAttribute}`);
    console.log(`  Varbit index param ID: ${varbitIndexParamId}`);

    const taskJsonPath = './out/combat.json';
    let tasks: ITask[];
    try {
      const taskJsonContent = readFileSync(taskJsonPath, 'utf-8');
      tasks = JSON.parse(taskJsonContent);
    } catch (error) {
      console.error(`Error reading task file ${taskJsonPath}:`, error);
      throw error;
    }

    console.log('Appending wiki data to combat tasks...');
    const enhancedTasks = await this.wikiService.extractAndAppendData(
      tasks,
      wikiUrl,
      taskIdAttribute,
      varbitIndexParamId,
      COMBAT_COLUMNS,
    );

    const outputFileName = taskJsonPath.replace('.json', '-with-wiki.json');
    if (options.json) {
      writeFileSync(outputFileName, JSON.stringify(enhancedTasks, null));
      console.log(`Enhanced combat tasks written to ${outputFileName}`);
    } else {
      console.log(JSON.stringify(enhancedTasks, null, 2));
    }
  }

  public async handleApplyCombatSkillRequirements(options: { input?: string; output?: string }) {
    const inputPath = options.input ?? './out/combat-with-wiki.json';
    const outputPath = options.output ?? './out/combat-with-wiki-skills.json';

    let tasks: ITask[];
    try {
      const taskJsonContent = readFileSync(inputPath, 'utf-8');
      tasks = JSON.parse(taskJsonContent);
    } catch (error) {
      console.error(`Error reading task file ${inputPath}:`, error);
      throw error;
    }

    const combinedSkillsById = await this.combatSkillRequirementsService.applyCombatSkillRequirements(tasks);
    this.writeToFile(combinedSkillsById, 'combat-ca-skill-reqs.json');

    writeFileSync(outputPath, JSON.stringify(tasks, null));
    console.log(`Combat skill requirements written to ${outputPath}`);
  }

  private writeToFile(obj: any, fileNameAndPath: string): void {
    mkdirSync('./out', { recursive: true });
    writeFileSync('./out/' + fileNameAndPath, JSON.stringify(obj, null));
  }

}
