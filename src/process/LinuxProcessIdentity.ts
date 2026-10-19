import { parseLinuxProcessStat } from "./LinuxProcessStat.js";
import type { ProcessIdentityObservation } from "./ProcessOwnership.js";

const unavailable = (reason: string): ProcessIdentityObservation => ({
  state: "unavailable",
  reason,
});

/** Corroborate a missing procfs record in the caller's native PID namespace. */
export const observeMissingLinuxProcessIdentity = (
  pid: number,
  probe: (pid: number) => boolean,
  signal?: AbortSignal,
): ProcessIdentityObservation => {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return unavailable("invalid_process_id");
  let failure: unknown;
  let present = false;
  try {
    present = probe(pid);
  } catch (cause: unknown) {
    failure = cause;
  }
  signal?.throwIfAborted();
  if (failure instanceof Error && "code" in failure && failure.code === "ESRCH")
    return { state: "absent", reason: "not-found-in-caller-pid-namespace" };
  return unavailable(
    failure === undefined
      ? present
        ? "proc_stat_missing_but_process_signal_probe_succeeded"
        : "proc_stat_missing_and_process_signal_probe_returned_false"
      : `proc_stat_missing_and_process_signal_probe_failed: ${failure instanceof Error ? failure.message : String(failure)}`,
  );
};

/** Parse native identity and membership from one synchronous procfs observation. */
export const observeLinuxProcessIdentity = (
  pid: number,
  host: {
    readonly readStat: (pid: number) => string;
    readonly probe: (pid: number) => boolean;
  },
  signal?: AbortSignal,
): ProcessIdentityObservation => {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return unavailable("invalid_process_id");
  try {
    const stat = host.readStat(pid);
    signal?.throwIfAborted();
    const parsed = parseLinuxProcessStat(stat);
    return parsed === undefined || parsed.pid !== pid
      ? unavailable("malformed_proc_stat")
      : {
          state: "readable",
          identity: `linux-starttime:${parsed.startTime}`,
          lifecycle: { state: "observed", lifecycle: parsed.lifecycle },
          relation: {
            state: "observed",
            parentPid: parsed.parentPid,
            processGroupId: parsed.processGroupId,
          },
        };
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    return cause instanceof Error &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ESRCH")
      ? observeMissingLinuxProcessIdentity(pid, host.probe, signal)
      : unavailable(cause instanceof Error ? cause.message : String(cause));
  }
};
