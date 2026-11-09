import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import { errorMessage, toolError } from "./errors";
import { isPlainRecord, isRecord } from "./record";

interface StandardIssue {
  message: string;
  path?: readonly PropertyKey[];
}

interface StandardResult {
  value?: unknown;
  issues?: readonly StandardIssue[];
}

interface StandardSchemaLike {
  "~standard": {
    validate(value: unknown): StandardResult | Promise<StandardResult>;
  };
}

// Standard Schema implementations such as Zod 4 may expose `~standard` as a
// prototype getter. Match OpenCode core and use `in` here; this is a deliberate
// exception to the own-property rule for the Standard Schema interface.
const isStandardSchema = (value: unknown): value is StandardSchemaLike => {
  if (!isRecord(value) || !("~standard" in value)) return false;
  const standard = value["~standard"];
  return isRecord(standard) && typeof standard.validate === "function";
};

const isIssuePath = (value: unknown): value is readonly PropertyKey[] | undefined =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every(
      (part) =>
        typeof part === "string" || typeof part === "number" || typeof part === "symbol",
    ));

const issueText = (issue: StandardIssue): string => {
  const path = issue.path?.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
};

const formatIssues = (issues: readonly StandardIssue[]): string => {
  try {
    return issues.map(issueText).join("; ");
  } catch {
    return toolError("Standard Schema returned invalid issues");
  }
};

const decodeJsonSchema = (schema: Record<string, unknown>) => {
  const schemaVersion = Object.hasOwn(schema, "$schema") ? schema.$schema : undefined;
  const draft =
    (typeof schemaVersion === "string" && schemaVersion.includes("draft-07")) ||
    Object.hasOwn(schema, "definitions")
      ? JsonSchema.fromSchemaDraft07(schema)
      : JsonSchema.fromSchemaDraft2020_12(schema);
  return Schema.make(SchemaRepresentation.fromJsonSchemaDocument(draft).ast);
};

/**
 * Validate rendered target arguments against the target's input schema.
 * Effect and Standard schemas are decoded directly; plain JSON Schema targets
 * are converted to an Effect schema first. Unsupported schemas fail closed.
 */
export const validateTargetInput = async (
  schema: unknown,
  value: unknown,
): Promise<unknown> => {
  if (schema === undefined || schema === null) return value;
  if (schema === true) return value;
  if (schema === false) return toolError("the target schema rejects all values");

  if (Schema.isSchema(schema)) {
    try {
      return Schema.decodeUnknownSync(
        schema as unknown as Schema.ConstraintDecoder<unknown>,
      )(value);
    } catch (error) {
      return toolError(errorMessage(error));
    }
  }

  if (isStandardSchema(schema)) {
    let result: StandardResult;
    try {
      result = await schema["~standard"].validate(value);
    } catch (error) {
      return toolError(errorMessage(error));
    }
    if (!isRecord(result)) {
      return toolError("Standard Schema returned an invalid result");
    }
    const hasIssues = Object.hasOwn(result, "issues");
    if (hasIssues) {
      if (
        !Array.isArray(result.issues) ||
        !result.issues.every(
          (issue) =>
            isRecord(issue) &&
            typeof issue.message === "string" &&
            isIssuePath(issue.path),
        )
      ) {
        return toolError("Standard Schema returned invalid issues");
      }
      if (result.issues.length > 0) return toolError(formatIssues(result.issues));
    }
    if (!Object.hasOwn(result, "value")) {
      return toolError(
        hasIssues
          ? "Standard Schema returned issues without a value"
          : "Standard Schema returned neither a value nor issues",
      );
    }
    return result.value;
  }

  if (isPlainRecord(schema)) {
    try {
      const codec = decodeJsonSchema(schema);
      // Effect Schema keeps excess properties by default. JSON Schema's
      // `additionalProperties: false` is only enforced with this option.
      return Schema.decodeUnknownSync(
        codec as unknown as Schema.ConstraintDecoder<unknown>,
        { onExcessProperty: "error" },
      )(value);
    } catch (error) {
      return toolError(errorMessage(error));
    }
  }

  return toolError("unsupported target input schema");
};
