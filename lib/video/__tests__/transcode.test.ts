import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { MAX_SOURCE_BYTES, ffmpegPath, frameTimes, previewArgs, readInfo, removeTranscoded, transcode, v1080Args, v720Args } from "@/lib/video/transcode";
import { removeStored, storeVideo } from "@/lib/video/store";
import { readSource } from "@/lib/__tests__/_read-source";
import { storageStub } from "./_video-db";

/**
 * The encodes' arguments, what ffmpeg's words are read as, and one real run where a binary is named by FFMPEG_PATH (none in CI or on
 * Vercel's test path, so it skips there). No network: the operator's file is a stubbed fetch of a clip made here. Blind spot: a clip
 * from lavfi is 8-bit H.264; no real Seedance 10-bit HEVC source was in any run, and nobody looked at the picture.
 */
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const arg = (args: string[], name: string) => args[args.indexOf(name) + 1];

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the settled encodes", () => {
  it("preview: 6 s, silent, 480 short side, crf 32 under 500k, faststart, no metadata", () => {
    const a = previewArgs();
    expect(a).toContain("-an");
    expect(a).not.toContain("-c:a");
    expect([arg(a, "-t"), arg(a, "-crf"), arg(a, "-maxrate"), arg(a, "-bufsize"), arg(a, "-c:v"), arg(a, "-profile:v"), arg(a, "-movflags"), arg(a, "-map_metadata"), arg(a, "-g")])
      .toEqual(["6", "32", "500k", "1000k", "libx264", "high", "+faststart", "-1", "48"]);
    expect(arg(a, "-vf")).toContain("if(lt(iw,ih),480,-2)");
    expect(arg(a, "-vf")).toContain("format=yuv420p");
  });

  it("v720 and v1080 carry the sound, each with its settled quality", () => {
    expect([arg(v720Args(), "-crf"), arg(v720Args(), "-maxrate"), arg(v720Args(), "-c:a"), arg(v720Args(), "-b:a")]).toEqual(["26", "2500k", "aac", "128k"]);
    expect([arg(v1080Args(), "-crf"), arg(v1080Args(), "-maxrate"), arg(v1080Args(), "-c:a"), arg(v1080Args(), "-b:a")]).toEqual(["23", "5000k", "aac", "128k"]);
    expect(arg(v720Args(), "-vf")).toContain("if(lt(iw,ih),720,-2)");
    expect(arg(v1080Args(), "-vf")).toContain("if(lt(iw,ih),1080,-2)");
    expect([v720Args(), v1080Args()].every((a) => !a.includes("-an") && arg(a, "-movflags") === "+faststart")).toBe(true);
  });

  it("up to 5 stills: the poster's first, the quarters, the end, each once and inside the clip", () => {
    expect(frameTimes(8000)).toEqual([1, 2, 4, 6, 7.9]);
    expect(frameTimes(4000)).toEqual([1, 2, 3, 3.9]);
    const short = frameTimes(1000);
    expect(short[0]).toBe(0.5);
    expect(new Set(short).size).toBe(short.length);
    expect(Math.max(...short)).toBeLessThan(1);
    expect(frameTimes(0).every((t) => t >= 0)).toBe(true);
  });

  it("the binary: FFMPEG_PATH, else ffmpeg-static's, from the function's own directory", () => {
    vi.stubEnv("FFMPEG_PATH", "/x/ffmpeg");
    expect(ffmpegPath()).toBe("/x/ffmpeg");
    vi.stubEnv("FFMPEG_PATH", "");
    expect(ffmpegPath()).toBe(join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
  });
});

