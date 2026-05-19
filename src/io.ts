import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Single shared readline for the whole process. Both the main chat loop
// and tool-confirmation prompts read through this one instance, so they
// never fight over stdin.
export const rl = readline.createInterface({ input, output });

/**
 * Ask a yes/no question on the terminal.
 * Defaults to NO — only the literal answers 'y', 'Y', 'yes' count as yes.
 * Enter alone == no. This is the safer default for destructive actions.
 */
export async function confirm(question: string): Promise<boolean> {
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
