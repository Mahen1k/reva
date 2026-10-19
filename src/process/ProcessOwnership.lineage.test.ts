import { expect, it, vi } from "vitest";

import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
  type ProcessIdentityObservation,
  type ProcessOwnershipHost,
  type ProcessTableEntry,
} from "./ProcessOwnership.js";
import { ProcessOwnershipEvidenceOwner } from "./ProcessOwnershipEvidence.js";
import { observeOwnedProcessLineage } from "./ProcessOwnershipObservation.js";

const launcher: ProcessTableEntry = {
  pid: 100,
  parentPid: 1,
  processGroupId: 100,
  state: "S",
  command: "launcher",
};
const child: ProcessTableEntry = {
  ...launcher,
  pid: 101,
  parentPid: 100,
  command: "child",
};
const grandchild: ProcessTableEntry = {
  ...child,
  pid: 102,
  parentPid: 101,
  command: "grandchild",
};

const nativeIdentity = (
  row: ProcessTableEntry,
): Extract<ProcessIdentityObservation, { readonly state: "readable" }> => ({
  state: "readable",
  identity: `start-${String(row.pid)}`,
  lifecycle: { state: "observed", lifecycle: "non-zombie" },
  relation: {
    state: "observed",
    parentPid: row.parentPid,
    processGroupId: row.processGroupId,
  },
});

it.each([
  { missing: "identity", token: "matching" },
  { missing: "relation", token: "matching" },
  { missing: "relation", token: "unavailable" },
  { missing: "relation", token: "foreign" },
] as const)(
  "retains descendants with an unreadable native $missing and $token token through table omission",
  async ({ missing, token }) => {
    const evidenceOwner = new ProcessOwnershipEvidenceOwner();
    const ownership = {
      runId: "run",
      leaderPid: launcher.pid,
      processGroupId: launcher.processGroupId,
      sweepTokenOwnedProcesses: true as const,
      evidenceOwner,
    };
    let phase: "observing" | "omitted" | "exited" = "observing";
    const identityReads: number[][] = [];
    const signalGroup = vi.fn();
    const host: ProcessOwnershipHost = {
      listProcesses: async () =>
        phase === "observing" ? [launcher, child, grandchild] : [],
      environment: async () => ({ REA_PROCESS_RUN_ID: ownership.runId }),
      runTokens: async (rows) =>
        new Map(
          rows.map(({ pid }) => [
            pid,
            pid === child.pid && token === "unavailable"
              ? { state: "unavailable" as const, reason: "token denied" }
              : {
                  state: "readable" as const,
                  runId:
                    pid === child.pid && token === "foreign"
                      ? "foreign"
                      : ownership.runId,
                },
          ]),
        ),
      processIdentities: async (rows) => {
        identityReads.push(rows.map(({ pid }) => pid));
        return new Map(
          rows.map((row): [number, ProcessIdentityObservation] => {
            if (
              phase === "exited" ||
              (phase === "omitted" && row.pid !== child.pid)
            )
              return [row.pid, { state: "absent", reason: "not-in-snapshot" }];
            if (row.pid !== child.pid) return [row.pid, nativeIdentity(row)];
            if (missing === "identity")
              return [
                row.pid,
                { state: "unavailable", reason: "native identity denied" },
              ];
            return [
              row.pid,
              {
                ...nativeIdentity(row),
                relation: { state: "unavailable", reason: "relation denied" },
              },
            ];
          }),
        );
      },
      signalGroup,
    };

    await expect(
      observeOwnedProcessLineage(ownership, host),
    ).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(evidenceOwner.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: child.pid }),
        expect.objectContaining({
          pid: grandchild.pid,
          applicability: "token-verified",
        }),
      ]),
    );
    if (token !== "matching")
      expect(evidenceOwner.candidates).toContainEqual(
        expect.objectContaining({
          pid: child.pid,
          identity: "start-101",
          applicability: "related-ownership-unresolved",
          scopeEvidence: "unverified-table-relation",
        }),
      );

    phase = "omitted";
    identityReads.length = 0;
    await expect(
      cleanupOwnedProcessGroup(ownership, host),
    ).resolves.toMatchObject({
      cleaned: false,
      failures: [
        expect.objectContaining({
          pid: child.pid,
          reason:
            token === "unavailable"
              ? "environment-unreadable"
              : token === "foreign"
                ? "run-token-mismatch"
                : "process-identity-unavailable",
        }),
      ],
    });
    expect(identityReads.flat()).toContain(child.pid);
    expect(evidenceOwner.candidates).toHaveLength(1);

    phase = "exited";
    await expect(cleanupOwnedProcessGroup(ownership, host)).resolves.toEqual({
      cleaned: true,
      signaled: false,
    });
    expect(evidenceOwner.candidates).toEqual([]);
    expect(signalGroup).not.toHaveBeenCalled();
  },
);

