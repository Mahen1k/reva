import {
  lstat,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Scenario profile directories REA creates directly inside the temp root. */
export const SCENARIO_PROFILE_PREFIX = "rea-browser-scenario-";

/** Marker the launching REA process writes inside the profile it owns. */
export const SCENARIO_PROFILE_OWNER_FILE = ".rea-scenario-owner.json";

/** What one launching process records, so a later run can prove staleness. */
export interface ScenarioProfileOwner {
  readonly schema: 1;
  readonly pid: number;
  readonly created_at: string;
}

/** Singleton entries Chromium creates while a profile is open. */
const SINGLETON_ENTRIES = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
] as const;

/** Whether a process id is still live; EPERM still means the process exists. */
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Record the owning process before the profile is opened. A profile without
 * this marker is never reclaimed, so an older REA release's directory and any
 * foreign directory stay untouched.
 */
export const writeScenarioProfileOwner = async (
  profilePath: string,
  options: { readonly pid?: number; readonly now?: () => Date } = {},
): Promise<void> => {
  const owner: ScenarioProfileOwner = {
    schema: 1,
    pid: options.pid ?? process.pid,
    created_at: (options.now?.() ?? new Date()).toISOString(),
  };
  await writeFile(
    join(profilePath, SCENARIO_PROFILE_OWNER_FILE),
    `${JSON.stringify(owner)}\n`,
    { mode: 0o600 },
  );
};

const readScenarioProfileOwner = async (
  profilePath: string,
): Promise<ScenarioProfileOwner | undefined> => {
  let text: string;
  try {
    text = await readFile(
      join(profilePath, SCENARIO_PROFILE_OWNER_FILE),
      "utf8",
    );
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const {
      schema,
      pid,
      created_at: createdAt,
    } = parsed as Record<string, unknown>;
    return schema === 1 &&
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      typeof createdAt === "string"
      ? { schema: 1, pid, created_at: createdAt }
      : undefined;
  } catch {
    return undefined;
  }
};

/** The process id Chromium encodes in a singleton link target, when readable. */
const singletonOwnerPid = (target: string): number | undefined => {
  const match = /-(\d+)$/u.exec(target);
  if (match === null) return undefined;
  const pid = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * Whether some process may still hold this profile open. Every answer we
 * cannot prove is "yes": an entry that is not a symlink, a target without a
 * trailing process id, or a live singleton owner keeps the directory.
 */
const profileLockIsHeld = async (
  profilePath: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<boolean> => {
  for (const entry of SINGLETON_ENTRIES) {
    const path = join(profilePath, entry);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      continue;
    }
    if (!stats.isSymbolicLink()) return true;
    let target: string;
    try {
      target = await readlink(path);
    } catch {
      return true;
    }
    const pid = singletonOwnerPid(target);
    if (pid === undefined || isProcessAlive(pid)) return true;
  }
  return false;
};

export interface ScenarioProfileReclamation {
  readonly reclaimed: readonly string[];
  readonly skipped: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
}

/**
 * Reclaim scenario profiles an earlier, terminated REA run could not remove.
 * A profile is removed only when it carries this process's own marker, its
 * recorded owner is gone, and no singleton entry proves a live browser. Every
 * other directory is reported as skipped and left untouched.
 */
export const reclaimStaleScenarioProfiles = async (
  options: {
    readonly root?: string;
    readonly isProcessAlive?: (pid: number) => boolean;
  } = {},
): Promise<ScenarioProfileReclamation> => {
  const root = options.root ?? tmpdir();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const reclaimed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { reclaimed, skipped };
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(SCENARIO_PROFILE_PREFIX)) continue;
    // A symlink is never a directory REA owns, even when it resolves to one.
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const owner = await readScenarioProfileOwner(path);
    if (owner === undefined) {
      skipped.push({ path, reason: "no owner marker" });
      continue;
    }
    if (isProcessAlive(owner.pid)) {
      skipped.push({ path, reason: "owner is live" });
      continue;
    }
    if (await profileLockIsHeld(path, isProcessAlive)) {
      skipped.push({ path, reason: "profile lock is held" });
      continue;
    }
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      reclaimed.push(path);
    } catch {
      skipped.push({ path, reason: "removal failed" });
    }
  }
  return { reclaimed, skipped };
};
