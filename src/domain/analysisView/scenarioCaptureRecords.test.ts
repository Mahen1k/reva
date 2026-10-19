import { describe, expect, it } from "vitest";

import {
  SCENARIO_EXCHANGES,
  scenarioCaptureFixture,
} from "../../../tests/fixtures/browserScenarioCapture.js";
import { scenarioCaptureRecords } from "./scenarioCaptureRecords.js";

describe("scenarioCaptureRecords", () => {
  it("projects each transaction, in request order, as a HAR-shaped record with its retained bytes", () => {
    const projected = scenarioCaptureRecords(scenarioCaptureFixture());
    expect(projected.totalRecords).toBe(SCENARIO_EXCHANGES.length);
    expect(projected.records.map((record) => record.ordinal)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    const user = projected.records[1];
    expect(user?.reported).toEqual({
      request: { method: "GET", url: "http://127.0.0.1:3101/api/users/2" },
      response: {
        status: 200,
        content: {
          mimeType: "application/json",
          text: Buffer.from('{"id":2,"login":"probe"}').toString("base64"),
          encoding: "base64",
        },
      },
    });
    expect(user?.binary_fields).toMatchObject([
      { pointer: "/response/content/text", state: "retained", bytes: 24 },
    ]);
    expect(user?.location).toEqual({
      kind: "json-pointer",
      pointer: "/events/items/3",
    });
    // A JSON request body becomes postData, so the manifest can read its key types.
    expect(projected.records[4]?.reported).toMatchObject({
      request: {
        postData: {
          mimeType: "application/json",
          text: '{"title":"Lighthouse Rota"}',
        },
      },
    });
    // A redacted URL is withheld rather than templated; a failed request has no response.
    expect(projected.records[5]?.reported).toMatchObject({
      request: { url: null },
    });
    expect(projected.records[7]?.reported).toEqual({
      request: { method: "GET", url: "http://127.0.0.1:3101/api/slow" },
    });
    expect(projected.limitations).toContain(
      "1 of 8 scenario transactions retained no response body; their tools replay status and content type only.",
    );
  });

  it("leaves a transaction that cannot be attributed to one request and response unrepresented", () => {
    const capture = scenarioCaptureFixture(SCENARIO_EXCHANGES.slice(1, 2));
    const response = capture.events.items.find(
      (event) => event.kind === "response",
    );
    if (response === undefined) throw new Error("Fixture lacks a response");
    const duplicated = {
      ...capture,
      events: {
        ...capture.events,
        items: [...capture.events.items, { ...response, sequence: 99 }],
      },
    };
    expect(scenarioCaptureRecords(duplicated).records[0]?.reported).toEqual({});
  });
});
