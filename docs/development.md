# Development

## Dependencies

Runtime dependencies:

- `handlebars@^4.7.10` — template compilation and rendering.
- `picomatch@^4.0.7` — glob allowlists.

Optional peer dependencies:

- `@opencode/plugin@^2.3.2` — provided by OpenCode at runtime.
- `effect@^4.0.6` — provided by OpenCode; used for target input validation.

Dev dependencies add Bun/Node types, `effect`, Oxlint, Prettier, and TypeScript.
There is no build step; OpenCode loads `src/index.ts` directly.

## Source layout

`src/index.ts` is the composition root. It resolves configuration, creates the
path and render services, registers the tools and the bundled skill, and returns
the cleanup function.

| Module           | Owns                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `index.ts`       | Plugin definition, capability guards, composition, cleanup               |
| `config.ts`      | Options, defaults, normalization, limits                                 |
| `errors.ts`      | `Tool.Error` helper and the OpenCode capability message                  |
| `record.ts`      | Prototype-safe record helpers: `isRecord`, `isPlainRecord`, null records |
| `bytes.ts`       | UTF-8 byte counts and shared byte-limit errors                           |
| `paths.ts`       | Allowlists, realpath, read/write permissions, file I/O                   |
| `permissions.ts` | Permission assertion dedupe and invocation metadata                      |
| `render.ts`      | Handlebars environment, helpers, strict rendering, render errors         |
| `chain.ts`       | Template objects, `$params`, `$type`, `$parts`, args rendering           |
| `dispatch.ts`    | Target lookup, allow/deny, validation, execution, output formatting      |
| `validation.ts`  | Effect Schema, Standard Schema, and JSON Schema target validation        |
| `build.ts`       | `template_build` text/file modes and output metadata                     |
| `output.ts`      | `allowedOutputFormats` strategy and output schema selection              |
| `skill.ts`       | Bundled `SKILL.md` parsing and registration                              |
| `text.ts`        | Clipping and length helpers                                              |
| `tool-name.ts`   | Tool name normalization, validation, namespace prefixing                 |
| `tools/names.ts` | Tool name constants                                                      |
| `tools/index.ts` | Tool registration and namespace description                              |
| `tools/call.ts`  | `template_call` input/output schemas and execution                       |
| `tools/build.ts` | `template_build` input/output schemas and execution                      |

`SKILL.md` sits at the package root, beside `src/`; `skill.ts` resolves it with
`new URL("../SKILL.md", import.meta.url)`.

## Tests

Tests mix public `setup`/tool calls with focused unit tests:

- `config.test.ts` — defaults, normalization, invalid options, limits.
- `paths.test.ts` — glob matching, dotfiles, external patterns, symlinks,
  hard links, non-regular files, permissions, dedupe, abort.
- `render.test.ts` — strict mode, helpers, arity, collisions, prototype access,
  partials.
- `chain.test.ts` — template objects, params, chains, separators, types,
  whole-args, JSON strings, reserved keys.
- `call.test.ts` — target lookup, allow/deny, permissions, validation, formats,
  renderOnly, errors, metadata, abort.
- `build.test.ts` — text/file modes, path templating, overwrite, permissions,
  limits.
- `output.test.ts` — format strategy, output schemas, handler registry.
- `tool-name.test.ts` — name normalization, validation, namespace prefixing.
- `text.test.ts` — trim-before-clip behavior and blank handling.
- `skill.test.ts` — frontmatter parsing, registration, read and transform failures.
- `lifecycle.test.ts` — capability guards and independent disposal failures.
- `harness.test.ts` — harness lifecycle: single setup and scoped disposal.
- `schema.test.ts` — representative input/output schema validation.
- `schema-validator.test.ts` — coverage for the test schema validator.

`tests/harness.ts` builds the mocked plugin context and registers per-test
cleanup. `tests/temp.ts` provides isolated temporary directories. Some tests
call `setup` and the registered tools; others call modules such as
`resolveConfig`, `renderTemplate`, or the path helpers directly.

Test the packed package manually in a real OpenCode server. CI runs the
automated checks listed under [CI](#ci).

## Commands

```sh
bun install
bun run lint
bun run format
bun run format:check
bun run typecheck
bun test
bun run check
npm pack --dry-run
```

`bun run check` runs lint, format checking, typecheck, and the test suite.
`npm pack --dry-run` prints the tarball contents without writing a package.
`bun run format` rewrites files with Prettier. The Prettier config is
in `package.json`: semicolons, print width 90. Oxlint configuration is in
`.oxlintrc.json`.

Run the checks above before release.

Check Markdown links. Run the manual integration check below.

## Manual integration check

1. Install the packed package or point `plugins` at the checkout.
2. Run `opencode reload`.
3. Create a template file and call `template_call` with `subagent` and a file
   template. Confirm the child session receives the rendered prompt.
4. Call `template_build` in text mode and file mode. Confirm the output object
   and written file.
5. Check `read`/`edit` permission prompts and an external path with
   `external_directory`.
6. Check `format: "json"` and `renderOnly: true`.
7. Confirm `renderOnly: true` does not execute the target or trigger its permission prompt.
8. Confirm `allowedTools`/`deniedTools` and self-target denial.

## Verification

Use these checks to confirm a local or packed install:

- **Local checkout import.** From the repository:

  ```sh
  bun -e "import('./src/index.ts').then(m => console.log('IMPORT_OK id=' + m.default.id))"
  ```

  Expect `IMPORT_OK id=tool-templates`.

- **Packed package.** Follow [packed package](installation.md#packed-package),
  then point `plugins` at the extracted package directory and start OpenCode.
  Expect a `loading plugin` line for that directory. A standalone
  `bun -e "import('opencode-tool-templates')"` outside OpenCode fails with
  `Cannot find package '@opencode/plugin'`; OpenCode supplies that peer.

- **Manual copy.** Follow [manual installation](installation.md#manual-installation).
  Expect `handlebars` and `picomatch` to be installed and OpenCode to load the
  copied package.

- **CLI syntax.** `opencode plugin add --help` shows:

  ```text
  USAGE
    opencode plugin add [flags] <package>
  ```

  The command installs a package plugin into the global configuration and does
  not accept tarballs.

- **Full tool call.** Run the [manual integration check](#manual-integration-check)
  with a working model: `template_call` with `subagent` and a file template,
  then `template_build` in text and file modes.

## Package contents

`npm pack` includes `src/`, `SKILL.md`, `README.md`, `LICENSE`, `SECURITY.md`,
`CHANGELOG.md`, and the `docs/*.md` files. Tests, CI, and local configuration
stay in the repository. The `files` field in `package.json` defines the package
contents; `npm pack --dry-run` shows the resulting tarball.

## CI

`.github/workflows/ci.yml` runs on push and pull requests on `ubuntu-latest`:

- install with `bun install --frozen-lockfile`;
- `bun run check`;
- `npm pack --dry-run`.

The workflow uses read-only contents permission, a 15-minute timeout, and
cancels superseded runs on the same ref.

CI is Ubuntu-only. Windows-specific path tests run locally on Windows and are
not part of CI.
