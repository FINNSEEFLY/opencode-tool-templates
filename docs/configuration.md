# Configuration

Pass options with the object form of a `plugins` entry in `opencode.json(c)`.
Options come from the `plugins` entry; the plugin reads them from `ctx.options`
in `setup`. If you installed with `opencode plugin add`, replace the string
entry with the object form to add options.

A plugin auto-discovered from a `plugins/` directory has no entry, so it always
uses defaults. To pass options, load it through `opencode.json(c)`.

## Full example

The example shows the defaults and uses the npm package name. You can omit any
option you do not need. For a local checkout, use the directory path instead;
see [installation](installation.md).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-tool-templates",
      "options": {
        "namespace": "template",
        "templatePaths": ["**/*"],
        "buildPaths": ["**/*"],
        "allowHardLinkedTemplates": false,
        "allowedTools": [],
        "deniedTools": [],
        "defaultSeparator": "\n\n",
        "defaultSkipEmpty": true,
        "allowedOutputFormats": ["text", "json"],
        "registerSkill": true,
        "limits": {
          "maxTemplateBytes": 1048576,
          "maxRenderedBytes": 2097152,
          "maxChainParts": 100,
        },
      },
    },
  ],
}
```

## Options

| Option                     | Type     | Default               | Effect                                                                                            |
| -------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `namespace`                | string   | `"template"`          | Tool prefix. Dots become underscores in registered tool names: `<prefix>_call`, `<prefix>_build`. |
| `templatePaths`            | string[] | `["**/*"]`            | Glob allowlist for `$file` templates. An empty array disables file templates.                     |
| `buildPaths`               | string[] | `["**/*"]`            | Glob allowlist for `template_build` output. An empty array disables file output.                  |
| `allowHardLinkedTemplates` | boolean  | `false`               | Allow `$file` templates with multiple hard links. Only `true` enables it.                         |
| `allowedTools`             | string[] | `[]`                  | Target names `template_call` may use. Empty allows all. Matching is exact.                        |
| `deniedTools`              | string[] | `[]`                  | Target names `template_call` must never use. Denials win; matching is case-insensitive.           |
| `defaultSeparator`         | string   | `"\n\n"`              | Default `$separator` for `$parts` chains.                                                         |
| `defaultSkipEmpty`         | boolean  | `true`                | Default `$skipEmpty` for `$parts` chains. Empty means zero characters.                            |
| `allowedOutputFormats`     | string[] | `["text", "json"]`    | Formats `template_call` may return. `["text"]` or `["json"]` removes the per-call `format` input. |
| `registerSkill`            | boolean  | `true`                | Registers the bundled `SKILL.md` as a model-facing skill.                                         |
| `limits`                   | object   | see [Limits](#limits) | Bounds for template size, rendered size, and chain length.                                        |

Unknown top-level options and unknown `limits` keys are rejected. The error
names the unknown key, suggests a close match when one exists, and lists the
known keys.

Top-level `options` may be `null` or `undefined`; both mean defaults. `limits`
may be omitted or `undefined`; both use defaults. Otherwise, `options` and
`limits` must be objects; arrays and primitives are rejected. `limits: null` is
rejected.

## Namespace

`namespace` is trimmed and clipped to 64 characters. An empty or non-string value
uses `"template"`. The value may contain dot-separated segments with letters,
digits, underscores, and hyphens; leading, trailing, and consecutive dots are
rejected.

The plugin replaces dots with underscores when it computes registered tool
names. A namespace `company.templates` registers `company_templates_call` and
`company_templates_build`. The namespace description is registered once through
`editor.namespace`.

## Path allowlists

`templatePaths` and `buildPaths` accept string arrays:

- Relative patterns resolve from the project directory.
- Absolute patterns are used as written.
- `..` is allowed; the final absolute pattern is normalized.
- Maximum 64 patterns; each pattern is clipped to 1024 characters.
- Non-array values are rejected.
- Invalid entries and non-string entries are ignored.
- An empty array disables that side; inline templates still work.
- Patterns starting with `!` are ignored. Negative patterns are not supported;
  use permission rules for denials.
- Matching uses `picomatch` with `dot: true` and `nocase` on Windows.
- Paths are normalized to forward slashes before matching.
- Directory entries are not expanded automatically. Use `dir/**/*` to allow a
  directory tree.

The allowlist is a candidate filter, not a permission. A match does not bypass
`read` or `edit`; see the [security model](security-model.md).

Hard-link policy for `$file` templates:

- `$file` templates with more than one hard link are rejected by default.
- `allowHardLinkedTemplates: true` permits them but weakens the path boundary.
  Any value other than `true` uses `false`.
- Output files always reject hard links.

See the [security model](security-model.md#allowlists-are-not-permissions) for
identity checks and the hard-link trade-off.

Relative `$file` paths and `buildPaths` output paths resolve from the project
directory. Permission resources use the active location; see the
[security model](security-model.md).

## Target allow/deny

`allowedTools` and `deniedTools` accept target names:

- `allowedTools` matches names exactly.
- `deniedTools` matches names case-insensitively.
- Maximum 200 entries; each entry is trimmed and must be at most 128 characters.
- Non-array values are rejected.
- Non-string, empty, overlong, and invalid entries fail configuration
  resolution. They are not silently dropped.
- Valid duplicates are removed.
- `allowedTools: []` allows every target except self-targets.
- `deniedTools` wins over `allowedTools`.
- `template_call` may never target itself, even if allowed.
- `template_build` does not call tools, so these options do not apply to it.

## Separator and empty parts

- `defaultSeparator` must be a string; non-strings use `"\n\n"`. The value is
  clipped to 1024 characters. An empty string is allowed.
- `defaultSkipEmpty` uses `true` unless the value is exactly `false`.
- A part is empty only when it renders to zero characters. Whitespace-only parts
  are kept; the text is not trimmed.
- Per-chain `$separator` and `$skipEmpty` override these defaults.
- Part-level `$separator` and `$skipEmpty` are invalid.

## Output formats

`allowedOutputFormats` applies only to `template_call`:

- Unknown values are ignored.
- A non-array, an empty list, or a list with no recognized values falls back to
  `["text", "json"]`.
- A partially valid list keeps the recognized values in `text`, `json` order.
- `["text"]` omits the `format` input and the output schema.
- `["json"]` omits `format` and always returns JSON content with the output
  schema.
- Both values enable the per-call `format` input; the default is `"text"`.

`template_build` always returns its object output.

## Limits

All limits are integers. Invalid values fall back to the default; valid values
are floored and clamped.

| Option             | Default   | Range        | Effect                                                   |
| ------------------ | --------- | ------------ | -------------------------------------------------------- |
| `maxTemplateBytes` | `1048576` | 1 KiB–10 MiB | Maximum size of one template source: inline or `$file`.  |
| `maxRenderedBytes` | `2097152` | 1 KiB–20 MiB | Maximum rendered output, args, params, and output paths. |
| `maxChainParts`    | `100`     | 1–500        | Maximum parts in one `$parts` chain.                     |

`maxTemplateBytes` is enforced before compiling an inline `$inline` source and
on each `$file` read. `maxRenderedBytes` is enforced while rendering chains, on
serialized `template_call` args, on `args` JSON strings before parsing, on
serialized `$params` per template object or part, on pretty `renderOnly`
content, on `template_build` text, and on rendered output paths.

## Global vs project configuration

Options are scoped to the config file that contains the `plugins` entry:

- **Global** — `~/.config/opencode/opencode.json(c)`: applies to every project.
- **Project** — `./opencode.json(c)` or `./.opencode/opencode.json(c)`: applies
  to that project only.
- **System** — `/etc/opencode/opencode.json(c)` on Linux,
  `/Library/Application Support/opencode` on macOS, or `%ProgramData%\opencode`
  on Windows: managed settings with the highest precedence.

Plugin arrays from applicable config files are merged; they are not replaced.
OpenCode rejects duplicate plugin IDs, so load the plugin in exactly one scope.

## Examples

Allow only project templates and build output:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-tool-templates",
      "options": {
        "templatePaths": ["templates/**/*", "prompts/**/*.md"],
        "buildPaths": ["build/**/*"],
      },
    },
  ],
}
```

Allow external templates as well:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-tool-templates",
      "options": {
        "templatePaths": ["**/*", "C:/shared/templates/**/*.md"],
        "buildPaths": ["**/*", "D:/tmp/opencode-builds/**/*"],
      },
    },
  ],
}
```

Restrict target tools:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-tool-templates",
      "options": {
        "allowedTools": ["subagent", "subagent_steer"],
        "deniedTools": ["shell", "edit"],
      },
    },
  ],
}
```

Force JSON output:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-tool-templates",
      "options": {
        "allowedOutputFormats": ["json"],
      },
    },
  ],
}
```

See [installation](installation.md) for path rules and local setups, and the
[security model](security-model.md) for permission behavior.
