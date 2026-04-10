import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import * as path from 'path';
import { QuestRequirementsService } from '../quests/quest-requirements.service';
import { ITask, ITaskSkill } from '../../types/task-mockup.interface';

@Injectable()
export class CombatSkillRequirementsService {
  constructor(private questRequirements: QuestRequirementsService) {}

  private resolveTaskJsonStorePath(...segments: string[]): string {
    return path.resolve(process.cwd(), '../task-json-store', ...segments);
  }

  private readCustomColumn<T = any>(columnName: string): T {
    const columnPath = this.resolveTaskJsonStorePath('custom-data', 'COMBAT', `${columnName}.json`);
    const raw = readFileSync(columnPath, 'utf-8');
    return JSON.parse(raw) as T;
  }

  public async buildCombatSkillRequirements(): Promise<Record<number, ITaskSkill[]>> {
    const skillsColumn = this.readCustomColumn<{ values?: Record<string, ITaskSkill[]> }>('skills');
    const questsColumn = this.readCustomColumn<{ values?: Record<string, number[]> }>('quests');

    const skillsById: Record<number, ITaskSkill[]> = {};

    const mergeSkills = (base: Record<string, number>, extra: Record<string, number>) => {
      Object.entries(extra).forEach(([skill, level]) => {
        const numericLevel = Number(level);
        if (Number.isNaN(numericLevel)) {
          return;
        }
        base[skill] = Math.max(base[skill] ?? 0, numericLevel);
      });
    };

    const directSkills = skillsColumn?.values ?? {};
    const questValues = questsColumn?.values ?? {};

    for (const [taskIdString, questIds] of Object.entries(questValues)) {
      const taskId = Number(taskIdString);
      if (Number.isNaN(taskId)) {
        continue;
      }

      const aggregated: Record<string, number> = {};
      const quests = Array.isArray(questIds) ? questIds : [];

      for (const questId of quests) {
        const numericQuestId = Number(questId);
        if (Number.isNaN(numericQuestId)) {
          continue;
        }
        const rollup = await this.questRequirements.getQuestRequirementRollup(numericQuestId);
        mergeSkills(aggregated, rollup.skills ?? {});
      }

      const existing = Array.isArray(directSkills[taskIdString]) ? directSkills[taskIdString] : [];
      for (const entry of existing) {
        if (!entry?.skill) {
          continue;
        }
        const numericLevel = Number(entry.level);
        if (Number.isNaN(numericLevel)) {
          continue;
        }
        aggregated[entry.skill] = Math.max(aggregated[entry.skill] ?? 0, numericLevel);
      }

      const combined = Object.entries(aggregated)
        .map(([skill, level]) => ({ skill, level }))
        .sort((a, b) => a.skill.localeCompare(b.skill));

      if (combined.length > 0) {
        skillsById[taskId] = combined;
      }
    }

    for (const [taskIdString, entries] of Object.entries(directSkills)) {
      const taskId = Number(taskIdString);
      if (Number.isNaN(taskId)) {
        continue;
      }
      if (skillsById[taskId]) {
        continue;
      }
      if (Array.isArray(entries) && entries.length > 0) {
        skillsById[taskId] = entries;
      }
    }

    return skillsById;
  }

  public async applyCombatSkillRequirements(tasks: ITask[]): Promise<Record<number, ITaskSkill[]>> {
    const skillsById = await this.buildCombatSkillRequirements();
    for (const task of tasks) {
      const combinedSkills = skillsById[task.structId];
      if (combinedSkills?.length) {
        task.skills = combinedSkills;
      }
    }
    return skillsById;
  }
}
