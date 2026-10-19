import { expect, it } from "vitest";

import {
  traceExecution,
  verifyHistoricalPidReads,
} from "../../../scripts/verify/recorded-crash/trace-ownership.mjs";

const options = {
  sentinelPid: 42,
  psPaths: new Set(["/usr/bin/ps"]),
  identityExecutable: "/usr/bin/node",
  identityHelper: "/package/dist/process/LinuxProcessIdentityObserverMain.js",
};
const exec = (
  arguments_: readonly string[],
  executable = "/usr/bin/node",
  result = "0",
) =>
  `execve(${JSON.stringify(executable)}, ${JSON.stringify(arguments_)}, 0x123 /* 2 vars */) = ${result}`;
const identityArguments = [
  options.identityExecutable,
  options.identityHelper,
  "--global-identities",
];
const identity = () => exec(identityArguments);
const enumeration = [
  'openat(AT_FDCWD, "/proc", O_RDONLY|O_DIRECTORY|O_CLOEXEC) = 17',
  'getdents64(17, [{d_ino=1, d_name="."}, {d_ino=42, d_name="42"}], 32768) = 80',
] as const;
const read = (path = "stat", flags = "O_RDONLY|O_CLOEXEC") =>
  `openat(AT_FDCWD, "/proc/42/${path}", ${flags}) = 21`;
const trace = (pid: number, lines: readonly string[]) => ({
  pid,
  file: `trace.${pid}`,
  text: lines.join("\n"),
});

it("decodes exact escaped observer argv without accepting truncation", () => {
  const source = "const x='quoted';\nreadFile('/proc/'+pid+'/stat');";
  expect(traceExecution(exec(["node", "-e", source]))).toMatchObject({
    arguments: ["node", "-e", source],
    successful: true,
  });
  expect(
    traceExecution(
      'execve("/usr/bin/node", ["node", "-e", "source"...], 0x0) = 0',
    ),
  ).toBeUndefined();
});

it("accepts stat reads only after the fixed observer globally enumerates proc", () => {
  expect(
    verifyHistoricalPidReads(
      [trace(100, [identity(), ...enumeration, read()])],
      options,
    ),
  ).toEqual([{ actor: 100, observer: "native-identities", syscall: read() }]);
});

it("joins completed unfinished directory reads without granting thread authority", () => {
  expect(
    verifyHistoricalPidReads(
      [
        trace(100, [
          identity(),
          enumeration[0],
          "getdents64(17,  <unfinished ...>",
          '<... getdents64 resumed>[{d_ino=42, d_name="42"}], 32768) = 80',
          read(),
        ]),
      ],
      options,
    ),
  ).toHaveLength(1);
});

it.each([
  ["root Node", [trace(100, [exec(["/usr/bin/node", "cli.mjs"]), read()])]],
  [
    "provider",
    [trace(100, [exec(["python", "provider.py"], "/usr/bin/python"), read()])],
  ],
  [
    "wrong observer helper",
    [
      trace(100, [
        exec([
          options.identityExecutable,
          "/tmp/helper.js",
          "--global-identities",
        ]),
        ...enumeration,
        read(),
      ]),
    ],
  ],
  [
    "wrong observer executable",
    [
      trace(100, [
        exec(identityArguments, "/tmp/node"),
        ...enumeration,
        read(),
      ]),
    ],
  ],
  [
    "failed exec",
    [
      trace(100, [
        exec(identityArguments, "/usr/bin/node", "-1 EACCES"),
        ...enumeration,
        read(),
      ]),
    ],
  ],
  [
    "PID-selecting argument",
    [trace(100, [exec([...identityArguments, "42"]), ...enumeration, read()])],
  ],
  [
    "extra argv",
    [
      trace(100, [
        exec([...identityArguments, "extra"]),
        ...enumeration,
        read(),
      ]),
    ],
  ],
  [
    "wrong mode",
    [
      trace(100, [
        exec([options.identityExecutable, options.identityHelper, "--pid"]),
        ...enumeration,
        read(),
      ]),
    ],
  ],
  ["missing global enumeration", [trace(100, [identity(), read()])]],
  [
    "unrelated directory descriptor",
    [
      trace(100, [
        identity(),
        enumeration[0],
        'getdents64(18, [{d_name="42"}], 32768) = 80',
        read(),
      ]),
    ],
  ],
  [
    "empty enumeration result",
    [
      trace(100, [
        identity(),
        enumeration[0],
        "getdents64(17, [], 32768) = 0",
        read(),
      ]),
    ],
  ],
  [
    "read before enumeration",
    [trace(100, [identity(), read(), ...enumeration])],
  ],
  ["unobserved worker", [trace(100, [identity()]), trace(101, [read()])]],
  [
    "forked child",
    [
      trace(100, [
        identity(),
        ...enumeration,
        "clone(child_stack=NULL, flags=SIGCHLD) = 101",
      ]),
      trace(101, [read()]),
    ],
  ],
  [
    "shared-VM child without thread",
    [
      trace(100, [
        identity(),
        ...enumeration,
        "clone(child_stack=NULL, flags=CLONE_VM|SIGCHLD) = 101",
      ]),
      trace(101, [read()]),
    ],
  ],
  [
    "helper worker thread",
    [
      trace(100, [
        identity(),
        ...enumeration,
        "clone(child_stack=NULL, flags=CLONE_THREAD) = 101",
      ]),
      trace(101, [read()]),
    ],
  ],
  [
    "observer after provider exec",
    [
      trace(100, [
        identity(),
        ...enumeration,
        exec(["python", "provider.py"], "/usr/bin/python"),
        read(),
      ]),
    ],
  ],
  [
    "cloned before observer exec",
    [
      trace(100, [
        "clone(child_stack=NULL, flags=CLONE_THREAD) = 101",
        identity(),
        ...enumeration,
      ]),
      trace(101, [read()]),
    ],
  ],
  [
    "native status path",
    [trace(100, [identity(), ...enumeration, read("status")])],
  ],
  [
    "suffixed stat path",
    [trace(100, [identity(), ...enumeration, read("stat.backup")])],
  ],
  [
    "process memory path",
    [trace(100, [identity(), ...enumeration, read("mem")])],
  ],
  [
    "native environment path",
    [trace(100, [identity(), ...enumeration, read("environ")])],
  ],
  [
    "write attempt",
    [trace(100, [identity(), ...enumeration, read("stat", "O_RDWR")])],
  ],
  [
    "truncation attempt",
    [
      trace(100, [
        identity(),
        ...enumeration,
        read("stat", "O_RDONLY|O_TRUNC"),
      ]),
    ],
  ],
] as const)(
  "rejects unattributed historical PID reads: %s",
  (_name, traces) => {
    expect(() => verifyHistoricalPidReads(traces, options)).toThrow(
      /Historical PID/u,
    );
  },
);

it("retains the exact process-table observer exception", () => {
  const ps = exec(
    ["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="],
    "/usr/bin/ps",
  );
  expect(
    verifyHistoricalPidReads([trace(100, [ps, read("environ")])], options),
  ).toHaveLength(1);
  expect(() =>
    verifyHistoricalPidReads(
      [trace(100, [exec(["ps", "-p", "42"], "/usr/bin/ps"), read()])],
      options,
    ),
  ).toThrow(/Historical PID/u);
  expect(() =>
    verifyHistoricalPidReads(
      [
        trace(100, [
          exec(
            ["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="],
            "/tmp/ps",
          ),
          read(),
        ]),
      ],
      { ...options, psPaths: new Set(["/tmp/ps"]) },
    ),
  ).toThrow(/Historical PID/u);
});