describe("the binary reaches one function", () => {
  it("next.config traces it into the cron's route alone, at the path it is read from", () => {
    const config = readSource(join(__dirname, "..", "..", "..", "next.config.ts"));
    expect(config).toContain('outputFileTracingIncludes: { "/api/cron/video-jobs": ["./node_modules/ffmpeg-static/ffmpeg"] }');
    const pkg = JSON.parse(readSource(join(__dirname, "..", "..", "..", "package.json"))) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["ffmpeg-static"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("what ffmpeg says of a file", () => {
  const SAYS = `Input #0, mov,mp4, from 'x':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv), 1920x1080, 900 kb/s, 24 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s`;

  it("reads length, size and sound", () => {
    expect(readInfo(SAYS)).toEqual({ durationMs: 62500, width: 1920, height: 1080, audio: true });
  });
  it("no sound is no sound; no picture is null", () => {
    expect(readInfo(SAYS.split("\n").slice(0, 3).join("\n"))?.audio).toBe(false);
    expect(readInfo("  Duration: 00:00:04.00\n  Stream #0:0: Audio: aac")).toBeNull();
    expect(readInfo("garbage")).toBeNull();
  });
});

describe("what ffmpeg runs with", () => {
  it("an empty environment: the process that parses a file from elsewhere holds no secret", async () => {
    vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", "stub-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no video")));
    vi.mocked(execFile).mockImplementationOnce(((_file: string, _args: string[], _options: object, done: (e: Error, out: string, err: string) => void) => {
      done(Object.assign(new Error("exit"), { code: 1 }), "", "says nothing");
    }) as never);
    await expect(transcode("https://o/v.mp4", { bitrate: "high" })).rejects.toThrow("holds no picture");
    const options = vi.mocked(execFile).mock.calls.at(-1)![2] as { env?: unknown };
    expect(options.env).toStrictEqual({});
  });
});

describe("what is read from elsewhere", () => {
  it("an http address is refused, and leaves nothing behind", async () => {
    await expect(transcode("http://o/v.mp4", { bitrate: "high" })).rejects.toThrow("not https");
  });
  it("a declared size past the ceiling is refused before any byte is kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(4), { headers: { "content-length": String(MAX_SOURCE_BYTES + 1) } })));
    await expect(transcode("https://o/v.mp4", { bitrate: "high" })).rejects.toThrow("too large");
  });
  it("an answer past the ceiling that declares none is cut off", async () => {
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(MAX_SOURCE_BYTES / 3)); c.close(); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big)));
    await expect(transcode("https://o/v.mp4", { bitrate: "high" })).rejects.toThrow("too large");
  }, 30_000);
  it("a refused download is a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      // A redirect is refused by the fetch itself: "https only" would otherwise hold for the first address alone.
      expect(init?.redirect).toBe("error");
      return new Response("no", { status: 403 });
    }));
    await expect(transcode("https://o/v.mp4", { bitrate: "high" })).rejects.toThrow("answered 403");
  });
});

