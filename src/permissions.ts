import type { ToolContext } from "@opencode/plugin/promise/tool";
import { toolError } from "./errors";

export interface PermissionApi {
  assert(input: any): Promise<void>;
}

export interface PermissionGuard {
  assert(input: any): Promise<void>;
}

/**
 * Permission assertions are deduplicated per tool call. A guard must be
 * created for each call; reusing one across calls would skip checks.
 */
export const createPermissionGuard = (permission: PermissionApi): PermissionGuard => {
  const pending = new Map<string, Promise<void>>();
  return {
    async assert(input) {
      const key = JSON.stringify([input.action, input.resources ?? [], input.save ?? []]);
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = Promise.resolve()
        .then(() => permission.assert(input))
        .then(
          () => undefined,
          (error) => {
            pending.delete(key);
            throw error;
          },
        );
      pending.set(key, promise);
      return promise;
    },
  };
};

export const permissionInvocation = (context: ToolContext) => {
  if (!context.sessionID) {
    return toolError("Cannot check permissions: the calling session is unknown.");
  }
  return {
    sessionID: context.sessionID,
    agent: context.agent,
    source:
      context.messageID && context.id
        ? { type: "tool" as const, messageID: context.messageID, id: context.id }
        : undefined,
  };
};
