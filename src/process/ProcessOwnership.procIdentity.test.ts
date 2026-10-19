import { expect, it, vi } from "vitest";

import { observeLinuxProcessIdentity } from "./LinuxProcessIdentity.js";

const filesystemError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });

const fixture = () => {
  const readStat = vi.fn<(pid: number) => string>();
  const probe = vi.fn<(pid: number) => boolean>();
  return {
    readStat,
    probe,
    observe: (signal?: AbortSignal) =>
      observeLinuxProcessIdentity(42, { readStat, probe }, signal),
  };
};

it("reports absence only when /proc lookup and signal-zero both report ESRCH", () => {
  const host = fixture();
  host.probe.mockImplementation(() => {
    throw filesystemError("ESRCH");
  });
  for (const code of ["ENOENT", "ESRCH"]) {
    host.readStat.mockImplementationOnce(() => {
      throw filesystemError(code);
    });
    expect(host.observe()).toEqual({
      state: "absent",
      reason: "not-found-in-caller-pid-namespace",
    });
  }
  expect(host.probe).toHaveBeenCalledTimes(2);
  expect(host.probe).toHaveBeenNthCalledWith(1, 42);
});

it("keeps hidden or permission-denied live PIDs unavailable", () => {
  const host = fixture();
  host.readStat.mockImplementation(() => {
    throw filesystemError("ENOENT");
  });
  host.probe.mockReturnValueOnce(true);
  expect(host.observe()).toEqual({
    state: "unavailable",
    reason: "proc_stat_missing_but_process_signal_probe_succeeded",
  });
  host.probe.mockImplementationOnce(() => {
    throw filesystemError("EPERM");
  });
  expect(host.observe()).toMatchObject({
    state: "unavailable",
    reason: expect.stringContaining("EPERM"),
  });
  host.probe.mockReturnValueOnce(false);
  expect(host.observe()).toMatchObject({
    state: "unavailable",
    reason: "proc_stat_missing_and_process_signal_probe_returned_false",
  });
});

it("keeps permission, parser, and unexpected failures unavailable", () => {
  const host = fixture();
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    host.readStat.mockImplementationOnce(() => {
      throw filesystemError(code);
    });
    expect(host.observe()).toMatchObject({ state: "unavailable" });
  }
  host.readStat.mockReturnValueOnce("42 (fixture) S malformed");
  expect(host.observe()).toEqual({
    state: "unavailable",
    reason: "malformed_proc_stat",
  });
  expect(host.probe).not.toHaveBeenCalled();
});

it("rejects invalid PIDs before procfs lookup or signal probing", () => {
  const host = fixture();
  expect(observeLinuxProcessIdentity(0, host)).toEqual({
    state: "unavailable",
    reason: "invalid_process_id",
  });
  expect(host.readStat).not.toHaveBeenCalled();
  expect(host.probe).not.toHaveBeenCalled();
});

it("preserves cancellation before and after the signal-zero probe", () => {
  const host = fixture();
  const controller = new AbortController();
  const reason = Object.assign(new Error("cancelled"), { name: "AbortError" });
  controller.abort(reason);
  expect(() => host.observe(controller.signal)).toThrow(reason);
  expect(host.readStat).not.toHaveBeenCalled();
  const afterProbe = new AbortController();
  host.readStat.mockImplementationOnce(() => {
    throw filesystemError("ENOENT");
  });
  host.probe.mockImplementationOnce(() => {
    afterProbe.abort(reason);
    throw filesystemError("ESRCH");
  });
  expect(() => host.observe(afterProbe.signal)).toThrow(reason);
});

it("preserves native generation, lifecycle, and relation without consulting process rows", () => {
  const fields = [
    "Z",
    "7",
    "8",
    "9",
    ...Array.from({ length: 15 }, () => "0"),
    "123",
  ];
  const host = fixture();
  host.readStat.mockReturnValueOnce(`42 (fixture ) old) ${fields.join(" ")}`);
  expect(host.observe()).toEqual({
    state: "readable",
    identity: "linux-starttime:123",
    lifecycle: { state: "observed", lifecycle: "zombie" },
    relation: { state: "observed", parentPid: 7, processGroupId: 8 },
  });
  host.readStat.mockReturnValueOnce(`43 (fixture) ${fields.join(" ")}`);
  expect(host.observe()).toEqual({
    state: "unavailable",
    reason: "malformed_proc_stat",
  });
  expect(host.probe).not.toHaveBeenCalled();
});

it("preserves exact cancellation when a successful native read completes after abort", () => {
  const host = fixture();
  const controller = new AbortController();
  const reason = { caller: "native identity cancellation" };
  host.readStat.mockImplementationOnce(() => {
    controller.abort(reason);
    return "ignored";
  });
  let caught: unknown;
  try {
    host.observe(controller.signal);
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBe(reason);
  expect(host.probe).not.toHaveBeenCalled();
});
