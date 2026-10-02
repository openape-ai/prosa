import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  HARNESS_VERSION, LOCKFILES, RUNTIME, TSCONFIG, canonicalJson, hashFiles, listFiles, programEnv, readGeneratedFiles, readManifest,
  runChecks, sha256, typecheck, verifyOutput, writeManifest, type BuildInputs, type Manifest,
} from "./artifact.ts";
import { ENTRY, PROMPT_SHA256, PROMPT_VERSION, compile, type CompileResult, type CompileSession, type GeneratedFile } from "./compiler.ts";
import { findProjectRoot, loadConfig, resolveApiKey, resolveModelSettings, type ProsaConfig } from "./config.ts";

export const OUTPUT_DIR = ".output";

interface Project {
  root: string;
  config: ProsaConfig;
  outDir: string;
}

function openProject(): Project {
  const root = findProjectRoot();
  return { root, config: loadConfig(root), outDir: join(root, OUTPUT_DIR) };
}

function computeInputs(project: Project, sourcePath: string): BuildInputs {
  const settings = resolveModelSettings(project.config);
  return {
    source: { path: relative(project.root, sourcePath), sha256: sha256(readFileSync(sourcePath)) },
    choicesSha256: sha256(canonicalJson(project.config.choices ?? {})),
    promptVersion: PROMPT_VERSION,
    promptSha256: PROMPT_SHA256,
    harnessVersion: HARNESS_VERSION,
    model: settings.model,
    options: { maxTokens: settings.maxTokens },
    runtime: RUNTIME,
  };
}

function integrityError(problems: string[], hint: string): Error {
  return new Error(`${OUTPUT_DIR} does not match its manifest:\n  ${problems.join("\n  ")}\n${hint}`);
}

export async function build(sourceArg: string, options: { force: boolean }): Promise<void> {
  const project = openProject();
  const sourcePath = resolve(sourceArg);
  if (!existsSync(sourcePath)) throw new Error(`source file not found: ${sourceArg}`);
  if (relative(project.root, sourcePath).startsWith("..")) throw new Error(`source ${sourceArg} lies outside the project root ${project.root}`);
  const inputs = computeInputs(project, sourcePath);

  const existing = readManifest(project.outDir);
  let previousFiles: GeneratedFile[] | undefined;
  if (existing) {
    const problems = verifyOutput(project.outDir, existing);
    if (problems.length > 0 && !options.force) {
      throw integrityError(problems, "Manual changes are not accepted. Run `prosa build --force <file>` to regenerate, or restore the files.");
    }
    if (problems.length === 0 && canonicalJson(existing.inputs) === canonicalJson(inputs) && !options.force) {
      console.log(`reused ${OUTPUT_DIR}: ${Object.keys(existing.files).length} files unchanged, state ${existing.state}, no compiler request`);
      if (existing.state === "awaiting-install") console.log("dependencies are not installed yet: run `prosa install`");
      return;
    }
    if (problems.length === 0 && existing.state === "validated") previousFiles = readGeneratedFiles(project.outDir, existing);
  }

  const settings = resolveModelSettings(project.config);
  const apiKey = resolveApiKey(project.config);
  const staging = `${project.outDir}.staging-${process.pid}`;
  const packageManager = project.config.packageManager ?? "npm";
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2) + "\n");

  let manifest: Manifest | undefined;
  const session: CompileSession = {
    sourceName: basename(sourcePath),
    source: readFileSync(sourcePath, "utf8"),
    choices: project.config.choices ?? {},
    previousFiles: previousFiles ?? [],
    staging,
    validate: (result) => {
      manifest = stageManifest(staging, result, inputs, packageManager);
      return manifest.state === "validated" ? validateStaged(staging, manifest) : null;
    },
  };

  try {
    console.log(`compiling ${session.sourceName} with ${settings.model}`);
    const { result, stats } = await compile(settings, apiKey, session, (line) => console.log(line));
    if (!manifest) throw new Error("unreachable: validated without manifest");
    manifest.compiler = stats;
    publish(staging, project.outDir, manifest);
    const fileCount = Object.keys(manifest.files).length;
    console.log(`built ${OUTPUT_DIR}: ${fileCount} files, ${result.checks.length} checks, state ${manifest.state} (${stats.turns} turns, ${stats.toolCalls} tool calls, ${stats.inputTokens + stats.outputTokens} tokens)`);
    if (result.notes) console.log(`compiler notes: ${result.notes}`);
    if (manifest.state === "awaiting-install") console.log(`external dependencies declared (${Object.keys(manifest.dependencies).join(", ")}): run \`prosa install\` before \`prosa run\``);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nThe previous ${OUTPUT_DIR} is unchanged.`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Harness-owned package.json plus hashes of everything the compiler actually wrote. */
function stageManifest(staging: string, result: CompileResult, inputs: BuildInputs, packageManager: "npm" | "pnpm"): Manifest {
  const packageJson = { name: "prosa-output", private: true, type: "module", dependencies: result.dependencies };
  writeFileSync(join(staging, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
  const files = listFiles(staging);
  const stray = files.filter((f) => !f.endsWith(".ts") && f !== "package.json" && f !== "tsconfig.json");
  if (stray.length > 0) throw new Error(`compiler left unexpected files: ${stray.join(", ")}`);
  if (!files.includes(ENTRY)) throw new Error(`compiler finished without writing ${ENTRY}`);
  const hasDependencies = Object.keys(result.dependencies).length > 0;
  return {
    manifestVersion: 1,
    inputs,
    entry: ENTRY,
    files: hashFiles(staging, files),
    dependencies: result.dependencies,
    packageManager,
    lock: null,
    checks: result.checks,
    state: hasDependencies ? "awaiting-install" : "validated",
    compiledAt: new Date().toISOString(),
  };
}

function validateStaged(dir: string, manifest: Manifest): string | null {
  const typeErrors = typecheck(dir);
  if (typeErrors) return `type check failed:\n${typeErrors}`;
  const checkFailures = runChecks(dir, manifest.entry, manifest.checks);
  if (checkFailures) return `behavioral checks failed:\n${checkFailures}`;
  return null;
}

/** Swap the validated staging directory in; the old build survives any failure before the rename. */
function publish(staging: string, outDir: string, manifest: Manifest): void {
  writeManifest(staging, manifest);
  const previous = `${outDir}.prev`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(outDir)) renameSync(outDir, previous);
  renameSync(staging, outDir);
  rmSync(previous, { recursive: true, force: true });
}

function openBuild(project: Project): Manifest {
  const manifest = readManifest(project.outDir);
  if (!manifest) throw new Error(`no build in ${OUTPUT_DIR}: run \`prosa build <file>\` first`);
  const problems = verifyOutput(project.outDir, manifest);
  if (problems.length > 0) throw integrityError(problems, "Run `prosa build --force <file>` to regenerate.");
  return manifest;
}

