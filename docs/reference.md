# Tool reference

The plugin registers two tools under a namespace. With the default namespace
`template`, the names are `template_call` and `template_build`. Namespace
segments may contain letters, digits, underscores, and hyphens. Dots separate
segments and become underscores in registered tool names. Other characters fail
configuration. In Code Mode, call them as `tools.template.call` and
`tools.template.build`.

A target name is a tool's registered name, such as `subagent` or
`subagent_steer`.

Inputs marked `?` are optional; unknown properties are rejected.

- When `allowedOutputFormats` allows both formats (the default),
  `template_call` accepts `format`; see [Text vs JSON](#text-vs-json).
- Target allow/deny follows the rules in the [security model](security-model.md).
- For usage guidance, see the bundled `SKILL.md`.
- Configuration options and defaults are in [configuration](configuration.md).

## template_call

Render Handlebars templates into another tool's arguments and call that tool in
one step. The target is addressed by that name, such as `subagent` or
`subagent_steer`.

### Inputs

| Name          | Type                  | Default  | Notes                                                                                        |
| ------------- | --------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `tool`        | string                | —        | Required. Exact target tool name.                                                            |
| `args`        | object \| JSON string | —        | Required. Values may be template objects.                                                    |
| `params?`     | object                | `{}`     | Values shared by every template object in `args`. Template and part `$params` override them. |
| `format?`     | `"text"` \| `"json"`  | `"text"` | Only present when both output formats are allowed.                                           |
| `renderOnly?` | boolean               | `false`  | Render args without calling the target or validating its input.                              |

Plain strings are literal. Use a template object to render them.
`args` may also be a JSON object string; the plugin parses it first and then
renders its values. A JSON string must contain an object, not an array or
primitive.

When `args` itself is a template object, its default `$type` is `"json"` and the
rendered result must be an object.

### Output

`content` is the model-visible text. `output` is a structured object:

- normal call: `{ tool, output? }`;
- `renderOnly`: `{ tool, args }`.

`output` is present only when `allowedOutputFormats` includes `json`. When only
`text` is allowed, the tool has no output schema.

`metadata` is plain-object target metadata plus `templateTarget`; non-object
metadata is ignored. When the target returns no usable metadata, the result
contains only `templateTarget`.

The output schema when JSON is allowed:

```json
{
  "type": "object",
  "properties": {
    "tool": { "type": "string" },
    "output": {},
    "args": {}
  },
  "required": ["tool"],
  "additionalProperties": false
}
```

### Content behavior

`format: "text"` uses the target content. When content is `undefined` or `null`,
it falls back to the compact JSON of the target output; if output is also
`undefined`, it returns an empty string. A `null` output is serialized as
`"null"`. Target content is passed through unchanged, even when it looks like an
error.

- `format: "json"` returns pretty JSON `{ tool }` or `{ tool, output }`;
  `output` is omitted only when the target returns `undefined`. `null` is kept
  as `"output": null`. JSON mode puts the structured result in `content`; the
  `output` field stores it separately.
- `renderOnly` returns pretty JSON of the rendered args. `format` does not
  affect `renderOnly`.
- `renderOnly` still resolves the target, enforces `allowedTools`/`deniedTools`
  and self-target denial, and applies `maxRenderedBytes`. It skips target input
  validation, target permission checks, and target execution.

### Behavior

1. Check `allowedTools`/`deniedTools`; `template_call` may never target itself.
2. Call `ctx.tool.list()` at execution time.
3. Find the target by its exact name.
4. Render `args` with params.
5. Check the rendered args against `maxRenderedBytes`.
6. For `renderOnly`, serialize the rendered args as pretty JSON, check its byte
   length against `maxRenderedBytes`, then return it without target validation,
   target permission checks, or target execution.
7. Validate the rendered arguments against the target input schema.
8. Call `target.execute(decodedArgs, context)`.
9. Normalize the result.

Target input validation follows these rules:

- `additionalProperties: false` rejects extra rendered fields; an omitted or
  open `additionalProperties` keeps them.
- A missing target schema (`input: undefined` or `null`) and `input: true` are
  unconstrained: rendered arguments pass through without validation.
- `input: false` rejects every value.
- Target leaf permissions still run inside the target. `execute.before`/
  `execute.after` hooks do not run, and the target output schema is not checked.

### Errors

- Unknown target: `Tool.Error`. When `allowedTools` is non-empty, the message
  lists up to 50 allowed targets, excluding denied tools and `template_call`;
  otherwise it lists none.
- Self-target: `Tool.Error`.
- Target outside `allowedTools` or inside `deniedTools`: `Tool.Error`. Allow
  matching is exact; deny matching is case-insensitive.
- Invalid rendered arguments: `Tool.Error` with the target name, validation
  detail, and a hint to use `$type` for numbers, booleans, or JSON.
- Target permission denial from the target executor: `Tool.Error` with the
  `Target tool "<id>" failed:` prefix, like other target failures. `renderOnly`
  does not check target permissions.
- Render failure: `Tool.Error` with `Template "<source>" failed: ...`; see
  [render errors](#render-errors). A `$parts` part failure is reported once as
  `Chain part N (<source>) failed: ...`.
- Template path not allowed or not readable.
- Thrown target failure: `Tool.Error` with the prefix
  `Target tool "<id>" failed: ...`; the cause (`error` field) and metadata are
  preserved. The prefix applies only to thrown failures. `Tool.Result` has no
  error flag, so content returned by a target, including `File not found: ...`
  or `Could not find oldString ...`, is passed through unchanged.
- Invalid target result: `Tool.Error` naming the target when `execute` returns
  a primitive, `null`/`undefined`, or an array instead of an object.
- Invalid target content: `Tool.Error` naming the target when `content` is
  present and is neither a string nor a content array. `null`/`undefined`
  content falls back to output or an empty string.
- Invalid target output: `Tool.Error` naming the target when JSON serialization
  fails. This applies when output is exposed or used as the text fallback, for
  example with `BigInt` or circular data.
- Abort: the interrupt is preserved, not converted to a target error.

## template_build

Assemble a template object and return the text or write it to a file.
`template_build` never calls another tool, so `allowedTools`/`deniedTools` do
not apply.

### Inputs

| Name         | Type            | Default | Notes                                                                  |
| ------------ | --------------- | ------- | ---------------------------------------------------------------------- |
| `template`   | template object | —       | Required. `$inline`, `$file`, or `$parts`; a plain string is rejected. |
| `path?`      | string          | —       | Optional output path. Present means file mode.                         |
| `overwrite?` | boolean         | `false` | Allow replacing an existing file. Only valid with `path`.              |

`path` may contain `{{...}}` and is rendered with the template object's
chain-level/object-level `$params`, not part-level overrides.

### Output

| Field   | Type    | Notes                                                                                                  |
| ------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `text`  | string? | Present in text mode. The full assembled text.                                                         |
| `path`  | string? | Present in file mode. Relative to the active location for internal paths; absolute for external paths. |
| `bytes` | integer | UTF-8 byte length of the assembled text.                                                               |
| `parts` | integer | Chain length; `1` for a single-source template object.                                                 |

Output schema:

```json
{
  "type": "object",
  "properties": {
    "text": { "type": "string" },
    "path": { "type": "string" },
    "bytes": { "type": "integer" },
    "parts": { "type": "integer" }
  },
  "required": ["bytes", "parts"],
  "additionalProperties": false
}
```

### Content behavior

- Text mode (no `path`) returns the assembled text in content and in
  `output.text`.
- File mode returns a short summary, for example:
  `Wrote build/task.md (1234 bytes, 4 parts).`
  `output` contains `path`, `bytes`, and `parts`; the assembled text is not
  returned. Use text mode when the caller needs the full text.

### Behavior

- `template` must be a template object. A plain string is rejected.
- Only `$type: "string"` is accepted; the result is always text.
- `path` must match `buildPaths`. The error does not echo the configured
  patterns.
- External paths also request `external_directory`, then `edit`.
- Parent directories are created.
- `overwrite: false` refuses an existing file.
- Existing directories, non-regular files, broken symlinks, empty paths, and NUL
  bytes are rejected.
- Hard-linked files are refused even with `overwrite: true`; `overwrite` only
  applies to existing single-link regular files.
- Existing files are rechecked after `edit`; a file replaced during the prompt
  is rejected when identity can be compared. On filesystems reporting `ino` 0,
  the check is best-effort. New files are created exclusively, so a file that
  appears during the prompt is not overwritten.
- `overwrite` without `path` is rejected.

## Template objects

Plain strings are literal. A template object has exactly one source: `$inline`,
`$file`, or `$parts`.

### Keys

| Key          | Type                                          | Where        | Purpose                                    |
| ------------ | --------------------------------------------- | ------------ | ------------------------------------------ |
| `$inline`    | string                                        | object       | Inline Handlebars template.                |
| `$file`      | string                                        | object       | Template file path.                        |
| `$parts`     | array                                         | object       | Flat chain of `$inline`/`$file` parts.     |
| `$params`    | object                                        | object, part | Values for this template or part.          |
| `$type`      | `"string"`, `"number"`, `"boolean"`, `"json"` | object       | Convert the rendered string.               |
| `$separator` | string                                        | chain        | Separator between parts.                   |
| `$skipEmpty` | boolean                                       | chain        | Skip parts that render to zero characters. |

Rules:

- Exactly one source is required.
- `$params` and `$type` require a source.
- `$separator` and `$skipEmpty` are valid only on a `$parts` chain.
- Part-level `$separator`, `$skipEmpty`, and `$type` are invalid.
- An object with a source may contain only the reserved keys above. An unknown
  `$...` key next to a source is an error.
- An object without a source and with unknown `$...` keys is an ordinary object,
  not a template object.
- To pass reserved keys as target arguments, use `$type: "json"`; the parsed
  JSON is final and is not rescanned for template objects.

### `params` and `$params`

`template_call` has a top-level `params` input. It is shared by every template
object in `args`.

- `params` is shared by all template objects in `args`.
- `$params` on a template object/chain is shared by all parts.
- `$params` on a part overrides the chain values for that part.
- Merge order is `params` < template object `$params` < part `$params`.
- Merge is shallow: an object or array value is replaced whole.

```jsonc
{
  "tool": "subagent",
  "params": { "project": "billing", "TASK_ID": "T-123" },
  "args": {
    "agent": "general",
    "description": { "$inline": "{{project}} task" },
    "prompt": {
      "$inline": "Project: {{project}}\nTask: {{TASK_ID}}",
      "$params": { "project": "auth-service" },
    },
  },
}
```

The description renders `billing task`; the prompt renders
`Project: auth-service` and `Task: T-123`.

A top-level `$params` inside a structured `args` object is rejected. Put shared
values in `params`. A whole-args template object still accepts its own
`$params`, which overrides `params`.

`params` applies to one `template_call` invocation; separate calls do not share
it.

`$params` values are data, not templates. A value containing `{{...}}` is not
rendered again.

### `$type`

- `"string"` (default) returns the rendered text.
- `"number"` uses `Number(trimmed)` and requires non-empty text and a finite
  result.
- `"boolean"` accepts `"true"` or `"false"` after trimming and lowercasing.
- `"json"` uses `JSON.parse` and accepts any JSON value.
- On a chain, `$type` applies to the final joined string.
- On a single-source template object, `$type` applies to its rendered string.
- On a part, `$type` is invalid.
- For `template_call`, a whole-`args` template object defaults to `"json"` and
  must render to an object.
- Parsed JSON is final and is not rescanned.

### `$parts`

```jsonc
{
  "$parts": [
    { "$inline": "Project: {{project}}" },
    { "$file": "templates/task.md", "$params": { "task": "Implement auth" } },
    { "$inline": "Task ID: {{taskId}}" },
  ],
  "$params": {
    "taskId": "T-123",
    "project": "billing",
  },
  "$separator": "\n\n",
  "$skipEmpty": true,
}
```

- `$parts` must be a non-empty array.
- A part is only `$inline` or `$file`; nested `$parts` is invalid.
- `$previous` and `$previousPart` are not supported.
- `$separator` defaults to `defaultSeparator` (`"\n\n"`).
- `$skipEmpty` defaults to `defaultSkipEmpty` (`true`).
- A part is empty only when it renders to zero characters. Whitespace-only
  parts are kept.
- Empty parts are skipped with `$skipEmpty: true`; separators around them are
  not added. If every part is empty, the result is `""`.
- With `$skipEmpty: false`, empty parts and separators remain.
- An abort during a part propagates as an abort; it is not wrapped as a
  `Chain part ... failed` error.

### `$file` path templating

- The `$file` value is a string.
- If it contains `{{...}}`, the path is rendered with the current merged
  `$params` before resolution.
- Relative paths resolve from the project directory.
- Absolute paths are used as written.
- The resolved real path must match `templatePaths`.
- A missing file and a path outside `templatePaths` return the same error; the
  error does not echo allowlist patterns or resolved absolute paths.
- Symlinks are resolved with `realpath` and checked again. A symlink that
  escapes the allowlist is rejected.
- Files with multiple hard links are rejected unless
  `allowHardLinkedTemplates: true`. Enabling it weakens the path boundary.
- The file identity is checked again after `read`; a file replaced during the
  permission prompt is rejected when identity can be compared. On filesystems
  reporting `ino` 0, the check is best-effort.
- The target must be a regular file and must fit `maxTemplateBytes`.
- The file must be valid UTF-8 text. A BOM is stripped; NUL, DEL, and binary
  control bytes are rejected.
- File reads request `read`, plus `external_directory` for paths outside both
  the active location and the project.

### Whole-args template

`args` may be a whole-arguments template object, usually a file:

```jsonc
{
  "tool": "subagent",
  "params": {
    "agent": "general",
    "description": "Implement auth",
    "prompt": "Long prompt...",
  },
  "args": {
    "$file": "templates/subagent-args.json.hbs",
  },
}
```

`$type` defaults to `"json"`, and the rendered result must be an object. The
file can use the `json` helper to embed strings safely:

```text
{
  "agent": "{{agent}}",
  "description": "{{description}}",
  "prompt": {{json prompt}}
}
```

A `$params` on the whole-args template object overrides `params`.

### `args` as a JSON string

If `args` is a string, the plugin parses it first. The result must be an object,
not an array or primitive. After parsing, values are rendered like a normal
object. If the parsed object is itself a template object (`$inline`, `$file`, or
`$parts`), it is treated as a whole-args template object, just like passing that
object as `args`.

## Handlebars

The plugin uses Handlebars 4.7 with one shared environment per module load.

Compile options:

- `strict: true`
- `noEscape: true`
- `knownHelpersOnly: true`
- prototype access controls stay at their safe defaults.

### Helpers

Standard helpers: `if`, `unless`, `each`, `with`, `lookup`. The `log` helper is
removed.

Bundled helpers:

| Helper              | Behavior                                                 |
| ------------------- | -------------------------------------------------------- |
| `json(value)`       | Pretty `JSON.stringify`; `undefined` becomes `"null"`.   |
| `join(array, sep?)` | Joins an array; `sep` defaults to `","`.                 |
| `eq(a, b)`          | Strict equality.                                         |
| `ne(a, b)`          | Strict inequality.                                       |
| `and(a, b, ...)`    | True when every value is truthy; at least two arguments. |
| `or(a, b, ...)`     | True when any value is truthy; at least two arguments.   |
| `not(value)`        | Boolean negation.                                        |

Bundled helpers validate arity. Extra positional and named/hash arguments are
errors, not silently ignored. Partials and custom helpers are not supported.

### Context

- Params are flat variables: `{{TASK_ID}}`, `{{taskId}}`, `{{project_name}}`.
- The merged params are also available under `{{$params.TASK_ID}}`.
- `$params` is reserved; a param with that name is shadowed by the namespace.
- Handlebars helpers have priority over context properties. Use
  `{{$params.if}}` when a param name collides with a helper.
- Missing direct variables are strict-mode errors with a hint to pass them in
  `$params`. `{{#if missing}}`, `{{#each missing}}`, and `{{#with missing}}`
  use their fallback branch instead.
- Unknown helpers list the allowed helpers. A partial lookup reports that
  partials are not supported.

### Render errors

Render failures are `Tool.Error` values that name the source and use normalized
messages. Handlebars internals such as `[object Object]`, `knownHelpersOnly`, and
raw `line:column` locations are not shown.

- Missing variable: names the source and, when available, the line, and points
  at `$params`.
- Unknown helper: names the helper and lists the allowed helpers.
- Partial: reports that partials are not supported.
- `$parts` part: reported once as `Chain part N (<source>) failed: ...`.

Typical messages:

```text
Template "<source>" failed: "name" is not defined (line N). If it is a parameter, pass it in $params; use {{$params.name}} if the name collides with a helper.
Template "<source>" failed: Unknown helper "name" (line N). Allowed helpers: if, unless, each, with, lookup, json, join, eq, ne, and, or, not.
Template "<source>" failed: Partials are not supported (line N).
```

`$inline` uses `<inline>`. A `$file` uses its path when known; a path-template
failure uses `<file path>`. A chain part uses the rendered path when available,
otherwise the raw path. The line is omitted when Handlebars does not report one.

## Limits

- `maxTemplateBytes` bounds each template source: inline `$inline` strings and
  `$file` contents.
- `maxRenderedBytes` bounds rendered output, `args` JSON strings, serialized
  `$params`, `renderOnly` content, and output paths.
- `maxChainParts` bounds the number of parts in one `$parts` chain.

Args values also have fixed safety caps: 64 levels of nesting and 10,000 items
per array. See [configuration](configuration.md#limits) for defaults and ranges,
and [limitations](limitations.md#resource-limits) for the caps.

## Text vs JSON

`allowedOutputFormats` controls `template_call`:

- `["text", "json"]` (default): `format` is accepted; default `"text"`.
- `["text"]`: text only; no `format` input and no output schema.
- `["json"]`: JSON content is forced; no `format` input, but the output schema
  is present.

`template_build` always returns its own object output; `allowedOutputFormats`
does not affect it.
