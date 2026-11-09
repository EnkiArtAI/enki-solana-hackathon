// Runs before every `npm run build`: is the binary ffmpeg-static's install fetched the one its release published?
// A mismatch stops the build, so production stays on its last deployment. A platform without a pin, or no binary at
// all, says NOT verified and passes: a checkout without one still builds, and the cron fails its jobs safely.
// The pins are GitHub's digests of ffmpeg-static 5.3.0's binary-release-tag b6.1.1, read without downloading anything.
// For a new platform or version:
//   gh api repos/eugeneware/ffmpeg-static/releases/tags/<tag> --jq '.assets[]|select(.name=="ffmpeg-<platform>-<arch>")|.digest'
// Blind spot: a digest says the file is the one uploaded, not that the publisher's build is clean. FFMPEG_PATH is unchecked.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PINS = {
  "linux-x64": "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
  "win32-x64": "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
};

/** What the build is told about this file. */
export function verdict(file, target, pins = PINS) {
  if (!existsSync(file)) return { exit: 0, line: `ffmpeg-static: no binary at ${file}: NOT verified` };
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (!pins[target]) return { exit: 0, line: `ffmpeg-static: no pin for ${target}, sha256 ${sha256}: NOT verified` };
  if (sha256 !== pins[target]) return { exit: 1, line: `ffmpeg-static ${target}: sha256 ${sha256} is not the pinned ${pins[target]}. Do not ship this binary.` };
  return { exit: 0, line: `ffmpeg-static ${target} verified` };
}

// By name: a URL comparison skipped the whole check, silently and with exit 0, when the path ran through a link.
if (process.argv[1]?.endsWith("check-ffmpeg-binary.mjs")) {
  // The path lib/video/transcode.ts ffmpegPath() reads.
  const file = join(process.cwd(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const { exit, line } = verdict(file, `${process.platform}-${process.arch}`);
  (exit ? console.error : console.log)(line);
  process.exit(exit);
}