it("retains a live native descendant behind an exited table ancestor", async () => {
  const evidenceOwner = new ProcessOwnershipEvidenceOwner();
  const tokenReads: number[] = [];
  const host: ProcessOwnershipHost = {
    listProcesses: async () => [launcher, child, grandchild],
    environment: async (pid) => {
      tokenReads.push(pid);
      return { REA_PROCESS_RUN_ID: "run" };
    },
    processIdentities: async (rows) =>
      new Map(
        rows.map((row): [number, ProcessIdentityObservation] => [
          row.pid,
          row.pid === child.pid
            ? { state: "absent", reason: "not-in-snapshot" }
            : nativeIdentity(row),
        ]),
      ),
    signalGroup: vi.fn(),
  };

  await expect(
    observeOwnedProcessLineage(
      { runId: "run", leaderPid: 100, processGroupId: 100, evidenceOwner },
      host,
    ),
  ).resolves.toMatchObject({ status: "unavailable" });
  expect(tokenReads).toContain(grandchild.pid);
  expect(evidenceOwner.candidates).toContainEqual(
    expect.objectContaining({
      pid: grandchild.pid,
      applicability: "token-verified",
    }),
  );
  expect(evidenceOwner.candidates.map(({ pid }) => pid)).not.toContain(
    child.pid,
  );
});

it.each(["unavailable-relation", "absent"] as const)(
  "retains detached unreadable descendants through an ancestor with %s native facts",
  async (ancestor) => {
    const evidenceOwner = new ProcessOwnershipEvidenceOwner();
    const ownership = {
      runId: "run",
      leaderPid: 100,
      processGroupId: 100,
      evidenceOwner,
    };
    const detached = { ...grandchild, processGroupId: grandchild.pid };
    let omitted = false;
    const host: ProcessOwnershipHost = {
      listProcesses: async () => (omitted ? [] : [launcher, child, detached]),
      environment: async () => ({}),
      runTokens: async (rows) =>
        new Map(
          rows.map(({ pid }) => [
            pid,
            pid === launcher.pid
              ? { state: "readable" as const, runId: "run" }
              : { state: "unavailable" as const, reason: "token denied" },
          ]),
        ),
      processIdentities: async (rows) =>
        new Map(
          rows.map((row): [number, ProcessIdentityObservation] => [
            row.pid,
            (omitted && row.pid === launcher.pid) ||
            (ancestor === "absent" && row.pid === child.pid)
              ? { state: "absent", reason: "not-in-snapshot" }
              : row.pid === child.pid
                ? {
                    ...nativeIdentity(row),
                    relation: {
                      state: "unavailable",
                      reason: "relation denied",
                    },
                  }
                : nativeIdentity(row),
          ]),
        ),
      signalGroup: vi.fn(),
    };

    await expect(
      observeOwnedProcessLineage(ownership, host),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(evidenceOwner.candidates).toContainEqual(
      expect.objectContaining({
        pid: grandchild.pid,
        identity: "start-102",
        applicability: "related-ownership-unresolved",
        scopeEvidence: "unverified-table-relation",
      }),
    );

    omitted = true;
    await expect(
      verifyNoTokenOwnedProcesses("run", host, [], ownership),
    ).resolves.toMatchObject({
      cleaned: false,
      failures: expect.arrayContaining([
        expect.objectContaining({
          pid: grandchild.pid,
          reason: "environment-unreadable",
        }),
      ]),
    });
    expect(host.signalGroup).not.toHaveBeenCalled();
  },
);

it("retains a verified child before rejecting an unreadable launcher identity", async () => {
  const evidenceOwner = new ProcessOwnershipEvidenceOwner();
  const host: ProcessOwnershipHost = {
    listProcesses: async () => [launcher, child],
    environment: async () => ({ REA_PROCESS_RUN_ID: "run" }),
    processIdentities: async (rows) =>
      new Map(
        rows.map((row): [number, ProcessIdentityObservation] => [
          row.pid,
          row.pid === launcher.pid
            ? { state: "unavailable", reason: "native identity denied" }
            : nativeIdentity(row),
        ]),
      ),
    signalGroup: vi.fn(),
  };

  await expect(
    observeOwnedProcessLineage(
      { runId: "run", leaderPid: 100, processGroupId: 100, evidenceOwner },
      host,
    ),
  ).resolves.toMatchObject({ status: "unavailable" });
  expect(evidenceOwner.candidates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        pid: launcher.pid,
        applicability: "identity-unresolved",
      }),
      expect.objectContaining({
        pid: child.pid,
        applicability: "token-verified",
      }),
    ]),
  );
});

