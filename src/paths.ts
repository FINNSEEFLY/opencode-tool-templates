import type { ToolContext } from "@opencode/plugin/promise/tool";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import picomatch from "picomatch";
import { assertByteLimit, byteLength } from "./bytes";
import type { Config } from "./config";
import { abortError, errorMessage, toolError } from "./errors";
import { permissionInvocation, type PermissionGuard } from "./permissions";

export interface PathLocation {
  directory: string;
  project: { directory: string };
}

export interface ReadTemplateResult {
  text: string;
  resource: string;
}

export interface WriteTemplateResult {
  path: string;
  bytes: number;
}

export interface TemplatePaths {
  /** Test seam; production matches through the readTemplate closure. */
  matchesTemplatePath(absolute: string): boolean;
  readTemplate(
    path: string,
    context: ToolContext,
    guard: PermissionGuard,
  ): Promise<ReadTemplateResult>;
  writeTemplate(
    path: string,
    text: string,
    context: ToolContext,
    guard: PermissionGuard,
    options: { overwrite: boolean },
  ): Promise<WriteTemplateResult>;
}

const slash = (value: string) => value.replaceAll("\\", "/");

const canonicalRoot = (value: string) => {
  const withDrive = /^[A-Za-z]:$/.test(value) ? `${value}${sep}` : value;
  return resolve(withDrive);
};

const isFilesystemRoot = (value: string) => {
  const resolved = canonicalRoot(value);
  return resolved === parse(resolved).root;
};

const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const compileMatchers = (patterns: readonly string[], base: string) => {
  const matchers: Array<{
    readonly absolute: boolean;
    readonly match: (value: string) => boolean;
  }> = [];
  const options = { dot: true, nocase: process.platform === "win32" };
  for (const pattern of patterns) {
    // Negations are not part of the allowlist contract. Ignoring them avoids
    // turning a relative pattern into a picomatch negation.
    if (pattern.startsWith("!")) continue;
    try {
      if (isAbsolute(pattern)) {
        matchers.push({
          absolute: true,
          match: picomatch(slash(resolve(pattern)), options),
        });
        continue;
      }
      const relativePattern = slash(relative(base, resolve(base, pattern)));
      if (!relativePattern) continue;
      matchers.push({ absolute: false, match: picomatch(relativePattern, options) });
    } catch {
      // Invalid glob entries are ignored; config normalization keeps strings only.
    }
  }
  return (absolute: string) => {
    const normalized = slash(absolute);
    const relativePath = slash(relative(base, absolute));
    return matchers.some((matcher) => {
      if (matcher.absolute) return matcher.match(normalized);
      // On Windows, path.relative returns an absolute path for another drive.
      // A relative allowlist pattern must never match a path outside its base.
      if (isAbsolute(relativePath)) return false;
      return matcher.match(relativePath);
    });
  };
};

const decodeText = (buffer: Uint8Array, file: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return toolError(`Template file "${file}" is not valid UTF-8 text.`);
  }
};

// O_NOFOLLOW is unavailable on Windows, where the final-component check relies
// on the post-open identity comparison instead.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
// A swapped FIFO must not block the open; the fstat check rejects it before
// any read.
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | NONBLOCK;
const OVERWRITE_FLAGS = constants.O_RDWR | NO_FOLLOW;
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

const sameIdentity = (
  expected: { dev: bigint; ino: bigint },
  actual: { dev: bigint; ino: bigint },
): boolean => {
  if (expected.dev !== actual.dev) return false;
  // Some Windows filesystems report ino 0. There is no stable file id to
  // compare then; the dev check and the path checks still apply.
  if (expected.ino === 0n && actual.ino === 0n) return true;
  return expected.ino === actual.ino;
};

const notAllowedOrMissing = (path: string): never =>
  toolError(`Template path "${path}" is not allowed by templatePaths or was not found.`);

/** Keep OS error details without echoing the resolved absolute path. */
export const redactPath = (
  message: string,
  absolute: string,
  displayPath: string,
): string =>
  absolute === displayPath ? message : message.replaceAll(absolute, () => displayPath);

const HIDDEN_REALPATH_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
]);

const readHandleText = async (
  handle: FileHandle,
  displayPath: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
  while (true) {
    if (signal?.aborted) throw abortError(signal);
    let bytesRead: number;
    try {
      const result = await handle.read(chunk, 0, chunk.length, null);
      bytesRead = result.bytesRead;
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (error instanceof Error && error.name === "AbortError") throw error;
      return toolError(
        `Cannot read template file "${displayPath}": ${errorMessage(error)}`,
      );
    }
    if (bytesRead === 0) break;
    total += bytesRead;
    assertByteLimit({
      bytes: total,
      max: maxBytes,
      label: `Template file "${displayPath}"`,
      limit: "maxTemplateBytes",
    });
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  if (signal?.aborted) throw abortError(signal);
  return decodeText(Buffer.concat(chunks, total), displayPath);
};

const hasBinaryControl = (text: string) =>
  Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    );
  });

