"use client";

import type { KeyboardEvent, ReactNode } from "react";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import { STUDIO_TEXT } from "@/lib/studio/types";
import { counter, type DetailField, type Details } from "@/lib/ui/studio/fields";

/** One labelled field: its name in the kit's mono label, a counter near its end, the sentence that refuses it. */
export function Field({ label, count, error, children }: { label: string; count?: string | null; error?: string | null; children: ReactNode }) {
  return (
    <label className="st-field">
      <span className="st-field-head"><span className="kit-label">{label}</span>{count && <span className="st-count">{count}</span>}</span>
      {children}
      {error && <span className="st-err" role="alert">{error}</span>}
    </label>
  );
}

/**
 * A project's and a content piece's Name, Description and Link (Kev, 2026-10-30: "Name, Description, Link"). Enter in
 * Name or Link goes on (`onEnter`), as the dialog's primary button does.
 */
export default function DetailFields({ value, onChange, problem, onEnter }: {
  value: Details;
  onChange: (next: Details) => void;
  problem: { field: DetailField; message: string } | null;
  onEnter: () => void;
}) {
  const set = (field: DetailField) => (v: string) => onChange({ ...value, [field]: v });
  const enter = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); onEnter(); } };
  const error = (field: DetailField) => (problem?.field === field ? problem.message : null);
  return (
    <>
      <Field label="Name" count={counter(value.name, STUDIO_TEXT.name, STUDIO_TEXT.name - 10)} error={error("name")}>
        <input className="st-input" data-autofocus value={value.name} maxLength={STUDIO_TEXT.name} autoComplete="off" spellCheck={false}
          aria-invalid={!!error("name") || undefined} onChange={(e) => set("name")(e.target.value)} onKeyDown={enter} />
      </Field>
      <Field label="Description" count={counter(value.description, STUDIO_TEXT.description, STUDIO_TEXT.description - 50)} error={error("description")}>
        <AutosizeTextarea className="st-input st-area" value={value.description} onChange={set("description")} min={72} max={180} growOnly={false}
          maxLength={STUDIO_TEXT.description} placeholder="What it is for, who it speaks to" />
      </Field>
      <Field label="Link" error={error("link")}>
        <input className="st-input" type="url" inputMode="url" placeholder="https://" value={value.link} maxLength={STUDIO_TEXT.link} autoComplete="url"
          aria-invalid={!!error("link") || undefined} onChange={(e) => set("link")(e.target.value)} onKeyDown={enter} />
      </Field>
    </>
  );
}
