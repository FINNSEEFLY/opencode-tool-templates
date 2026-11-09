# Limitations

Read this before relying on the plugin for large prompts or generated files. The
tool contracts are in [reference](reference.md); this page covers what can go
wrong and what to do about it.

## Target calls

- **Target hooks are bypassed.** The nested call does not run the target's
  `execute.before`/`execute.after` hooks. Target permission checks still run
  inside the target executor. See
  [target permissions](security-model.md#target-permissions).
- **`ctx.tool.list()` is not permission-filtered.** `allowedTools` is the only
  filter; keep it narrow.
- **`template_call` does not pre-check target permissions.** The target's own
  executor checks them with the actual resource. A target that does not check
  permissions itself is not protected by the plugin; keep `allowedTools` narrow.
- **`renderOnly` does not check target permissions.** It does not execute the
  target, so target permission is checked only on a real call. File template
  reads still check `read`.
- **Target output is not schema-encoded.** The plugin passes the target's
  content and output through without validating or encoding them with the target
  output schema.
- **Invalid target results are rejected.** A primitive, `null`/`undefined`, or
  array result is reported as a `Tool.Error` naming the target. Content that is
  present and neither a string nor a content array also fails; `null`/`undefined`
  content falls back to output or an empty string.
- **Target content is passed through unchanged.** A target result has no error
  flag. Content such as `File not found: ...` or
  `Could not find oldString ...` is target output, not a plugin failure. Only
  thrown failures get the `Target tool "<id>" failed:` prefix.
- **Target output must be JSON-serializable when exposed in JSON mode or used
  for the text fallback.** Output that is exposed in JSON/both modes or needed
  for the text fallback is rejected with a `Tool.Error` when it cannot be
  serialized, such as `BigInt` or circular data. Text-only results with valid
  content do not validate an unused output.
- **Non-object metadata is ignored.** Only plain-object target metadata is
  merged; `templateTarget` always remains.
- **Structured output is visible only through content.** The model sees
  `content`, not the separate `output` object. Use `format: "json"` to put the
  structured result into content.
- **The nested call is not a separate tool event in the UI.** The UI shows
  `template_call`; the target's child session or side effects are created
  normally.
- **Target lookup happens at execution time.** Tools registered after the call
  starts are visible on the next call, not during the current one.
- **Self-target is always denied.** `template_call` cannot call itself, even
  when `allowedTools` includes it.
- **Abort behavior follows the target.** The plugin preserves aborts, but the
  target may finish a long operation before noticing the interrupt.

## Target validation

- **The plugin does not coerce types; target schemas may.** A schema that
  rejects mismatched types rejects a rendered `"true"` for a boolean field; use
  `$type: "boolean"`. Effect and Standard schemas can transform values during
  decode, so a coercing target schema may accept or convert the rendered string.
- **Schema support is limited to Effect Schema, Standard Schema, and JSON
  Schema.** Other schema objects are rejected.
- **JSON Schema draft detection is heuristic.** Draft-07 is used when `$schema`
  contains `draft-07` or the document has `definitions`; otherwise draft
  2020-12 is used.
- **JSON Schema closed objects are enforced.** `additionalProperties: false`
  rejects extra rendered fields. When `additionalProperties` is omitted or
  open, extra fields are retained and passed to the target.
- **Malformed Standard Schema results are rejected.** A success result must
  contain an explicit `value` property; a failure result must contain a non-empty
  `issues` array. Each issue needs a string `message` and an optional `path`
  array of string, number, or symbol keys.
- **`renderOnly` still resolves the target.** It enforces `allowedTools`/
  `deniedTools` and self-target denial, renders the arguments, and applies
  `maxRenderedBytes` to the compact and pretty JSON content. It skips target
  input validation, target permission checks, and target execution. File
  template read permissions are still checked.

## Template syntax

- **No partials or custom helpers.** Only the built-in and bundled helpers are
  available. Unknown helpers are errors.
- **No nested `$parts`.** A chain is flat; a part is only `$inline` or `$file`.
- **No `$previous`/`$previousPart`.** Parts cannot read previous output.
- **`params` is per call.** Values cannot be shared across separate
  `template_call` invocations. A top-level `$params` in a structured `args`
  object fails with a placement hint; put shared values in `params`. A
  whole-args template object still accepts its own `$params`.
- **No `$params` templating.** `$params` values are data; a value containing
  `{{...}}` is not rendered again.
- **Reserved keys are interpreted.** To pass a target argument with `$inline`,
  `$file`, `$parts`, `$params`, `$type`, `$separator`, or `$skipEmpty`, use
  `$type: "json"`; parsed JSON is not rescanned.
- **`template_build` is text-only.** It accepts only `$type: "string"` (or no
  `$type`); number, boolean, and JSON results are rejected.
- **Extra helper arguments are errors.** Bundled helpers enforce arity and
  reject named/hash arguments instead of ignoring them.
- **Whitespace-only parts are kept.** `$skipEmpty` skips only parts that render
  to zero characters. It does not trim.
- **Aborts are preserved through chains.** An interrupt during a `$parts` part
  is rethrown as an abort, not wrapped as a chain error.

## Files and paths

- **No template caching.** Files are read on every call. Editing a template
  takes effect on the next call.
- **Directory globs are not expanded.** Use `dir/**/*`; a bare `dir` pattern
  matches the directory entry, not its contents.
- **Negative glob patterns are ignored.** The allowlists are positive-only. Use
  permission rules for denials.
- **Relative patterns and input paths use the project directory.** If the
  active location is a subdirectory, permission resources and `template_build`
  `output.path` still use that location and may look like `../file`.
- **Windows cross-drive paths do not match relative patterns.** A relative
  pattern such as `**/*` never matches a path on another drive. Add an absolute
  pattern for that drive.
- **Hard-linked templates are rejected by default.** `$file` templates with
  more than one hard link fail unless `allowHardLinkedTemplates: true`. The
  option weakens the path boundary; see the
  [security model](security-model.md#allowlists-are-not-permissions). Output
  files always reject hard links.
- **File identity is checked again after permission.** A swapped file is
  rejected when identity can be compared; on filesystems reporting `ino` 0, the
  check is best-effort. See [path checks](security-model.md#allowlists-are-not-permissions)
  for reads and [write safety](security-model.md#write-safety) for outputs.
- **Parent-directory races can redirect a path.** A directory renamed or
  swapped after the final path check and before the open can still redirect the
  final path.
- **New output files narrow the race.** `mkdir` is followed by a re-resolve, a
  final check, and an exclusive create. The window remains between the final
  check and the create.
- **The race is not fully closed.** Closing it needs handle-relative APIs,
  which the plugin does not use.
- **Mount points and bind mounts are outside the path checks.** A privileged
  actor with mount rights can redirect an allowed path without changing its
  name. The plugin does not detect this.
- **Absolute allowlist patterns are used as written.** If an absolute pattern
  root is a symlink, the real target path may not match it. Add the real path as
  a pattern if needed. The path is rejected when it does not match.
- **Template files must be valid UTF-8 text.** NUL, DEL, and binary control
  bytes are rejected. A binary file that happens to be valid UTF-8 can still be
  read.
- **Size limits are fixed per call.** `maxTemplateBytes` applies to each inline
  or file template source; `maxRenderedBytes` applies to rendered output, `args`
  strings, serialized `$params`, `renderOnly` content, and output paths.
- **`template_build` file mode does not return the text.** Use text mode when the
  full text must be in content. See [reference](reference.md#template_build).
- **Output files are refused unless `overwrite: true`.** Existing directories,
  non-regular files, broken symlinks, and hard-linked files are always rejected;
  `overwrite` applies only to an existing single-link regular file.
- **Output paths are rechecked after `edit`.** A file swapped or created during
  the prompt is rejected, even with `overwrite: true`. See
  [write safety](security-model.md#write-safety).
- **Write-side OS errors can include absolute paths.** Errors from output
  resolution, `mkdir`, `open`, and writing pass the OS message through, which
  may contain the resolved absolute path.
- **Treat write error text as local diagnostic output.** Read errors and
  allowlist refusals avoid resolved absolute paths.

## Resource limits

- **Args arrays are capped at 10,000 items.** A larger array fails with
  `Tool.Error` before its items are rendered.
- **Args nesting is capped at 64 levels.** Deeper objects or arrays fail with
  `Tool.Error` before the next level is rendered.
- **`$params` must be JSON-serializable.** `BigInt`, circular data, and other
  values that `JSON.stringify` rejects fail with `Tool.Error`.
- **Input caps limit, but do not prevent, `{{#each}}` expansion.** A template
  can still repeat or expand a bounded input many times. Each template source is
  rendered before its output is checked, so a pathological template can consume
  CPU and memory. Keep `$params` small and do not render untrusted templates.

## Handlebars

- **Strict mode is enabled.** A direct missing variable is an error.
  `{{#if missing}}`, `{{#each missing}}`, and `{{#with missing}}` use their
  fallback branch.
- **Render errors are normalized.** Messages name the template source and, when
  available, the line; missing variables point at `$params`; unknown helpers
  list the allowed helpers; partials are reported as unsupported. A `$parts`
  failure is reported once as `Chain part N (<source>) failed: ...`.
- **Helper names win over params.** A param named `if`, `each`, `with`, `unless`,
  `lookup`, `json`, `join`, `eq`, `ne`, `and`, `or`, or `not` needs
  `{{$params.name}}`.
- **`$params` is reserved.** A param with that name is shadowed by the namespace.
- **Prototype names are not variables.** `toString`, `constructor`,
  `hasOwnProperty`, and similar names are not resolved from the prototype.
- **No `log` helper.** The standard `log` helper is removed.

## Output and UI

- **`format` is available only when both formats are allowed.** With
  `["text"]` or `["json"]`, the input is omitted and the configured format is
  forced.
- **JSON mode replaces content with JSON.** Even if the target returns image or
  text content arrays, `format: "json"` returns the pretty JSON object. Use text
  mode when the target's content array matters.
- **`template_call` output is absent in text-only mode.** There is no output
  schema; use content.
- **`template_build` always returns its object output.** `allowedOutputFormats`
  does not apply to it.

## Compatibility

- **OpenCode V2 with `ctx.tool.list` and `ctx.permission.assert` is required.**
  Setup fails with a clear error when either capability is missing.
- **The plugin runs from source.** There is no build step and no bundled
  JavaScript output.
- **Runtime dependencies are bundled by the package manager.** `handlebars` and
  `picomatch` must be installed; manual copies must include them or run
  `bun install`.
- **Test integration manually.** CI runs `bun run check` and
  `npm pack --dry-run`. Load the packed package into a real OpenCode server and
  call `template_call` with `subagent` and a file template when validating an
  installation.
