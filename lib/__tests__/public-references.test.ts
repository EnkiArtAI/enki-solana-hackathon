import { describe, expect, it } from "vitest";
import { publicReferences } from "@/lib/public-references";

/**
 * DEC-514: lib/public-references.ts asks for public images whose owner shows their references, then those renders'
 * references in the order they were sent; a failed read (before SQL 43 the column is missing) shows none.
 */
type Call = [string, ...unknown[]];
const fake = (answers: Record<string, { data: unknown[] | null; error: { code: string } | null }>) => {
  const calls: Record<string, Call[]> = {};
  const client = {
    from: (table: string) => {
      const log: Call[] = (calls[table] = []);
      const q = {
        select: (...a: unknown[]) => { log.push(["select", ...a]); return q; },
        in: (...a: unknown[]) => { log.push(["in", ...a]); return q; },
        eq: (...a: unknown[]) => { log.push(["eq", ...a]); return q; },
        order: (...a: unknown[]) => { log.push(["order", ...a]); return q; },
        then: (ok: (v: unknown) => unknown) => Promise.resolve(answers[table]).then(ok),
      };
      return q;
    },
  };
  return { calls, client: client as never };
};

describe("the references shown with public images", () => {
  it("are asked of public images whose owner shows them, then in the order they were sent, for every image of a render", async () => {
    const { calls, client } = fake({
      generated_images: { data: [{ id: "i1", generation_id: "g1" }, { id: "i2", generation_id: "g1" }, { id: "i3", generation_id: null }], error: null },
      generation_reference_images: { data: [{ generation_id: "g1", storage_url: "https://blob/r1.webp" }, { generation_id: "g1", storage_url: null }, { generation_id: "g1", storage_url: "https://blob/r2.webp" }], error: null },
    });
    const got = await publicReferences(client, ["i1", "i2", "i3"]);
    expect([...got]).toEqual([["i1", ["https://blob/r1.webp", "https://blob/r2.webp"]], ["i2", ["https://blob/r1.webp", "https://blob/r2.webp"]]]);
    expect(calls.generated_images).toEqual([["select", "id, generation_id"], ["in", "id", ["i1", "i2", "i3"]], ["eq", "visibility", "public"], ["eq", "references_public", true]]);
    expect(calls.generation_reference_images).toEqual([
      ["select", "generation_id, sequence_index, storage_url"], ["in", "generation_id", ["g1"]], ["order", "sequence_index", { ascending: true }],
    ]);
  });

  it("are none before SQL 43, after a failed read, or for no images, without asking further", async () => {
    const missing = fake({ generated_images: { data: null, error: { code: "42703" } }, generation_reference_images: { data: [{ generation_id: "g1", storage_url: "x" }], error: null } });
    expect((await publicReferences(missing.client, ["i1"])).size).toBe(0);
    expect(missing.calls.generation_reference_images).toBeUndefined();
    const refsFail = fake({ generated_images: { data: [{ id: "i1", generation_id: "g1" }], error: null }, generation_reference_images: { data: null, error: { code: "500" } } });
    expect((await publicReferences(refsFail.client, ["i1"])).size).toBe(0);
    const none = fake({});
    expect((await publicReferences(none.client, [])).size).toBe(0);
    expect(none.calls).toEqual({});
  });
});
