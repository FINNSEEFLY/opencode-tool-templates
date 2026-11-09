# Security Policy

## Supported versions

Security fixes ship in the latest published minor release.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting:

<https://github.com/finnseefly/opencode-tool-templates/security/advisories/new>

Include:

- the affected version;
- the OpenCode version;
- a minimal reproduction or the relevant plugin configuration;
- the impact you observed;
- any suggested fix or mitigation.

If private reporting is unavailable, open a minimal public issue asking for a
private channel. Do not include exploit details in that issue.

## Scope

This plugin exposes model-facing tools that read template files, write build
outputs, and invoke other OpenCode tools with rendered arguments. Reports about
path traversal, symlink escapes, permission bypass, arbitrary tool invocation,
template injection, or unsafe file overwrites are in scope.

Templates are trusted content. See the [security model](docs/security-model.md)
for the trust model and path rules.
