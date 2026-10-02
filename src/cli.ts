#!/usr/bin/env node
import { parseArgs } from "node:util";
import { build, install, run } from "./commands.ts";

const USAGE = `usage:
  prosa build [--force] <file.prosa>   compile prose into .output/ (reuses an unchanged build)
  prosa install                        install declared dependencies into .output/ and validate
  prosa run [-- <args...>]             execute the validated .output/index.ts with Node

Configuration: prosa.json in the project root (model, baseUrl, apiKeyFile, packageManager, choices, maxTokens)
Environment:   OPENAI_API_KEY, OPENAI_BASE_URL, PROSA_MODEL, PROSA_MAX_TURNS, PROSA_TIMEOUT_MS
Runtime:       Node ${process.versions.node} (Node >= 24 required)`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "build": {
      const { values, positionals } = parseArgs({ args: rest, options: { force: { type: "boolean", default: false } }, allowPositionals: true });
      if (positionals.length !== 1) throw new Error(`build expects exactly one source file\n${USAGE}`);
      await build(positionals[0], { force: values.force });
      return;
    }
    case "install":
      if (rest.length > 0) throw new Error(`install takes no arguments\n${USAGE}`);
      install();
      return;
    case "run":
      run(rest[0] === "--" ? rest.slice(1) : rest);
      return;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command "${command}"\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(`prosa: ${error.message}`);
  process.exitCode = process.exitCode || 1;
});
