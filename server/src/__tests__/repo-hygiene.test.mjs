import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// ko-mcp is a PUBLIC repository. Two hygiene rules, checked over the whole
// repo (not just server/), both skipped when this is not a git checkout
// (e.g. a source tarball):
//
// 1. No tracked file may also be ignored. A .gitignore rule added after a file
//    was committed does not untrack it. Fix: `git rm --cached <path>`.
// 2. No tracked text file may carry private traces: local machine paths,
//    private-repo issue references, or private workspace paths. Public readers
//    cannot open them. Refer to "(internal tracker)" / `internal#N` instead.
//    The patterns are assembled from pieces so this file does not match itself.

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.error) return { status: null, out: "" };
  return { status: r.status, out: r.stdout ?? "" };
}

const top = git(["rev-parse", "--show-toplevel"]);
const root = top.status === 0 ? top.out.trim() : null;

const FORBIDDEN = [
  "/" + "Users/",
  "codex" + "-studio/",
  "ko-" + "bastion#",
  "ko-" + "api#",
  "airflow" + "-project#",
];

describe("repository hygiene (public repo)", () => {
  it("tracks no file that .gitignore excludes", () => {
    if (!root) return;
    const r = git(["-C", root, "ls-files", "--cached", "--ignored", "--exclude-standard"]);
    expect(r.status).toBe(0);
    expect(r.out.split("\n").filter(Boolean)).toEqual([]);
  });

  it("tracked text files carry no local paths or private-repo references", () => {
    if (!root) return;
    const args = ["-C", root, "grep", "-n", "-I", "-F"];
    for (const p of FORBIDDEN) args.push("-e", p);
    const r = git(args);
    // git grep: 0 = matches found, 1 = no match, anything else = error.
    expect(r.status === 0 || r.status === 1).toBe(true);
    expect(r.out.split("\n").filter(Boolean)).toEqual([]);
  });
});
