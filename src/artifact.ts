import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Check, GeneratedFile } from "./compiler.ts";

export const MANIFEST_FILE = "prosa.manifest.json";
export const LOCKFILES: Record<string, "npm" | "pnpm"> = { "package-lock.json": "npm", "pnpm-lock.yaml": "pnpm" };
export const RUNTIME = { node: ">=24", execution: "node runs index.ts directly (type stripping, erasable syntax only)" };

const require = createRequire(import.meta.url);
export const HARNESS_VERSION: string = require("../package.json").version;
const TSC = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const TYPE_ROOTS = join(dirname(require.resolve("@types/node/package.json")), "..");

export interface BuildInputs {
  source: { path: string; sha256: string };
  choicesSha256: string;
  promptVersion: number;
  promptSha256: string;
  harnessVersion: string;
  model: string;
  options: { maxTokens: number };
  runtime: typeof RUNTIME;
}

export type BuildState = "validated" | "awaiting-install";

export interface Manifest {
  manifestVersion: 1;
  inputs: BuildInputs;
  entry: string;
  /** sha256 per generated file and the harness-owned package.json; never node_modules or this manifest. */
  files: Record<string, string>;
  dependencies: Record<string, string>;
  packageManager: "npm" | "pnpm";
  lock: { file: string; sha256: string } | null;
  checks: Check[];
  state: BuildState;
  compiledAt: string;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable JSON: object keys sorted recursively, so equal inputs always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function readManifest(outDir: string): Manifest | null {
  const file = join(outDir, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); rebuild with --force`);
  }
  const m = raw as Partial<Manifest>;
  const valid = m?.manifestVersion === 1 && typeof m.inputs === "object" && typeof m.files === "object" && typeof m.entry === "string"
    && (m.state === "validated" || m.state === "awaiting-install") && (m.packageManager === "npm" || m.packageManager === "pnpm")
    && Array.isArray(m.checks) && typeof m.dependencies === "object";
  if (!valid) throw new Error(`${file} has an unexpected shape; rebuild with --force`);
  return m as Manifest;
}

export function writeManifest(outDir: string, manifest: Manifest): void {
  writeFileSync(join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === MANIFEST_FILE) continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel + "/"));
    else out.push(rel);
  }
  return out;
}

/** Byte-level integrity of a build directory against its manifest. Empty result means intact. */
export function verifyOutput(outDir: string, manifest: Manifest): string[] {
  const problems: string[] = [];
  for (const [path, expected] of Object.entries(manifest.files)) {
    const full = join(outDir, path);
    if (!existsSync(full)) problems.push(`missing: ${path}`);
    else if (sha256(readFileSync(full)) !== expected) problems.push(`modified: ${path}`);
  }
  const known = new Set(Object.keys(manifest.files));
  for (const path of listFiles(outDir)) {
    if (known.has(path)) continue;
    if (manifest.lock && path === manifest.lock.file) {
      if (sha256(readFileSync(join(outDir, path))) !== manifest.lock.sha256) problems.push(`modified: ${path}`);
      continue;
    }
    problems.push(`unexpected: ${path}`);
  }
  if (manifest.lock && !existsSync(join(outDir, manifest.lock.file))) problems.push(`missing: ${manifest.lock.file}`);
  return problems;
}

export function hashFiles(outDir: string, paths: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) files[path] = sha256(readFileSync(join(outDir, path)));
  return files;
}

export function readGeneratedFiles(outDir: string, manifest: Manifest): GeneratedFile[] {
  return Object.keys(manifest.files)
    .filter((path) => path.endsWith(".ts"))
    .map((path) => ({ path, content: readFileSync(join(outDir, path), "utf8") }));
}

export const TSCONFIG = {
  compilerOptions: {
    strict: true, noEmit: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022",
    erasableSyntaxOnly: true, allowImportingTsExtensions: true, skipLibCheck: true, types: ["node"], typeRoots: [TYPE_ROOTS],
  },
  include: ["**/*.ts"],
  exclude: ["node_modules"],
};

/** Strict type check of the whole generated program via its harness-owned tsconfig.json; packages resolve from outDir/node_modules. */
export function typecheck(outDir: string): string | null {
  const result = spawnSync(process.execPath, [TSC, "-p", join(outDir, "tsconfig.json")], { cwd: outDir, encoding: "utf8" });
  if (result.error) throw new Error(`tsc could not start: ${result.error.message}`);
  if (result.status === 0) return null;
  return (result.stdout + result.stderr).trim() || `tsc exited with status ${result.status}`;
}

/** Runs the examples the prose stated against the generated entry point. */
export function runChecks(outDir: string, entry: string, checks: Check[]): string | null {
  const failures: string[] = [];
  for (const check of checks) {
    const result = spawnSync(process.execPath, [entry, ...check.args], { cwd: outDir, encoding: "utf8", env: programEnv(), timeout: 30_000 });
    const label = `args ${JSON.stringify(check.args)}`;
    if (result.error) failures.push(`${label}: ${result.error.message}`);
    else if (result.status !== check.exitCode) failures.push(`${label}: exit ${result.status}, expected ${check.exitCode}; stderr: ${result.stderr.trim()}`);
    else if (result.stdout.trimEnd() !== check.stdout.trimEnd()) failures.push(`${label}: stdout ${JSON.stringify(result.stdout)}, expected ${JSON.stringify(check.stdout)}`);
  }
  return failures.length === 0 ? null : failures.join("\n");
}

/** Environment for generated programs: compiler-only variables never reach them. */
export function programEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OPENAI_") || key.startsWith("PROSA_")) continue;
    env[key] = value;
  }
  return env;
}