const t = {
  dir: "", original: "", preview: "", v720: "", v1080: null as string | null, poster: Buffer.from("poster"), frames: [], info: { durationMs: 4000, width: 854, height: 480, audio: true },
};
describe("the store", () => {
  const files = () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const put = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };
    return { dir, made: { ...t, dir, original: put("o", "original"), preview: put("p", "preview"), v720: put("7", "seven"), v1080: put("1", "ten") } };
  };
  const SHA = /^u1\/[0-9a-f]{64}\.(mp4|webp)$/;

  it("puts each file under its hash, immutable for a year, the original privately", async () => {
    const { dir, made } = files();
    const storage = storageStub();
    const stored = await storeVideo({ storage } as never, "u1", made);
    expect(storage.log.put.map((p) => p.bucket)).toEqual(["videos", "videos", "videos", "videos", "video-originals"]);
    expect(storage.log.put.every((p) => SHA.test(p.path))).toBe(true);
    expect(storage.log.put.slice(0, 4).every((p) => p.options.cacheControl === "31536000")).toBe(true);
    expect(storage.log.put.map((p) => p.options.contentType)).toEqual(["video/mp4", "video/mp4", "video/mp4", "image/webp", "video/mp4"]);
    expect(stored).toMatchObject({ width: 854, height: 480, durationMs: 4000, v720Bytes: 5 });
    expect(stored.poster).toMatch(/^https:\/\/store\.test\/videos\/u1\/[0-9a-f]{64}\.webp$/);
    expect(stored.v1080).toMatch(/^https:\/\/store\.test\/videos\//);
    // The original has no public address, and is not named for taking down with the public files.
    expect(stored.paths).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toContain("video-originals");
    rmSync(dir, { recursive: true, force: true });
  });

  it("no v1080 where none was made", async () => {
    const { dir, made } = files();
    const stored = await storeVideo({ storage: storageStub() } as never, "u1", { ...made, v1080: null });
    expect(stored.v1080).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the same bytes, the same name", async () => {
    const { dir, made } = files();
    const [a, b] = [storageStub(), storageStub()];
    await storeVideo({ storage: a } as never, "u1", made);
    await storeVideo({ storage: b } as never, "u1", made);
    expect(a.log.put.map((p) => p.path)).toEqual(b.log.put.map((p) => p.path));
    rmSync(dir, { recursive: true, force: true });
  });

  it("a public file refused: what landed comes down, and it throws", async () => {
    const { dir, made } = files();
    const storage = storageStub();
    storage.log.failPut = /webp$/;
    await expect(storeVideo({ storage } as never, "u1", made)).rejects.toThrow("could not be stored");
    expect(storage.log.removed).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the original refused is no failure: the buyer's video does not depend on it", async () => {
    const { dir, made } = files();
    const storage = storageStub();
    storage.log.failPut = /^video-originals/;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(storeVideo({ storage } as never, "u1", made)).resolves.toMatchObject({ v720Bytes: 5 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("taking down names the paths; nothing to take down asks nothing", async () => {
    const storage = storageStub();
    await removeStored({ storage } as never, []);
    expect(storage.log.removed).toEqual([]);
    await removeStored({ storage } as never, ["a", "b"]);
    expect(storage.log.removed).toEqual(["a", "b"]);
  });
});

/** A real binary, when one is named. */
const FF = process.env.FFMPEG_PATH;
describe.skipIf(!FF)("a real encode", () => {
  const ff = (args: string[]) => execFileSync(FF!, ["-hide_banner", "-y", ...args], { stdio: "pipe" });
  const says = (file: string) => {
    try { execFileSync(FF!, ["-hide_banner", "-i", file], { stdio: "pipe" }); return ""; }
    catch (e) { return String((e as { stderr: Buffer }).stderr); }
  };
  /** Whether the file's index comes before its data. */
  const moovFirst = (file: string) => { const b = readFileSync(file).toString("latin1"); return b.indexOf("moov") < b.indexOf("mdat"); };

  it("a 1080p clip with sound becomes the whole set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "src-"));
    const src = join(dir, "s.mp4");
    ff(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(readFileSync(src))));

    const high = await transcode("https://o/v.mp4", { bitrate: "high" });
    expect(high.info).toMatchObject({ width: 1920, height: 1080, audio: true });
    expect(Math.abs(high.info.durationMs - 8000)).toBeLessThan(200);

    const preview = says(high.preview);
    expect(preview).not.toMatch(/Audio:/);
    expect(preview).toMatch(/h264 \(High\)/);
    expect(preview).toMatch(/yuv420p/);
    expect(preview).toMatch(/, 854x480/);
    expect(preview).toMatch(/Duration: 00:00:06/);
    expect(moovFirst(high.preview)).toBe(true);

    const v720 = says(high.v720);
    expect(v720).toMatch(/Audio: aac/);
    expect(v720).toMatch(/, 1280x720/);
    expect(moovFirst(high.v720)).toBe(true);
    expect(says(high.v1080!)).toMatch(/, 1920x1080/);

    const poster = await sharp(high.poster).metadata();
    expect([poster.format, poster.height]).toEqual(["webp", 480]);
    expect(high.poster.length).toBeLessThan(35_000);
    expect(high.frames).toHaveLength(5);
    expect((await sharp(high.frames[0]).metadata()).format).toBe("jpeg");
    await removeTranscoded(high.dir);

    const standard = await transcode("https://o/v.mp4", { bitrate: "standard" });
    expect(standard.v1080).toBeNull();
    await removeTranscoded(standard.dir);
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it("a tall clip keeps its shape; one under 1080p makes no v1080; a silent one stays silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "src-"));
    const src = join(dir, "t.mp4");
    ff(["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24:duration=2", "-c:v", "libx264", "-preset", "ultrafast", src]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(readFileSync(src))));
    const made = await transcode("https://o/v.mp4", { bitrate: "high" });
    expect(made.v1080).toBeNull();
    expect(made.info.audio).toBe(false);
    expect(says(made.preview)).toMatch(/, 480x854/);
    expect(says(made.v720)).not.toMatch(/Audio:/);
    expect((await sharp(made.poster).metadata()).width).toBe(480);
    await removeTranscoded(made.dir);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("a file that holds no picture throws and leaves nothing to deliver", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("this is no video")));
    await expect(transcode("https://o/v.mp4", { bitrate: "high" })).rejects.toThrow("holds no picture");
  }, 30_000);
});
