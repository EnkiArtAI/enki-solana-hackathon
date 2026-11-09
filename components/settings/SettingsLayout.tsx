import React from "react";
import { ChevronLeft } from "lucide-react";
import PanelHead from "@/components/enki-shell/PanelHead";
import "./settings.css";

interface SettingsLayoutProps {
  children: React.ReactNode;
  title: React.ReactNode;
  description?: string;
  /** Back to where Settings was opened from; the button stays at the top left while the page scrolls (Kev, 2026-10-13). */
  onBack: () => void;
}

export default function SettingsLayout({ children, title, description, onBack }: SettingsLayoutProps) {
  // Back is ek-tuck-hide: it gives way while the phone header is tucked, so only its small burger stays (enki-shell.css).
  return (
    <div className="set-page">
      <button type="button" className="set-back ek-tuck-hide" onClick={onBack}>
        <ChevronLeft size={13} strokeWidth={2.4} aria-hidden />Back
      </button>
      {/* The panels' frame and headline (DEC-499); the line under it always renders, so its reserved height keeps the
          tab menu fixed. */}
      <div className="set-container ek-page">
        <PanelHead title={title} sub={description ?? ""} />
        {children}
      </div>
    </div>
  );
}
