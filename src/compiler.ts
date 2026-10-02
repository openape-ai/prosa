import { createHash } from "node:crypto";
import type { ModelSettings } from "./config.ts";

export const PROMPT_VERSION = 1;

export const SYSTEM_PROMPT = `You are the Prosa compiler, prompt version ${PROMPT_VERSION}. A Prosa source file describes a program in natural language, usually German. Translate the prose into a complete TypeScript program.

Reply with exactly one JSON object and nothing else, no code fences, no commentary:
{"files":[{"path":"index.ts","content":"..."}],"entry":"index.ts","dependencies":{},"checks":[],"questions":[],"notes":""}

Rules for the generated program:
- Target: Node.js 24 executing .ts files directly through type stripping. Use ES modules. Relative imports must include the .ts extension, for example: import { addiere } from "./addiere.ts";
- Use only erasable TypeScript syntax: no enums, no namespaces, no parameter properties, no decorators, no "import x = require". Use "import type" for type-only imports.
- The code must pass "tsc --strict" with Node type definitions available. Never use "any".
- Prefer the Node standard library. Only when the prose requires an external package, list it in "dependencies" as {"name": "^version"} and import it normally.
- Put every function or component the prose names into its own module named after it. "index.ts" is the application entry point and must be present. Program arguments are process.argv.slice(2). Write to stdout with console.log or process.stdout.write; set the exit code with process.exitCode or process.exit.
- Paths are relative, use forward slashes, end in .ts, and contain no ".." segments.

Rules for the JSON fields:
- "checks": one entry {"args":[...],"stdout":"...","exitCode":0} per concrete example the prose literally states. "stdout" is the complete expected standard output. Do not invent examples.
- "questions": if the prose leaves a decision open that changes observable behavior and no accepted decision covers it, list concise questions here instead of guessing. A non-empty list rejects the build.
- "notes": one short sentence on noteworthy interpretation choices, or an empty string.`;

export const PROMPT_SHA256 = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface Check {
  args: string[];
  stdout: string;
  exitCode: number;
}

export interface CompilerResponse {
  files: GeneratedFile[];
  entry: "index.ts";
  dependencies: Record<string, string>;
  checks: Check[];
  questions: string[];
  notes: string;
}

export interface CompileRequest {
  sourceName: string;
  source: string;
  choices: Record<string, string>;
  previousFiles?: GeneratedFile[];
  /** Validation failure of the previous attempt, fed back for one bounded repair round. */
  repair?: string;
}

export const ENTRY = "index.ts";
export const RESERVED_FILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "prosa.manifest.json", "tsconfig.json"]);
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function isSafeOutputPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  if (segments[0] === "node_modules" || segments[0].startsWith(".")) return false;
  if (!path.endsWith(".ts") || RESERVED_FILES.has(path)) return false;
  return true;
}

function fail(message: string): never {
  throw new Error(`compiler response invalid: ${message}`);
}

export function parseCompilerResponse(text: string): CompilerResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    fail(`not JSON (${(error as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("not a JSON object");
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.files) || r.files.length === 0) fail('"files" must be a non-empty array');
  const seen = new Set<string>();
  const files: GeneratedFile[] = r.files.map((f: unknown, i: number) => {
    const file = f as { path?: unknown; content?: unknown };
    if (!isSafeOutputPath(file.path as string)) fail(`files[${i}].path is not a safe relative .ts path: ${JSON.stringify(file.path)}`);
    if (typeof file.content !== "string" || file.content.length === 0) fail(`files[${i}].content must be a non-empty string`);
    if (seen.has(file.path as string)) fail(`duplicate path ${file.path}`);
    seen.add(file.path as string);
    return { path: file.path as string, content: file.content };
  });
  if (r.entry !== ENTRY) fail(`"entry" must be "${ENTRY}"`);
  if (!seen.has(ENTRY)) fail(`"files" must contain ${ENTRY}`);

  const dependencies: Record<string, string> = {};
  if (r.dependencies !== undefined) {
    if (typeof r.dependencies !== "object" || r.dependencies === null || Array.isArray(r.dependencies)) fail('"dependencies" must be an object');
    for (const [name, range] of Object.entries(r.dependencies)) {
      if (!PACKAGE_NAME.test(name)) fail(`invalid dependency name ${JSON.stringify(name)}`);
      if (typeof range !== "string" || !/^[\w.^~<>=* -]+$/.test(range)) fail(`invalid version range for ${name}`);
      dependencies[name] = range;
    }
  }

  const checks: Check[] = [];
  if (r.checks !== undefined) {
    if (!Array.isArray(r.checks)) fail('"checks" must be an array');
    r.checks.forEach((c: unknown, i: number) => {
      const check = c as { args?: unknown; stdout?: unknown; exitCode?: unknown };
      if (!Array.isArray(check.args) || !check.args.every((a) => typeof a === "string")) fail(`checks[${i}].args must be a string array`);
      if (typeof check.stdout !== "string") fail(`checks[${i}].stdout must be a string`);
      if (!Number.isInteger(check.exitCode)) fail(`checks[${i}].exitCode must be an integer`);
      checks.push({ args: check.args as string[], stdout: check.stdout, exitCode: check.exitCode as number });
    });
  }

  const questions = r.questions === undefined ? [] : r.questions;
  if (!Array.isArray(questions) || !questions.every((q) => typeof q === "string")) fail('"questions" must be a string array');
  const notes = r.notes === undefined ? "" : r.notes;
  if (typeof notes !== "string") fail('"notes" must be a string');

  return { files, entry: ENTRY, dependencies, checks, questions, notes };
}

export function buildUserMessage(request: CompileRequest): string {
  const choices = Object.entries(request.choices);
  const parts = [
    `Source file: ${request.sourceName}`,
    "",
    "Accepted decisions:",
    choices.length === 0 ? "(none)" : choices.map(([k, v]) => `- ${k}: ${v}`).join("\n"),
  ];
  if (request.previousFiles?.length) {
    parts.push("", "Previous validated build of an older source version, for reference only. Return the complete new program:");
    for (const file of request.previousFiles) parts.push(`--- ${file.path} ---`, file.content);
  }
  if (request.repair) {
    parts.push("", `Your previous reply failed validation. Fix the problem and return the complete corrected JSON:`, request.repair);
  }
  parts.push("", "Source:", request.source);
  return parts.join("\n");
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** One non-streaming chat completion. The key lives only in the request header. */
export async function requestCompletion(settings: ModelSettings, apiKey: string, request: CompileRequest): Promise<string> {
  const timeoutMs = Number(process.env.PROSA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(request) },
        ],
        max_tokens: settings.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`compiler request to ${settings.baseUrl} failed: ${(error as Error).message}`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`compiler request failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  let data: { model?: string; choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`compiler returned non-JSON body: ${body.slice(0, 200)}`);
  }
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.length === 0) throw new Error("compiler returned no message content");
  if (choice?.finish_reason === "length") throw new Error(`compiler output truncated at ${settings.maxTokens} tokens; raise "maxTokens" in prosa.json`);
  if (data.model && data.model !== settings.model) throw new Error(`compiler answered with model ${data.model} instead of ${settings.model}`);
  return content;
}
