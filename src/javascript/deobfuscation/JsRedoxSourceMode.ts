import { extname } from "node:path";

export type JsRedoxSourceMode = "auto" | "module" | "commonjs";

/** Preserve filename-imposed JS mode across the private and published copies. */
export const jsRedoxSourceMode = (path: string): JsRedoxSourceMode => {
  switch (extname(path).toLowerCase()) {
    case ".mjs":
      return "module";
    case ".cjs":
      return "commonjs";
    default:
      return "auto";
  }
};

/** Stable filename suffix carrying every mode distinction the producer honors. */
export const jsRedoxSourceSuffix = (path: string): ".js" | ".mjs" | ".cjs" => {
  const mode = jsRedoxSourceMode(path);
  return mode === "module" ? ".mjs" : mode === "commonjs" ? ".cjs" : ".js";
};
