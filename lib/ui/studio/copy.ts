import type { ProjectDetail, ProjectSummary } from "@/lib/studio/types";

/** "1 asset", "12 assets". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A folder card's mono line: "3 contents · 12 assets · 2 characters". */
export const countsLine = ({ counts }: Pick<ProjectSummary, "counts">) =>
  [plural(counts.contents, "content"), plural(counts.assets, "asset"), plural(counts.characters, "character")].join(" · ");

/** "a, b and c". */
const listed = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "");

/** What a project's delete takes, said before it goes (renders never go: they are the gallery's). */
export function projectGoes(d: Pick<ProjectDetail, "assets" | "characters" | "styles" | "masterPrompts" | "contents">): string {
  const parts = [
    [d.assets.length, "asset"], [d.characters.length, "character"], [d.styles.length, "style"],
    [d.masterPrompts.length, "master prompt"], [d.contents.length, "content piece"],
  ].filter(([n]) => n) as Array<[number, string]>;
  const one = parts.length === 1 && parts[0][0] === 1;
  const said = listed(parts.map(([n, what]) => plural(n, what)));
  return `${parts.length ? `Its ${said} ${one ? "goes" : "go"} with it. ` : ""}Your renders stay in your gallery.`;
}

/** What a content piece's delete leaves. */
export const contentGoes = (count: number) =>
  count > 1 ? `Its ${count} images stay in your gallery.` : count ? "Its image stays in your gallery." : "Your renders stay in your gallery.";
