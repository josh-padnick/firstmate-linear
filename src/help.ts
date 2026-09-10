import { CliUsageError } from "./cli-output";

type HelpOption = [string, string];
interface CommandHelp {
  usage: string;
  description: string;
  options?: HelpOption[];
  example?: string;
}
const commands: Record<string, CommandHelp> = {
  installation: {
    usage: "installation",
    description: "Show the selected Firstmate installation.",
  },
  test: {
    usage: "test",
    description: "Check compatibility using isolated fixtures.",
    options: [
      [
        "--capability NAME",
        "Test task-state, briefs, messages, fleet, or routed-reads; repeat to select.",
      ],
    ],
    example: "--capability task-state",
  },
  task: {
    usage: "task TASK_ID",
    description: "Read a Firstmate task's state and execution attempt.",
    example: "sample-task",
    options: [
      ["--secondmate ID", "Read a task owned by this registered secondmate through the primary."],
    ],
  },
  fleet: {
    usage: "fleet",
    description: "List work in the primary and its registered secondmate homes.",
    options: [
      ["--secondmate ID", "Limit child discovery to one registered secondmate."],
      ["--refresh", "Read now, bypassing failed-home retry backoff."],
    ],
  },
  "brief-update": {
    usage: "brief-update",
    description: "Add workflow instructions to an authored Firstmate brief.",
    options: [["--input FILE", "Required: JSON brief-update request."]],
    example: "--input update.json",
  },
  "brief-check": {
    usage: "brief-check",
    description: "Check whether a Firstmate brief includes the expected update.",
    options: [
      ["--input FILE", "Required: JSON execution-attempt reference."],
      ["--receipt FILE", "Required: JSON receipt from brief-update."],
    ],
    example: "--input attempt.json --receipt receipt.json",
  },
  send: {
    usage: "send",
    description: "Queue a message for Firstmate.",
    options: [["--input FILE", "Required: JSON message addressed to Firstmate."]],
    example: "--input message.json",
  },
  receive: {
    usage: "receive",
    description: "Accept a full reply or task-report envelope from Firstmate.",
    options: [["--input FILE", "Required: JSON reply or report envelope."]],
    example: "--input response.json",
  },
  respond: {
    usage: "respond REQUEST_ID",
    description: "Reply to an existing request; FM Linear fills in metadata.",
    options: [
      ["--input FILE", "Required: JSON reply content."],
      ["--message-id ID", "Optional: identifier for a distinct follow-up."],
    ],
    example: "request-123 --input reply.json",
  },
  "extension-package": {
    usage: "extension-package DIRECTORY",
    description: "Create a package for Firstmate's event extension.",
    options: [["--executable PATH", "Compiled executable; defaults to the running executable."]],
    example: "/path/to/package --executable /path/to/fm-linear",
  },
};

const requiredOptions: HelpOption[] = [
  ["--home PATH", "Firstmate home containing task data and config."],
  ["--code-root PATH", "Firstmate source checkout containing bin/."],
  ["--state DATABASE", "FM Linear's SQLite database path."],
];

export function requiredOptionsHelp(
  render: (title: string, rows: HelpOption[]) => string = (title, rows) =>
    `${title}\n${rows.map(([name, description]) => `  ${name.padEnd(22)}${description}`).join("\n")}`,
): string {
  return `${render("Required options", requiredOptions)}\n\nPass these paths explicitly. Config and environment defaults are not supported yet.`;
}

/** Show the command list first; put detailed options in each command's help. */
export function cliHelp(command?: string): string {
  const color =
    process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const bold = (text: string) => (color ? `\x1b[1m${text}\x1b[0m` : text);
  const accent = (text: string) => (color ? `\x1b[36m${text}\x1b[0m` : text);
  const narrow = process.stdout.isTTY && process.stdout.columns < 80;
  const section = (title: string, rows: HelpOption[]) =>
    `${bold(title)}\n${rows
      .map(([name, description]) =>
        narrow
          ? `  ${accent(name)}\n    ${description}`
          : `  ${accent(name.padEnd(22))}${description}`,
      )
      .join("\n")}`;
  const outputOptions: HelpOption[] = [
    ["--format FORMAT", "Output human (default), json, or toon."],
    ["--json", "Alias for --format json."],
    ["-h, --help", "Show help."],
  ];
  if (!command)
    return [
      `${bold("FM Linear")} connects Firstmate to Linear.`,
      `${bold("Usage:")} fm-linear <command> [options]`,
      section(
        "Commands",
        Object.entries(commands).map(([name, help]) => [name, help.description]),
      ),
      section("Global options", outputOptions),
      "Run fm-linear <command> --help for options and examples.",
    ].join("\n\n");

  const help = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!help)
    throw new CliUsageError("Unknown command.", "Run fm-linear --help for supported commands.");
  const result = [`${bold("Usage:")} fm-linear ${help.usage} [options]`, help.description];
  if (command !== "extension-package") result.push(requiredOptionsHelp(section));
  if (help.options) result.push(section("Command options", help.options));
  result.push(section("Output and help", outputOptions));
  const example = `  fm-linear ${command}${help.example ? ` ${help.example}` : ""}`;
  result.push(
    `${bold("Example")}\n${example}${command === "extension-package" ? "" : " \\\n    --home /path/to/firstmate-home \\\n    --code-root /path/to/firstmate \\\n    --state /path/to/fm-linear.sqlite"}`,
  );
  if (command === "test") result.push("Exits 1 if any selected check fails or cannot be verified.");
  if (command === "brief-update")
    result.push("Use --format json to save a receipt for brief-check.");
  return result.join("\n\n");
}
