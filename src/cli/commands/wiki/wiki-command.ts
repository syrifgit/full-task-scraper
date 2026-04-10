import { Injectable } from '@nestjs/common';
import { writeFileSync, mkdirSync } from 'node:fs';
import { IColumnDefinitions } from '../../../core/services/wiki/column-definitions.interface';
import { WikiService } from '../../../core/services/wiki/wiki.service';
import { InteractivePrompt } from '../../interactive-prompt.util';
import { LEAGUE_5_COLUMNS } from '../tasks/column-definitions/league-5-columns';

@Injectable()
export class WikiCommand {
  constructor(private wikiService: WikiService) {}

  public async handleWikiTaskTypeExtract(options: any) {
    const wikiUrl: string = await InteractivePrompt.input(
      'enter the wiki url with all tasks on it',
      'https://oldschool.runescape.wiki/w/Raging_Echoes_League/Tasks',
    );

    const taskIdAttribute: string = await InteractivePrompt.input(
      'enter the task id attribute (from the tr elements)',
      'data-taskid',
    );

    // TODO: Get from user
    const columnDefinitions: IColumnDefinitions = LEAGUE_5_COLUMNS;

    const includeNameDescription = true;
    const data = await this.wikiService.extractWikiData(
      wikiUrl,
      taskIdAttribute,
      columnDefinitions,
      includeNameDescription,
    );

    if (options.json) {
      mkdirSync('./out', { recursive: true });
      writeFileSync(`./out/wiki-scrape.json`, JSON.stringify(data, null));
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }

}
