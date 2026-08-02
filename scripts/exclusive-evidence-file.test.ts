import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeExclusiveExternalEvidenceFile } from "./exclusive-evidence-file";

function roots(): { readonly repository: string; readonly output: string } {
  const repository = realpathSync(mkdtempSync("/tmp/ssef-repo-"));
  const output = realpathSync(mkdtempSync("/tmp/ssef-output-"));
  writeFileSync(resolve(repository, "source.txt"), "source-safe\n");
  return { repository, output };
}

describe("exclusive external runtime evidence file", () => {
  it("creates one new mode-600 external file without overwriting", () => {
    const { repository, output } = roots();
    const path = resolve(output, "evidence.json");
    expect(writeExclusiveExternalEvidenceFile(repository, path, "evidence\n")).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("evidence\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeExclusiveExternalEvidenceFile(repository, path, "replacement\n")).toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe("evidence\n");
  });

  it("rejects in-repository and escaping symlink occupants without modifying targets", () => {
    const first = roots();
    const repositoryTarget = resolve(first.repository, "source.txt");
    const outputSymlink = resolve(first.output, "in-repo-link.json");
    symlinkSync(repositoryTarget, outputSymlink);
    expect(() => writeExclusiveExternalEvidenceFile(first.repository, outputSymlink, "hostile\n")).toThrow(/already exists/);
    expect(readFileSync(repositoryTarget, "utf8")).toBe("source-safe\n");

    const second = roots();
    const externalTarget = resolve(second.output, "external-target.json");
    writeFileSync(externalTarget, "external-safe\n");
    const escapingSymlink = resolve(second.output, "escaping-link.json");
    symlinkSync(externalTarget, escapingSymlink);
    expect(() => writeExclusiveExternalEvidenceFile(second.repository, escapingSymlink, "hostile\n")).toThrow(/already exists/);
    expect(readFileSync(externalTarget, "utf8")).toBe("external-safe\n");
  });

  it("rejects hard links, existing files, and symlinked parents without modification", () => {
    const hard = roots();
    const target = resolve(hard.repository, "source.txt");
    const hardLink = resolve(hard.output, "hard-link.json");
    linkSync(target, hardLink);
    expect(() => writeExclusiveExternalEvidenceFile(hard.repository, hardLink, "hostile\n")).toThrow(/already exists/);
    expect(readFileSync(target, "utf8")).toBe("source-safe\n");

    const existing = roots();
    const existingPath = resolve(existing.output, "existing.json");
    writeFileSync(existingPath, "existing-safe\n");
    expect(() => writeExclusiveExternalEvidenceFile(existing.repository, existingPath, "hostile\n")).toThrow(/already exists/);
    expect(readFileSync(existingPath, "utf8")).toBe("existing-safe\n");

    const linkedParent = roots();
    const realParent = resolve(linkedParent.output, "real-parent");
    mkdirSync(realParent);
    const parentLink = resolve(linkedParent.output, "parent-link");
    symlinkSync(realParent, parentLink);
    expect(() => writeExclusiveExternalEvidenceFile(
      linkedParent.repository,
      resolve(parentLink, "evidence.json"),
      "hostile\n",
    )).toThrow(/parent chain|non-symbolic-link/);
  });

  it("rejects before-open and after-open path swaps without modifying the substitute", () => {
    const before = roots();
    const beforePath = resolve(before.output, "before.json");
    expect(() => writeExclusiveExternalEvidenceFile(before.repository, beforePath, "evidence\n", {
      beforeOpen: () => writeFileSync(beforePath, "substitute-safe\n"),
    })).toThrow();
    expect(readFileSync(beforePath, "utf8")).toBe("substitute-safe\n");

    const after = roots();
    const afterPath = resolve(after.output, "after.json");
    expect(() => writeExclusiveExternalEvidenceFile(after.repository, afterPath, "evidence\n", {
      afterOpen: (path) => {
        renameSync(path, `${path}.opened`);
        writeFileSync(path, "substitute-safe\n");
      },
    })).toThrow(/changed during the exclusive write/);
    expect(readFileSync(afterPath, "utf8")).toBe("substitute-safe\n");
  });

  it("rejects a same-inode same-length mutation after the intended bytes are written", () => {
    const { repository, output } = roots();
    const path = resolve(output, "mutated.json");
    const returned: string[] = [];
    expect(() => returned.push(writeExclusiveExternalEvidenceFile(repository, path, "evidence\n", {
      afterWrite: (openedPath) => writeFileSync(openedPath, "mutated!\n"),
    }))).toThrow(/bytes changed/);
    expect(returned).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("mutated!\n");
  });

  it("rejects a same-inode mutation after readback but before terminal identity validation", () => {
    const { repository, output } = roots();
    const path = resolve(output, "post-read.json");
    const returned: string[] = [];
    expect(() => returned.push(writeExclusiveExternalEvidenceFile(repository, path, "evidence\n", {
      afterRead: (openedPath) => writeFileSync(openedPath, "mutated!\n"),
    }))).toThrow(/changed after descriptor readback/);
    expect(returned).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("mutated!\n");
  });
});