const outputChanged = (): never =>
  toolError("Output path changed during permission check; retry.");

type HardLinkSubject = "template" | "output";

const HARD_LINK_MESSAGES: Record<HardLinkSubject, (path: string) => string> = {
  template: (path) =>
    `Template file "${path}" has multiple hard links; hard-linked templates are disabled. Set allowHardLinkedTemplates: true to allow them.`,
  output: (path) =>
    `Output file "${path}" has multiple hard links; refusing to overwrite it.`,
};

const assertNoHardLinks = ({
  subject,
  path,
  nlink,
  allow,
}: {
  subject: HardLinkSubject;
  path: string;
  nlink: bigint;
  allow: boolean;
}): void => {
  if (allow || nlink <= 1n) return;
  toolError(HARD_LINK_MESSAGES[subject](path));
};

const openExistingOutput = async (
  target: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<FileHandle> =>
  open(target, OVERWRITE_FLAGS).catch((error: unknown) => {
    if (signal?.aborted) throw abortError(signal);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOENT") return outputChanged();
    return toolError(`Failed to write output file "${path}": ${errorMessage(error)}`);
  });

const openNewOutput = async (
  target: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<FileHandle> =>
  open(target, CREATE_FLAGS).catch((error: unknown) => {
    if (signal?.aborted) throw abortError(signal);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return toolError(
        `Output file "${path}" appeared during permission check; refusing to overwrite it.`,
      );
    }
    if (code === "ELOOP") return outputChanged();
    return toolError(`Failed to write output file "${path}": ${errorMessage(error)}`);
  });

const writeHandleText = async (
  handle: FileHandle,
  text: string,
  path: string,
  signal: AbortSignal | undefined,
  truncate: boolean,
): Promise<void> => {
  if (signal?.aborted) throw abortError(signal);
  if (truncate) {
    try {
      await handle.truncate(0);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      return toolError(`Failed to write output file "${path}": ${errorMessage(error)}`);
    }
    if (signal?.aborted) throw abortError(signal);
  }
  try {
    await handle.writeFile(text, { encoding: "utf8", signal });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (error instanceof Error && error.name === "AbortError") throw error;
    return toolError(`Failed to write output file "${path}": ${errorMessage(error)}`);
  }
  if (signal?.aborted) throw abortError(signal);
};

export const createTemplatePaths = async ({
  config,
  location,
}: {
  config: Config;
  location: PathLocation;
}): Promise<TemplatePaths> => {
  // Relative paths and allowlist patterns belong to the project, not to the
  // session location. Permission resources stay location-relative like the
  // built-in read/write tools, even when the session runs in a subdirectory.
  const projectBase = canonicalRoot(location.project.directory);
  const realProject = canonicalRoot(
    await realpath(location.project.directory).catch(() => location.project.directory),
  );
  const realLocation = canonicalRoot(
    await realpath(location.directory).catch(() => location.directory),
  );
  const matchesReal = compileMatchers(config.templatePaths, realProject);
  const matchesBuild = compileMatchers(config.buildPaths, realProject);

  const internal = (absolute: string) =>
    (!isFilesystemRoot(realLocation) && isInside(realLocation, absolute)) ||
    (!isFilesystemRoot(realProject) && isInside(realProject, absolute));

  const resourceFor = (absolute: string) =>
    internal(absolute) ? slash(relative(realLocation, absolute) || ".") : slash(absolute);

  const PATH_PERMISSION_ACTIONS = {
    read: "read",
    write: "edit",
  } as const;

  const createPathAssertion =
    (action: (typeof PATH_PERMISSION_ACTIONS)[keyof typeof PATH_PERMISSION_ACTIONS]) =>
    async (absolute: string, context: ToolContext, guard: PermissionGuard) => {
      const invocation = permissionInvocation(context);
      if (!internal(absolute)) {
        await guard.assert({
          ...invocation,
          action: "external_directory",
          resources: [slash(join(dirname(absolute), "*"))],
          save: [slash(join(realProject, "*"))],
        });
      }
      await guard.assert({
        ...invocation,
        action,
        resources: [resourceFor(absolute)],
        save: ["*"],
      });
    };

  const assertRead = createPathAssertion(PATH_PERMISSION_ACTIONS.read);

  const resolveWriteTarget = async (target: string): Promise<string> => {
    const segments: string[] = [];
    let current = target;
    while (true) {
      try {
        const real = await realpath(current);
        return canonicalRoot(join(real, ...segments.toReversed()));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          return toolError(
            `Cannot resolve output path "${target}": ${errorMessage(error)}`,
          );
        }
        // realpath follows a symlink leaf. If the leaf is a dangling symlink,
        // lstat still sees it; reject instead of writing through it later.
        const link = await lstat(current).catch(() => undefined);
        if (link?.isSymbolicLink()) {
          return toolError(
            `Output path "${target}" contains a broken symlink at "${current}".`,
          );
        }
        const parent = dirname(current);
        if (parent === current) return canonicalRoot(target);
        segments.push(basename(current));
        current = parent;
      }
    }
  };

  const assertWrite = createPathAssertion(PATH_PERMISSION_ACTIONS.write);

  return {
    matchesTemplatePath: matchesReal,
    async readTemplate(path, context, guard) {
      if (context.signal?.aborted) throw abortError(context.signal);
      if (path.includes("\0")) return toolError("Template path contains a NUL byte.");
      if (config.templatePaths.length === 0) {
        return toolError("File templates are disabled: templatePaths is empty.");
      }
      const lexical = canonicalRoot(isAbsolute(path) ? path : resolve(projectBase, path));
      const resolved = await realpath(lexical).then(
        (value) => ({ value: canonicalRoot(value) }),
        (error: unknown) => ({ error }),
      );
      if ("error" in resolved) {
        const code = (resolved.error as NodeJS.ErrnoException).code;
        if (code !== undefined && HIDDEN_REALPATH_ERROR_CODES.has(code)) {
          return notAllowedOrMissing(path);
        }
        return toolError(
          `Cannot resolve template path "${path}": ${redactPath(errorMessage(resolved.error), lexical, path)}`,
        );
      }
      const absolute = resolved.value;
      if (!matchesReal(absolute)) return notAllowedOrMissing(path);
      const info = await stat(absolute, { bigint: true }).catch((error) =>
        toolError(
          `Cannot inspect template file "${path}": ${redactPath(errorMessage(error), absolute, path)}`,
        ),
      );
      if (!info.isFile()) {
        return toolError(`Template path "${path}" is not a file.`);
      }
      const maxBytes = config.limits.maxTemplateBytes;
      assertByteLimit({
        bytes: Number(info.size),
        max: maxBytes,
        label: `Template file "${path}"`,
        limit: "maxTemplateBytes",
      });
      assertNoHardLinks({
        subject: "template",
        path,
        nlink: info.nlink,
        allow: config.allowHardLinkedTemplates,
      });
      await assertRead(absolute, context, guard);
      if (context.signal?.aborted) throw abortError(context.signal);
      // Re-resolve after the prompt so a parent-directory or symlink swap during
      // the prompt is rejected before opening. The confirmed path must still be
      // the same regular file.
      const confirmed = await realpath(lexical).then(
        (value) => canonicalRoot(value),
        () => undefined,
      );
      if (confirmed !== absolute) {
        return toolError("Template file changed during permission check; retry.");
      }
      const confirmedInfo = await lstat(confirmed, { bigint: true }).catch(
        (error: unknown) => {
          if (context.signal?.aborted) throw abortError(context.signal);
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
            return toolError("Template file changed during permission check; retry.");
          }
          return toolError(
            `Cannot inspect template file "${path}": ${redactPath(errorMessage(error), confirmed, path)}`,
          );
        },
      );
      if (!confirmedInfo.isFile()) {
        return toolError(`Template path "${path}" is not a file.`);
      }
      assertNoHardLinks({
        subject: "template",
        path,
        nlink: confirmedInfo.nlink,
        allow: config.allowHardLinkedTemplates,
      });
      if (!sameIdentity(info, confirmedInfo)) {
        return toolError("Template file changed during permission check; retry.");
      }
      const handle = await open(absolute, READ_FLAGS).catch((error: unknown) => {
        if (context.signal?.aborted) throw abortError(context.signal);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP" || code === "ENOENT") {
          return toolError("Template file changed during permission check; retry.");
        }
        return toolError(
          `Cannot read template file "${path}": ${redactPath(errorMessage(error), absolute, path)}`,
        );
      });
      try {
        const opened = await handle
          .stat({ bigint: true })
          .catch((error) =>
            toolError(
              `Cannot inspect template file "${path}": ${redactPath(errorMessage(error), absolute, path)}`,
            ),
          );
        if (!opened.isFile()) {
          return toolError(`Template path "${path}" is not a file.`);
        }
        assertNoHardLinks({
          subject: "template",
          path,
          nlink: opened.nlink,
          allow: config.allowHardLinkedTemplates,
        });
        if (!sameIdentity(info, opened)) {
          return toolError("Template file changed during permission check; retry.");
        }
        assertByteLimit({
          bytes: Number(opened.size),
          max: maxBytes,
          label: `Template file "${path}"`,
          limit: "maxTemplateBytes",
        });
        const raw = await readHandleText(handle, path, maxBytes, context.signal);
        const text = raw.replace(/^\uFEFF/, "");
        if (text.includes("\0")) {
          return toolError(`Template file "${path}" contains NUL bytes and is not text.`);
        }
        if (hasBinaryControl(text)) {
          return toolError(
            `Template file "${path}" contains binary control bytes and is not text.`,
          );
        }
        return { text, resource: resourceFor(absolute) };
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async writeTemplate(path, text, context, guard, options) {
      if (context.signal?.aborted) throw abortError(context.signal);
      if (path.includes("\0")) return toolError("Output path contains a NUL byte.");
      if (config.buildPaths.length === 0) {
        return toolError("File output is disabled: buildPaths is empty.");
      }
      const bytes = byteLength(text);
      assertByteLimit({
        bytes,
        max: config.limits.maxRenderedBytes,
        label: "Output",
      });
      const lexical = canonicalRoot(isAbsolute(path) ? path : resolve(projectBase, path));
      const absolute = await resolveWriteTarget(lexical);
      if (!matchesBuild(absolute)) {
        return toolError(`Output path "${path}" is not allowed by buildPaths.`);
      }
      const existing = await stat(absolute, { bigint: true }).then(
        (value) => value,
        (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return undefined;
          return toolError(
            `Cannot inspect output path "${path}": ${errorMessage(error)}`,
          );
        },
      );
      if (existing && !existing.isFile()) {
        return toolError(
          existing.isDirectory()
            ? `Output path "${path}" is a directory.`
            : `Output path "${path}" is not a regular file.`,
        );
      }
      if (existing) {
        assertNoHardLinks({
          subject: "output",
          path,
          nlink: existing.nlink,
          allow: false,
        });
      }
      if (existing && !options.overwrite) {
        return toolError(
          `Output file "${path}" already exists; pass overwrite: true to replace it.`,
        );
      }
      await assertWrite(absolute, context, guard);
      if (context.signal?.aborted) throw abortError(context.signal);

      const confirmed = await resolveWriteTarget(lexical);
      if (confirmed !== absolute) return outputChanged();
      if (!matchesBuild(confirmed)) {
        return toolError(`Output path "${path}" is not allowed by buildPaths.`);
      }

      if (existing) {
        const current = await stat(confirmed, { bigint: true }).catch(
          (error: unknown) => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") return outputChanged();
            return toolError(
              `Cannot inspect output path "${path}": ${errorMessage(error)}`,
            );
          },
        );
        if (!current.isFile()) {
          return toolError(
            current.isDirectory()
              ? `Output path "${path}" is a directory.`
              : `Output path "${path}" is not a regular file.`,
          );
        }
        assertNoHardLinks({
          subject: "output",
          path,
          nlink: current.nlink,
          allow: false,
        });
        if (!sameIdentity(existing, current)) return outputChanged();
        const handle = await openExistingOutput(confirmed, path, context.signal);
        try {
          const opened = await handle
            .stat({ bigint: true })
            .catch((error) =>
              toolError(`Cannot inspect output file "${path}": ${errorMessage(error)}`),
            );
          if (
            !opened.isFile() ||
            opened.nlink !== 1n ||
            !sameIdentity(existing, opened)
          ) {
            return outputChanged();
          }
          await writeHandleText(handle, text, path, context.signal, true);
        } finally {
          await handle.close().catch(() => undefined);
        }
        return { path: resourceFor(confirmed), bytes };
      }

      try {
        await mkdir(dirname(confirmed), { recursive: true });
      } catch (error) {
        if (context.signal?.aborted) throw abortError(context.signal);
        return toolError(`Failed to write output file "${path}": ${errorMessage(error)}`);
      }
      if (context.signal?.aborted) throw abortError(context.signal);
      const final = await resolveWriteTarget(lexical);
      if (final !== confirmed) return outputChanged();
      if (!matchesBuild(final)) {
        return toolError(`Output path "${path}" is not allowed by buildPaths.`);
      }
      const handle = await openNewOutput(final, path, context.signal);
      try {
        const opened = await handle
          .stat({ bigint: true })
          .catch((error) =>
            toolError(`Cannot inspect output file "${path}": ${errorMessage(error)}`),
          );
        if (!opened.isFile() || opened.nlink !== 1n) return outputChanged();
        await writeHandleText(handle, text, path, context.signal, false);
      } finally {
        await handle.close().catch(() => undefined);
      }
      return { path: resourceFor(final), bytes };
    },
  };
};
