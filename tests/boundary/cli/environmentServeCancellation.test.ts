import { EventEmitter } from "node:events";

import pino from "pino";
import { expect, it } from "vitest";

import { withCommandCancellation } from "../../../src/cli/commandCancellation.js";
import { serveEnvironmentCommand } from "../../../src/cli/environmentCommands.js";
import { writeEnvironmentServeFiles } from "../../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("ends environment-serve startup as cancelled, before binding, when a shutdown signal arrives while loading", async () => {
  const root = await createTestTempDirectory("rea-environment-serve-cancel-");
  const files = await writeEnvironmentServeFiles(root);
  const events = new EventEmitter();
  const host: {
    on: EventEmitter["on"];
    off: EventEmitter["off"];
    exitCode?: number | string | null | undefined;
  } = { on: events.on.bind(events), off: events.off.bind(events) };
  const command = withCommandCancellation(
    (signal) =>
      serveEnvironmentCommand(
        {
          manifest: files.manifestPath,
          evidence: files.capturePath,
          host: "127.0.0.1",
          port: 0,
        },
        {},
        pino({ level: "silent" }),
        signal,
      ),
    host,
  );
  events.emit("SIGTERM");
  const result = await command;
  expect(result).toMatchObject({ code: "cancelled" });
  expect(result).not.toHaveProperty("status", "stopped");
  expect(host.exitCode).toBe(143);
});
