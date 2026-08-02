import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export interface RepositoryFileHooks {
  readonly beforeOpen?: (absolutePath: string) => void;
  readonly afterOpen?: (absolutePath: string) => void;
}

function repositoryRoot(root: string): string {
  const absolute = resolve(root);
  const status = lstatSync(absolute);
  if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(absolute) !== absolute) {
    throw new Error("Repository root must be one real, non-symbolic-link directory.");
  }
  return absolute;
}

function repositoryTarget(root: string, path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Repository path is unsafe: ${path}.`);
  }
  const absolute = resolve(root, path);
  const contained = relative(root, absolute);
  if (contained === "" || contained === ".." || contained.startsWith(`..${sep}`)) {
    throw new Error(`Repository path escaped the root: ${path}.`);
  }
  return absolute;
}

interface DirectoryIdentity {
  readonly absolute: string;
  readonly status: BigIntStats;
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function directoryChain(root: string, targetParent: string, create: boolean): readonly DirectoryIdentity[] {
  const relativeParent = relative(root, targetParent);
  const identities: DirectoryIdentity[] = [{ absolute: root, status: lstatSync(root, { bigint: true }) }];
  let current = root;
  for (const part of relativeParent === "" ? [] : relativeParent.split(sep)) {
    current = resolve(current, part);
    try {
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error(`Repository parent is not a real directory: ${relative(root, current).split(sep).join("/")}.`);
      }
    } catch (error) {
      if (!create || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      mkdirSync(current, { mode: 0o755 });
    }
    const real = realpathSync(current);
    if (real !== current || (real !== root && !real.startsWith(`${root}${sep}`))) {
      throw new Error(`Repository parent escaped through a symbolic link: ${relative(root, current).split(sep).join("/")}.`);
    }
    identities.push({ absolute: current, status: lstatSync(current, { bigint: true }) });
  }
  return identities;
}

function revalidateDirectoryChain(root: string, identities: readonly DirectoryIdentity[]): void {
  for (const identity of identities) {
    const status = lstatSync(identity.absolute, { bigint: true });
    if (status.isSymbolicLink() || !status.isDirectory() || !sameObject(identity.status, status)) {
      throw new Error(`Repository parent changed during file IO: ${relative(root, identity.absolute).split(sep).join("/") || "."}.`);
    }
    if (realpathSync(identity.absolute) !== identity.absolute) {
      throw new Error(`Repository parent became a symbolic link during file IO: ${relative(root, identity.absolute).split(sep).join("/") || "."}.`);
    }
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function regularTarget(root: string, absolute: string, path: string): BigIntStats {
  const status = lstatSync(absolute, { bigint: true });
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${path} is not one regular repository file.`);
  if (status.nlink !== 1n) throw new Error(`${path} must not be hard-linked.`);
  const real = realpathSync(absolute);
  if (real !== absolute || !real.startsWith(`${root}${sep}`)) throw new Error(`${path} escaped the repository through a symbolic link.`);
  return status;
}

export function readRepositoryFile(rootInput: string, path: string, hooks: RepositoryFileHooks = {}): Buffer {
  const root = repositoryRoot(rootInput);
  const absolute = repositoryTarget(root, path);
  const parents = directoryChain(root, dirname(absolute), false);
  const preOpen = regularTarget(root, absolute, path);
  hooks.beforeOpen?.(absolute);
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameIdentity(preOpen, before)) {
      throw new Error(`${path} changed before its descriptor was verified.`);
    }
    hooks.afterOpen?.(absolute);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(absolute, { bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(after, current) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error(`${path} changed while it was being read.`);
    }
    revalidateDirectoryChain(root, parents);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function writeRepositoryFile(
  rootInput: string,
  path: string,
  bytes: Uint8Array | string,
  hooks: RepositoryFileHooks = {},
): void {
  const root = repositoryRoot(rootInput);
  const absolute = repositoryTarget(root, path);
  const parents = directoryChain(root, dirname(absolute), true);
  let preOpen: BigIntStats | undefined;
  try {
    preOpen = regularTarget(root, absolute, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  hooks.beforeOpen?.(absolute);
  const descriptor = openSync(
    absolute,
    constants.O_WRONLY
      | (preOpen ? 0 : constants.O_CREAT | constants.O_EXCL)
      | (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || (preOpen ? !sameIdentity(preOpen, before) : before.size !== 0n)
    ) {
      throw new Error(`${path} changed before its output descriptor was verified.`);
    }
    hooks.afterOpen?.(absolute);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(absolute, { bigint: true });
    if (after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino || !sameIdentity(after, current)) {
      throw new Error(`${path} changed while it was being written.`);
    }
    revalidateDirectoryChain(root, parents);
  } finally {
    closeSync(descriptor);
  }
}