/** The lockfile the package manager left behind; foreign lockfiles were already rejected by the integrity check. */
function detectLockfile(outDir: string, pm: "npm" | "pnpm"): string | null {
  return Object.entries(LOCKFILES).find(([file, owner]) => owner === pm && existsSync(join(outDir, file)))?.[0] ?? null;
}

export function install(): void {
  const project = openProject();
  const manifest = openBuild(project);
  if (Object.keys(manifest.dependencies).length === 0) {
    console.log("no external dependencies declared; nothing to install");
    return;
  }
  const pm = manifest.packageManager;
  const version = spawnSync(pm, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) throw new Error(`package manager ${pm} is not available on PATH`);

  console.log(`running ${pm} install in ${OUTPUT_DIR} (${Object.keys(manifest.dependencies).join(", ")})`);
  const result = spawnSync(pm, ["install"], { cwd: project.outDir, stdio: "inherit", env: programEnv() });
  if (result.error) throw new Error(`${pm} install could not start: ${result.error.message}`);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${pm} install failed with status ${result.status}; build state stays ${manifest.state}`);
  }
  const producedLock = detectLockfile(project.outDir, pm);
  if (!producedLock) throw new Error(`${pm} install produced no lockfile; cannot record a reproducible dependency state`);

  const failure = validateStaged(project.outDir, manifest);
  if (failure) throw new Error(`installed dependencies, but validation failed; build state stays ${manifest.state}:\n${failure}`);
  manifest.lock = { file: producedLock, sha256: sha256(readFileSync(join(project.outDir, producedLock))) };
  manifest.state = "validated";
  writeManifest(project.outDir, manifest);
  console.log(`installed and validated: ${producedLock} recorded, state validated`);
}

export function run(args: string[]): void {
  const project = openProject();
  const manifest = openBuild(project);
  const sourcePath = join(project.root, manifest.inputs.source.path);
  if (!existsSync(sourcePath)) throw new Error(`source ${manifest.inputs.source.path} recorded in the build no longer exists`);
  const current = computeInputs(project, sourcePath);
  if (canonicalJson(current) !== canonicalJson(manifest.inputs)) {
    throw new Error(`build is stale: source or configuration changed since the last build. Run \`prosa build ${manifest.inputs.source.path}\``);
  }
  if (manifest.state !== "validated") throw new Error(`build is not validated (state ${manifest.state}): run \`prosa install\` first`);

  const child = spawn(process.execPath, [manifest.entry, ...args], { cwd: project.outDir, stdio: "inherit", env: programEnv() });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`prosa: could not start ${manifest.entry}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

