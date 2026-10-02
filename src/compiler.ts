import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, Type, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { runProgram, typecheck } from "./artifact.ts";
import type { ModelSettings } from "./config.ts";

export const PROMPT_VERSION = 2;

export const SYSTEM_PROMPT = `You are the Prosa compiler, prompt version ${PROMPT_VERSION}. A Prosa source file describes a program in natural language, usually German. Translate the prose into a complete TypeScript program using only the tools provided; never answer with code in text.

Workflow:
1. Write every module with write_file. "index.ts" is the application entry point and must exist. Put every function or component the prose names into its own module named after it.
2. Call typecheck and fix every reported error. Call run with the arguments of each example the prose states and compare the output. Every run starts in a fresh empty working directory; use "before" for invocations that must happen first.
3. Finish with done, listing external dependencies, one check per concrete example the prose literally states (with "before" for preceding invocations), and a one-sentence note on interpretation choices. Do not invent examples.
If the prose leaves a decision open that changes observable behavior and no accepted decision covers it, call ask with concise questions instead of guessing.

Rules for the generated program:
- Target: Node.js 24 executing .ts files directly through type stripping. Use ES modules. Relative imports must include the .ts extension, for example: import { addiere } from "./addiere.ts";
- Use only erasable TypeScript syntax: no enums, no namespaces, no parameter properties, no decorators, no "import x = require". Use "import type" for type-only imports.
- The code must pass "tsc --strict" with Node type definitions available. Never use "any".
- Prefer the Node standard library. Only when the prose requires an external package, import it normally and declare it in done with a caret version range. Packages are not installed during compilation, so typecheck and run will report their imports as unresolved; that is expected and the harness validates them after installation.
- Program arguments are process.argv.slice(2). The program runs with the user's current directory as working directory, never the directory of its own modules. Write to stdout with console.log or process.stdout.write; set the exit code with process.exitCode or process.exit.
- Paths are relative, use forward slashes, end in .ts, and contain no ".." segments.`;

export const PROMPT_SHA256 = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface Check {
  args: string[];
  stdout: string;
  exitCode: number;
  /** Invocations run first in the same empty directory, for examples that build on earlier calls. */
  before?: string[][];
}

export interface CompileResult {
  dependencies: Record<string, string>;
  checks: Check[];
  notes: string;
}

export interface CompileSession {
  sourceName: string;
  source: string;
  choices: Record<string, string>;
  previousFiles: GeneratedFile[];
  /** Staging directory the tools may write into; must already contain tsconfig.json. */
  staging: string;
  /** Harness validation after done; a returned message is fed back for one more round. */
  validate: (result: CompileResult) => string | null;
}

export interface CompileStats {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export class QuestionsError extends Error {
  readonly questions: string[];
  constructor(questions: string[]) {
    super(`the compiler needs decisions before it can build:\n  - ${questions.join("\n  - ")}\nAnswer them in the prose or under "choices" in prosa.json, then build again.`);
    this.questions = questions;
  }
}

export const ENTRY = "index.ts";
export const RESERVED_FILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "prosa.manifest.json", "tsconfig.json"]);
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const VERSION_RANGE = /^[\w.^~<>=* -]+$/;
const MAX_ROUNDS = 2;
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_TIMEOUT_MS = 600_000;

export function isSafeOutputPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  if (segments[0] === "node_modules" || segments[0].startsWith(".")) return false;
  if (!path.endsWith(".ts") || RESERVED_FILES.has(path)) return false;
  return true;
}

function text(value: string, extra: { isError?: boolean; terminate?: boolean } = {}) {
  return { content: [{ type: "text" as const, text: value }], details: undefined, ...extra };
}

function parseResult(args: { dependencies: { name: string; version: string }[]; checks: Check[]; notes: string }): CompileResult {
  const dependencies: Record<string, string> = {};
  for (const { name, version } of args.dependencies) {
    if (!PACKAGE_NAME.test(name)) throw new Error(`invalid dependency name ${JSON.stringify(name)}`);
    if (!VERSION_RANGE.test(version)) throw new Error(`invalid version range for ${name}`);
    dependencies[name] = version;
  }
  for (const check of args.checks) {
    if (!Number.isInteger(check.exitCode)) throw new Error("check exitCode must be an integer");
  }
  return { dependencies, checks: args.checks, notes: args.notes };
}

