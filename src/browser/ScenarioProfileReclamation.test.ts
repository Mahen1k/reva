import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  SCENARIO_PROFILE_OWNER_FILE,
  SCENARIO_PROFILE_PREFIX,
  processIsAlive,
  reclaimStaleScenarioProfiles,
  writeScenarioProfileOwner,
} from "./ScenarioProfileReclamation.js";

const LIVE_PID = 4242;
const onlyLivePid = (pid: number): boolean => pid === LIVE_PID;

const profileDirectory = async (
  root: string,
  name: string,
): Promise<string> => {
  const path = join(root, `${SCENARIO_PROFILE_PREFIX}${name}`);
  await mkdir(path, { recursive: true });
  return path;
};

// lstat never follows a link, so a dangling symlink still counts as present.
const existing = (path: string): Promise<boolean> =>
  import("node:fs/promises").then(({ lstat }) =>
    lstat(path).then(
      () => true,
      () => false,
    ),
  );

it("reclaims a profile whose recorded owner is gone", async () => {
  const root = await createTestTempDirectory("rea-scenario-reclaim-");
  const path = await profileDirectory(root, "stale");
  await writeScenarioProfileOwner(path, { pid: 111 });

  const result = await reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
  });

  expect(result.reclaimed).toEqual([path]);
  expect(result.skipped).toEqual([]);
  await expect(existing(path)).resolves.toBe(false);
});

it("keeps a profile whose recorded owner is still live", async () => {
  const root = await createTestTempDirectory("rea-scenario-live-");
  const path = await profileDirectory(root, "live");
  await writeScenarioProfileOwner(path, { pid: LIVE_PID });

  const result = await reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
  });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "owner is live" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("never removes a prefixed directory without this package's owner marker", async () => {
  const root = await createTestTempDirectory("rea-scenario-unowned-");
  const path = await profileDirectory(root, "older-release");

  const result = await reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
  });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "no owner marker" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile whose singleton link names a live process", async () => {
  const root = await createTestTempDirectory("rea-scenario-held-");
  const path = await profileDirectory(root, "browser-live");
  await writeScenarioProfileOwner(path, { pid: 111 });
  await symlink(`testhost-${LIVE_PID}`, join(path, "SingletonLock"));

  const result = await reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
  });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "profile lock is held" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("reclaims a profile whose singleton link names a dead process", async () => {
  const root = await createTestTempDirectory("rea-scenario-unlocked-");
  const path = await profileDirectory(root, "browser-gone");
  await writeScenarioProfileOwner(path, { pid: 111 });
  await symlink("testhost-222", join(path, "SingletonLock"));

  const result = await reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
  });

  expect(result.reclaimed).toEqual([path]);
  await expect(existing(path)).resolves.toBe(false);
});

it("keeps a profile whose singleton entry cannot be proven dead", async () => {
  const root = await createTestTempDirectory("rea-scenario-unproven-");
  const path = await profileDirectory(root, "unreadable-lock");
  await writeScenarioProfileOwner(path, { pid: 111 });
  await writeFile(join(path, "SingletonLock"), "not a process link");

  const result = await reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
  });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "profile lock is held" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("ignores other prefixes, plain files, and symlinked directories", async () => {
  const root = await createTestTempDirectory("rea-scenario-foreign-");
  const foreign = join(root, "playwright-artifacts-1");
  await mkdir(foreign, { recursive: true });
  const marker = join(root, `${SCENARIO_PROFILE_PREFIX}file`);
  await writeFile(marker, "not a directory");
  const target = await profileDirectory(root, "target");
  await writeScenarioProfileOwner(target, { pid: 111 });
  await symlink(target, join(root, `${SCENARIO_PROFILE_PREFIX}link`));

  const result = await reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
  });

  expect(result.reclaimed).toEqual([target]);
  await expect(existing(foreign)).resolves.toBe(true);
  await expect(existing(marker)).resolves.toBe(true);
  await expect(
    existing(join(root, `${SCENARIO_PROFILE_PREFIX}link`)),
  ).resolves.toBe(true);
});

it("reclaims a profile owned by a process that already exited", async () => {
  const root = await createTestTempDirectory("rea-scenario-real-");
  const path = await profileDirectory(root, "exited-owner");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Expected a child process id");
  await once(child, "exit");
  await writeScenarioProfileOwner(path, { pid });
  expect(processIsAlive(pid)).toBe(false);

  const result = await reclaimStaleScenarioProfiles({ root });

  expect(result.reclaimed).toEqual([path]);
});

it("keeps a profile this process owns", async () => {
  const root = await createTestTempDirectory("rea-scenario-self-");
  const path = await profileDirectory(root, "self");
  await writeScenarioProfileOwner(path);
  expect(processIsAlive(process.pid)).toBe(true);

  const result = await reclaimStaleScenarioProfiles({ root });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "owner is live" }]);
});
