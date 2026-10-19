import assert from "node:assert/strict";

const ownershipPsArguments =
  '["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="]';

const successfulExecutions = (text) =>
  text
    .split("\n")
    .filter(
      (line) => /^(?:execve|execveat)\(/u.test(line) && line.endsWith(" = 0"),
    );
const readOnlyProcOpen = (line) =>
  /^openat\(AT_FDCWD, "\/proc\/(\d+)\/([^/"\n]+)", O_RDONLY(?:\|O_CLOEXEC)?\) = (?:\d+|-1 [A-Z]+)/u.exec(
    line,
  );

/**
 * Allow only the procfs paths used by the process-ownership scan: ps may
 * inspect its process-table fields, and its caller's thread group may read
 * native identity and UID records. With strace -ff, libuv worker threads get
 * separate files; follow CLONE_THREAD edges, never ordinary child-process
 * edges. strace cannot distinguish the purpose of a stat/status read inside
 * the same Node thread group, so this is deliberately limited to those two
 * files; provider Python/GDB children remain outside the permit.
 */
export const assertHistoricalPidReadsAreOwnershipOnly = ({
  traces,
  sentinelPid,
  psExecutables,
  supervisorCommands,
}) => {
  const processGroups = new Map();
  const findGroup = (pid) => {
    const parent = processGroups.get(pid);
    if (parent === undefined) {
      processGroups.set(pid, pid);
      return pid;
    }
    if (parent === pid) return pid;
    const root = findGroup(parent);
    processGroups.set(pid, root);
    return root;
  };
  const joinThreadGroup = (left, right) => {
    const leftRoot = findGroup(left);
    const rightRoot = findGroup(right);
    if (leftRoot !== rightRoot) processGroups.set(rightRoot, leftRoot);
  };

  const cloneEvents = [];
  for (const trace of traces) {
    let unfinished;
    for (const rawLine of trace.text.split("\n")) {
      const line = rawLine.trimStart();
      const start = /^(clone3?|fork|vfork)\((.*)<unfinished \.\.\.>$/u.exec(
        line,
      );
      if (start !== null) {
        unfinished = { name: start[1], text: start[2] };
        continue;
      }
      const resumed = /^<\.\.\. (clone3?|fork|vfork) resumed>(.*)$/u.exec(line);
      if (resumed !== null && resumed[1] === unfinished?.name) {
        cloneEvents.push({
          parentPid: trace.pid,
          text: `${unfinished.text}${resumed[2]}`,
        });
        unfinished = undefined;
        continue;
      }
      const complete =
        /^(clone3?|fork|vfork)\((.*\)) = (\d+)(?:<[^>]*>)?$/u.exec(line);
      if (complete !== null)
        cloneEvents.push({
          parentPid: trace.pid,
          childPid: Number(complete[3]),
          text: complete[2],
        });
    }
  }

  for (const event of cloneEvents) {
    const childPid =
      event.childPid ?? /\) = (\d+)(?:<[^>]*>)?$/u.exec(event.text)?.[1];
    if (childPid === undefined) continue;
    event.childPid = Number(childPid);
    if (/\bCLONE_THREAD\b/u.test(event.text))
      joinThreadGroup(event.parentPid, event.childPid);
  }

  const psPids = new Set();
  const supervisors = new Map();
  const invalidGroups = new Set();
  const sampledIdentities = new Map();
  for (const trace of traces) {
    const executions = successfulExecutions(trace.text);
    const group = findGroup(trace.pid);
    if (executions.length === 1) {
      const line = executions[0];
      const executable = /^execve\("([^"]+)"/u.exec(line)?.[1];
      if (psExecutables.has(executable) && line.includes(ownershipPsArguments))
        psPids.add(trace.pid);
    }
    if (executions.length > 0) {
      const knownSupervisor =
        executions.length === 1 &&
        supervisorCommands.some(({ executable, script }) =>
          executions[0].startsWith(
            `execve(${JSON.stringify(executable)}, [${JSON.stringify(executable)}, ${JSON.stringify(script)}`,
          ),
        );
      if (knownSupervisor && !supervisors.has(group))
        supervisors.set(group, trace.pid);
      else invalidGroups.add(group);
    }
    const sampled = sampledIdentities.get(group) ?? new Set();
    for (const line of trace.text.split("\n")) {
      const opened = readOnlyProcOpen(line);
      if (opened?.[2] === "stat") sampled.add(Number(opened[1]));
    }
    sampledIdentities.set(group, sampled);
  }

  const psParentGroups = new Set(
    cloneEvents
      .filter(({ childPid }) => childPid !== undefined && psPids.has(childPid))
      .map(({ parentPid }) => findGroup(parentPid)),
  );

  const nativeIdentityGroups = new Set(
    [...psParentGroups].filter((group) => {
      const supervisor = supervisors.get(group);
      const sampled = sampledIdentities.get(group);
      return (
        supervisor !== undefined &&
        !invalidGroups.has(group) &&
        sampled?.has(supervisor) &&
        sampled.has(sentinelPid)
      );
    }),
  );

  const ownershipReads = [];
  const pidPrefix = `/proc/${sentinelPid}/`;
  for (const trace of traces) {
    const isPsProcess = psPids.has(trace.pid);
    const isOwnershipProcessThread = nativeIdentityGroups.has(
      findGroup(trace.pid),
    );
    const pidReads = trace.text
      .split("\n")
      .filter((line) => line.includes(pidPrefix));
    for (const line of pidReads) {
      const opened = readOnlyProcOpen(line);
      const field = opened?.[1] === String(sentinelPid) ? opened[2] : undefined;
      const psRead =
        isPsProcess &&
        ["stat", "status", "cmdline", "wchan", "environ"].includes(field);
      const ownershipThreadRead =
        isOwnershipProcessThread && ["stat", "status"].includes(field);
      assert.ok(
        psRead || ownershipThreadRead,
        `Historical PID caused a provider lookup in trace.${trace.pid}: ${line}`,
      );
      ownershipReads.push(line);
    }
  }
  return ownershipReads;
};
