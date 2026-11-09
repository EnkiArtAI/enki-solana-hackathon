"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import PillMenu from "@/components/kit/PillMenu";
import { Icon } from "@/components/enki-shell/icons";
import { toolLink, type Tool } from "@/lib/ui/feed/world";
import { appendBlock, contextText, styleBlock } from "@/lib/ui/studio/compose";
import { useStudioScope, type StudioScopeValue } from "./StudioScope";
import "./studio.css";

/**
 * Create in a project's context, one row over the composer (Kev, 2026-10-30: "different content pieces that all access
 * the same reference images, characters, styles and master prompts ... so that the brand ID stays the same"): where it
 * is ("Moonlight › Launch teaser"), where Image's renders go, the project's master prompts and styles to add to the
 * words, and the way out. A content piece's own master prompt and style fill an empty composer once, as words it shows:
 * nothing is sent that the composer does not show.
 */
export default function StudioStrip({ scope, ...rest }: {
  /** Create > Video hands its scope; Create > Image's is the context's (StudioScope). */
  scope?: StudioScopeValue | null;
  tool: Tool;
  text: string;
  setText: (text: string) => void;
}) {
  const own = useStudioScope();
  const at = scope ?? own;
  return at && <Strip scope={at} {...rest} />;
}

function Strip({ scope, tool, text, setText }: { scope: StudioScopeValue; tool: Tool; text: string; setText: (text: string) => void }) {
  const router = useRouter();
  const { project, content } = scope;
  const filled = useRef<string | null>(null);
  useEffect(() => {
    if (!content || filled.current === content.id) return;
    filled.current = content.id;
    if (text.trim()) return;
    const words = contextText(
      project.masterPrompts.find((p) => p.id === content.masterPromptId) ?? null,
      project.styles.find((s) => s.id === content.styleId) ?? null,
    );
    if (words) setText(words);
    // Once per content piece, as it first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content?.id]);

  return (
    <div className="st-strip" role="group" aria-label={`Working in ${project.project.name}`}>
      <span className="st-strip-where">
        <Icon name="folder" size={15} stroke={1.8} />
        <span className="st-strip-name">{project.project.name}{content && <> <span aria-hidden>›</span> {content.name}</>}</span>
      </span>
      {content && tool === "image" && <span className="st-strip-note">New images go to {content.name}</span>}
      <span className="st-strip-acts">
        {project.masterPrompts.length > 0 && (
          <PillMenu trigger={<span>Master prompt</span>} ariaLabel="Add a master prompt" title="Add a master prompt"
            value={null} options={project.masterPrompts.map((p) => ({ key: p.id, label: p.name }))}
            onPick={(id) => setText(appendBlock(text, project.masterPrompts.find((p) => p.id === id)?.prompt ?? ""))} />
        )}
        {project.styles.length > 0 && (
          <PillMenu trigger={<span>Style</span>} ariaLabel="Add a style" title="Add a style"
            value={null} options={project.styles.map((s) => ({ key: s.id, label: s.name, sub: s.palette.length ? `${s.palette.length} colours` : null }))}
            onPick={(id) => { const s = project.styles.find((x) => x.id === id); if (s) setText(appendBlock(text, styleBlock(s))); }} />
        )}
        <button type="button" className="st-strip-x kit-hit" aria-label="Leave the project" title="Leave the project"
          onClick={() => router.replace(toolLink(tool))}>
          <Icon name="x" size={14} stroke={2} />
        </button>
      </span>
    </div>
  );
}
