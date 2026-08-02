import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepositoryFile, writeRepositoryFile } from "./repository-file";

function fixture(): string {
  const root = mkdtempSync("/tmp/srf-");
  mkdirSync(resolve(root, "nested"));
  writeFileSync(resolve(root, "nested/source.txt"), "trusted\n");
  return realpathSync(root);
}

describe("fail-closed repository file IO", () => {
  it("reads and writes only stable regular files beneath real directory parents", () => {
    const root = fixture();
    expect(readRepositoryFile(root, "nested/source.txt").toString("utf8")).toBe("trusted\n");
    writeRepositoryFile(root, "generated/deep/output.txt", "generated\n");
    expect(readRepositoryFile(root, "generated/deep/output.txt").toString("utf8")).toBe("generated\n");
  });

  it("rejects in-repository and escaping symbolic links for reads and writes", () => {
    const root = fixture();
    symlinkSync(resolve(root, "nested/source.txt"), resolve(root, "nested/in-repo.txt"));
    symlinkSync(resolve(tmpdir(), "foreign-receipt-file"), resolve(root, "nested/escaping.txt"));
    symlinkSync(resolve(root, "nested"), resolve(root, "linked-parent"));
    expect(() => readRepositoryFile(root, "nested/in-repo.txt")).toThrow(/regular repository file|symbolic link/);
    expect(() => readRepositoryFile(root, "nested/escaping.txt")).toThrow(/regular repository file|symbolic link/);
    expect(() => writeRepositoryFile(root, "nested/in-repo.txt", "hostile")).toThrow(/regular repository file|symbolic link/);
    expect(() => writeRepositoryFile(root, "linked-parent/output.txt", "hostile")).toThrow(/real directory/);
  });

  it("rejects directories, sockets, and controlled referent replacement", async () => {
    const root = fixture();
    expect(() => readRepositoryFile(root, "nested")).toThrow(/regular repository file/);
    const socket = resolve(root, "nested/source.sock");
    const server = createServer();
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(socket, accept);
    });
    try {
      expect(() => readRepositoryFile(root, "nested/source.sock")).toThrow(/regular repository file/);
    } finally {
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    }

    expect(() => readRepositoryFile(root, "nested/source.txt", {
      afterOpen: (absolute) => {
        renameSync(absolute, `${absolute}.retired`);
        writeFileSync(absolute, "replacement\n");
      },
    })).toThrow(/changed while it was being read/);
  });

  it("rejects before-open swaps without reading or truncating either regular file", () => {
    const root = fixture();
    const readResults: Buffer[] = [];
    expect(() => readResults.push(readRepositoryFile(root, "nested/source.txt", {
      beforeOpen: (absolute) => {
        renameSync(absolute, `${absolute}.original`);
        writeFileSync(absolute, "substitute\n");
      },
    }))).toThrow(/changed before its descriptor was verified/);
    expect(readResults).toEqual([]);
    expect(readFileSync(resolve(root, "nested/source.txt.original"), "utf8")).toBe("trusted\n");
    expect(readFileSync(resolve(root, "nested/source.txt"), "utf8")).toBe("substitute\n");

    const output = resolve(root, "nested/output-before-open.txt");
    writeFileSync(output, "original-output\n");
    expect(() => writeRepositoryFile(root, "nested/output-before-open.txt", "generated\n", {
      beforeOpen: (absolute) => {
        renameSync(absolute, `${absolute}.original`);
        writeFileSync(absolute, "substitute-output\n");
      },
    })).toThrow(/changed before its output descriptor was verified/);
    expect(readFileSync(`${output}.original`, "utf8")).toBe("original-output\n");
    expect(readFileSync(output, "utf8")).toBe("substitute-output\n");

    const absent = resolve(root, "nested/initially-absent.txt");
    expect(() => writeRepositoryFile(root, "nested/initially-absent.txt", "generated\n", {
      beforeOpen: () => writeFileSync(absent, "new-occupant\n"),
    })).toThrow();
    expect(readFileSync(absent, "utf8")).toBe("new-occupant\n");
  });

  it("rejects hard-linked read and write targets", () => {
    const root = fixture();
    linkSync(resolve(root, "nested/source.txt"), resolve(root, "nested/hard-link.txt"));
    expect(() => readRepositoryFile(root, "nested/source.txt")).toThrow(/hard-linked/);
    expect(() => readRepositoryFile(root, "nested/hard-link.txt")).toThrow(/hard-linked/);
    expect(() => writeRepositoryFile(root, "nested/source.txt", "hostile\n")).toThrow(/hard-linked/);
    expect(readFileSync(resolve(root, "nested/hard-link.txt"), "utf8")).toBe("trusted\n");
  });

  it("rejects a controlled output-path replacement without overwriting the substitute", () => {
    const root = fixture();
    const target = resolve(root, "nested/output.txt");
    writeFileSync(target, "old\n");
    expect(() => writeRepositoryFile(root, "nested/output.txt", "generated\n", {
      afterOpen: (absolute) => {
        renameSync(absolute, `${absolute}.retired`);
        writeFileSync(absolute, "substitute\n");
      },
    })).toThrow(/changed while it was being written/);
    expect(readRepositoryFile(root, "nested/output.txt").toString("utf8")).toBe("substitute\n");
  });
});
