# Prosa

Prosa compiles German prose into a TypeScript program, freezes the generated artifact with content hashes, and runs it. The compiler is an LLM; the harness owns every file write, hash, validation and acceptance decision. A frozen build is reused byte-for-byte without a model request until its inputs change.

## Requirements

- Node.js 24 or newer. Generated programs are `.ts` files that Node executes directly through type stripping, so they are limited to erasable TypeScript syntax (no enums, namespaces, parameter properties or decorators). The type check enforces this before a build is published.
- `npm install` in this repository (installs `typescript` for validation, `@types/node`, and the pi agent runtime for the compiler loop).
- Optional: `npm link` to get a global `prosa` command; otherwise use `node src/cli.ts`.

## Usage

```sh
prosa build ./example.prosa   # compile into .output/, or reuse the unchanged build
prosa install                 # only when the build declares external packages
prosa run -- 1 2 3            # execute .output/index.ts with forwarded arguments
```

The project root is the nearest ancestor of the current directory that contains `prosa.json`, otherwise the current directory. The build lives in `<root>/.output/`; the model never chooses output locations.

### Configuration

`prosa.json` in the project root (all fields optional):

| Field | Meaning |
| --- | --- |
| `model` | compiler model ID, default `gpt-4.1`; overridden by `PROSA_MODEL` |
| `baseUrl` | OpenAI-compatible base URL ending in `/v1`; overridden by `OPENAI_BASE_URL` |
| `apiKeyFile` | development option: JSON file whose `api_key` field holds the key, used only when `OPENAI_API_KEY` is unset |
| `packageManager` | `npm` (default) or `pnpm`, recorded at build time |
| `choices` | accepted answers to compiler questions, sent with every compilation |
| `maxTokens` | completion limit, default 8192 |

The key is read inside the compiler process, never logged, never written to the manifest, never sent to the model, and stripped from the generated program's environment together with every other `OPENAI_*` and `PROSA_*` variable.

### What `build` does

1. Hashes the source, the accepted choices, the versioned compiler prompt, the harness version, the model, the generation options and the runtime contract. These are the build inputs.
2. Reads `.output/prosa.manifest.json` if present and verifies every recorded file hash. Modified, missing or unexpected files are an error; `prosa build --force <file>` regenerates. Manual edits are never adopted silently.
3. If the inputs and the output are unchanged, the build is reused: no model request, no rewritten bytes, no touched timestamps.
4. Otherwise it runs the compiler as a bounded tool loop (`@earendil-works/pi-agent-core` with `@earendil-works/pi-ai` as transport to any OpenAI-compatible endpoint). The model only has these tools, all executed and checked by the harness inside a staging directory next to `.output`:

   | Tool | Effect |
   | --- | --- |
   | `write_file` | writes one relative `.ts` file; unsafe paths are rejected |
   | `read_previous` | reads a file of the previous validated build |
   | `typecheck` | `tsc --strict` over the staging directory |
   | `run` | executes `index.ts` in a fresh empty temp directory with a filtered environment and a timeout; `before` runs earlier invocations first |
   | `ask` | stops with questions for the author |
   | `done` | submits dependencies, the checks for the examples stated in the prose, and a note |

   After `done` the harness itself writes the `package.json`, hashes everything the model wrote, type-checks and runs the checks. A failure is fed back once (two rounds total); the turn budget is `PROSA_MAX_TURNS` (default 40) and the wall-clock limit `PROSA_TIMEOUT_MS` (default 600000). Only a validated staging directory is swapped in; any failure leaves the previous `.output` untouched.
5. Open questions from the compiler abort the build and are printed; answer them in the prose or under `choices`.

What validation establishes: all written paths are safe, the program type-checks under Node ESM resolution, and the examples the prose states pass, each in a fresh empty directory. A hash proves byte identity, so reuse re-establishes exactly that state and nothing more; it does not prove semantic correctness beyond the stated examples, and a fresh compilation of the same prose is not guaranteed to produce identical code. The manifest records turns, tool calls and token usage of the compiler run as provenance only; they are not compared.

### Dependencies and `install`

A build with external packages gets a harness-owned `package.json` and the state `awaiting-install`; `run` refuses it with the corrective command. `prosa install` verifies the output hashes, runs `npm install` or `pnpm install` as an argument array inside `.output`, propagates its output and exit status, then type-checks, runs the checks, records the lockfile hash and marks the build `validated`. Dependency-free builds need no install step. A regenerated build drops `node_modules`; run `prosa install` again.

### `run`

`prosa run` requires a manifest in state `validated`, an unchanged source and configuration, and intact output hashes; otherwise it fails with the reason. It never calls the compiler. The program runs as `node .output/index.ts <args>` with the invoking directory as working directory (relative imports resolve from the module files, data files land where the user is) and inherited stdin, stdout and stderr; the exit code and termination signals are forwarded.

## Examples

- [examples/addiere](examples/addiere/addiere.prosa): the addition fixture with explicit semantics (zero counts, no arguments sum to 0, invalid arguments exit with code 2 and a message on stderr, output `Hallo Welt: <sum>`). Compiles into `addiere.ts` and `index.ts`.
- [examples/farbe](examples/farbe/farbe.prosa): a greeting that colors the name with the npm package `picocolors`, demonstrating the explicit install flow.
- [examples/zeit](examples/zeit/zeit.prosa): a time tracker with `start`, `stop` and `bericht` subcommands and a `zeit.json` data file, written like a small specification (glossary, chapters, decisions, examples with preceding calls). Compiles into nine modules.

```sh
cd examples/addiere
prosa build addiere.prosa && prosa run -- 1 2 3     # Hallo Welt: 6
cd ../farbe
prosa build farbe.prosa && prosa install && prosa run -- Prosa
```

## Development

```sh
npm test                                   # node:test suite with a local fake compiler server
node node_modules/typescript/bin/tsc -p tsconfig.json
```

## Experiments

- [Astra compiler experiment](experiments/2026-10-03-astra-compiler/README.md): German and English inputs, runtime observations and frozen-artifact verification with `gpt-6-astra`.
- [Luna comparison run](experiments/2026-10-02-english-compiler/README.md): the resumed experiment from the original Claude Code session.
