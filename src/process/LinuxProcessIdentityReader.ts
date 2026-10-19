import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import { safeParseJson } from "../domain/safeJson.js";
import { execFileOutput } from "./ExecFileOutput.js";
import { observeMissingLinuxProcessIdentity } from "./LinuxProcessIdentity.js";
import type {
  ProcessIdentityObservation,
  ProcessTableEntry,
} from "./ProcessOwnership.js";

const nativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const unavailableSchema = z.strictObject({
  state: z.literal("unavailable"),
  reason: z.string().min(1),
});
const observationSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("readable"),
    identity: z.string().regex(/^linux-starttime:\d+$/u),
    lifecycle: z.discriminatedUnion("state", [
      z.strictObject({
        state: z.literal("observed"),
        lifecycle: z.enum(["non-zombie", "zombie"]),
      }),
      unavailableSchema,
    ]),
    relation: z.discriminatedUnion("state", [
      z.strictObject({
        state: z.literal("observed"),
        parentPid: nativeInteger,
        processGroupId: nativeInteger,
      }),
      unavailableSchema,
    ]),
  }),
  z.strictObject({
    state: z.literal("absent"),
    reason: z.literal("not-found-in-caller-pid-namespace"),
  }),
  unavailableSchema,
]);
const responseSchema = z.strictObject({
  protocol: z.literal("linux-process-identities/v1"),
  observations: z.array(
    z.strictObject({
      pid: nativeInteger.min(1),
      observation: observationSchema,
    }),
  ),
});

/** Read an independent global native snapshot, then select the caller's rows. */
export const readLinuxProcessIdentities = async (
  processes: readonly ProcessTableEntry[],
  hostEnvironment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, ProcessIdentityObservation>> => {
  signal?.throwIfAborted();
  const selected = new Map<number, ProcessIdentityObservation>();
  const requested = new Set<number>();
  for (const { pid } of processes)
    if (!Number.isSafeInteger(pid) || pid <= 0)
      selected.set(pid, { state: "unavailable", reason: "invalid_process_id" });
    else requested.add(pid);
  if (requested.size === 0) return selected;
  try {
    const { stdout } = await execFileOutput(
      process.execPath,
      fileURLToPath(import.meta.url).endsWith(".ts")
        ? [
            "--import",
            pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm"))
              .href,
            fileURLToPath(
              new URL("./LinuxProcessIdentityObserverMain.ts", import.meta.url),
            ),
            "--global-identities",
          ]
        : [
            fileURLToPath(
              new URL("./LinuxProcessIdentityObserverMain.js", import.meta.url),
            ),
            "--global-identities",
          ],
      {
        env: hostEnvironment,
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
        stopSignal: "SIGTERM",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    signal?.throwIfAborted();
    const decoded = safeParseJson(stdout);
    if (!decoded.ok)
      throw new Error("Linux process identity helper returned invalid JSON");
    const parsed = responseSchema.safeParse(decoded.value);
    if (!parsed.success)
      throw new Error(
        "Linux process identity helper returned an invalid protocol response",
      );
    const observed = new Map<number, ProcessIdentityObservation>();
    for (const { pid, observation } of parsed.data.observations) {
      if (observed.has(pid))
        throw new Error(
          "Linux process identity helper returned duplicate PIDs",
        );
      observed.set(pid, observation);
    }
    for (const pid of requested)
      selected.set(
        pid,
        observed.get(pid) ??
          observeMissingLinuxProcessIdentity(
            pid,
            (candidate) => process.kill(candidate, 0),
            signal,
          ),
      );
    signal?.throwIfAborted();
    return selected;
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    const diagnostic = cause instanceof Error ? cause.message : String(cause);
    for (const pid of requested)
      selected.set(pid, {
        state: "unavailable",
        reason: `linux_process_identity_reader_failed: ${diagnostic}`,
      });
    return selected;
  }
};
