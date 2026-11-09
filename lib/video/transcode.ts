import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

/**
 * What a provider's file becomes (decided 2026-10-30, the preview 2026-11-03, DEC-2026-11-03-66). The provider's original stays
 * private and is never served: Seedance's 1080p is 10-bit HEVC, which Chrome on Windows and Linux, Edge and old Firefox cannot
 * play. v720 and v1080 are the only files with sound; preview.mp4 is the silent feed loop; poster.webp what every picture surface
 * shows. One thread each: measured `27864 ms` for an 11 s 1080p job on one desktop thread, and several jobs may share a function.
 */
export const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const FFMPEG_MS = 8 * 60_000;
/** Up to 5 stills go to the image check; the first is also the poster, so no surface shows a frame nothing judged. */
const POSTER_SHORT_SIDE = 480;

const short = (side: number) => `scale='if(lt(iw,ih),${side},-2)':'if(lt(iw,ih),-2,${side})':flags=bicubic,fps=24,format=yuv420p`;
const H264 = ["-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-g", "48", "-movflags", "+faststart", "-map_metadata", "-1"];
const SOUND = ["-c:a", "aac", "-b:a", "128k", "-ac", "2"];

export const previewArgs = () => ["-t", "6", "-vf", short(480), "-an", ...H264, "-crf", "32", "-maxrate", "500k", "-bufsize", "1000k"];
export const v720Args = () => ["-vf", short(720), ...H264, "-crf", "26", "-maxrate", "2500k", "-bufsize", "5000k", ...SOUND];
export const v1080Args = () => ["-vf", short(1080), ...H264, "-crf", "23", "-maxrate", "5000k", "-bufsize", "10000k", ...SOUND];

/** Where to take the still pictures, in seconds: the poster's (1 s, or the middle of a shorter clip), the quarters and the end, each once. */
export function frameTimes(durationMs: number): number[] {
  const d = Math.max(durationMs, 200) / 1000;
  const at = [Math.min(1, d / 2), d / 4, d / 2, (3 * d) / 4, Math.max(0, d - 0.1)].map((t) => Math.round(t * 100) / 100);
  return [...new Set(at)];
}

/** The binary: FFMPEG_PATH where one is named (a checkout, a test), else ffmpeg-static's, traced into the cron's function by next.config. */
export const ffmpegPath = () => process.env.FFMPEG_PATH || join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

/**
 * env: {}: ffmpeg parses a file from elsewhere, so the process doing that inherits none of this function's secrets, and they
 * reach no crash report or child of its own. Not a sandbox: on Linux a compromised ffmpeg under the same uid can still read
 * /proc/<parent>/environ (DEC-2026-11-04-78).
 */
const run = (args: string[], signal?: AbortSignal) => new Promise<{ code: number; stderr: string }>((done, fail) => {
  execFile(ffmpegPath(), ["-hide_banner", "-y", ...args], { maxBuffer: 1 << 24, timeout: FFMPEG_MS, signal, env: {} as NodeJS.ProcessEnv }, (error, _out, stderr) => {
    const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
    if (code === null) fail(new Error(`[video] ffmpeg did not run: ${error?.name ?? "unknown"}`));
    else done({ code, stderr });
  });
});
const must = async (args: string[], signal?: AbortSignal) => {
  const { code } = await run(["-threads", "1", ...args], signal);
  if (code !== 0) throw new Error(`[video] ffmpeg exited ${code}`);
};

export interface SourceInfo { durationMs: number; width: number; height: number; audio: boolean }

/** What ffmpeg says of a file with no output named (it exits 1 for that, which is no failure here). Null when it finds no picture. */
export function readInfo(stderr: string): SourceInfo | null {
  const time = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const size = /Stream #[^\n]*Video:[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr);
  if (!time || !size) return null;
  return {
    durationMs: Math.round((Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000),
    width: Number(size[1]),
    height: Number(size[2]),
    audio: /Stream #[^\n]*Audio:/.test(stderr),
  };
}

/** The provider's file on disk, https only with redirects refused (as lib/wallet-nfts reads a picture), and with a ceiling: it is the one thing here read from elsewhere. */
async function download(url: string, to: string, signal?: AbortSignal): Promise<number> {
  if (!/^https:\/\//i.test(url)) throw new Error("[video] the output is not https");
  const res = await fetch(url, { signal, redirect: "error" });
  if (!res.ok || !res.body) throw new Error(`[video] the output answered ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_SOURCE_BYTES) throw new Error("[video] the output is too large");
  let bytes = 0;
  const counted = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_BYTES) throw new Error("[video] the output is too large");
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body as never), counted, createWriteStream(to));
  return bytes;
}

export interface Transcoded {
  dir: string;
  original: string;
  preview: string;
  v720: string;
  v1080: string | null;
  poster: Buffer;
  /** JPEGs for the image check, the poster's frame first. */
  frames: Buffer[];
  info: SourceInfo;
}

/**
 * Downloads and encodes in a directory of its own, which the caller removes with removeTranscoded. High keeps v720 and v1080
 * where the source has it; Standard v720 alone (Kev asked for Sume's pill, and the provider has no bitrate field, so this is what
 * it means: a smaller file, less storage). Throws on anything it cannot do; nothing is half delivered from here.
 */
export async function transcode(url: string, { bitrate, signal }: { bitrate: "high" | "standard"; signal?: AbortSignal }): Promise<Transcoded> {
  const dir = await mkdtemp(join(tmpdir(), "video-"));
  try {
    const original = join(dir, "original");
    await download(url, original, signal);
    const info = readInfo((await run(["-i", original], signal)).stderr);
    if (!info) throw new Error("[video] the output holds no picture");

    const out = (name: string) => join(dir, name);
    await must(["-i", original, "-threads", "1", ...previewArgs(), out("preview.mp4")], signal);
    await must(["-i", original, "-threads", "1", ...v720Args(), out("v720.mp4")], signal);
    const big = bitrate === "high" && Math.min(info.width, info.height) >= 1080;
    if (big) await must(["-i", original, "-threads", "1", ...v1080Args(), out("v1080.mp4")], signal);

    const frames: Buffer[] = [];
    for (const [i, t] of frameTimes(info.durationMs).entries()) {
      await must(["-ss", String(t), "-i", original, "-frames:v", "1", "-q:v", "3", out(`frame${i}.jpg`)], signal);
      frames.push(await readFile(out(`frame${i}.jpg`)));
    }
    const wide = info.width >= info.height;
    const poster = await sharp(frames[0])
      .resize(wide ? { height: POSTER_SHORT_SIDE } : { width: POSTER_SHORT_SIDE })
      .webp({ quality: 75 })
      .toBuffer();
    return { dir, original, preview: out("preview.mp4"), v720: out("v720.mp4"), v1080: big ? out("v1080.mp4") : null, poster, frames, info };
  } catch (e) {
    await removeTranscoded(dir);
    throw e;
  }
}

export const removeTranscoded = (dir: string) => rm(dir, { recursive: true, force: true }).catch(() => undefined);
