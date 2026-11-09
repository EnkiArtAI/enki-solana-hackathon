import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("share.css", () => {
  const css = readFileSync(join(__dirname, "..", "..", "..", "components", "share", "share.css"), "utf8");
  it("holds no colour of its own: no hex, no rgb", () => {
    expect(css.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull();
    expect(css.match(/rgba?\(/gi)).toBeNull();
  });
  it("sits under the notices and the step-up", () => {
    expect(css).toContain("z-index: 10010");
  });
});
