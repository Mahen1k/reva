import { base64PatternSchemaConstraints } from "../domain/stringPatterns.js";
import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./jsonSchemaKeywords.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Project only the owned base64 grammars, leaving instance annotations intact. */
export const portableBase64Schema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const visited = new WeakMap<object, Record<string, unknown>>();
  const project = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const previous = visited.get(value);
    if (previous !== undefined) return previous;
    const result = { ...value };
    visited.set(value, result);
    for (const [key, child] of Object.entries(value)) {
      if (schemaMaps.has(key) && isRecord(child))
        result[key] = Object.fromEntries(
          Object.entries(child).map(([name, nested]) => [
            name,
            project(nested),
          ]),
        );
      else if (schemaArrays.has(key) && Array.isArray(child))
        result[key] = child.map(project);
      else if (schemaChildren.has(key))
        result[key] = Array.isArray(child)
          ? child.map(project)
          : project(child);
    }
    const constraints =
      typeof value.pattern === "string"
        ? base64PatternSchemaConstraints(value.pattern)
        : undefined;
    if (constraints !== undefined) {
      delete result.pattern;
      result.allOf = [
        ...(Array.isArray(result.allOf) ? result.allOf : []),
        ...constraints,
      ];
    }
    return result;
  };
  return project(schema) as Record<string, unknown>;
};
