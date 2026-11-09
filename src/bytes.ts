import { toolError } from "./errors";

export type ByteLimitName = "maxRenderedBytes" | "maxTemplateBytes";

/** UTF-8 byte length used by every limit check. */
export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

export interface ByteLimit {
  bytes: number;
  max: number;
  label: string;
  limit?: ByteLimitName;
  verb?: "is" | "are";
}

/**
 * Throw when a byte count exceeds its configured limit. Keeping the message
 * shape here prevents render, dispatch, and file I/O limits from drifting.
 */
export const assertByteLimit = ({
  bytes,
  max,
  label,
  limit = "maxRenderedBytes",
  verb = "is",
}: ByteLimit): void => {
  if (bytes > max) {
    toolError(`${label} ${verb} ${bytes} bytes; ${limit} is ${max}.`);
  }
};
