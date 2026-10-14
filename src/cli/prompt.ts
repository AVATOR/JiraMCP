import readline from "node:readline";

const isTTY = process.stdin.isTTY === true;

/**
 * Writes to stdout, which is free to use in the setup wizard (it is not the MCP channel).
 *
 * @param text Text to print.
 */
function write(text: string) {
  process.stdout.write(text);
}

export const styles = {
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
  dim: (text: string) => `\u001b[2m${text}\u001b[0m`,
  green: (text: string) => `\u001b[32m${text}\u001b[0m`,
  red: (text: string) => `\u001b[31m${text}\u001b[0m`,
  yellow: (text: string) => `\u001b[33m${text}\u001b[0m`,
  cyan: (text: string) => `\u001b[36m${text}\u001b[0m`
};

type AskOptions = {
  defaultValue?: string;
  // Hides the typed characters, used for secrets.
  secret?: boolean;
  // Re-asks until the value passes; return a string to show an error.
  validate?: (value: string) => string | undefined;
};

/**
 * Creates a readline interface on stdin/stdout.
 * @returns A readline interface; terminal mode follows isTTY.
 */
function createInterface(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });
}

/**
 * Asks one question; with secret the typed characters are not echoed.
 *
 * @param rl Readline interface.
 * @param query Prompt text.
 * @param secret Do not echo the typed characters.
 * @returns The raw answer.
 */
function question(rl: readline.Interface, query: string, secret: boolean): Promise<string> {
  return new Promise((resolve) => {
    if (!secret) {
      rl.question(query, resolve);
      return;
    }

    // readline has no masked mode, so the echo is suppressed while the answer is typed.
    const target = rl as unknown as { _writeToOutput?: (chunk: string) => void; output: NodeJS.WriteStream };
    const original = target._writeToOutput?.bind(rl);

    target._writeToOutput = (chunk: string) => {
      if (chunk.includes(query)) {
        target.output.write(query);
        return;
      }

      if (chunk === "\r\n" || chunk === "\n") {
        target.output.write(chunk);
      }
    };

    rl.question(query, (answer) => {
      target._writeToOutput = original;
      resolve(answer);
    });
  });
}

/**
 * Prompts until the answer passes validation; fails when there is no TTY.
 *
 * @param label Question text.
 * @param options Default value, secret mode and validation.
 * @returns The trimmed answer, or the default when it is empty.
 */
export async function ask(label: string, options: AskOptions = {}): Promise<string> {
  if (!isTTY) {
    throw new Error("Interactive setup needs a TTY. Run `npx jira-mcp-add` from a terminal.");
  }

  const rl = createInterface();

  try {
    for (;;) {
      const suffix = options.defaultValue ? styles.dim(` [${options.defaultValue}]`) : "";
      const raw = await question(rl, `${styles.cyan("?")} ${label}${suffix}: `, options.secret === true);
      const value = raw.trim() || options.defaultValue?.trim() || "";
      const error = options.validate?.(value);

      if (error) {
        write(`${styles.red("✖")} ${error}\n`);
        continue;
      }

      return value;
    }
  } finally {
    rl.close();
  }
}

/**
 * Asks a yes/no question and returns the answer as a boolean.
 *
 * @param label Question text.
 * @param defaultValue Answer used when the user just presses Enter.
 * @returns True for yes.
 */
export async function confirm(label: string, defaultValue = true): Promise<boolean> {
  const answer = await ask(`${label} ${styles.dim(defaultValue ? "(Y/n)" : "(y/N)")}`, {
    defaultValue: defaultValue ? "y" : "n",
    validate: (value) => (/^(y|yes|n|no)$/i.test(value) ? undefined : "Answer y or n.")
  });

  return /^(y|yes)$/i.test(answer);
}

/**
 * Shows a numbered list and returns the value of the chosen entry.
 *
 * @param label Question text.
 * @param choices Options, each with an optional hint.
 * @returns The value of the chosen option.
 */
export async function select(label: string, choices: { value: string; hint?: string }[]): Promise<string> {
  write(`${styles.cyan("?")} ${label}\n`);
  choices.forEach((choice, index) => {
    write(
      `  ${styles.bold(String(index + 1))}. ${choice.value}${choice.hint ? styles.dim(` — ${choice.hint}`) : ""}\n`
    );
  });

  const answer = await ask("Choice", {
    defaultValue: "1",
    validate: (value) => {
      const index = Number(value);
      return Number.isInteger(index) && index >= 1 && index <= choices.length
        ? undefined
        : `Enter a number between 1 and ${choices.length}.`;
    }
  });

  return choices[Number(answer) - 1].value;
}

export const log = {
  title: (text: string) => write(`\n${styles.bold(text)}\n`),
  info: (text: string) => write(`  ${text}\n`),
  note: (text: string) => write(`  ${styles.dim(text)}\n`),
  success: (text: string) => write(`${styles.green("✔")} ${text}\n`),
  warn: (text: string) => write(`${styles.yellow("!")} ${text}\n`),
  error: (text: string) => write(`${styles.red("✖")} ${text}\n`),
  blank: () => write("\n")
};
