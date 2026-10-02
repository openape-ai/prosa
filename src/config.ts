import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ProsaConfig {
  model?: string;
  baseUrl?: string;
  /** Development option: JSON file whose `api_key` field holds the compiler API key. */
  apiKeyFile?: string;
  packageManager?: "npm" | "pnpm";
  /** Accepted answers to compiler questions, sent with every compilation. */
  choices?: Record<string, string>;
  maxTokens?: number;
}

export const CONFIG_FILE = "prosa.json";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4.1";
const DEFAULT_MAX_TOKENS = 8192;

/** Project root: nearest ancestor of `from` containing prosa.json, else `from` itself. */
export function findProjectRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

export function loadConfig(root: string): ProsaConfig {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return {};
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object`);
  const config = raw as Record<string, unknown>;
  for (const key of ["model", "baseUrl", "apiKeyFile"]) {
    if (config[key] !== undefined && typeof config[key] !== "string") throw new Error(`${file}: "${key}" must be a string`);
  }
  if (config.packageManager !== undefined && config.packageManager !== "npm" && config.packageManager !== "pnpm") {
    throw new Error(`${file}: "packageManager" must be "npm" or "pnpm"`);
  }
  if (config.maxTokens !== undefined && !Number.isInteger(config.maxTokens)) throw new Error(`${file}: "maxTokens" must be an integer`);
  if (config.choices !== undefined) {
    const choices = config.choices;
    const valid = typeof choices === "object" && choices !== null && Object.values(choices).every((v) => typeof v === "string");
    if (!valid) throw new Error(`${file}: "choices" must map question keys to string answers`);
  }
  return config as ProsaConfig;
}

export interface ModelSettings {
  baseUrl: string;
  model: string;
  maxTokens: number;
}

/** Everything that identifies a compilation except the credential; safe to record in the manifest. */
export function resolveModelSettings(config: ProsaConfig): ModelSettings {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL ?? config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: process.env.PROSA_MODEL ?? config.model ?? DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/** Resolved only when a compilation is actually needed; never logged or recorded. */
export function resolveApiKey(config: ProsaConfig): string {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv) return fromEnv;
  if (!config.apiKeyFile) throw new Error("no compiler API key: set OPENAI_API_KEY or \"apiKeyFile\" in prosa.json");
  const file = config.apiKeyFile.replace(/^~(?=\/|$)/, homedir());
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`apiKeyFile ${file}: ${(error as Error).message}`);
  }
  const key = (parsed as { api_key?: unknown })?.api_key;
  if (typeof key !== "string" || key.length === 0) throw new Error(`apiKeyFile ${file}: missing non-empty "api_key" field`);
  return key;
}
