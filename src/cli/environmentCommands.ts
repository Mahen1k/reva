import { z } from "incur";
import type { Logger } from "pino";

import {
  ENVIRONMENT_SERVE_OPERATION,
  loadEnvironmentSource,
} from "../application/environment/environmentSource.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { parseEnvironmentName } from "../config/environmentName.js";
import {
  parseMcpHttpEndpoint,
  type McpHttpEndpoint,
} from "../config/mcpHttpEndpoint.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { createLogger } from "../logger.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

/** Same envelope label as the other JSON-input commands and `parseCliJsonInput`. */
const cliError = (error: AnalysisError): JsonValue => ({
  error: "Application workflow failed",
  ...projectAnalysisError(error),
});

/** The listener announces its URL at info like `rea mcp --http`; an explicit REA_LOG_LEVEL still wins. */
const listenerLogger = (
  environment: Readonly<NodeJS.ProcessEnv>,
  logger: Logger,
): Logger =>
  environment.REA_LOG_LEVEL === undefined
    ? createLogger("cli", "info")
    : logger;

/** Resolve until the one-shot signal requests shutdown. */
const untilAborted = (signal: AbortSignal): Promise<undefined> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else
      signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
  });

/** A listener that could not bind or failed after binding, as the command's typed refusal. */
const transportError = (
  endpoint: McpHttpEndpoint,
  cause: Error,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    ENVIRONMENT_SERVE_OPERATION,
    "transport",
    cause.message,
    { host: endpoint.host, port: endpoint.port },
    {
      cause,
      retryable: false,
      remediationAction:
        "Choose another --port or MCP_PORT, or stop the process using it.",
    },
  );

interface ServeArguments {
  readonly manifest: string;
  readonly evidence: string;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

/** A shutdown requested while the files load ends startup before the listener binds. */
const startupCancelled = (signal: AbortSignal): JsonValue =>
  cliError(
    new AnalysisCancelledError(ENVIRONMENT_SERVE_OPERATION, {
      cause: signal.reason,
    }),
  );

/** Load both Evidence files, bind the listener and run until a signal ends it. */
export const serveEnvironmentCommand = async (
  input: ServeArguments,
  environment: Readonly<NodeJS.ProcessEnv>,
  logger: Logger,
  signal: AbortSignal,
): Promise<JsonValue> => {
  const endpoint = parseMcpHttpEndpoint(environment, {
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.port === undefined ? {} : { port: input.port }),
  });
  if (!endpoint.ok) return cliError(endpoint.error);
  const environmentName = parseEnvironmentName(environment);
  if (!environmentName.ok) return cliError(environmentName.error);
  const manifest = await parseCliJsonInput(
    input.manifest,
    ENVIRONMENT_SERVE_OPERATION,
  );
  if (!manifest.ok) return manifest.error;
  if (signal.aborted) return startupCancelled(signal);
  const evidence = await parseCliJsonInput(
    input.evidence,
    ENVIRONMENT_SERVE_OPERATION,
  );
  if (!evidence.ok) return evidence.error;
  if (signal.aborted) return startupCancelled(signal);
  const source = loadEnvironmentSource(manifest.value, evidence.value);
  if (!source.ok) return cliError(source.error);
  // Loaded here so registering the command catalog never loads the HTTP listener.
  const { serveEnvironment } =
    await import("../server/environment/serveEnvironment.js");
  const { StreamableHttpListenError } =
    await import("../server/http/streamableHttpListenError.js");
  if (signal.aborted) return startupCancelled(signal);
  // A listener that fails after binding ends the command instead of serving nothing.
  let failListener: (error: Error) => void = () => undefined;
  const listenerFailed = new Promise<Error>((resolve) => {
    failListener = resolve;
  });
  let served: Awaited<ReturnType<typeof serveEnvironment>>;
  try {
    served = await serveEnvironment({
      source: source.value,
      ...endpoint.value,
      ...(environmentName.value === undefined
        ? {}
        : { environmentName: environmentName.value }),
      logger: listenerLogger(environment, logger),
      onerror: (error) => failListener(error),
    });
  } catch (cause: unknown) {
    if (!(cause instanceof StreamableHttpListenError)) throw cause;
    return cliError(transportError(endpoint.value, cause));
  }
  let failure: Error | undefined;
  try {
    failure = await Promise.race([untilAborted(signal), listenerFailed]);
  } finally {
    await served.close();
  }
  if (failure !== undefined)
    return cliError(transportError(endpoint.value, failure));
  return {
    status: "stopped",
    url: served.url,
    environment: served.card.name,
    tools: served.card.capabilities.tools.length,
    evidence_id: source.value.evidenceId,
    manifest_evidence_id: source.value.manifestEvidenceId,
  };
};

/** Register the long-running agent environment server command. */
export const registerEnvironmentCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.environmentServe, {
    description:
      "Serve an environment manifest as an agent environment that replays retained capture records over streamable HTTP until SIGINT or SIGTERM",
    args: z.object({
      manifest: z
        .string()
        .describe(
          "Environment manifest Evidence JSON path (inspect-analysis-view environment-manifest output)",
        ),
    }),
    options: z.object({
      evidence: z
        .string()
        .describe(
          "Parent capture Evidence JSON path (inspect-web-network-capture output) the manifest cites",
        ),
      host: z
        .string()
        .min(1)
        .optional()
        .describe("Listener address; default MCP_HOST, else 127.0.0.1"),
      port: z
        .number()
        .int()
        .min(0)
        .max(65535)
        .optional()
        .describe(
          "Listener port; default MCP_PORT, else 0 for an ephemeral port",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.environmentServe, () =>
          serveEnvironmentCommand(
            {
              manifest: args.manifest,
              evidence: options.evidence,
              host: options.host,
              port: options.port,
            },
            environment,
            logger,
            signal,
          ),
        ),
      ),
  });
};
