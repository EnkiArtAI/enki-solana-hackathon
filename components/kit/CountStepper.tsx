"use client";

/**
 * How many images one press makes: − ×N + (image UI v2, handoff §5.11). The
 * ends grey out instead of wrapping; the caller says how many it allows.
 */
export default function CountStepper({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="kit-stepper" role="group" aria-label="Images per run">
      <button type="button" className="kit-stepper-btn kit-hit" aria-label="Fewer images" disabled={value <= 1} onClick={() => onChange(value - 1)}>−</button>
      <span className="kit-stepper-n" aria-live="polite">×{value}</span>
      <button type="button" className="kit-stepper-btn kit-hit" aria-label="More images" disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}