it("uses a readable native relation to exclude a stale table descendant", async () => {
  const evidenceOwner = new ProcessOwnershipEvidenceOwner();
  const tokenReads: number[] = [];
  const host: ProcessOwnershipHost = {
    listProcesses: async () => [launcher, child],
    environment: async (pid) => {
      tokenReads.push(pid);
      return { REA_PROCESS_RUN_ID: pid === launcher.pid ? "run" : "foreign" };
    },
    processIdentities: async (rows) =>
      new Map(
        rows.map((row) => [
          row.pid,
          nativeIdentity(
            row.pid === child.pid
              ? { ...row, parentPid: 1, processGroupId: 200 }
              : row,
          ),
        ]),
      ),
    signalGroup: vi.fn(),
  };

  await expect(
    observeOwnedProcessLineage(
      { runId: "run", leaderPid: 100, processGroupId: 100, evidenceOwner },
      host,
    ),
  ).resolves.toMatchObject({
    status: "verified",
    lineage: { descendants: [] },
  });
  expect(tokenReads).toEqual([launcher.pid]);
  expect(evidenceOwner.candidates.map(({ pid }) => pid)).toEqual([
    launcher.pid,
  ]);
});

it("does not retain table scope after a native relation resolves as unrelated", async () => {
  const evidenceOwner = new ProcessOwnershipEvidenceOwner();
  let identityReads = 0;
  const host: ProcessOwnershipHost = {
    listProcesses: async () => [launcher, child],
    environment: async (pid) => ({
      REA_PROCESS_RUN_ID: pid === launcher.pid ? "run" : "foreign",
    }),
    processIdentities: async (rows) => {
      identityReads += 1;
      return new Map(
        rows.map((row): [number, ProcessIdentityObservation] => [
          row.pid,
          row.pid !== child.pid
            ? nativeIdentity(row)
            : identityReads === 1
              ? {
                  ...nativeIdentity(row),
                  relation: { state: "unavailable", reason: "relation denied" },
                }
              : nativeIdentity({ ...row, parentPid: 1, processGroupId: 200 }),
        ]),
      );
    },
    signalGroup: vi.fn(),
  };

  await expect(
    observeOwnedProcessLineage(
      { runId: "run", leaderPid: 100, processGroupId: 100, evidenceOwner },
      host,
    ),
  ).resolves.toMatchObject({ status: "unavailable" });
  expect(evidenceOwner.candidates.map(({ pid }) => pid)).toEqual([
    launcher.pid,
  ]);
});
