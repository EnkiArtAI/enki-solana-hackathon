import { sealOf } from "@/lib/ui/kit/seal";

/**
 * A person's picture on Enki: their seal (lib/ui/kit/seal), filling the frame
 * that holds it; the frame gives the size and the shape (round, rounded).
 */
export default function Seal({ handle }: { handle: string }) {
  const s = sealOf(handle);
  return (
    <svg className="kit-seal" viewBox="0 0 96 96" aria-hidden focusable="false" preserveAspectRatio="xMidYMid slice"
      style={{ display: "block", width: "100%", height: "100%" }}>
      <rect width="96" height="96" fill={s.bg} />
      {s.parts.map((p, i) =>
        p.kind === "circle" ? <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} />
          : p.kind === "line" ? <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.stroke} strokeWidth={p.width} strokeLinecap="round" />
            : <path key={i} d={p.d} fill={p.fill} stroke={p.stroke} strokeWidth={p.width} strokeLinecap="round" opacity={p.opacity} />)}
      <circle cx="48" cy="48" r="21" fill={s.bg} opacity={0.88} />
      <text x="48" y="58" textAnchor="middle" fontSize="30" fontStyle="italic" fill={s.fg} style={{ fontFamily: "var(--font-serif)" }}>{s.initial}</text>
    </svg>
  );
}
