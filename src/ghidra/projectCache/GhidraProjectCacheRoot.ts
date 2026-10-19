import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import {
  requireWindowsNativeAuthority,
  type WindowsNativeAuthority,
} from "../../windows/WindowsNativeLoader.js";
import { GhidraProjectCacheError } from "./GhidraProjectCacheTypes.js";

const nativeIdentitySchema = z
  .object({ privateDacl: z.literal(true) })
  .passthrough();
const createdDirectorySchema = z
  .object({ path: z.string().min(1) })
  .passthrough();

/** Native operations that establish and verify a durable private cache root. */
export interface GhidraProjectCacheRootHost {
  /** Create a private directory beneath `parent` and return its path. */
  createPrivateDirectory(parent: string): string;
  /** Throw unless `path` is an owner-only directory with a protected DACL. */
  verifyPrivateDirectory(path: string): unknown;
}

const systemRootHost = (): GhidraProjectCacheRootHost => {
  const native = (): WindowsNativeAuthority => requireWindowsNativeAuthority();
  return {
    createPrivateDirectory(parent: string): string {
      const created = createdDirectorySchema.parse(
        native().call("runtime_create", [parent, "rea-ghidra-cache-"]),
      );
      // The returned runtime handle is deliberately not stored. It owns the
      // directory only for explicit runtime_close; releasing the handle closes
      // its leases without marking the now-durable directory for deletion.
      return created.path;
    },
    verifyPrivateDirectory(path: string): unknown {
      const verified = native().call("cutter_bridge_verify_directory", [path]);
      nativeIdentitySchema.parse(verified);
      return verified;
    },
  } satisfies GhidraProjectCacheRootHost;
};

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const rootError = (
  message: string,
  root: string,
  cause?: unknown,
): GhidraProjectCacheError =>
  new GhidraProjectCacheError(
    "io",
    message,
    root,
    cause === undefined ? undefined : { cause },
  );

const assertDirectory = async (root: string): Promise<void> => {
  const stats = await lstat(root).catch((cause: unknown) => {
    if (isNotFound(cause))
      throw rootError("Ghidra project cache root does not exist", root, cause);
    throw cause;
  });
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw rootError(
      "Ghidra project cache root must be a directory, not a link",
      root,
    );
};

const ensurePosixRoot = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertDirectory(root);
  // mkdir does not tighten an existing directory. Only POSIX exposes owner
  // bits to Node, and a widened root would expose every stored project.
  if (process.getuid === undefined) return;
  const before = await lstat(root);
  if ((before.mode & 0o077) === 0) return;
  await chmod(root, 0o700);
  const after = await lstat(root);
  if ((after.mode & 0o077) !== 0)
    throw rootError(
      "Ghidra project cache root permissions could not be made owner-only",
      root,
    );
};

const ensureWindowsRoot = async (
  root: string,
  host: GhidraProjectCacheRootHost,
): Promise<void> => {
  // Only the leaf is private. Its protected, inheritable DACL covers every
  // staging copy, entry, lease, and lock created beneath it.
  await mkdir(dirname(root), { recursive: true });
  const existing = await lstat(root).catch((cause: unknown) => {
    if (isNotFound(cause)) return undefined;
    throw cause;
  });
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw rootError(
        "Ghidra project cache root must be a directory, not a link",
        root,
      );
    try {
      host.verifyPrivateDirectory(root);
      return;
    } catch (cause: unknown) {
      throw rootError(
        "Ghidra project cache root is not an owner-only directory; move it under the current user's profile or create it with a private DACL",
        root,
        cause,
      );
    }
  }
  const created = host.createPrivateDirectory(dirname(root));
  try {
    await rename(created, root);
  } catch (cause: unknown) {
    await rm(created, { recursive: true, force: true }).catch(() => undefined);
    // A concurrent initializer may have won the name. Accept only a root that
    // then passes the same private-DACL verification.
    const raced = await lstat(root).catch(() => undefined);
    if (raced === undefined)
      throw rootError(
        "Ghidra project cache root could not be created privately",
        root,
        cause,
      );
  }
  await assertDirectory(root);
  try {
    host.verifyPrivateDirectory(root);
  } catch (cause: unknown) {
    throw rootError(
      "Ghidra project cache root could not be verified as owner-only",
      root,
      cause,
    );
  }
};

/**
 * Establish the durable cache root before any project bytes are written.
 *
 * POSIX roots are created owner-only and existing widened roots are tightened.
 * Windows roots are created through the native protected-DACL boundary (or an
 * existing root must already pass it) because POSIX mode bits do not set a
 * Windows DACL.
 */
export const ensureGhidraProjectCacheRoot = async (
  root: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly host?: GhidraProjectCacheRootHost;
  } = {},
): Promise<void> => {
  try {
    if ((options.platform ?? process.platform) === "win32")
      await ensureWindowsRoot(root, options.host ?? systemRootHost());
    else await ensurePosixRoot(root);
  } catch (cause: unknown) {
    if (cause instanceof GhidraProjectCacheError) throw cause;
    throw rootError(
      "Ghidra project cache root could not be prepared",
      root,
      cause,
    );
  }
};
