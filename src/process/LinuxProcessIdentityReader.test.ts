import { afterEach, expect, it, vi } from "vitest";

const command = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./ExecFileOutput.js", () => ({ execFileOutput: command.execute }));

import { readLinuxProcessIdentities } from "./LinuxProcessIdentityReader.js";
import type { ProcessTableEntry } from "./ProcessOwnership.js";

const row: ProcessTableEntry = {
  pid: 42,
  parentPid: 1,
  processGroupId: 42,
  state: "S",
  command: "caller-provided-row",
};
const observation = {
  state: "readable",
  identity: "linux-starttime:123",
  lifecycle: { state: "observed", lifecycle: "non-zombie" },
  relation: { state: "observed", parentPid: 7, processGroupId: 8 },
} as const;
const output = (observations: readonly unknown[]) => ({
  stdout: JSON.stringify({
    protocol: "linux-process-identities/v1",
    observations,
  }),
});
afterEach(() => {
  command.execute.mockReset();
  vi.restoreAllMocks();
});

it("selects requested rows from a global snapshot without passing any requested PID", async () => {
  command.execute.mockResolvedValue(
    output([
      { pid: 42, observation },
      { pid: 123, observation },
    ]),
  );
  const environment = { PATH: "/authored/helper-path" };
  await expect(readLinuxProcessIdentities([row], environment)).resolves.toEqual(
    new Map([[42, observation]]),
  );
  expect(command.execute).toHaveBeenCalledWith(
    process.execPath,
    [
      "--import",
      expect.stringMatching(/tsx/u),
      expect.stringMatching(/LinuxProcessIdentityObserverMain\.ts$/u),
      "--global-identities",
    ],
    {
      env: environment,
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      stopSignal: "SIGTERM",
    },
  );
});

it("does not launch for empty or invalid-only requests", async () => {
  await expect(readLinuxProcessIdentities([], {})).resolves.toEqual(new Map());
  await expect(
    readLinuxProcessIdentities([{ ...row, pid: 0 }], {}),
  ).resolves.toEqual(
    new Map([[0, { state: "unavailable", reason: "invalid_process_id" }]]),
  );
  expect(command.execute).not.toHaveBeenCalled();
});

it("preserves explicit native absence and unavailable facts without signal probing", async () => {
  const absent = {
    state: "absent",
    reason: "not-found-in-caller-pid-namespace",
  };
  const unknown = {
    state: "unavailable",
    reason: "authored native permission failure",
  };
  command.execute.mockResolvedValue(
    output([
      { pid: 42, observation: absent },
      { pid: 43, observation: unknown },
    ]),
  );
  const probe = vi.spyOn(process, "kill");
  await expect(
    readLinuxProcessIdentities([row, { ...row, pid: 43 }], {}),
  ).resolves.toEqual(
    new Map([
      [42, absent],
      [43, unknown],
    ]),
  );
  expect(probe).not.toHaveBeenCalled();
});

it.each([
  "not JSON",
  JSON.stringify({ protocol: "other", observations: [] }),
  JSON.stringify({
    protocol: "linux-process-identities/v1",
    observations: [],
    extra: true,
  }),
  output([
    { pid: 42, observation },
    { pid: 42, observation },
  ]).stdout,
  output([
    {
      pid: 42,
      observation: { state: "readable", identity: "unsafe incomplete fact" },
    },
  ]).stdout,
  output([{ pid: 0, observation }]).stdout,
  output([
    { pid: 42, observation: { state: "absent", reason: "process-not-listed" } },
  ]).stdout,
])("keeps malformed global response unavailable: %s", async (stdout) => {
  command.execute.mockResolvedValue({ stdout });
  const probe = vi.spyOn(process, "kill");
  await expect(readLinuxProcessIdentities([row], {})).resolves.toEqual(
    new Map([
      [
        42,
        {
          state: "unavailable",
          reason: expect.stringContaining(
            "linux_process_identity_reader_failed",
          ),
        },
      ],
    ]),
  );
  expect(probe).not.toHaveBeenCalled();
});

it("corroborates missing rows with signal-zero and keeps permission failures unknown", async () => {
  command.execute.mockResolvedValue(output([]));
  const probe = vi.spyOn(process, "kill");
  probe.mockImplementationOnce(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await expect(readLinuxProcessIdentities([row], {})).resolves.toEqual(
    new Map([
      [42, { state: "absent", reason: "not-found-in-caller-pid-namespace" }],
    ]),
  );
  probe.mockReturnValueOnce(true);
  await expect(readLinuxProcessIdentities([row], {})).resolves.toEqual(
    new Map([
      [
        42,
        {
          state: "unavailable",
          reason: "proc_stat_missing_but_process_signal_probe_succeeded",
        },
      ],
    ]),
  );
  probe.mockImplementationOnce(() => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  });
  await expect(readLinuxProcessIdentities([row], {})).resolves.toEqual(
    new Map([
      [42, { state: "unavailable", reason: expect.stringContaining("EPERM") }],
    ]),
  );
});

it("keeps command failures unavailable without probing or falling back to parent procfs", async () => {
  command.execute.mockRejectedValue(new Error("authored helper failure"));
  const probe = vi.spyOn(process, "kill");
  await expect(readLinuxProcessIdentities([row], {})).resolves.toEqual(
    new Map([
      [
        42,
        {
          state: "unavailable",
          reason:
            "linux_process_identity_reader_failed: authored helper failure",
        },
      ],
    ]),
  );
  expect(probe).not.toHaveBeenCalled();
});

it("preserves exact cancellation before launch and after command settlement", async () => {
  const controller = new AbortController();
  const reason = { caller: "cancel native snapshot" };
  controller.abort(reason);
  await expect(
    readLinuxProcessIdentities([row], {}, controller.signal),
  ).rejects.toBe(reason);
  expect(command.execute).not.toHaveBeenCalled();
  const after = new AbortController();
  command.execute.mockImplementationOnce(async () => {
    after.abort(reason);
    return output([{ pid: 42, observation }]);
  });
  await expect(
    readLinuxProcessIdentities([row], {}, after.signal),
  ).rejects.toBe(reason);
  expect(command.execute.mock.calls[0]?.[2]?.signal).toBe(after.signal);
});

it("preserves cancellation through a rejected helper and a missing-row probe", async () => {
  const commandAbort = new AbortController();
  const reason = { caller: "cancel during native helper" };
  command.execute.mockImplementationOnce(async () => {
    commandAbort.abort(reason);
    throw new Error("stopped helper");
  });
  await expect(
    readLinuxProcessIdentities([row], {}, commandAbort.signal),
  ).rejects.toBe(reason);
  const probeAbort = new AbortController();
  command.execute.mockResolvedValueOnce(output([]));
  vi.spyOn(process, "kill").mockImplementationOnce(() => {
    probeAbort.abort(reason);
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await expect(
    readLinuxProcessIdentities([row], {}, probeAbort.signal),
  ).rejects.toBe(reason);
});
