import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { portableBase64Schema } from "./portableBase64Schema.js";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "./toolSchemaMetadata.js";
import { toolContract } from "./toolContracts.js";
import {
  CANONICAL_BASE64_PATTERN,
  PADDED_BASE64_PATTERN,
} from "../domain/stringPatterns.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";

const validator = (pattern: RegExp) =>
  new Ajv2020({ strict: false }).compile(
    portableBase64Schema({ type: "string", pattern: pattern.source }),
  );

it.each([CANONICAL_BASE64_PATTERN, PADDED_BASE64_PATTERN])(
  "matches the runtime grammar exactly for %s",
  (pattern) => {
    const validate = validator(pattern);
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const samples = [
      "",
      "A",
      "AA",
      "AAA",
      "AAAA",
      "====",
      "A===",
      "AA==",
      "AB==",
      "AAA=",
      "AAB=",
      "éAAA",
      "😀==",
      "\ud800AAA",
    ];
    for (const first of alphabet)
      for (const second of alphabet)
        samples.push(`${first}${second}==`, `A${first}${second}=`);
    for (let code = 0; code < 128; code++)
      for (let position = 0; position <= 4; position++)
        samples.push(
          `AAAA`.slice(0, position) +
            String.fromCharCode(code) +
            `AAAA`.slice(position),
        );
    for (const tail of ["\n", "\r", "\r\n", "\u2028", "\u2029"])
      for (const prefix of ["", "AA==", "AAA=", "AAAA"])
        samples.push(prefix + tail);
    for (const sample of samples)
      expect(validate(sample), JSON.stringify(sample)).toBe(
        pattern.test(sample),
      );
  },
);

it("keeps portable clauses stack-safe at the 32 MiB capture budget", () => {
  const encoded = Buffer.alloc(24 * 1024 * 1024 - 3, 0x81).toString("base64");
  for (const pattern of [CANONICAL_BASE64_PATTERN, PADDED_BASE64_PATTERN]) {
    const validate = validator(pattern);
    for (const sample of [
      encoded,
      `${encoded.slice(0, -1)}!`,
      `${encoded.slice(0, -3)}R==`,
      `${encoded}A`,
      `${encoded}\n`,
    ])
      expect(validate(sample)).toBe(pattern.test(sample));
  }
});

it("projects schema positions while retaining existing intersections and literal data", () => {
  const literal = { pattern: CANONICAL_BASE64_PATTERN.source };
  const input = {
    type: "object",
    examples: [literal],
    default: literal,
    const: literal,
    properties: {
      payload: {
        type: "string",
        pattern: CANONICAL_BASE64_PATTERN.source,
        allOf: [{ maxLength: 4 }],
      },
    },
    $defs: {
      encoded: { type: "string", pattern: PADDED_BASE64_PATTERN.source },
    },
    not: { pattern: CANONICAL_BASE64_PATTERN.source },
    additionalProperties: { pattern: "^(?=arbitrary)arbitrary$" },
  };
  const projected = portableBase64Schema(input);
  expect(projected).toMatchObject({
    examples: [literal],
    default: literal,
    const: literal,
    properties: {
      payload: {
        allOf: [
          { maxLength: 4 },
          { pattern: "^(?:....)*$" },
          { pattern: String.raw`^[A-Za-z0-9+\x2f]*={0,2}$` },
          { not: { pattern: String.raw`[^A-Za-z0-9+\x2f=]` } },
          { not: { pattern: "[^AQgw]==$|[^AEIMQUYcgkosw048=]=$" } },
        ],
      },
    },
    additionalProperties: input.additionalProperties,
  });
  expect(input.properties.payload.pattern).toBe(
    CANONICAL_BASE64_PATTERN.source,
  );
});

it.each(["draft-2020-12", "draft-07"] as const)(
  "projects both MCP directions before output identity hashing: %s",
  (target) => {
    const canonical = z.strictObject({
      encoded: z.string().regex(CANONICAL_BASE64_PATTERN),
    });
    const contract = {
      ...toolContract("open_binary"),
      inputSchema: canonical,
      outputSchema: canonical,
    };
    const input = toolInputSchemaWithMetadata(contract);
    const output = toolOutputSchemaWithMetadata(contract);
    const projectedInput = input["~standard"].jsonSchema.input({ target });
    const projectedOutput = output["~standard"].jsonSchema.output({ target });
    expect(JSON.stringify(projectedInput)).not.toContain("(?!");
    expect(JSON.stringify(projectedOutput)).not.toContain("(?!");
    const { $id, ...withoutId } = projectedOutput;
    expect($id).toBe(
      `urn:rea:tool-output:sha256:${digestCanonicalValue({ target, schema: withoutId }, "Tool output schema")}`,
    );
    expect(input.safeParse({ encoded: "AB==" }).success).toBe(false);
    expect(output.safeParse({ encoded: "AB==" }).success).toBe(false);
  },
);
