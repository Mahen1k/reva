import { describe, expect, it } from "vitest";

import { environmentServeSource } from "../../../tests/fixtures/environmentServe.js";
import type { EnvironmentManifestTool } from "./environmentSource.js";
import {
  environmentCard,
  environmentToolDefinitions,
  environmentToolInputSchema,
  REPLAY_CATALOG_INSTRUCTIONS,
} from "./environmentTools.js";

const source = environmentServeSource();
const definitions = environmentToolDefinitions(
  source.manifest,
  source.evidenceId,
);

const tool = (name: string): EnvironmentManifestTool => {
  const found = source.manifest.tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`Fixture manifest lacks ${name}`);
  return found;
};

describe("environmentToolDefinitions", () => {
  it("maps every manifest tool in order with a replay description naming its records and evidence", () => {
    expect(definitions.map(({ name }) => name)).toEqual(
      source.manifest.tools.map(({ name }) => name),
    );
    const users = tool("get_users_by_id");
    const definition = definitions.find(({ name }) => name === users.name);
    expect(definition?.description).toBe(
      `${REPLAY_CATALOG_INSTRUCTIONS} GET ${users.path_template}; replays retained records [${users.record_ordinals.join(", ")}]; evidence ${source.evidenceId}`,
    );
    expect(definition?.tool).toBe(users);
  });

  it("derives required string path parameters with their rule and observed values, refusing other arguments", () => {
    const users = tool("get_users_by_id");
    expect(environmentToolInputSchema(users)).toEqual({
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Path segment 2 (numeric); observed: 2, 3",
        },
      },
      required: ["id"],
      additionalProperties: false,
    });
    const folders = tool("get_folders_by_uid");
    expect(environmentToolInputSchema(folders).properties.uid).toEqual({
      type: "string",
      description: expect.stringMatching(
        /^Path segment 2 \((?:after-uid-literal|opaque-token|sibling-variance)\); observed: .*general/u,
      ),
    });
  });

  it("derives optional string query parameters and no body for reads", () => {
    const search = environmentToolInputSchema(tool("get_search"));
    expect(search.required).toEqual([]);
    expect(search.additionalProperties).toBe(false);
    expect(Object.keys(search.properties).sort()).toEqual(["query", "type"]);
    expect(search.properties.query).toEqual({
      type: "string",
      description:
        "Query parameter query; optional, matched against the recorded query on replay.",
    });
    expect("body" in search.properties).toBe(false);
  });

  it("adds an optional body object for write methods describing the recorded key types", () => {
    const folders = environmentToolInputSchema(tool("post_folders"));
    expect(folders).toEqual({
      type: "object",
      properties: {
        body: {
          type: "object",
          description: "Request body; recorded top-level keys: title (string).",
        },
      },
      required: [],
      additionalProperties: false,
    });
    const deleted = environmentToolInputSchema(tool("delete_teams_by_id"));
    expect("body" in deleted.properties).toBe(false);
    expect(
      environmentToolInputSchema({ ...tool("post_folders"), body_shape: null })
        .properties.body?.description,
    ).toBe(
      "Request body; the capture retained no JSON body shape for this tool.",
    );
  });
});

