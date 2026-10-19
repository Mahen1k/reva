import assert from "node:assert/strict";

const quoted = '"(?:[^"\\\\]|\\\\.)*"';
const executionPattern = new RegExp(`^execve\\((${quoted}), `, "u");

/** Decode complete strace exec arguments; truncated or non-string argv fails closed. */
export const traceExecution = (line) => {
  const match = executionPattern.exec(line);
  if (match === null) return undefined;
  const start = match[0].length;
  if (line[start] !== "[") return undefined;
  let quotedString = false;
  let escaped = false;
  let end = start + 1;
  for (; end < line.length; end++) {
    const character = line[end];
    if (escaped) escaped = false;
    else if (quotedString && character === "\\") escaped = true;
    else if (character === '"') quotedString = !quotedString;
    else if (!quotedString && character === "]") break;
  }
  try {
    const executable = JSON.parse(match[1]);
    const arguments_ = JSON.parse(line.slice(start, end + 1));
    if (
      !Array.isArray(arguments_) ||
      !arguments_.every((value) => typeof value === "string")
    )
      return undefined;
    return {
      executable,
      arguments: arguments_,
      successful: / = 0$/u.test(line),
    };
  } catch {
    return undefined;
  }
};

const completeLines = (text) => {
  const completed = [];
  let unfinished;
  for (const line of text.split("\n")) {
    const start = /^(\w+)\((.*)<unfinished \.\.\.>$/u.exec(line);
    if (start !== null) {
      assert.equal(
        unfinished,
        undefined,
        "Overlapping unfinished trace syscalls",
      );
      unfinished = { name: start[1], prefix: `${start[1]}(${start[2]}` };
      continue;
    }
    const resumed = /^<\.\.\. (\w+) resumed>(.*)$/u.exec(line);
    if (resumed !== null) {
      assert.equal(
        unfinished?.name,
        resumed[1],
        "Unmatched resumed trace syscall",
      );
      completed.push(`${unfinished.prefix}${resumed[2]}`);
      unfinished = undefined;
    } else completed.push(line);
  }
  assert.equal(unfinished, undefined, "Incomplete traced ownership syscall");
  return completed;
};

const observerRole = (
  execution,
  { psPaths, identityExecutable, identityHelper },
) => {
  if (!execution?.successful) return undefined;
  if (
    ["/bin/ps", "/usr/bin/ps"].includes(execution.executable) &&
    psPaths.has(execution.executable) &&
    JSON.stringify(execution.arguments) ===
      JSON.stringify(["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="])
  )
    return { kind: "process-table" };
  if (
    execution.executable !== identityExecutable ||
    JSON.stringify(execution.arguments) !==
      JSON.stringify([
        identityExecutable,
        identityHelper,
        "--global-identities",
      ])
  )
    return undefined;
  return { kind: "native-identities" };
};

const readOnlyOpen = (line) =>
  /^open(?:at|at2)?\(/u.test(line) &&
  /\bO_RDONLY\b/u.test(line) &&
  !/\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND|TMPFILE)\b/u.test(line);

/** Attribute sentinel reads only to successful fixed global observers. */
export const verifyHistoricalPidReads = (traces, options) => {
  const byPid = new Map(
    traces.map((trace) => [
      trace.pid,
      { ...trace, lines: completeLines(trace.text) },
    ]),
  );
  assert.equal(byPid.size, traces.length, "Duplicate trace actor identity");
  const ownershipReads = [];
  for (const [pid, trace] of byPid) {
    let role;
    const procDirectoryDescriptors = new Set();
    let globalEnumerationObserved = false;
    for (const line of trace.lines) {
      if (/^execve(?:at)?\(/u.test(line)) {
        role = observerRole(traceExecution(line), options);
        procDirectoryDescriptors.clear();
        globalEnumerationObserved = false;
      }
      if (role?.kind === "native-identities") {
        if (
          readOnlyOpen(line) &&
          /"\/proc",/u.test(line) &&
          /\bO_DIRECTORY\b/u.test(line)
        ) {
          const descriptor = / = (\d+)$/u.exec(line)?.[1];
          if (descriptor !== undefined)
            procDirectoryDescriptors.add(descriptor);
        }
        const directoryRead = /^getdents64\((\d+),.* = ([1-9]\d*)$/u.exec(line);
        if (
          directoryRead !== null &&
          procDirectoryDescriptors.has(directoryRead[1])
        )
          globalEnumerationObserved = true;
      }
      if (!line.includes(`/proc/${options.sentinelPid}/`)) continue;
      const path = new RegExp(
        `"/proc/${options.sentinelPid}/([^"\\\\]+)"`,
        "u",
      ).exec(line)?.[1];
      const allowed =
        role?.kind === "process-table"
          ? ["stat", "status", "cmdline", "wchan", "environ"].includes(path)
          : role?.kind === "native-identities" &&
            globalEnumerationObserved &&
            path === "stat" &&
            readOnlyOpen(line);
      assert.ok(
        allowed,
        `Historical PID caused a provider lookup in ${trace.file}: ${line}`,
      );
      ownershipReads.push({ actor: pid, observer: role.kind, syscall: line });
    }
  }
  return ownershipReads;
};
