import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

/** One scripted assistant turn: tool calls the fake model makes in that turn. */
interface Turn {
  calls: { name: string; args: unknown }[];
  model?: string;
}

const fake = { server: createServer(), url: "", requests: 0, queue: [] as Turn[] };

/** Serializes a turn as an OpenAI chat-completions SSE stream with tool calls. */
function sse(turn: Turn): string {
  const model = turn.model ?? "fake-model";
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model, choices, ...extra })}\n\n`;
  let body = chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
  turn.calls.forEach((call, index) => {
    const tool = { index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } };
    body += chunk([{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }]);
  });
  body += chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
  body += chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  return body + "data: [DONE]\n\n";
}

const write = (path: string, content: string) => ({ name: "write_file", args: { path, content } });
const done = (checks: unknown[] = [], dependencies: unknown[] = [], notes = "") => ({ name: "done", args: { dependencies, checks, notes } });

const ADD_FILES = {
  "addiere.ts": "export function addiere(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0);\n}\n",
  "index.ts": 'import { addiere } from "./addiere.ts";\nconst args = process.argv.slice(2);\nif (args.some((a) => !/^[0-9]+$/.test(a))) {\n  console.error("invalid");\n  process.exit(2);\n}\nconsole.log(`Hallo Welt: ${addiere(args.map(Number))}`);\nconsole.log(`key:${process.env.OPENAI_API_KEY ?? "absent"}`);\n',
};
/** Two turns: write both modules, then submit with one check. */
const ADD_TURNS: Turn[] = [
  { calls: Object.entries(ADD_FILES).map(([p, c]) => write(p, c)) },
  { calls: [done([{ args: ["1", "2"], stdout: "Hallo Welt: 3\nkey:absent\n", exitCode: 0 }])] },
];

before(async () => {
  fake.server.on("request", (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      fake.requests++;
      assert.equal(req.headers.authorization, "Bearer test-key");
      assert.doesNotMatch(body, /test-key/);
      const next = fake.queue.shift();
      if (!next) {
        res.writeHead(500).end("no scripted turn left");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(next));
    });
  });
  await new Promise<void>((ready) => fake.server.listen(0, "127.0.0.1", ready));
  const address = fake.server.address();
  fake.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
});
after(() => fake.server.close());

let project = "";
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "prosa-test-"));
  writeFileSync(join(project, "prosa.json"), JSON.stringify({ model: "fake-model", baseUrl: fake.url }));
  writeFileSync(join(project, "add.prosa"), "Addiere alle Argumente.\n");
  fake.queue = [];
  fake.requests = 0;
});

interface Result { status: number | null; stdout: string; stderr: string }

/** Async so the in-process fake server can answer while the CLI runs. */
function prosa(args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: "test-key", PROSA_SECRET: "hidden", ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => settle({ status, stdout, stderr }));
  });
}

const out = (path: string) => join(project, ".output", path);

describe("prosa build", () => {
  test("compiles through the tool loop, then reuses the unchanged build without a request", async () => {
    fake.queue.push(...ADD_TURNS);
    const first = await prosa(["build", "add.prosa"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /built \.output: 4 files, 1 checks, state validated \(2 turns, 3 tool calls/);
    assert.equal(fake.requests, 2);
    const bytes = readFileSync(out("index.ts"));
    const mtime = statSync(out("index.ts")).mtimeMs;

    const second = await prosa(["build", "add.prosa"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /reused \.output: 4 files unchanged, state validated, no compiler request/);
    assert.equal(fake.requests, 2);
    assert.deepEqual(readFileSync(out("index.ts")), bytes);
    assert.equal(statSync(out("index.ts")).mtimeMs, mtime);
  });

  test("detects modified, deleted and unexpected output files; --force regenerates", async () => {
    fake.queue.push(...ADD_TURNS);
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);

    writeFileSync(out("addiere.ts"), "export const addiere = () => 0;\n");
    const modified = await prosa(["build", "add.prosa"]);
    assert.equal(modified.status, 1);
    assert.match(modified.stderr, /modified: addiere\.ts/);
    assert.equal(fake.requests, 2);

    rmSync(out("addiere.ts"));
    writeFileSync(out("extra.ts"), "export {};\n");
    const broken = await prosa(["build", "add.prosa"]);
    assert.match(broken.stderr, /missing: addiere\.ts/);
    assert.match(broken.stderr, /unexpected: extra\.ts/);
    assert.equal((await prosa(["run"])).status, 1);

    fake.queue.push(...ADD_TURNS);
    const forced = await prosa(["build", "--force", "add.prosa"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fake.requests, 4);
    assert.ok(!existsSync(out("extra.ts")));
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);
    assert.equal(fake.requests, 4);
  });

  test("source and configuration changes invalidate reuse", async () => {
    fake.queue.push(...ADD_TURNS, ...ADD_TURNS, ...ADD_TURNS);
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);
    writeFileSync(join(project, "add.prosa"), "Addiere alle Argumente, auch negative.\n");
    assert.equal((await prosa(["run", "1"])).status, 1, "stale build must not run");
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);
    assert.equal(fake.requests, 4);
    writeFileSync(join(project, "prosa.json"), JSON.stringify({ model: "fake-model", baseUrl: fake.url, choices: { zero: "counts" } }));
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);
    assert.equal(fake.requests, 6);
  });

  test("rejected tools, failed validation, budget and model substitution leave the previous build intact", async () => {
    fake.queue.push(...ADD_TURNS);
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);
    const before = readFileSync(out("prosa.manifest.json"), "utf8");
    writeFileSync(join(project, "add.prosa"), "changed\n");

    fake.queue.push({ calls: [write("../escape.ts", "export {};"), write("/abs.ts", "export {};")] }, { calls: [done()] });
    const unsafe = await prosa(["build", "add.prosa"]);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /finished without writing index\.ts/);
    assert.match(unsafe.stderr, /previous \.output is unchanged/);
    assert.equal(fake.requests, 4);
    assert.equal(readFileSync(out("prosa.manifest.json"), "utf8"), before);

    fake.queue.push(
      { calls: [write("index.ts", "const n: number = 'x';\n")] }, { calls: [done()] },
      { calls: [write("index.ts", "enum E { A }\nconsole.log(E.A);\n")] }, { calls: [done()] },
    );
    const typeError = await prosa(["build", "add.prosa"]);
    assert.equal(typeError.status, 1);
    assert.match(typeError.stdout, /validation failed \(round 1\/2\): type check failed/);
    assert.match(typeError.stderr, /validation failed after 2 rounds/);
    assert.match(typeError.stderr, /erasable/i);
    assert.equal(fake.requests, 8);
    assert.equal(readFileSync(out("prosa.manifest.json"), "utf8"), before);

    fake.queue.push(
      { calls: [write("index.ts", 'console.log("x");\n')] }, { calls: [done([{ args: [], stdout: "y\n", exitCode: 0 }])] },
      { calls: [done()], model: "other-model" },
    );
    const checkFail = await prosa(["build", "add.prosa"]);
    assert.equal(checkFail.status, 1);
    assert.match(checkFail.stdout, /behavioral checks failed/);
    assert.match(checkFail.stderr, /other-model instead of fake-model/);
    assert.equal(readFileSync(out("prosa.manifest.json"), "utf8"), before);

    fake.queue.push(...ADD_TURNS);
    const budget = await prosa(["build", "add.prosa"], { PROSA_MAX_TURNS: "1" });
    assert.equal(budget.status, 1);
    assert.match(budget.stderr, /turn budget of 1 exhausted/);
    assert.equal(readFileSync(out("prosa.manifest.json"), "utf8"), before);
    assert.ok(!existsSync(join(project, `.output.staging-${process.pid}`)));
  });

  test("open questions reject the build and name them", async () => {
    fake.queue.push({ calls: [{ name: "ask", args: { questions: ["Does zero count?"] } }] });
    const result = await prosa(["build", "add.prosa"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Does zero count\?/);
    assert.ok(!existsSync(out("prosa.manifest.json")));
  });
});

describe("prosa run", () => {
  test("forwards arguments, exit codes and a filtered environment", async () => {
    fake.queue.push(...ADD_TURNS);
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);
    const ok = await prosa(["run", "--", "1", "2", "3"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, "Hallo Welt: 6\nkey:absent\n");
    const bad = await prosa(["run", "--", "1", "x"]);
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /invalid/);
    assert.equal((await prosa(["run", "--", "--force"])).stdout, "");
  });
});

describe("prosa install", () => {
  test("a dependency build awaits install and run refuses", async () => {
    fake.queue.push(
      { calls: [write("index.ts", 'import pc from "picocolors";\nconsole.log(pc.red("x"));\n')] },
      { calls: [done([], [{ name: "picocolors", version: "^1.1.1" }])] },
    );
    const built = await prosa(["build", "add.prosa"]);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /state awaiting-install/);
    assert.deepEqual(JSON.parse(readFileSync(out("package.json"), "utf8")).dependencies, { picocolors: "^1.1.1" });
    const refused = await prosa(["run"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /run `prosa install` first/);

    writeFileSync(out("pnpm-lock.yaml"), "lockfileVersion: 9\n");
    assert.match((await prosa(["install"])).stderr, /unexpected: pnpm-lock\.yaml/);
  });

  test("a dependency-free build reports nothing to install", async () => {
    fake.queue.push(...ADD_TURNS);
    assert.equal((await prosa(["build", "add.prosa"])).status, 0);
    assert.match((await prosa(["install"])).stdout, /nothing to install/);
  });
});
