import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * DEC-512 (Kev, 2026-10-29: "with the preview image visible in the notification"): a followed maker's new post shows
 * its picture in place of the icon and opens the post.
 */
const shell = vi.hoisted(() => ({ items: [] as unknown[], push: vi.fn() }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useEffect: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: shell.push }) }));
vi.mock("@/hooks/useNotifications", () => ({ useNotifications: () => ({ items: shell.items, unseen: 0, loaded: true }), markNotificationsSeen: vi.fn() }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({}) }));

import NotificationsPanel from "@/components/enki-shell/NotificationsPanel";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const notif = (over: Record<string, unknown>) => ({ id: "n", kind: "comment", title: "t", body: null, targetType: null, targetId: null, count: 1, seen: false, createdAt: new Date().toISOString(), meta: {}, ...over });

describe("a new post in the notifications panel", () => {
  it("shows the post's picture in place of the icon, and opens the image or the prompt", () => {
    shell.items = [
      notif({ id: "a", kind: "new_image", targetType: "image", targetId: "i-1", meta: { thumb: "https://blob.test/t.webp" } }),
      notif({ id: "b", kind: "new_prompt", targetType: "prompt", targetId: "p-1" }),
    ];
    const tree = NotificationsPanel({}) as El;
    expect([...walk(tree)].filter((el) => el.type === "img").map((el) => el.props.src)).toEqual(["https://blob.test/t.webp"]);
    const rows = [...walk(tree)].filter((el) => el.props.role === "link");
    expect(rows.map((r) => r.props.title)).toEqual(["Open this image", "Open this prompt"]);
    (rows[0].props.onClick as () => void)();
    expect(shell.push).toHaveBeenCalledWith("/i/i-1");
  });
});
