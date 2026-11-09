import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast }));
const { notify } = await import("@/components/kit/notify");

describe("notify", () => {
  beforeEach(() => toast.mockClear());

  it("hands the message to the global toaster, once", () => {
    notify("Prompt copied");
    expect(toast).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith({ description: "Prompt copied", variant: "default" });
  });

  it("shows an error in the destructive look", () => {
    notify("NFT image unavailable", { tone: "error" });
    expect(toast).toHaveBeenCalledWith({ description: "NFT image unavailable", variant: "destructive" });
  });
});

describe("the toaster it speaks through", () => {
  const ui = (name: string) => readSource(join(__dirname, "..", "..", "..", "..", "components", "ui", name));

  it("shows a toast for 2 s", () => {
    expect(ui("toaster.tsx")).toMatch(/<ToastProvider duration=\{2000\}>/);
  });

  it("sits bottom centre, where useToastOffset can lift it", () => {
    const viewport = ui("toast.tsx");
    expect(viewport).toContain("bottom-[var(--enki-toast-bottom,16px)] left-1/2");
    expect(viewport).toContain("-translate-x-1/2");
  });

  it("is the v2 pill: ink with paper, radius 14, 14 px (handoff §5.17)", () => {
    const toast = ui("toast.tsx");
    expect(toast).toContain("rounded-[14px] px-[18px] py-[11px] text-[14px] font-medium");
    expect(toast).toContain("bg-[var(--enki-ink)] text-[var(--enki-paper)]");
  });

  it("sits 120 px up while the Image View is open", () => {
    const view = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "ImageView.tsx"));
    expect(view).toContain("useToastOffset(model.status === \"ready\" ? 120 : null);");
  });
});
