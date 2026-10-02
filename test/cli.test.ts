import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

interface FakeLlm {
  server: Server;
  url: string;
  requests: number;
  queue: string[];
}

const fake: FakeLlm = { server: createServer(), url: "", requests: 0, queue: [] };

function reply(content: string, model = "fake-model"): string {
  return JSON.stringify({ model, choices: [{ message: { content }, finish_reason: "stop" }] });
}

function program(files: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ files: Object.entries(files).map(([path, content]) => ({ path, content })), entry: "index.ts", dependencies: {}, checks: [], questions: [], notes: "", ...extra });
}

const ADD_PROGRAM = program({
  "addiere.ts": 'export function addiere(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0);\n}\n',
  "index.ts": 'import { addiere } from "./addiere.ts";\nconst args = process.argv.slice(2);\nif (args.some((a) => !/^[0-9]+$/.test(a))) {\n  console.error("invalid");\n  process.exit(2);\n}\nconsole.log(`Hallo Welt: ${addiere(args.map(Number))}`);\nconsole.log(`key:${process.env.OPENAI_API_KEY ?? "absent"}`);\n',
}, { checks: [{ args: ["1", "2"], stdout: "Hallo Welt: 3\nkey:absent\n", exitCode: 0 }] });

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
        res.writeHead(500).end("no canned response");
        return;
      }
      res.setHeader("content-type", "application/json").end(next);
    });
  });
  await new Promise<void>((done) => fake.server.listen(0, "127.0.0.1", done));
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
function prosa(...args: string[]): Promise<Result> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: "test-key", PROSA_SECRET: "hidden" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

function out(path: string): string {
  return join(project, ".output", path);
}