describe("environment catalog description budgets", () => {
  it("bounds observation and record samples without changing the retained manifest", () => {
    const users = tool("get_users_by_id");
    const observations = Array.from(
      { length: 10_000 },
      (_, index) => `${String(index)}-${"x".repeat(200)}`,
    );
    const ordinals = Array.from({ length: 10_000 }, (_, index) => index);
    const expanded = {
      ...users,
      params: users.params.map((param) => ({
        ...param,
        observed_values: observations,
      })),
      record_ordinals: ordinals,
    };
    const [definition] = environmentToolDefinitions(
      { ...source.manifest, tools: [expanded] },
      source.evidenceId,
    );
    expect(definition?.tool).toBe(expanded);
    expect(expanded.params[0]?.observed_values).toBe(observations);
    expect(expanded.record_ordinals).toBe(ordinals);
    for (const description of [
      definition?.description,
      definition?.inputSchema.properties.id?.description,
    ]) {
      expect(Buffer.byteLength(description ?? "")).toBeLessThan(1536);
      expect(description).toContain(
        "/10000 shown; full list in manifest Evidence",
      );
    }
    expect(definition?.description).toContain(source.evidenceId);
    expect(definition?.inputSchema.properties.id?.description).toContain(
      observations[0],
    );
  });

  it("cuts a long captured path in the tool description and keeps it whole in the manifest", () => {
    const users = tool("get_users_by_id");
    const long = {
      ...users,
      path_template: `/api/${"segment/".repeat(200_000)}{id}`,
    };
    const [definition] = environmentToolDefinitions(
      { ...source.manifest, tools: [long] },
      source.evidenceId,
    );
    expect(Buffer.byteLength(definition?.description ?? "")).toBeLessThan(2048);
    expect(definition?.description).toContain(
      "… (full path in manifest Evidence)",
    );
    expect(definition?.tool.path_template).toBe(long.path_template);
  });

  it("reports an omitted oversized value instead of publishing an unbounded or partial observation", () => {
    const users = tool("get_users_by_id");
    const schema = environmentToolInputSchema({
      ...users,
      params: users.params.map((param) => ({
        ...param,
        observed_values: ["😀".repeat(400), "other"],
      })),
    });
    const description = schema.properties.id?.description;
    expect(description).toBe(
      "Path segment 2 (numeric); observed: … (0/2 shown; full list in manifest Evidence)",
    );
    expect(description).not.toContain("\uFFFD");
  });

  it("applies the same sample budget to captured request-body key descriptions", () => {
    const folders = tool("post_folders");
    if (folders.body_shape === null)
      throw new Error("Missing fixture body shape");
    const properties = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `${String(index)}-${"x".repeat(200)}`,
        "string" as const,
      ]),
    );
    const bodyShape = { ...folders.body_shape, properties };
    const schema = environmentToolInputSchema({
      ...folders,
      body_shape: bodyShape,
    });
    const description = schema.properties.body?.description;
    expect(Buffer.byteLength(description ?? "")).toBeLessThan(1300);
    expect(description).toContain(
      "/10000 shown; full list in manifest Evidence",
    );
    expect(Object.keys(bodyShape.properties)).toHaveLength(10_000);
  });
});

describe("environmentToolInputSchema argument names", () => {
  it("keeps every input addressable when query names collide with a path parameter, the body or inherited names", () => {
    const schema = environmentToolInputSchema({
      ...tool("post_folders"),
      params: tool("get_users_by_id").params,
      query_parameter_names: ["id", "body", "constructor"],
    });
    expect(Object.keys(schema.properties)).toEqual([
      "id",
      "query_id",
      "body",
      "constructor",
      "request_body",
    ]);
    expect(Object.hasOwn(schema.properties, "constructor")).toBe(true);
    expect(schema.properties.query_id?.description).toBe(
      "Query parameter id; optional, matched against the recorded query on replay.",
    );
    expect(schema.properties.body?.type).toBe("string");
    expect(schema.properties.request_body?.type).toBe("object");
    expect(schema.required).toEqual(["id"]);
  });
});

describe("environmentCard", () => {
  it("shapes the card with fixed protocol fields, the tools and null extension slots in contract key order", () => {
    const card = environmentCard("grafana-example", definitions);
    expect(Object.keys(card)).toEqual([
      "name",
      "protocolVersion",
      "url",
      "preferredTransport",
      "additionalInterfaces",
      "capabilities",
      "children_environments",
    ]);
    expect(card).toMatchObject({
      name: "grafana-example",
      protocolVersion: "1.0",
      url: "/agentenv",
      preferredTransport: "JSONRPC",
      additionalInterfaces: [{ url: "/mcp", transport: "mcp" }],
      children_environments: null,
    });
    expect(Object.keys(card.capabilities)).toEqual([
      "extensions",
      "tools",
      "operations",
    ]);
    expect(card.capabilities.extensions).toBeNull();
    expect(card.capabilities.operations).toEqual([]);
    expect(card.capabilities.tools).toHaveLength(definitions.length);
    for (const [index, entry] of card.capabilities.tools.entries()) {
      expect(Object.keys(entry)).toEqual([
        "name",
        "description",
        "inputSchema",
      ]);
      expect(entry).toEqual({
        name: definitions[index]?.name,
        description: definitions[index]?.description,
        inputSchema: definitions[index]?.inputSchema,
      });
    }
    expect(environmentCard("renamed", definitions).name).toBe("renamed");
  });
});
