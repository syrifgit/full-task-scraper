import { Injectable } from '@nestjs/common';
import { writeFileSync } from 'node:fs';
import * as path from 'path';
import { QuestRequirementsService } from '../../../core/services/quests/quest-requirements.service';

@Injectable()
export class QuestCommand {
  constructor(
    private questRequirements: QuestRequirementsService,
  ) {}

  public async handleQuestListIds(): Promise<void> {
    const quests = await this.questRequirements.getQuestList();
    quests.forEach((quest) => {
      console.log(`${quest.id}\t${quest.name}`);
    });
  }

  public async handleQuestRollup(questId: number): Promise<void> {
    const result = await this.questRequirements.getQuestRequirementRollup(questId);
    console.log(JSON.stringify(result, null, 2));
  }

  public async handleQuestRequirementsDump(questId: number): Promise<void> {
    const output = await this.questRequirements.getQuestRequirementDetails(questId);
    if (!output) {
      console.error('dbrow not found', { tableId: 0, rowId: questId });
      return;
    }
    console.log(JSON.stringify(output, null, 2));
  }

  public async handleQuestRequirementsDumpAll(writeToFile?: boolean): Promise<void> {
    const outputQuests = await this.questRequirements.getQuestList();

    const output = {
      source: 'cache: dbrow quest table 0',
      updatedAt: new Date().toISOString(),
      quests: outputQuests,
    };

    if (writeToFile) {
      const outputPath = path.resolve(process.cwd(), './out/quests-dbrow.json');
      writeFileSync(outputPath, JSON.stringify(output, null, 2));
      console.log(`Saved ${outputQuests.length} quests to ${outputPath}`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  }
}
