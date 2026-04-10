import { Test } from '@nestjs/testing';
import { CacheProviderModule } from '../../../core/cache-provider.module';
import { PARAM_ID } from '../../../core/data/param-ids';
import { EnumServiceModule } from '../../../core/services/enum/enum-service.module';
import { EnumService } from '../../../core/services/enum/enum.service';
import { StructServiceModule } from '../../../core/services/struct/struct-service.module';
import { StructService } from '../../../core/services/struct/struct.service';
import { TasksCommand } from './tasks-command';
import { TasksCommandModule } from './tasks-command.module';

describe(TasksCommand.name, () => {
  let structService: StructService;
  let enumService: EnumService;
  let command: TasksCommand;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StructServiceModule, EnumServiceModule, CacheProviderModule, TasksCommandModule],
      providers: [StructService, EnumService],
    }).compile();

    structService = moduleRef.get<StructService>(StructService);
    enumService = moduleRef.get<EnumService>(EnumService);
    command = moduleRef.get<TasksCommand>(TasksCommand);
  });

  // These integration tests require interactive prompts (wiki URL input) and network
  // access that can't run in CI. They need to be rewritten with mocked services.
  describe(TasksCommand.prototype.handleTaskExtract, () => {
    it.skip('should return combat tasks', async () => {
      const options = {
        taskName: 'barrows novice',
        idParam: PARAM_ID.CA_VARBIT_INDEX,
        nameParam: PARAM_ID.CA_NAME,
        descriptionParam: PARAM_ID.CA_DESCRIPTION,
        tierParam: PARAM_ID.CA_TIER_ID,
        addlParams: false,
        name: 'combat',
        description: 'combat achievements',
        taskJsonName: 'COMBAT',
      };

      const result = await command.handleTaskExtract(options);

      expect(result.taskType.name).toEqual('combat');
      expect(result.taskType.taskJsonName).toEqual('COMBAT');
      expect(result.tasks.length).toEqual(568);
      expect(result.tasks[1]).toEqual({
        sortId: 1,
        structId: 3164,
      });
      expect(result.tasks[567]).toEqual({
        sortId: 567,
        structId: 1009,
      });
    });

    it.skip('should return league 4 tasks', async () => {
      const options = {
        taskName: 'enter sophanem',
        idParam: PARAM_ID.LEAGUE_VARBIT_INDEX,
        nameParam: PARAM_ID.LEAGUE_NAME,
        descriptionParam: PARAM_ID.LEAGUE_DESCRIPTION,
        tierParam: PARAM_ID.LEAGUE_TIER_ID,
        addlParams: false,
        name: 'league 4',
        description: 'leagues 4 tasks',
        taskJsonName: 'LEAGUE_4',
      };

      const result = await command.handleTaskExtract(options);

      expect(result.taskType.name).toEqual('league 4');
      expect(result.taskType.taskJsonName).toEqual('LEAGUE_4');
      expect(result.tasks.length).toEqual(1480);
      expect(result.tasks[0]).toEqual({
        sortId: 0,
        structId: 5286,
      });
      expect(result.tasks[1479]).toEqual({
        sortId: 1479,
        structId: 5840,
      });
    });
  });
});
