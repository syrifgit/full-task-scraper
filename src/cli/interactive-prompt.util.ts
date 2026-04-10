import { confirm, input, select } from '@inquirer/prompts';
import { ISelectOption } from './select-option.interface';

export class InteractivePrompt {
  public static async select<T>(message: string, choices: ISelectOption<T>[]): Promise<T> {
    const answers = await select({
      message,
      choices,
      loop: false,
    });

    return answers;
  }

  public static async confirm(message: string, defaultValue: boolean = true): Promise<boolean> {
    const answers = await confirm({
      message,
      default: defaultValue,
    });

    return answers;
  }

  public static async input(message: string, defaultValue?: string): Promise<string> {
    const result = await input({
      message,
      default: defaultValue,
    });

    return result;
  }

}
