# Installation

Install from npm or GitHub. See the
[README quick start](../README.md#quick-start). This page covers local, manual,
and packed installation, path rules, dependencies, and the difference between
server and CLI plugins.

## Requirements

- An OpenCode V2 build with `ctx.tool.list` and `ctx.permission.assert`; see the
  [README](../README.md) for the supported version.
- The plugin is a TypeScript directory package: `package.json` exports
  `./src/index.ts`, and OpenCode loads the sources directly. There is no build
  step.
- `handlebars` and `picomatch` are runtime dependencies. An npm/GitHub install
  fetches them automatically. A manual or packed install must install them.
- `@opencode/plugin` and `effect` are optional peer dependencies supplied by
  OpenCode at runtime. Do not install them just to run the plugin; a manual copy
  relies on OpenCode for both.
- Keep `SKILL.md` beside `src/` if you want the bundled skill. Without it, the
  tools still load, but the skill is skipped.

## npm or GitHub

```sh
opencode plugin add opencode-tool-templates
```

GitHub:

```sh
opencode plugin add github:finnseefly/opencode-tool-templates
```

`opencode plugin add` adds the plugin to the global config. After install, run
`opencode reload` and ask the agent to call `template_call`. For options, replace
the string entry with the object form shown in
[configuration](configuration.md).

## Local checkout

Use this when you want to run the repository directly or pin a local revision.

```sh
git clone https://github.com/finnseefly/opencode-tool-templates
cd opencode-tool-templates
bun install
```

Point `plugins` at the checkout directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/Users/<you>/opencode-tool-templates"],
}
```

Object form for options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/<you>/opencode-tool-templates",
      "options": {
        "namespace": "template",
        "templatePaths": ["**/*"],
        "buildPaths": ["**/*"],
      },
    },
  ],
}
```

Run `bun install` once after cloning. OpenCode loads the source directly and
resolves `handlebars` and `picomatch` from the checkout's `node_modules`.
`@opencode/plugin` and `effect` are supplied by OpenCode. The checkout's dev
dependencies include them for local typechecking and tests.

## Manual installation

OpenCode discovers immediate plugin package directories under the OpenCode
config directory:

```text
<global-config-dir>/plugins/
```

On Windows the global config directory is `%USERPROFILE%\.config\opencode`.
Copy the package as a directory named `tool-templates`:

```powershell
$target = "$env:USERPROFILE\.config\opencode\plugins\tool-templates"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item .\package.json, .\SKILL.md $target
Copy-Item .\src $target -Recurse
Set-Location $target
bun install --production --omit=peer
```

`bun install --production --omit=peer` installs `handlebars`, `picomatch`, and
their runtime dependencies. The `--omit=peer` flag skips the optional peers that
OpenCode supplies. Plain `bun install --production` also works, but installs
those peers into the copy as well.

OpenCode watches this directory and reloads plugins automatically. If the new
package is not picked up, run `opencode reload`; a full restart is not normally
needed.

This layout loads the plugin with its default options. An auto-discovered
package has no `plugins` entry, so there is nowhere to attach `options`. Use the
directory package layout below when you need to pass options.

> Project-scoped plugins live in `.opencode/plugins/`. A `plugins/` directory
> beside a project-root `opencode.json(c)` is **not** auto-discovered.

## Packed package

Use this to test the exact npm tarball or install from a local package.

```sh
npm pack --dry-run --json
mkdir <temp-dir>
npm pack --pack-destination <temp-dir>
cd <temp-dir>
npm init -y
npm install ./opencode-tool-templates-<version>.tgz --omit=dev
```

Replace `<version>` with the tarball name printed by `npm pack`.

Point `plugins` at the installed package directory. Use the absolute path to
`<temp-dir>` from the previous step:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<temp-dir>/node_modules/opencode-tool-templates"],
}
```

`npm install --omit=dev` installs `handlebars` and `picomatch`; OpenCode supplies
`@opencode/plugin` and `effect`. `opencode plugin add` does not accept tarball
targets, so configure the extracted directory instead.

## Path rules

Global config lives at `~/.config/opencode/opencode.json(c)`; project config
lives at `./opencode.json(c)` or `./.opencode/opencode.json(c)`. Both `.json` and
`.jsonc` are accepted. Relative paths resolve from the config file that contains
the entry, so a path that works in `./opencode.jsonc` needs one extra `../` in
`./.opencode/opencode.jsonc`.

`opencode.json(c)` can load the plugin from a directory that contains a
`package.json` with `name` and `exports`. Point `package` at the directory.

Project config — relative path from `./opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-tool-templates",
      "options": {
        "namespace": "template",
      },
    },
  ],
}
```

From `./.opencode/opencode.jsonc`, use
`"package": "../opencode-tool-templates"` or an absolute path.

The `plugins` array also accepts npm package names, GitHub specifications, local
directories, and `file://` URLs. Local paths must be directories; a path to a
single file is skipped.

> **Do not load the plugin twice.** Load it in one scope: auto-discovered
> (defaults only) or configured directory (options). A second `plugins` entry
> creates a duplicate plugin ID, which OpenCode rejects.

> **Windows paths.** Tilde expansion is not guaranteed for plugin paths on
> Windows; use an absolute forward-slash path such as `C:/Users/<you>/...`.
> `%USERPROFILE%` is not expanded inside JSON config strings.

> **Server plugin vs CLI plugin.** This plugin uses the server plugin API
> (`ctx.tool`, `ctx.permission`, `ctx.skill`, `ctx.location`), so load it as a
> server plugin — from the global plugins directory or from `plugins` in
> `opencode.json(c)`. The separate `cli.json` is for CLI-only (TUI) plugins and
> is not needed here.

## After installation

Run `opencode reload`, then ask the agent to call `template_call`. If the tool is
missing, check that `ctx.tool.list` and `ctx.permission.assert` are available in
your OpenCode build and that the plugin loaded without errors.

See [configuration](configuration.md) for all options, defaults, ranges, and
examples. Manual installs need the object form of the `plugins` entry to pass
options.
