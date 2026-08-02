import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ExclusiveEvidenceHooks {
  readonly beforeOpen?: (absolutePath: string) => void;
  readonly afterOpen?: (absolutePath: string) => void;
  readonly afterWrite?: (absolutePath: string) => void;
  readonly afterRead?: (absolutePath: string) => void;
}

interface PathIdentity {
  readonly absolute: string;
  readonly status: BigIntStats;
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameObject(left, right)
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const status = lstatSync(absolute);
  if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(absolute) !== absolute) {
    throw new Error(`${label} must be one real non-symbolic-link directory.`);
  }
  return absolute;
}

function captureParentChain(parent: string): readonly PathIdentity[] {
  const identities: PathIdentity[] = [];
  let current = resolve(sep);
  identities.push({ absolute: current, status: lstatSync(current, { bigint: true }) });
  for (const part of relative(current, parent).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const status = lstatSync(current, { bigint: true });
    if (status.isSymbolicLink() || !status.isDirectory() || realpathSync(current) !== current) {
      throw new Error("Evidence output parent chain contains a symbolic link or unsupported entry.");
    }
    identities.push({ absolute: current, status });
  }
  return identities;
}

function revalidateParentChain(identities: readonly PathIdentity[]): void {
  for (const identity of identities) {
    const current = lstatSync(identity.absolute, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory() || !sameObject(identity.status, current) || realpathSync(identity.absolute) !== identity.absolute) {
      throw new Error("Evidence output parent chain changed during the write.");
    }
  }
}

export function writeExclusiveExternalEvidenceFile(
  repositoryRootInput: string,
  outputPathInput: string,
  bytes: Uint8Array | string,
  hooks: ExclusiveEvidenceHooks = {},
): string {
  const repositoryRoot = realDirectory(repositoryRootInput, "Repository root");
  if (!isAbsolute(outputPathInput)) throw new Error("Runtime evidence path must be absolute.");
  const outputPath = resolve(outputPathInput);
  const parent = dirname(outputPath);
  const parentChain = captureParentChain(parent);
  const realParent = realDirectory(parent, "Runtime evidence parent");
  if (realParent === repositoryRoot || realParent.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("Runtime evidence parent must remain outside the source candidate worktree.");
  }
  const relativeOutput = relative(repositoryRoot, outputPath);
  if (relativeOutput === "" || (relativeOutput !== ".." && !relativeOutput.startsWith(`..${sep}`))) {
    throw new Error("Runtime evidence must remain outside the source candidate worktree.");
  }
  try {
    lstatSync(outputPath);
    throw new Error("Runtime evidence output already exists and will not be overwritten.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  hooks.beforeOpen?.(outputPath);
  const descriptor = openSync(
    outputPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== 0n || (before.mode & 0o777n) !== 0o600n) {
      throw new Error("Runtime evidence descriptor is not one new regular file.");
    }
    hooks.afterOpen?.(outputPath);
    const intended = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
    writeFileSync(descriptor, intended);
    fsyncSync(descriptor);
    hooks.afterWrite?.(outputPath);
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(outputPath, { bigint: true });
    if (
      !after.isFile()
      || after.nlink !== 1n
      || after.dev !== before.dev
      || after.ino !== before.ino
      || !sameFileSnapshot(after, current)
      || after.size !== BigInt(intended.byteLength)
      || (after.mode & 0o777n) !== 0o600n
    ) {
      throw new Error("Runtime evidence path changed during the exclusive write.");
    }
    const actual = Buffer.alloc(intended.byteLength);
    let offset = 0;
    while (offset < actual.byteLength) {
      const read = readSync(descriptor, actual, offset, actual.byteLength - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== actual.byteLength || !actual.equals(intended)) {
      throw new Error("Runtime evidence bytes changed during the exclusive write.");
    }
    hooks.afterRead?.(outputPath);
    const terminalDescriptor = fstatSync(descriptor, { bigint: true });
    const terminalPath = lstatSync(outputPath, { bigint: true });
    if (!sameFileSnapshot(after, terminalDescriptor) || !sameFileSnapshot(after, terminalPath)) {
      throw new Error("Runtime evidence file changed after descriptor readback.");
    }
    revalidateParentChain(parentChain);
    return outputPath;
  } finally {
    closeSync(descriptor);
  }
}
