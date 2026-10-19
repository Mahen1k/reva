import { expect, it } from "vitest";

import {
  assertHistoricalPidAccess,
  ownershipInventory,
} from "../../../scripts/verify/recorded-crash/trace-policy.mjs";

const assertHistoricalPidReadsAreOwnershipOnly = (input: {
  readonly traces: readonly { readonly pid: number; readonly text: string }[];
  readonly sentinelPid: number;
  readonly psExecutables: ReadonlySet<string>;
}) => {
  const traces = input.traces.map((trace) =>
    trace.pid === 1200
      ? {
          ...trace,
          text: 'execve("/fixture/node", ["node"], 0x1) = 0\n' + trace.text,
        }
      : trace,
  );
  const { nodeThreads, psPids } = ownershipInventory(
    traces,
    "/fixture/node",
    input.psExecutables,
  );
  return traces.flatMap((trace) =>
    assertHistoricalPidAccess({
      trace,
      historicalPid: input.sentinelPid,
      nodeThreads,
      liveCollision: true,
      psInventory: psPids.has(trace.pid),
    }),
  );
};

const psExec =
  'execve("/usr/bin/ps", ["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="], 0x7fff) = 0';

it("correlates the ps child trace with its parent identity read", () => {
  const ownershipReads = assertHistoricalPidReadsAreOwnershipOnly({
    sentinelPid: 4008,
    psExecutables: new Set(["/usr/bin/ps"]),
    traces: [
      {
        pid: 1200,
        text: [
          "vfork() = 1201",
          "clone3({flags=CLONE_VM|CLONE_SIGHAND|CLONE_THREAD}, 88) = 1202",
          'openat(AT_FDCWD, "/proc/4008/stat", O_RDONLY|O_CLOEXEC) = 21',
        ].join("\n"),
      },
      {
        pid: 1202,
        text: [
          'openat(AT_FDCWD, "/proc/4008/stat", O_RDONLY|O_CLOEXEC) = 21',
          'openat(AT_FDCWD, "/proc/4008/status", O_RDONLY|O_CLOEXEC) = 22',
        ].join("\n"),
      },
      {
        pid: 1201,
        text: [
          psExec,
          'openat(AT_FDCWD, "/proc/4008/status", O_RDONLY) = 3',
          'openat(AT_FDCWD, "/proc/4008/cmdline", O_RDONLY) = 4',
        ].join("\n"),
      },
    ],
  });

  expect(ownershipReads).toHaveLength(5);
});

it("joins unfinished and resumed CLONE_THREAD records", () => {
  const ownershipReads = assertHistoricalPidReadsAreOwnershipOnly({
    sentinelPid: 4008,
    psExecutables: new Set(["/usr/bin/ps"]),
    traces: [
      {
        pid: 1200,
        text: [
          "vfork() = 1201",
          "clone3({flags=CLONE_VM|CLONE_SIGHAND|CLONE_THREAD, child_tid=0x3 <unfinished ...>",
          "<... clone3 resumed>) = 1202",
        ].join("\n"),
      },
      {
        pid: 1202,
        text: 'openat(AT_FDCWD, "/proc/4008/stat", O_RDONLY) = 3',
      },
      { pid: 1201, text: psExec },
    ],
  });

  expect(ownershipReads).toHaveLength(1);
});

it("rejects provider-style reads outside the ps child and stat/status caller", () => {
  const traces = [
    {
      pid: 1200,
      text: [
        "vfork() = 1201",
        'openat(AT_FDCWD, "/proc/4008/cmdline", O_RDONLY) = 21',
      ].join("\n"),
    },
    { pid: 1201, text: psExec },
  ];

  expect(() =>
    assertHistoricalPidReadsAreOwnershipOnly({
      traces,
      sentinelPid: 4008,
      psExecutables: new Set(["/usr/bin/ps"]),
    }),
  ).toThrow("Historical PID caused a non-inventory lookup");
});

it("does not trust a ps command with different arguments or failed exec", () => {
  for (const text of [
    'execve("/usr/bin/ps", ["ps", "-ef"], 0x7fff) = 0',
    psExec.replace(" = 0", " = -1 EACCES"),
  ])
    expect(() =>
      assertHistoricalPidReadsAreOwnershipOnly({
        sentinelPid: 4008,
        psExecutables: new Set(["/usr/bin/ps"]),
        traces: [
          {
            pid: 1200,
            text: `vfork() = 1201\nopenat(AT_FDCWD, "/proc/4008/stat", O_RDONLY) = 3`,
          },
          { pid: 1201, text },
        ],
      }),
    ).toThrow("Historical PID caused a non-inventory lookup");
});

it("allows only known procfs fields inside the exact ps child", () => {
  expect(() =>
    assertHistoricalPidReadsAreOwnershipOnly({
      sentinelPid: 4008,
      psExecutables: new Set(["/usr/bin/ps"]),
      traces: [
        { pid: 1200, text: "vfork() = 1201" },
        {
          pid: 1201,
          text: `${psExec}\nopenat(AT_FDCWD, "/proc/4008/exe", O_RDONLY) = 3`,
        },
      ],
    }),
  ).toThrow("Historical PID caused a non-inventory lookup");
});

it("does not grant the ownership process thread permit to a forked child", () => {
  for (const field of ["stat", "status"])
    expect(() =>
      assertHistoricalPidReadsAreOwnershipOnly({
        sentinelPid: 4008,
        psExecutables: new Set(["/usr/bin/ps"]),
        traces: [
          {
            pid: 1200,
            text: ["vfork() = 1201", "clone3({flags=SIGCHLD}, 88) = 1203"].join(
              "\n",
            ),
          },
          { pid: 1201, text: psExec },
          {
            pid: 1203,
            text: `openat(AT_FDCWD, "/proc/4008/${field}", O_RDONLY) = 3`,
          },
        ],
      }),
    ).toThrow("Historical PID caused a non-inventory lookup");
});
