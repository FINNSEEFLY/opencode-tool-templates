# Security model

The plugin reads template files, renders trusted text into another tool's
arguments, and can write files. Treat templates as code for the target tool.

## Trusted templates

Templates are trusted content. `templatePaths` controls which files may be used,
including external paths. Whoever can edit a template can influence the prompt
or arguments passed to the target tool. The plugin does not fetch remote
templates or judge whether a configured path is trustworthy.

The plugin itself does not read environment variables, spawn processes, load
remote templates, or resolve partials. It can, however, invoke side-effecting
target tools through `template_call`, including `shell`, `edit`, and `write`.
Restrict targets with `allowedTools`/`deniedTools` and rely on each target's
own permissions. Handlebars is configured with `strict`, `noEscape`, and
`knownHelpersOnly`; prototype access stays blocked and only the built-in and
bundled helpers are available.

## Allowlists are not permissions

`templatePaths` and `buildPaths` decide which paths the plugin may attempt to
read or write. They do not grant permission:

- File templates request `read`.
- `template_build` output requests `edit`.
- A wildcard allowlist does not override a `deny` rule for a file such as
  `.env`.
- Read allowlists are applied to the resolved real path. Symlinks are resolved
  before the check, and a link that escapes the allowlist is rejected.
- Hard links are not resolved by `realpath`. `$file` templates with multiple
  hard links are rejected unless `allowHardLinkedTemplates: true`. Enabling the
  option weakens the path boundary: the link path can match `templatePaths`
  while the data lives outside the project.
- After the `read` prompt, the opened file's `dev`/`ino` identity is checked
  again. A file swapped during the prompt is rejected when identity can be
  compared; on filesystems reporting `ino` 0, the check is best-effort.
- `nlink` is checked again unless `allowHardLinkedTemplates: true`.
- On POSIX, `O_NOFOLLOW` also protects the final path component. On Windows,
  `O_NOFOLLOW` is unavailable; the final component relies on the identity
  checks.
- Mount points and bind mounts are outside these checks. A privileged actor
  with mount rights can redirect an allowed path without changing its name.
- Relative allowlist patterns never match a path on another Windows drive.

The active location is the session's working directory, which may be a project
subdirectory. Permission resources stay relative to the active location, like
the built-in `read` and `write` tools. Relative paths and allowlist patterns
themselves resolve from the project directory.

## External paths

Paths outside both the active location and the project need two things:

1. an explicit matching pattern in `templatePaths` or `buildPaths`;
2. an `external_directory` permission assertion.

`external_directory` uses the containing directory as the resource and the
project root as the save scope. It may prompt; the user can add an allow rule. A
path inside the project but outside the active location is internal and does not
need `external_directory`.

## Target permissions

`template_call` invokes the target tool's own executor. Permission checks that
the target performs itself still run and use the actual resource, such as a file
path, command, agent ID, or URL. The plugin does not pre-assert
`target.options.permission` with a wildcard resource, so scoped allow rules see
the same resource as a direct call.

A target that does not check permissions itself is not protected by
`template_call`; use `allowedTools`/`deniedTools` to keep the target set narrow.
`ctx.tool.list()` is not permission-filtered.

`renderOnly` does not execute the target and therefore does not check target
permissions. It resolves the target, enforces `allowedTools`/`deniedTools` and
self-target denial, renders the arguments, and applies `maxRenderedBytes`. Treat
it as a preview. File template reads still check `read`.

A target permission denial from the executor is reported like any other target
failure, with the `Target tool "<id>" failed:` prefix. The plugin does not
disable or bypass target permissions.

The target's `execute.before` and `execute.after` hooks do **not** run. Do not
rely on those hooks for security, logging, or side effects.

## Target allow/deny

`allowedTools` and `deniedTools` restrict which tools `template_call` may use:

- `allowedTools` is an allowlist when non-empty; matching is exact.
- `deniedTools` always wins; matching is case-insensitive.
- `template_call` may never target itself.
- `template_build` does not call tools, so target policy does not apply.

Invalid entries are rejected instead of silently widening the list. Use target
names such as `subagent` or `subagent_steer`. An allow entry must match the exact
name; a deny entry blocks the target in any letter case.

## Target input validation

Rendered arguments are validated against the target input schema before
execution:

- Effect Schema is decoded directly.
- Standard Schema is validated and its `value` is used.
- JSON Schema is converted to an Effect schema. Draft-07 is selected when
  `$schema` contains `draft-07` or the document has `definitions`; otherwise
  draft 2020-12 is used.
- Unsupported or malformed schemas are rejected.
- The decoded value is passed to `target.execute`.
- The plugin itself does not coerce rendered strings. A target schema may accept
  or transform values during decode; if it rejects mismatched types, use `$type`.

## Reserved keys

Objects with `$inline`, `$file`, `$parts`, `$params`, `$type`, `$separator`, or
`$skipEmpty` are interpreted by the plugin. To pass reserved keys as target
arguments, use `$type: "json"`; parsed JSON is final and is not rescanned for
template objects.

## Write safety

`template_build` file mode:

- `overwrite` defaults to `false`.
- Existing files are refused unless `overwrite: true`.
- Directories, non-regular files, and hard-linked files are always refused,
  even with `overwrite: true`.
- Broken symlinks are refused.
- The resolved real path must match `buildPaths`.
- External paths request `external_directory`, then `edit`.
- The target is re-resolved after `edit` and must not change.
- Existing files are reopened and checked again for identity, regular-file
  type, and a single hard link.
- New files are created exclusively, so a file that appears during the prompt
  is not overwritten. Writes go through the checked handle, not the path.
- Parent directories are created after permission checks.
- Output paths are checked for NUL bytes and empty rendered values.
- A parent-directory swap after the final path check and before the open
  remains a residual race on Windows and POSIX.
- For new files, `mkdir` is followed by a re-resolve, a final check, and an
  exclusive create. The window remains between the final check and the create.
- The race is not fully closable without handle-relative APIs; see
  [limitations](limitations.md).

## Secrets

Do not put secrets in `$params` if the target tool may see them. Rendered
arguments are passed to the target and may appear in transcripts, logs, or the
target's own output. Templates themselves do not read environment variables.

## Abort handling

Aborts are not converted to success or a generic failure.

- Template reads and writes preserve the abort signal.
- `template_call` does not wrap a target abort as a normal target error.
- An abort while rendering a `$parts` part is rethrown as an abort, not a chain
  error.
- `template_call` and `template_build` check the signal at entry and again
  before target execution or return. A call that starts aborted does not invoke
  the target.

See [SECURITY.md](../SECURITY.md) for vulnerability reporting and
[configuration](configuration.md) for options.
