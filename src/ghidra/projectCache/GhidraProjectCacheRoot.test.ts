import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureGhidraProjectCacheRoot } from "./GhidraProjectCacheRoot.js";

const roots: string[] = [];
const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-ghidra-cache-root-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("POSIX cache root", () => {
  it("creates a directory before a project is stored", async () => {
    const parent = await tempRoot();
    const root = join(parent, "nested", "cache");
    await ensureGhidraProjectCacheRoot(root, { platform: "linux" });
    await expect(
      lstat(root).then((stats) => stats.isDirectory()),
    ).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "tightens an existing group- or world-accessible root",
    async () => {
      const root = await tempRoot();
      await chmod(root, 0o755);
      await ensureGhidraProjectCacheRoot(root, { platform: "linux" });
      const stats = await lstat(root);
      expect(stats.mode & 0o077).toBe(0);
    },
  );

  it("rejects a root that is a link", async () => {
    const parent = await tempRoot();
    const target = join(parent, "target");
    const root = join(parent, "cache");
    await mkdir(target);
    await symlink(target, root);
    await expect(
      ensureGhidraProjectCacheRoot(root, { platform: "linux" }),
    ).rejects.toMatchObject({ reason: "io", path: root });
  });
});

describe("Windows cache root", () => {
  it("creates the leaf through the native private-DACL boundary", async () => {
    const parent = await tempRoot();
    const root = join(parent, "cache");
    const verified: string[] = [];
    await ensureGhidraProjectCacheRoot(root, {
      platform: "win32",
      host: {
        createPrivateDirectory(directory) {
          const created = join(directory, `private-${randomUUID()}`);
          mkdirSync(created, { recursive: true });
          return created;
        },
        verifyPrivateDirectory(path) {
          verified.push(path);
          return { privateDacl: true };
        },
      },
    });
    await expect(
      lstat(root).then((stats) => stats.isDirectory()),
    ).resolves.toBe(true);
    expect(verified).toEqual([root]);
  });

  it("accepts an existing root only after native verification", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "entry"), "private");
    const verified: string[] = [];
    await ensureGhidraProjectCacheRoot(root, {
      platform: "win32",
      host: {
        createPrivateDirectory() {
          throw new Error("an existing root must not be recreated");
        },
        verifyPrivateDirectory(path) {
          verified.push(path);
          return { privateDacl: true };
        },
      },
    });
    expect(verified).toEqual([root]);
    await expect(readFile(join(root, "entry"), "utf8")).resolves.toBe(
      "private",
    );
  });

  it("rejects an existing root that is not owner-only", async () => {
    const root = await tempRoot();
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: {
          createPrivateDirectory() {
            throw new Error("an existing root must not be recreated");
          },
          verifyPrivateDirectory() {
            throw new Error("unexpected trustee");
          },
        },
      }),
    ).rejects.toMatchObject({
      reason: "io",
      path: root,
      message: expect.stringContaining("not an owner-only directory"),
    });
  });

  it("rejects a linked root before verification", async () => {
    const parent = await tempRoot();
    const target = join(parent, "target");
    const root = join(parent, "cache");
    await mkdir(target);
    await symlink(target, root);
    let verified = false;
    await expect(
      ensureGhidraProjectCacheRoot(root, {
        platform: "win32",
        host: {
          createPrivateDirectory() {
            throw new Error("a linked root must not be recreated");
          },
          verifyPrivateDirectory() {
            verified = true;
            return { privateDacl: true };
          },
        },
      }),
    ).rejects.toMatchObject({ reason: "io", path: root });
    expect(verified).toBe(false);
  });
});
