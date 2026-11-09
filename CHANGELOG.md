# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-11-22

### Added

- Initial release of the `tool-templates` OpenCode plugin. Requires OpenCode 2.3.2+.
- Tools register in Code Mode by default; when Code Mode is unavailable, OpenCode exposes them directly as `template_call` and `template_build`.
- Two tools under the default `template` namespace:
  - `template_call` — render Handlebars templates into another tool's arguments and call that tool in one step.
  - `template_build` — assemble a template object into text or write it to a file.
- Template objects: `$inline`, `$file`, and flat `$parts` chains; plain strings are literals, nested `$parts` is rejected, and `$file` templates must be valid UTF-8 text.
- `$params` on template objects, chains, and parts, with shallow part-level overrides.
- A top-level `params` input for `template_call`, shared by every template
  object in `args`; template and part `$params` override it.
- `$type` conversion to string, number, boolean, or JSON; whole-`args` template objects default to JSON, and empty numeric renders are rejected.
- `$separator` and `$skipEmpty` for chains, with configurable defaults.
- `args` as an object or JSON object string, including whole-arguments template objects.
- `renderOnly` preview mode that resolves the target, enforces target allow/deny rules, and returns rendered arguments without calling the target, validating its input, or checking target permissions.
- Target lookup by name, `allowedTools`/`deniedTools`, and self-target denial.
- Target permission checks run inside the target with the real resource, so path-, command-, and agent-scoped allow rules see the rendered value instead of a wildcard.
- Target input validation through Effect Schema, Standard Schema, or JSON Schema.
- `template_call` text or JSON output; `template_build` text and file modes with `overwrite` and `buildPaths`. File mode returns `path`, `bytes`, and `parts` in `output`; the rendered text stays in the file.
- Template and build path allowlists, `read`/`edit`/`external_directory` permissions, and symlink checks.
- Hard-linked `$file` templates are rejected by default; `allowHardLinkedTemplates` opts in and weakens the path boundary. Output files always reject hard links.
- Write safety: existing directories, non-regular files, and broken symlinks are refused; new files are created exclusively.
- Configurable template, rendered-output, and chain limits, plus fixed caps on nesting and array length.
- Bundled Handlebars helpers (`json`, `join`, `eq`, `ne`, `and`, `or`, `not`), strict rendering, and no partials or custom helpers.
- Configuration options for namespace, paths, target allow/deny, separators, output formats, skill registration, and limits.
- Bundled `SKILL.md` and user docs for the tool reference, use cases, configuration, installation, security model, limitations, and development.
- Bun test suite, lint, typecheck, and GitHub Actions CI.
- Render failures use normalized diagnostics: missing variables name the source
  and line and point at `$params` when applicable; unknown helpers list the
  allowed helpers; partials are reported as unsupported; `$parts` failures are
  reported once.
- A top-level `$params` in `args` fails with a placement hint.
- Non-Error object throws are described with bounded JSON; circular values
  report `[unserializable object]`.
- Tool descriptions include compact examples and the plain-string literal
  warning.
