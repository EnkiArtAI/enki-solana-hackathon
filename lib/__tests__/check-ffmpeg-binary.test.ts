import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdict } from "../../scripts/check-ffmpeg-binary.mjs";

/**
 * The build's check of ffmpeg-static's binary, on temp files. Blind spot: no real ffmpeg-static binary is in this
 * checkout (`npm ci` on Linux fetches it), so a real match happens first on CI's build job or on Vercel.
 */
const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-ffmpeg-binary.mjs");
const check = verdict as (file: string, target: string, pins?: Record<string, string>) => { exit: number; line: string };

describe("the ffmpeg-static binary check", () => {
  let dir: string;
  let file: string;
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ffcheck-"));
    file = join(dir, "bin");
    writeFileSync(file, "the binary");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the pinned digest passes and says verified", () => {
    expect(check(file, "linux-x64", { "linux-x64": digest("the binary") })).toEqual({ exit: 0, line: "ffmpeg-static linux-x64 verified" });
  });

  it("another digest stops the build, and hashes the file it was given", () => {
    const r = check(file, "linux-x64", { "linux-x64": digest("another binary") });
    expect(r.exit).toBe(1);
    expect(r.line).toContain(`sha256 ${digest("the binary")} is not the pinned ${digest("another binary")}`);
  });

  it("a platform with no pin says NOT verified, with the hash to pin, and passes", () => {
    expect(check(file, "darwin-arm64", { "linux-x64": digest("the binary") })).toEqual({ exit: 0, line: `ffmpeg-static: no pin for darwin-arm64, sha256 ${digest("the binary")}: NOT verified` });
  });

  it("no binary says NOT verified and passes", () => {
    const r = check(join(dir, "nothing"), "linux-x64", { "linux-x64": digest("x") });
    expect(r.exit).toBe(0);
    expect(r.line).toMatch(/no binary at .*: NOT verified$/);
  });

  it("holds the two published digests of b6.1.1, and package.json still names ffmpeg-static 5.3.0", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain('"linux-x64": "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99"');
    expect(source).toContain('"win32-x64": "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00"');
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies["ffmpeg-static"]).toBe("5.3.0");
  });

  it("runs before every build", () => {
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.prebuild).toBe("node scripts/check-ffmpeg-binary.mjs");
  });

  describe("as the build runs it", () => {
    const run = (cwd: string) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: "utf8" });
    const here = `${process.platform}-${process.arch}`;

    it("no binary in the checkout: exit 0, NOT verified", () => {
      const r = run(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("NOT verified");
    });

    it.skipIf(!["linux-x64", "win32-x64"].includes(here))("a binary that is not the release's: exit 1, on stderr", () => {
      const cwd = mkdtempSync(join(tmpdir(), "ffcheck-"));
      mkdirSync(join(cwd, "node_modules", "ffmpeg-static"), { recursive: true });
      writeFileSync(join(cwd, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), "tampered");
      const r = run(cwd);
      rmSync(cwd, { recursive: true, force: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${digest("tampered")} is not the pinned`);
      expect(r.stdout).toBe("");
    });

    // A copy in a temp folder, reached through a link to that folder: nothing here links into the repo.
    it.skipIf(!["linux-x64", "win32-x64"].includes(here))("reached through a link, the same binary still stops the build: the check never skips in silence", () => {
      const base = mkdtempSync(join(tmpdir(), "ffcheck-"));
      const real = join(base, "real");
      mkdirSync(join(real, "scripts"), { recursive: true });
      mkdirSync(join(real, "node_modules", "ffmpeg-static"), { recursive: true });
      writeFileSync(join(real, "scripts", "check-ffmpeg-binary.mjs"), readFileSync(SCRIPT));
      writeFileSync(join(real, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), "tampered");
      const link = join(base, "link");
      symlinkSync(real, link, "junction");
      const r = spawnSync(process.execPath, [join(link, "scripts", "check-ffmpeg-binary.mjs")], { cwd: link, encoding: "utf8" });
      rmSync(base, { recursive: true, force: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${digest("tampered")} is not the pinned`);
    });
  });
});
