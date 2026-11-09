import type { ReactNode } from "react";
import "./enki-shell.css";

/** The headline every panel page opens with, in one place (Kev, 2026-10-29: "make it unified fitting my style";
 *  DEC-499): the title, the line under it, and the page's own controls at its right. */
export default function PanelHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="ek-page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="ek-page-title">{title}</h1>
        {sub !== undefined && <p className="ek-page-sub">{sub}</p>}
      </div>
      {children}
    </div>
  );
}