function buildTools(session: CompileSession, state: { result?: CompileResult; questions?: string[] }): AgentTool[] {
  const previous = new Map(session.previousFiles.map((f) => [f.path, f.content]));
  return [
    {
      name: "write_file",
      label: "write file",
      description: "Create or replace one generated TypeScript file in the output. The path is relative, forward slashes, ends in .ts.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id, params) => {
        const { path, content } = params as { path: string; content: string };
        if (!isSafeOutputPath(path)) return text(`rejected: ${JSON.stringify(path)} is not a safe relative .ts path`, { isError: true });
        if (content.length === 0) return text("rejected: empty content", { isError: true });
        mkdirSync(dirname(join(session.staging, path)), { recursive: true });
        writeFileSync(join(session.staging, path), content);
        return text(`wrote ${path} (${content.length} chars)`);
      },
    },
    {
      name: "read_previous",
      label: "read previous build",
      description: `Read a file of the previous validated build of an older source version, for reference. Available: ${[...previous.keys()].join(", ") || "none"}`,
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        const { path } = params as { path: string };
        const content = previous.get(path);
        return content === undefined ? text(`no previous file ${path}`, { isError: true }) : text(content);
      },
    },
    {
      name: "typecheck",
      label: "type check",
      description: "Run tsc --strict over all written files. Returns the diagnostics, or ok.",
      parameters: Type.Object({}),
      execute: async () => {
        const errors = typecheck(session.staging);
        return errors ? text(errors, { isError: true }) : text("ok: no type errors");
      },
    },
    {
      name: "run",
      label: "run program",
      description: "Execute index.ts with the given arguments in a fresh empty working directory; \"before\" lists invocations to run there first. Returns stdout, stderr and the exit code of the final invocation.",
      parameters: Type.Object({ args: Type.Array(Type.String()), before: Type.Optional(Type.Array(Type.Array(Type.String()))) }),
      execute: async (_id, params) => {
        const { args, before } = params as { args: string[]; before?: string[][] };
        const result = runProgram(join(session.staging, ENTRY), args, before ?? []);
        return text(`exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      },
    },
    {
      name: "ask",
      label: "ask",
      description: "Stop compilation and ask the author to decide open questions that change observable behavior.",
      parameters: Type.Object({ questions: Type.Array(Type.String()) }),
      execute: async (_id, params) => {
        const { questions } = params as { questions: string[] };
        state.questions = questions;
        return text("questions recorded; compilation stops", { terminate: true });
      },
    },
    {
      name: "done",
      label: "done",
      description: "Finish compilation. The harness then validates all written files itself.",
      parameters: Type.Object({
        dependencies: Type.Array(Type.Object({ name: Type.String(), version: Type.String() })),
        checks: Type.Array(Type.Object({ args: Type.Array(Type.String()), stdout: Type.String(), exitCode: Type.Number(), before: Type.Optional(Type.Array(Type.Array(Type.String()))) })),
        notes: Type.String(),
      }),
      execute: async (_id, params) => {
        const args = params as { dependencies: { name: string; version: string }[]; checks: Check[]; notes: string };
        try {
          state.result = parseResult(args);
        } catch (error) {
          return text(`rejected: ${(error as Error).message}`, { isError: true });
        }
        return text("submitted for validation", { terminate: true });
      },
    },
  ];
}

export function buildUserMessage(session: CompileSession): string {
  const choices = Object.entries(session.choices);
  const parts = [
    `Source file: ${session.sourceName}`,
    "",
    "Accepted decisions:",
    choices.length === 0 ? "(none)" : choices.map(([k, v]) => `- ${k}: ${v}`).join("\n"),
  ];
  if (session.previousFiles.length > 0) {
    parts.push("", "A previous validated build of an older source version exists; read_previous shows its files. Write the complete new program.");
  }
  parts.push("", "Source:", session.source);
  return parts.join("\n");
}

function prosaModel(settings: ModelSettings, apiKey: string) {
  const model: Model<"openai-completions"> = {
    id: settings.model,
    name: settings.model,
    api: "openai-completions",
    provider: "prosa",
    baseUrl: settings.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: settings.maxTokens,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
  };
  const provider = createProvider({
    id: "prosa",
    name: "Prosa compiler endpoint",
    baseUrl: settings.baseUrl,
    auth: { apiKey: { name: "Prosa compiler API key", resolve: async () => ({ auth: { apiKey } }) } },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { model, streamFn: models.streamSimple.bind(models) };
}

/** Runs the bounded tool loop. Resolves with the validated result; throws on questions, budget, errors or repeated validation failure. */
export async function compile(settings: ModelSettings, apiKey: string, session: CompileSession, log: (line: string) => void): Promise<{ result: CompileResult; stats: CompileStats }> {
  const maxTurns = Number(process.env.PROSA_MAX_TURNS ?? DEFAULT_MAX_TURNS);
  const timeoutMs = Number(process.env.PROSA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const state: { result?: CompileResult; questions?: string[]; wrongModel?: string } = {};
  const stats: CompileStats = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
  const { model, streamFn } = prosaModel(settings, apiKey);
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM_PROMPT, model, tools: buildTools(session, state) },
    streamFn,
    toolExecution: "sequential",
    finishTurn: () => (++stats.turns >= maxTurns ? { action: "end" } : undefined),
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      stats.toolCalls++;
      const args = event.args as Record<string, unknown>;
      log(`  ${event.toolName}${typeof args.path === "string" ? " " + args.path : ""}`);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message as AssistantMessage;
      stats.inputTokens += message.usage.input;
      stats.outputTokens += message.usage.output;
      if (message.responseModel && message.responseModel !== settings.model) state.wrongModel = message.responseModel;
    }
  });
  const deadline = setTimeout(() => agent.abort(), timeoutMs);
  try {
    let prompt = buildUserMessage(session);
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      state.result = undefined;
      await agent.prompt(prompt);
      const last = agent.state.messages.at(-1);
      const assistant = [...agent.state.messages].reverse().find((m) => m.role === "assistant") as AssistantMessage | undefined;
      if (state.wrongModel) throw new Error(`compiler answered with model ${state.wrongModel} instead of ${settings.model}`);
      if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
        throw new Error(`compiler request failed: ${assistant.errorMessage ?? assistant.stopReason}`);
      }
      if (state.questions) throw new QuestionsError(state.questions);
      if (!state.result) {
        const reason = stats.turns >= maxTurns ? `turn budget of ${maxTurns} exhausted` : `ended without calling done (last message role ${last?.role})`;
        throw new Error(`compiler ${reason}`);
      }
      const failure = session.validate(state.result);
      if (!failure) return { result: state.result, stats };
      log(`validation failed (round ${round}/${MAX_ROUNDS}): ${failure.split("\n")[0]}`);
      if (round === MAX_ROUNDS) throw new Error(`validation failed after ${MAX_ROUNDS} rounds:\n${failure}`);
      prompt = `The harness validated your submission and found problems. Fix them with the tools and call done again:\n${failure}`;
    }
    throw new Error("unreachable");
  } finally {
    clearTimeout(deadline);
  }
}
