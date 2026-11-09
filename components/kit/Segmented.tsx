"use client";

import type { CSSProperties, ReactNode } from "react";
import "./kit-controls.css";

/**
 * Two or three exclusive choices in one pill: Free | Premium, Text | Checkbox,
 * [ ] | T as a radiogroup; Craft | Verify and Generate | History | Comments as
 * a tablist. `slide`: equal-width choices under a thumb that glides to the
 * chosen one, like a switch (Open | Premium). `tone="soft"`: the chosen one on
 * paper over a quiet track, as the Settings mock draws its bars and pills.
 */
export default function Segmented<K extends string>({ options, value, onChange, ariaLabel, role, slide = false, tone }: {
  /** `disabled`: shown greyed, not offered yet. */
  options: Array<{ key: K; label: ReactNode; title?: string; disabled?: boolean }>;
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  role: "radiogroup" | "tablist";
  slide?: boolean;
  tone?: "soft";
}) {
  const radio = role === "radiogroup";
  const at = Math.max(0, options.findIndex((o) => o.key === value));
  return (
    <div className={`kit-seg kit-focus${slide ? " kit-seg--slide" : ""}`} role={role} aria-label={ariaLabel} data-tone={tone}
      style={slide ? { "--kit-seg-n": options.length, "--kit-seg-i": at } as CSSProperties : undefined}>
      {options.map((o) => (
        <button key={o.key} type="button" className="kit-seg-btn" title={o.title} disabled={o.disabled}
          role={radio ? "radio" : "tab"}
          aria-checked={radio ? o.key === value : undefined}
          aria-selected={radio ? undefined : o.key === value}
          onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