describe("prosa build", () => {
  test("compiles, then reuses the unchanged build without a request", async () => {
    fake.queue.push(reply(ADD_PROGRAM));
    const first = await prosa("build", "add.prosa");
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /built \.output: 4 files, 1 checks, state validated/);
    assert.equal(fake.requests, 1);
    const bytes = readFileSync(out("index.ts"));
    const mtime = statSync(out("index.ts")).mtimeMs;

    const second = await prosa("build", "add.prosa");
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /reused \.output: 4 files unchanged, state validated, no compiler request/);
    assert.equal(fake.requests, 1);
    assert.deepEqual(readFileSync(out("index.ts")), bytes);
    assert.equal(statSync(out("index.ts")).mtimeMs, mtime);
  });

  test("detects modified, deleted and unexpected output files; --force regenerates", async () => {
    fake.queue.push(reply(ADD_PROGRAM));
    assert.equal((await prosa("build", "add.prosa")).status, 0);

    writeFileSync(out("addiere.ts"), "export const addiere = () => 0;\n");
    const modified = await prosa("build", "add.prosa");
    assert.equal(modified.status, 1);
    assert.match(modified.stderr, /modified: addiere\.ts/);
    assert.equal(fake.requests, 1);

    rmSync(out("addiere.ts"));
    writeFileSync(out("extra.ts"), "export {};\n");
    const broken = await prosa("build", "add.prosa");
    assert.match(broken.stderr, /missing: addiere\.ts/);
    assert.match(broken.stderr, /unexpected: extra\.ts/);
    assert.equal((await prosa("run")).status, 1);

    fake.queue.push(reply(ADD_PROGRAM));
    const forced = await prosa("build", "--force", "add.prosa");
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fake.requests, 2);
    assert.ok(!existsSync(out("extra.ts")));
    assert.equal((await prosa("build", "add.prosa")).status, 0);
    assert.equal(fake.requests, 2);
  });

  test("source and configuration changes invalidate reuse", async () => {
    fake.queue.push(reply(ADD_PROGRAM), reply(ADD_PROGRAM), reply(ADD_PROGRAM));
    assert.equal((await prosa("build", "add.prosa")).status, 0);
    writeFileSync(join(project, "add.prosa"), "Addiere alle Argumente, auch negative.\n");
    assert.equal((await prosa("run", "1")).status, 1, "stale build must not run");
    assert.equal((await prosa("build", "add.prosa")).status, 0);
    assert.equal(fake.requests, 2);
    writeFileSync(join(project, "prosa.json"), JSON.stringify({ model: "fake-model", baseUrl: fake.url, choices: { zero: "counts" } }));
    assert.equal((await prosa("build", "add.prosa")).status, 0);
    assert.equal(fake.requests, 3);
  });

  test("invalid responses leave the previous build intact and are bounded to two attempts", async () => {
    fake.queue.push(reply(ADD_PROGRAM));
    assert.equal((await prosa("build", "add.prosa")).status, 0);
    const before = readFileSync(out("prosa.manifest.json"), "utf8");
    writeFileSync(join(project, "add.prosa"), "changed\n");

    fake.queue.push(reply("not json at all"), reply(program({ "../escape.ts": "export {};", "index.ts": "export {};" })));
    const bad = await prosa("build", "add.prosa");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not JSON/);
    assert.match(bad.stderr, /not a safe relative/);
    assert.match(bad.stderr, /previous \.output is unchanged/);
    assert.equal(fake.requests, 3);
    assert.equal(readFileSync(out("prosa.manifest.json"), "utf8"), before);

    fake.queue.push(reply(program({ "index.ts": "const n: number = 'x';\n" })), reply(program({ "index.ts": "enum E { A }\nconsole.log(E.A);\n" })));
    const typeError = await prosa("build", "add.prosa");
    assert.equal(typeError.status, 1);
    assert.match(typeError.stderr, /type check failed/);
    assert.match(typeError.stderr, /erasable/i);
    assert.equal(readFileSync(out("prosa.manifest.json"), "utf8"), before);

    fake.queue.push(reply(program({ "index.ts": 'console.log("x");\n' }, { checks: [{ args: [], stdout: "y\n", exitCode: 0 }] })), reply(ADD_PROGRAM, "other-model"));
    const checkFail = await prosa("build", "add.prosa");
    assert.equal(checkFail.status, 1);
    assert.match(checkFail.stderr, /behavioral checks failed/);
    assert.match(checkFail.stderr, /other-model instead of fake-model/);
    assert.equal(readFileSync(out("prosa.manifest.json"), "utf8"), before);
    assert.ok(!existsSync(join(project, `.output.staging-${process.pid}`)));
  });

  test("open questions reject the build and name them", async () => {
    fake.queue.push(reply(program({ "index.ts": "export {};\n" }, { questions: ["Does zero count?"] })));
    const result = await prosa("build", "add.prosa");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Does zero count\?/);
    assert.ok(!existsSync(out("prosa.manifest.json")));
  });
});

describe("prosa run", () => {
  test("forwards arguments, exit codes and a filtered environment", async () => {
    fake.queue.push(reply(ADD_PROGRAM));
    assert.equal((await prosa("build", "add.prosa")).status, 0);
    const ok = await prosa("run", "--", "1", "2", "3");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, "Hallo Welt: 6\nkey:absent\n");
    const bad = await prosa("run", "--", "1", "x");
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /invalid/);
    assert.equal((await prosa("run", "--", "--force")).stdout, "");
  });
});

describe("prosa install", () => {
  test("a dependency build awaits install, run refuses, install needs the package manager", async () => {
    fake.queue.push(reply(program({ "index.ts": 'import pc from "picocolors";\nconsole.log(pc.red("x"));\n' }, { dependencies: { picocolors: "^1.1.1" } })));
    const built = await prosa("build", "add.prosa");
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /state awaiting-install/);
    assert.deepEqual(JSON.parse(readFileSync(out("package.json"), "utf8")).dependencies, { picocolors: "^1.1.1" });
    const refused = await prosa("run");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /run `prosa install` first/);

    writeFileSync(out("pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const conflict = await prosa("install");
    assert.match(conflict.stderr, /unexpected: pnpm-lock\.yaml/);
  });

  test("a dependency-free build reports nothing to install", async () => {
    fake.queue.push(reply(ADD_PROGRAM));
    assert.equal((await prosa("build", "add.prosa")).status, 0);
    assert.match((await prosa("install")).stdout, /nothing to install/);
  });
});
