import { Command } from 'commander';
import { getCommandInstance } from '../..';
import { CombatCommand } from '../combat/combat-command';
import { CombatCommandModule } from '../combat/combat-command.module';

export const combatCommand = new Command('combat').description('combat achievement task operations');

combatCommand
  .command('generate')
  .option('--json', 'output to json file', false)
  .action(async (options: any) => {
    const command: CombatCommand = await getCommandInstance(CombatCommand, CombatCommandModule);
    await command.handleCombatTasks(options);
  });

combatCommand
  .command('apply-wiki')
  .description('Apply combat wiki data to combat tasks')
  .option('--json', 'output to json file', false)
  .action(async (options: any) => {
    const command: CombatCommand = await getCommandInstance(CombatCommand, CombatCommandModule);
    await command.handleApplyCombatWiki(options);
  });

combatCommand
  .command('apply-skills')
  .description('Apply combat skill requirements from task-json-store')
  .option('--input <path>', 'input task json file', './out/combat-with-wiki.json')
  .option('--output <path>', 'output task json file (defaults to out/combat-with-wiki-skills.json)')
  .action(async (options: { input?: string; output?: string }) => {
    const command: CombatCommand = await getCommandInstance(CombatCommand, CombatCommandModule);
    await command.handleApplyCombatSkillRequirements(options);
  });