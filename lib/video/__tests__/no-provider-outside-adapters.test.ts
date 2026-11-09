import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Who runs a video generator is one row and one file (Kev, 2026-11-03: "wir wechseln den betreiber später"): no operator's
 * name or host in lib, components, app or hooks outside lib/video/adapters, and on the video path no image provider's host
 * or key either, so a video can reach none of them whichever keys are set. Blind spot: this reads words; a host put together
 * at run time would pass. VideoModel's labels stay, they are what Kev asked for by name.
 */
const ROOT = join(__dirname, "..", "..", "..");
const OPERATORS = /byteplus|modelark|volces|ark_api_key|dashscope|aliyuncs|alibabacloud|model studio|klingai|kling\.ai|kling_(access|secret|api)/i;
const IMAGE_HOSTS = /wavespeed|generativelanguage|ai\.google\.dev|gemini_api_key|googleapis/i;
const VIDEO_PATH = /^(lib\/video\/|components\/create\/video\/|components\/image-view\/useVideoPrompt|app\/api\/video\/|hooks\/useVideoRoutes|lib\/ui\/image-view\/video)/;
// Remix's own rate, its comment naming the page it was read on; not the video path.
const LEFT_OUT = /(^|\/)__tests__\/|^lib\/video\/adapters\/|^lib\/remix\/price\.ts$/;

type Source = { path: string; text: string };
function sources(dir: string): Source[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [{ path, text: readFileSync(join(ROOT, path), "utf8") }] : [];
  });
}
const named = (files: Source[]) => files
  .filter((f) => !LEFT_OUT.test(f.path) && (OPERATORS.test(f.text) || (VIDEO_PATH.test(f.path) && IMAGE_HOSTS.test(f.text))))
  .map((f) => f.path);

describe("no provider outside its adapter", () => {
  it("is held by every source file", () => {
    const all = ["lib", "components", "app", "hooks"].flatMap(sources);
    expect(all.length).toBeGreaterThan(500);
    expect(named(all)).toEqual([]);
  });

  it("a planted name is found, in the right places and only there", () => {
    expect(named([{ path: "lib/foo.ts", text: "// runs on BytePlus" }])).toEqual(["lib/foo.ts"]);
    expect(named([{ path: "app/x.ts", text: "fetch('https://api-singapore.klingai.com')" }])).toEqual(["app/x.ts"]);
    expect(named([{ path: "lib/video/routes.ts", text: "process.env.WAVESPEED_API_KEY" }])).toEqual(["lib/video/routes.ts"]);
    expect(named([{ path: "app/api/video/quote/route.ts", text: "process.env.GEMINI_API_KEY" }])).toEqual(["app/api/video/quote/route.ts"]);
    // The image path keeps its own hosts, an operator's file its name.
    expect(named([{ path: "lib/generation/gemini.ts", text: "process.env.GEMINI_API_KEY" }])).toEqual([]);
    expect(named([{ path: "lib/video/adapters/byteplus.ts", text: "BytePlus" }])).toEqual([]);
    expect(named([{ path: "lib/video/__tests__/x.test.ts", text: "BytePlus" }])).toEqual([]);
  });
});
