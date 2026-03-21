import { ParamID } from '@abextm/cache2';
import { Command } from 'commander';
import { getCommandInstance } from '../..';
import { ArgumentValidator } from '../../../core/argument-validator';
import { RootCommand } from '../../root-command';
import { TasksCommand } from './tasks-command';
import { TasksCommandModule } from './tasks-command.module';
import { combatCommand } from './add-combat-command';

export function addTasksCommand(commandName: string, program: RootCommand): void {

  const updateVarps = new Command('update-varps')
    .description('Update task-type with fresh varp extraction from script analysis')
    .option('--type <taskType>', 'Task type name (e.g., COMBAT, DIARY, LEAGUE)')
    .option('--json', 'output to json file', false)
    .action(async (options: any) => {
      const command: TasksCommand = await getCommandInstance(TasksCommand, TasksCommandModule);
      await command.handleUpdateVarps(options);
    });
  const extract = new Command('extract')
    .description('extracts tasks using an interactive prompt, used to find data sources for tasks & task types')
    .option('--task-name <taskName>', 'override prompt for the task name')
    .option('--id-param <idParam>', 'override prompt for the id', ArgumentValidator.isNumber)
    .option('--name-param <nameParam>', 'override prompt for the name', ArgumentValidator.isNumber)
    .option('--description-param <descriptionParam>', 'override prompt for the description', ArgumentValidator.isNumber)
    .option('--tier-param <tierParam>', 'override prompt for the tier', ArgumentValidator.isNumber)
    .option('--addl-params', 'override prompt for additional params')
    .option('--json', 'output to json file')
    .action(async (options: any) => {
      const command: TasksCommand = await getCommandInstance(TasksCommand, TasksCommandModule);
      await command.handleTaskExtract(options);
    });

  const generateFrontendTasks = new Command('generate-frontend-tasks')
    .description('Generates a hydrated list of tasks in the form the frontend requires')
    .argument('<task-type-name>', 'extensionless filename for the .json that holds task data in task-json-store')
    .argument('<name-param-id>', "the task structs' string name param id", ArgumentValidator.isNumber)
    .argument('<description-param-id>', "the task structs' string description param id", ArgumentValidator.isNumber)
    .action(async (jsonFilename: string, nameParamId: ParamID, descriptionParamId: ParamID) => {
      const command: TasksCommand = await getCommandInstance(TasksCommand, TasksCommandModule);
      await command.handleGenerateFrontendTasks(jsonFilename, nameParamId, descriptionParamId);
    });
  const generateFull = new Command('generate-full')
    .description('Generates a full task JSON with all params resolved to human-readable values (for web tool consumption)')
    .argument('[task-type-name]', 'task type name (e.g., LEAGUE_5). If omitted, auto-detects active league from leagues.json.')
    .action(async (taskTypeName?: string) => {
      const command: TasksCommand = await getCommandInstance(TasksCommand, TasksCommandModule);
      await command.handleGenerateFullTasks(taskTypeName);
    });

  const updateWiki = new Command('update-wiki')
    .description('Re-scrapes wiki data (completion %, skills, notes) and updates existing full.json without re-extracting from cache')
    .argument('[task-type-name]', 'task type name (e.g., LEAGUE_5). If omitted, auto-detects active league from leagues.json.')
    .action(async (taskTypeName?: string) => {
      const command: TasksCommand = await getCommandInstance(TasksCommand, TasksCommandModule);
      await command.handleUpdateWikiData(taskTypeName);
    });

  program
    .command(commandName)
    .description('data operations related to tasks')
    .addCommand(updateVarps)
    .addCommand(combatCommand)
    .addCommand(extract)
    .addCommand(generateFrontendTasks)
    .addCommand(generateFull)
    .addCommand(updateWiki);
}
