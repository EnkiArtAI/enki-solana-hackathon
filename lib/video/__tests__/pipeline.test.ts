import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { encryptString, resetKeyringCache } from "@/lib/crypto";
import { VIDEO_JOB_AAD, runVideoJobs } from "@/lib/video/jobs";
import { USER, paidUnit, videoDb } from "./_video-db";

/**
 * The whole minute with the real ffmpeg where FFMPEG_PATH names one (none in CI, so it skips there): a stub operator answers done
 * with a clip, and the real transcode, the real store over the recorder, the real recordGeneration on PGlite run. VIDEO_FIXTURE
 * names a real clip; otherwise one is made here. No network. Blind spot: no provider's own file, no real upload, no real capture.
 */
const p = vi.hoisted(() => ({ frames: [] as Buffer[], clip: "" }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/video/adapters", () => ({ VIDEO_ADAPTERS: { stub: { configured: () => true, submit: async () => ({ taskId: "x" }), poll: async () => ({ state: "done", url: "https://o/v.mp4", usage: null }) } } }));
vi.mock("@/lib/moderation/image-check-bytes", async (original) => ({
  ...(await original<typeof import("@/lib/moderation/image-check-bytes")>()),
  checkImageBytes: async (bytes: Buffer) => { p.frames.push(bytes); return { verdict: "clear" }; },
}));
vi.mock("@/lib/payments/settle", () => ({
  voidAndFlush: async () => true,
  captureHeld: async () => ({ kind: "captured", signature: "sig" }),
}));
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins: async () => {} }));

const FF = process.env.FFMPEG_PATH;
describe.skipIf(!FF)("one job, end to end, with the real binary", () => {
  beforeAll(() => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    resetKeyringCache();
  });

  it("delivers: four public files, a kept original, five real stills judged, the row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipe-"));
    const clip = process.env.VIDEO_FIXTURE && existsSync(process.env.VIDEO_FIXTURE) ? process.env.VIDEO_FIXTURE : join(dir, "c.mp4");
    if (clip.startsWith(dir)) execFileSync(FF!, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", clip], { stdio: "pipe" });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      expect(input).toBe("https://o/v.mp4");
      return new Response(readFileSync(clip));
    }));
    const started = Date.now();

    const v = await videoDb();
    const unit = await paidUnit(v.db);
    await v.db.query("update public.generation_payment_intents set fulfilled_at = null where id = $1", [unit]);
    const model = (await v.db.query<{ id: string }>(`select id from public.models where name = 'Seedance 2.5'`)).rows[0].id;
    const id = crypto.randomUUID();
    const sealed = encryptString(JSON.stringify({ words: "rain", values: {} }), VIDEO_JOB_AAD(id));
    await v.db.query(
      `insert into public.video_jobs (id, user_id, intent_id, model_id, operator, provider_model, provider_task_id, settings, words_ct, words_iv, words_tag, words_kid, end_user_hash, status)
       values ($1, $2, $3, $4, 'stub', 'm', 't', $5, $6, $7, $8, $9, 'h', 'running')`,
      [id, USER, unit, model, JSON.stringify({ modelId: "seedance-2.5", seconds: 8, aspect: "16:9", resolution: "1080p", audio: true, bitrate: "high" }), sealed.encrypted, sealed.iv, sealed.authTag, sealed.kid ?? "field-v1"],
    );

    expect(await runVideoJobs(v.client, { request: new Request("http://enki.test"), deadlineAt: Date.now() + 700_000 })).toEqual({ due: 1, delivered: 1 });

    const puts = v.storage.log.put;
    expect(puts.map((f) => f.bucket)).toEqual(["videos", "videos", "videos", "videos", "video-originals"]);
    expect(puts.every((f) => f.bytes > 0)).toBe(true);
    const preview = puts[0].bytes;
    expect(preview).toBeLessThan(puts[1].bytes);
    expect(p.frames.length).toBe(5);
    expect((await sharp(p.frames[0]).metadata()).format).toBe("jpeg");
    const { rows } = await v.db.query<{ status: string; generated_image_id: string; video: { v1080: string; durationMs: number } }>("select status, generated_image_id, video from public.video_jobs where id = $1", [id]);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].video.v1080).toMatch(/^https:\/\/store\.test\/videos\//);
    const image = (await v.db.query<{ mime_type: string; storage_url: string; file_size_bytes: number }>("select mime_type, storage_url, file_size_bytes from public.generated_images where id = $1", [rows[0].generated_image_id])).rows[0];
    expect(image.mime_type).toBe("video/mp4");
    expect(image.file_size_bytes).toBe(puts[1].bytes);
    console.log(`[pipeline] ${clip.startsWith(dir) ? "lavfi" : "fixture"}: preview ${preview} B, v720 ${puts[1].bytes} B, v1080 ${puts[2].bytes} B, poster ${puts[3].bytes} B, ${Date.now() - started} ms`);
    await v.close();
    rmSync(dir, { recursive: true, force: true });
  }, 300_000);
});
