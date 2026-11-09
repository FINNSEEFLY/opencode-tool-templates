# Use cases

These patterns use `template_call` and `template_build` for orchestration. They
are examples, not a required workflow. For exact tool inputs and outputs, see
the [tool reference](reference.md).

## Stored prompts

A stored prompt is a prompt file plus a small header that describes it.

### Problem

An orchestrator that reads every stored prompt spends input tokens. Rewriting
the prompt for the target also spends output tokens and can change the original
wording.

### Pattern

Keep the full prompt in a file and a small header beside it. The header is an
index; the prompt file is the content passed to the target.

```text
prompts/
  implement-auth.md
  implement-auth-header.md
```

The header describes what the prompt does and lists the variables it needs:

```md
# implement-auth

Implements an authentication flow in the current project.

## Params

- `TASK_ID` — task identifier.
- `project` — project name.
- `scope` — optional area; defaults to `auth`.
```

The orchestrator reads only the header. It chooses the prompt and calls
`template_call`:

```jsonc
{
  "tool": "subagent",
  "args": {
    "agent": "general",
    "description": "Implement auth",
    "prompt": {
      "$file": "prompts/implement-auth.md",
      "$params": {
        "TASK_ID": "T-123",
        "project": "billing",
        "scope": "auth",
      },
    },
  },
}
```

`template_call` reads and renders the file. The stored prompt does not enter the
orchestrator's context, and the orchestrator does not rewrite it.

### Benefits

- The orchestrator reads a small header instead of the full stored prompt.
- The stored prompt is passed through unchanged.
- The same prompt can be reused across tasks.
- `$params` substitution is deterministic.

### Limits

- The header must list every required variable. A missing variable is a
  strict-mode error that names the source and, when available, the line, and
  points at `$params`.
- Headers can drift from stored prompts. Update them together. Use
  `template_build` to inspect the rendered text. `renderOnly` also puts the
  rendered args in context, so use it for debugging, not routine delegation.
- `$file` templates must match `templatePaths` and need `read` permission.
- Templates are trusted content. Treat prompt files and headers as code.
- The target still receives the rendered prompt and may log it.

## Runtime composition

### Problem

Many prompts share the same instruction blocks. Copying those blocks into every
prompt causes drift and makes updates expensive.

### Pattern

Keep stable blocks in separate files:

```text
rules/
  security.md
  testing.md
prompts/
  implement-auth.md
```

Build a prompt from `$parts` and pass it to the target:

```jsonc
{
  "tool": "subagent",
  "args": {
    "agent": "general",
    "description": "Implement auth",
    "prompt": {
      "$parts": [
        { "$file": "rules/security.md" },
        { "$file": "rules/testing.md", "$params": { "scope": "auth" } },
        {
          "$file": "prompts/implement-auth.md",
          "$params": { "TASK_ID": "T-123" },
        },
      ],
      "$params": {
        "TASK_ID": "T-123",
        "project": "billing",
      },
    },
  },
}
```

Part-level `$params` override chain-level values for that part. The merge is
shallow.

To inspect or write the composed prompt, use `template_build`; see the
[tool reference](reference.md#template_build).

### Benefits

- Change a shared rule once and every prompt that uses the block gets it.
- Compose only the blocks a task needs.
- Keep stable instructions out of the orchestrator's context.
- Reuse the same blocks across different agents and tasks.

### Limits

- Chains are flat. Nested `$parts` is invalid.
- Partials and custom helpers are not supported.
- Part-level `$type` is invalid; `$type` applies to the final joined string.
- `$separator` and `$skipEmpty` control spacing and empty blocks.
- The usual size limits apply: `maxChainParts`, `maxTemplateBytes`, and
  `maxRenderedBytes`.

## Choosing a pattern

| Need                                                | Use                                     |
| --------------------------------------------------- | --------------------------------------- |
| One stored prompt with a small parameter set        | A single `$file` template               |
| Shared rule blocks or task-specific composition     | A `$parts` chain                        |
| Preview target arguments without calling the target | `template_call` with `renderOnly: true` |
| Inspect or write the assembled text                 | `template_build`                        |

`renderOnly` skips target input validation, target permission checks, and target
execution. File template reads still need `read`.

For exact inputs, outputs, and limits, see the [tool reference](reference.md)
and [configuration](configuration.md).
