import { describe, it, expect } from "vitest";
import { formatAgo, downloadName, fileId } from "../format";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const before = (ms: number) => NOW - ms;
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

describe("formatAgo", () => {
  it("long: just now, minutes, hours, yesterday, days, weeks", () => {
    expect(formatAgo(before(30 * S), NOW)).toBe("just now");
    expect(formatAgo(before(5 * M), NOW)).toBe("5m ago");
    expect(formatAgo(before(59 * M + 59 * S), NOW)).toBe("59m ago");
    expect(formatAgo(before(90 * M), NOW)).toBe("1h ago");
    expect(formatAgo(before(2 * H + 5 * M), NOW)).toBe("2h ago");
    expect(formatAgo(before(23 * H), NOW)).toBe("23h ago");
    expect(formatAgo(before(30 * H), NOW)).toBe("yesterday");
    expect(formatAgo(before(2 * D), NOW)).toBe("2d ago");
    expect(formatAgo(before(3 * D), NOW)).toBe("3d ago");
    expect(formatAgo(before(8 * D), NOW)).toBe("1w ago");
    expect(formatAgo(before(34 * D), NOW)).toBe("4w ago");
  });

  it("short: now, 5m, 2h, 1d, 3w", () => {
    expect(formatAgo(before(30 * S), NOW, "short")).toBe("now");
    expect(formatAgo(before(5 * M), NOW, "short")).toBe("5m");
    expect(formatAgo(before(2 * H), NOW, "short")).toBe("2h");
    expect(formatAgo(before(30 * H), NOW, "short")).toBe("1d");
    expect(formatAgo(before(21 * D), NOW, "short")).toBe("3w");
  });

  it("gives the date from five weeks on, with the year only when it differs", () => {
    expect(formatAgo("2026-08-09T12:00:00Z", NOW)).toBe("Aug 9");
    expect(formatAgo("2026-08-09T12:00:00Z", NOW, "short")).toBe("Aug 9");
    expect(formatAgo("2025-08-09T12:00:00Z", NOW)).toBe("Aug 9, 2025");
    expect(formatAgo(before(35 * D), NOW)).toBe("Sep 4");
  });

  it("reads an ISO string, says just now for a clock ahead of ours, and nothing for garbage", () => {
    expect(formatAgo("2026-10-09T09:00:00Z", NOW)).toBe("3h ago");
    expect(formatAgo(NOW + 5 * M, NOW)).toBe("just now");
    expect(formatAgo("not a date", NOW)).toBe("");
  });
});

describe("downloadName", () => {
  it("is our prefix, the title's slug, the file's id and the type's extension (Kev, 2026-10-16)", () => {
    expect(downloadName("  Misty Harbor, at dawn!", "1792100285989_r22xj00", "image/webp")).toBe("enki-misty-harbor-at-dawn-1792100285989_r22xj00.webp");
    expect(downloadName("Cat", "a1b2c3d4", "image/png")).toBe("enki-cat-a1b2c3d4.png");
    expect(downloadName("Cat", "a1b2c3d4", "image/jpeg")).toBe("enki-cat-a1b2c3d4.jpg");
  });

  it("falls back to webp, and to the prefix alone when the title has no letters", () => {
    expect(downloadName("Cat", "a1b2c3d4", "")).toBe("enki-cat-a1b2c3d4.webp");
    expect(downloadName("名前", "a1b2c3d4", "image/webp")).toBe("enki-a1b2c3d4.webp");
    expect(downloadName("", "a1b2c3d4", "image/png")).toBe("enki-a1b2c3d4.png");
  });

  it("gives the prefix once for a title that starts with enki, never a word that only begins with it", () => {
    expect(downloadName("enki-k7q2xm3a", "a1b2c3d4", "image/png")).toBe("enki-k7q2xm3a-a1b2c3d4.png");
    expect(downloadName("Enki", "a1b2c3d4", "image/png")).toBe("enki-a1b2c3d4.png");
    expect(downloadName("Enkidu", "a1b2c3d4", "image/png")).toBe("enki-enkidu-a1b2c3d4.png");
  });
});

describe("fileId", () => {
  it("is the stored file's own name, whatever rendition or query the link carries", () => {
    expect(fileId("https://x.public.blob.vercel-storage.com/generations/1792100285989_r22xj00.png")).toBe("1792100285989_r22xj00");
    expect(fileId("https://x.public.blob.vercel-storage.com/generations/u/1792100290035_5h436bu.preview.webp?download=1")).toBe("1792100290035_5h436bu");
  });

  it("stamps a link that names nothing usable, differently each time", () => {
    const a = fileId("data:image/png;base64,AAAAAAAAAAAA");
    const b = fileId("https://cdn.example/x.png");
    expect(a).toMatch(/^[a-z0-9]{10,}$/);
    expect(b).toMatch(/^[a-z0-9]{10,}$/);
    expect(a).not.toBe(b);
  });
});
