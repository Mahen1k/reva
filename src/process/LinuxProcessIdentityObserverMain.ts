import { readFileSync, readdirSync } from "node:fs";

import { observeLinuxProcessIdentity } from "./LinuxProcessIdentity.js";

// This entry accepts no target/PID input. Its filesystem observations cover the
// native process table independently of the artifact being analyzed.
if (
  process.platform !== "linux" ||
  process.argv.length !== 3 ||
  process.argv[2] !== "--global-identities"
)
  throw new Error(
    "Linux process identity observer requires --global-identities",
  );

const observations = readdirSync("/proc")
  .filter((name) => /^[1-9]\d*$/u.test(name))
  .map(Number)
  .filter(Number.isSafeInteger)
  .sort((left, right) => left - right)
  .map((pid) => ({
    pid,
    observation: observeLinuxProcessIdentity(pid, {
      readStat: (selected) =>
        readFileSync(`/proc/${String(selected)}/stat`, "utf8"),
      probe: (selected) => process.kill(selected, 0),
    }),
  }));

process.stdout.write(
  `${JSON.stringify({ protocol: "linux-process-identities/v1", observations })}\n`,
);
