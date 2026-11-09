---
name: tool-templates
description: Use template_call and template_build to render Handlebars templates into tool arguments, call tools, and assemble or write template files. Covers template objects, chains, params, typed values, glob paths, permissions, and output formats.
---

# Tool Templates

Use these tools when a prompt or argument is large, reusable, or stored in a
file. The model passes the template object and small `$params` values; the
plugin renders the text. `template_call` also invokes the target tool.

## Names and namespace

Tool names use the plugin's `namespace` option as a prefix: `<prefix>_call` and
`<prefix>_build`. The default is `template`, so the tools are `template_call`
and `template_build`. Dots in the namespace become underscores. In Code Mode,
call them as `tools.template.call` and `tools.template.build`; the namespace
separator is `.` instead of `_`.

## Choose the tool

| Goal                                                  | Tool                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| Render arguments and call another tool                | `template_call`                                                 |
| Assemble a template object and return text            | `template_build` without `path`                                 |
| Assemble a template object and write a file           | `template_build` with `path`                                    |
| Preview rendered arguments without calling the target | `template_call` with `renderOnly: true` (target still resolved) |

Use `template_call` to invoke a target; use `template_build` to assemble text or
write a file. `renderOnly` previews target arguments without calling the target.

## Template objects

A plain string is never rendered; see [Examples](#examples). A template object
has exactly one source: `$inline`, `$file`, or `$parts`. It can also carry
`$params`, `$type`, `$separator`, and `$skipEmpty`.

| Key          | Meaning                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `$inline`    | Inline Handlebars template.                                                                        |
| `$file`      | File template, resolved under `templatePaths`.                                                     |
| `$parts`     | Flat chain of `$inline`/`$file` parts.                                                             |
| `$params`    | Values for this template object/chain; a part can override them.                                   |
| `$type`      | `string` (default), `number`, `boolean`, or `json`.                                                |
| `$separator` | Chain separator; default from config (`"\n\n"`).                                                   |
| `$skipEmpty` | Skip chain parts that render to zero characters; whitespace is kept. Default from config (`true`). |

Exactly one source is allowed. `$separator` and `$skipEmpty` are valid only on
`$parts`; part-level `$type` is invalid. `$type` converts the final rendered
string; on a chain it applies after joining.

A part is empty only when it renders to zero characters; whitespace-only parts
are kept.

An object with a source may contain only the keys above. An unknown `$...` key
next to a source is an error. An object without a source and with unknown `$...`
keys is an ordinary object.

To pass reserved keys as target arguments, use `$type: "json"`; parsed JSON is
final and is not rescanned for template objects.

## Params

- `params` is a `template_call` input shared by every template object in `args`.
- `$params` on a template object/chain is shared by all parts of that template.
- `$params` on a part overrides the chain values for that part.
- Merge order is `params` < template object `$params` < part `$params`; merge is
  shallow.
- `params` applies to one `template_call` invocation; separate calls do not
  share it.
- A top-level `$params` in a structured `args` object fails with a placement
  hint. Put shared values in `params`.

```jsonc
{
  "tool": "subagent",
  "params": { "project": "billing" },
  "args": {
    "prompt": {
      "$parts": [
        { "$inline": "Project: {{project}}" },
        { "$file": "templates/task.md", "$params": { "task": "Implement auth" } },
        { "$inline": "Task ID: {{TASK_ID}}" },
      ],
      "$params": { "TASK_ID": "T-123" },
      "$separator": "\n\n",
    },
  },
}
```

`$params` values are data, not templates. A value containing `{{...}}` is not
rendered again.

## Variables in templates

Params are available as flat variables:

```hbs
{{TASK_ID}}
{{taskId}}
```

Handlebars helpers have priority over context properties. If a param name
collides with a helper (`if`, `each`, `with`, `unless`, `lookup`, `json`,
`join`, `eq`, `ne`, `and`, `or`, `not`), use the `$params` namespace:

```hbs
{{$params.if}}
```

`$params` is reserved; a param with that name is shadowed. Bundled helpers check
their arity, so `{{json}}` and `{{eq a}}` fail instead of dumping context or
silently returning a boolean.

## Helpers

Standard: `if`, `unless`, `each`, `with`, `lookup`.

Bundled: `json`, `join`, `eq`, `ne`, `and`, `or`, `not`.

- `{{json value}}` pretty-prints JSON; use it inside JSON templates.
- `{{join items ", "}}` joins an array.
- `{{#if (eq a b)}}...{{/if}}` and similar comparisons work.

Partials and custom helpers are not supported.

## Text vs JSON

`template_call` accepts `format` when both formats are allowed. With one allowed
format, the input is omitted.

- `["text"]` returns text and drops the output schema.
- `["json"]` forces JSON content and keeps the output schema.

`template_build` always returns its object output; `allowedOutputFormats` does
not affect it.

Use text for a quick read. Use JSON when you need fields such as `output` or
`args`, or the target's structured result. Choose by task; do not force JSON
everywhere.

## template_call

Render Handlebars templates into another tool's arguments and call that tool in
one step.

```jsonc
{
  "tool": "subagent",
  "args": {
    "agent": "general",
    "description": "Implement auth",
    "prompt": { "$file": "templates/task.md" },
    "background": true,
  },
}
```

### Inputs

- `tool` — target tool name, e.g. `subagent` or `subagent_steer`.
- `args` — object or JSON object string. Values may be template objects.
- `params` — object. Values shared by every template object in `args`.
- `format` — `text` or `json`; see Text vs JSON.
- `renderOnly` — render args and return them without calling the target.

### Output

`content` is the model-visible text. `output` is `{ tool, output? }` for a normal
call, or `{ tool, args }` with `renderOnly`.

`format: "text"` returns the target content. `format: "json"` returns pretty JSON
`{ tool }` or `{ tool, output }`; `output` is omitted only for `undefined`, and
`null` is kept.

`renderOnly` returns pretty JSON of the rendered args.

`output` is present only when `allowedOutputFormats` includes `json`; with text
only, there is no output schema.

### Whole-args template

`args` may be a whole-arguments template, usually a file:

```jsonc
{
  "tool": "subagent",
  "params": { "agent": "general", "prompt": "Long prompt..." },
  "args": { "$file": "templates/subagent-args.json.hbs" },
}
```

`$type` defaults to `json`, and the result must be an object. The file can embed
strings safely with `{{json prompt}}`.

### Notes

- `args` may also be a JSON object string. It must contain an object, not an
  array or primitive.
- `renderOnly` does not call the target or validate the args. It still resolves
  the target, enforces allow/deny rules, and applies `maxRenderedBytes`. It does
  not check target permissions; those run when the target executes.
- `renderOnly` puts the rendered args in the model context; use it for
  debugging, not production. File template `read` permissions are still checked.
- Target input is validated against the target schema. Effect, Standard, and
  JSON Schema are supported. The plugin does not coerce values; use `$type` for
  numbers, booleans, or JSON. Some target schemas also coerce values during
  decode.
- The target output schema is not checked.
- Target content is passed through unchanged. Only a thrown target failure gets
  the `Target tool "<id>" failed:` prefix.
- A target permission denial from the target executor is wrapped like any target
  failure: `Target tool "<id>" failed: ...`.
- The nested call is not a separate tool event in the UI. The UI shows
  `template_call`; the target's child session or side effects are created
  normally.
- A target abort is preserved, not wrapped as a normal target error.

## template_build

Assemble a template object and return the text or write it to a file.
`template_build` never calls another tool.

```jsonc
{
  "template": {
    "$parts": [
      { "$inline": "Project: {{project}}" },
      { "$file": "templates/task.md", "$params": { "task": "Implement auth" } },
      { "$inline": "Task ID: {{TASK_ID}}" },
    ],
    "$params": { "TASK_ID": "T-123", "project": "billing" },
  },
  "path": "build/{{TASK_ID}}.md",
  "overwrite": false,
}
```

### Inputs

- `template` — a template object. Plain strings are rejected. Only
  `$type: "string"` is accepted; the result is always text.
- `path` — optional output path. Without it, the text is returned; with it, the
  text is written.
- `overwrite` — allow replacing an existing file; only with `path`.

### Output

The output fields are `text`, `path`, `bytes`, and `parts`; `text` and `path`
are mode-specific. Text mode returns the assembled text in content and `text`.
File mode returns a short summary; `output` contains `path`, `bytes`, and
`parts`, and `text` is absent. Use text mode when the model needs the full
assembled text. `output.path` is relative to the active location for internal
paths and absolute for external paths. `parts` is `1` for a single-source
template object; otherwise it is the chain length.

### Notes

- `path` is rendered with the template object's `$params`, not part-level
  overrides. It must match `buildPaths`; writing checks the `edit` permission.
- Existing files are refused unless `overwrite: true`. Directories, non-regular
  files, broken symlinks, and hard-linked files are always refused.
- File mode does not return the text; use text mode when the model needs the full
  assembled text.
- `template_build` always returns its object output; `allowedOutputFormats` does
  not apply.

## Permissions

- `$file` templates need `read`; `template_build` writes need `edit`; external
  paths also need `external_directory`.
- `templatePaths` and `buildPaths` are candidate allowlists, not permissions. A
  match does not bypass `read`, `edit`, or a deny rule. Empty arrays disable
  that side.
- Relative paths and allowlist patterns resolve from the project directory.
  Permission resources stay relative to the active location.
- Paths outside both the active location and the project need an explicit
  pattern and `external_directory`.
- Symlinks are resolved before the allowlist check; escaping and broken links
  are rejected. File identity is rechecked after the permission prompt.
- `$file` templates with multiple hard links are rejected unless
  `allowHardLinkedTemplates: true`; that option weakens the path boundary.
  Output files always reject hard links.
- `$file` paths may contain `{{...}}` and are rendered with current params.
- Target allow/deny: `allowedTools` matches exactly; `deniedTools` is
  case-insensitive and wins; `template_call` cannot target itself.
- Targets check their own permissions with the real resource, such as a path,
  command, agent ID, or URL. `template_call` does not pre-check with `*`.
- `renderOnly` does not execute the target, so it does not check target
  permissions. File template reads still need `read`.
- Target `execute.before`/`execute.after` hooks do not run. Do not rely on them
  for security, logging, or side effects.
- Target lookup is not permission-filtered; keep `allowedTools` narrow.
- Templates are trusted content. `template_call` can invoke side-effecting
  targets such as `shell`; restrict targets and rely on target permissions.

## Errors

Refusals are `Tool.Error`:

- Unknown target, self-target, target outside `allowedTools`/`deniedTools`, or
  target permission denial.
- Missing variable, invalid `$type`, or rendered args that do not match the
  target input schema.
- Render failure: `Template "<source>" failed: ...`. A missing variable names the
  source and line and points at `$params` when it is a parameter; an unknown
  helper lists the allowed helpers; a partial reports that partials are not
  supported.
- A `$parts` part failure is reported once as
  `Chain part N (<source>) failed: ...`.
- Invalid target result, content, or output.
- Template path not allowed, output path not allowed, or an existing file
  without `overwrite: true`.
- `$params` or rendered args that are not JSON-serializable.

Abort behavior:

- Template reads and writes preserve the abort signal.
- `template_call` does not wrap a target abort as a normal target error.
- An abort during a `$parts` part is rethrown as an abort, not a chain error.
- A call that starts aborted does not invoke the target.

## Limits

- `maxTemplateBytes` — 1 MiB per inline or file template source.
- `maxRenderedBytes` — 2 MiB for rendered output, args, params, `renderOnly`
  content, and output paths.
- `maxChainParts` — 100 parts per `$parts` chain.
- Args arrays — 10,000 items; nesting — 64 levels.
- `templatePaths`/`buildPaths` — 64 patterns; 1,024 characters each.
- `allowedTools`/`deniedTools` — 200 entries; 128 characters each.
- The first three are `limits` options. The array, nesting, pattern, and
  tool-name caps are fixed.

## Workflow

1. Choose the target tool and its exact name.
2. Put large or reusable text in a template object. Use `$file` for stored
   prompts and `$parts` for reusable blocks.
3. Fill `$params` with the small values the template needs.
4. Use `renderOnly` to preview target args, or `template_build` to inspect or
   write text.
5. Call `template_call` to invoke the target.

## Examples

Two common orchestration patterns. Comments explain the moving parts.

Stored prompt:

```jsonc
{
  "tool": "subagent",
  "args": {
    "agent": "general",
    "description": "Implement auth",
    "prompt": {
      "$file": "prompts/implement-auth.md", // full prompt stays on disk
      // values inserted into the template
      "$params": {
        "TASK_ID": "T-123",
        "project": "billing",
      },
    },
  },
}
```

Composed prompt:

```jsonc
{
  "tool": "subagent",
  "args": {
    "agent": "general",
    // literal: a plain string is not rendered; stays "Implement {{project}}"
    "description": "Implement {{project}}",
    "prompt": {
      "$parts": [
        { "$file": "rules/style.md" }, // shared style rules
        { "$file": "rules/security.md" }, // shared security rules
        { "$file": "prompts/implement-auth.md", "$params": { "TASK_ID": "T-123" } },
      ],
      "$params": { "project": "billing" }, // shared by the template parts
    },
  },
}
```

Use `template_build` when you need the assembled text or a file instead of a
target call.
