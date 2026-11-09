"use client";

/**
 * First-login username picker — a large centered card in the look of the app's
 * windows (components/enki-window.ts, the theme's tokens) that
 * asks for a name, checks availability live (green = free, red = taken) and
 * offers clickable suggestions that are verified free before being shown.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { CARD, CTA, LABEL, PILL, TEXT, TITLE } from "@/components/enki-window";

const VALID = /^[a-z0-9_]{3,20}$/;

// Adjective + artist-noun pools: the prefilled default name and the "no idea
// yet" suggestions are built from these.
const TONES = ["ember", "quiet", "neon", "lunar", "velvet", "wild", "paper", "golden", "misty", "cobalt"];
const ARTISTS = ["muse", "brush", "palette", "sketch", "canvas", "maker", "weaver", "pixel", "atelier", "raven"];

/** Random adjective_artist names, e.g. velvet_muse — used to prefill the field. */
function randomArtistNames(count: number): string[] {
  const seed = Math.floor(Math.random() * TONES.length * ARTISTS.length);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${TONES[(seed + i * 3) % TONES.length]}_${ARTISTS[(seed + i * 7) % ARTISTS.length]}`);
  }
  return out;
}

/** Starting suggestions before the user types: derived from their email/wallet. */
function deriveCandidates(email: string | null, wallet: string | null): string[] {
  const out: string[] = [];
  if (email) {
    const local = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    if (local.length >= 3) {
      out.push(local);
      const noDigits = local.replace(/\d+$/, "");
      if (noDigits.length >= 3 && noDigits !== local) out.push(noDigits);
      if (local.length <= 16) out.push(`${local}_art`);
    }
  }
  if (wallet) {
    const tail = wallet.replace(/^0x/, "").slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (tail.length >= 3) out.push(`enki_${tail}`);
  }
  return [...new Set(out)].filter((c) => VALID.test(c)).slice(0, 10);
}

/** Suggestions built FROM the typed name — every one visibly relates to it. */
function variantsOf(name: string): string[] {
  const base = name.slice(0, 14);
  const seed = Math.floor(Math.random() * TONES.length);
  return [
    `${base}_art`,
    `${base}_studio`,
    `the_${base}`,
    `${TONES[seed % TONES.length]}_${base}`,          // adjective + their name
    `${TONES[(seed + 4) % TONES.length]}_${base}`,
    `${base}_${Math.floor(10 + Math.random() * 89)}`,
  ].filter((c) => VALID.test(c) && c !== name);
}

type Status = "idle" | "checking" | "free" | "taken" | "invalid";

export default function UsernameOnboard({
  email,
  wallet,
  onDone,
}: {
  email: string | null;
  wallet: string | null;
  onDone: (handle: string) => void;
}) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const debRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);
  const touched = useRef(false); // user typed/picked — never overwrite with the prefill

  const batchCheck = useCallback(async (candidates: string[]): Promise<string[]> => {
    try {
      const res = await fetch("/api/users/handle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates }),
      });
      if (!res.ok) return [];
      return ((await res.json()) as { available: string[] }).available;
    } catch {
      return [];
    }
  }, []);

  // On mount: verify email/wallet-derived suggestions AND prefill the field
  // with a free adjective_artist default — if the user just confirms, that's
  // their name (there is no skip).
  const initialCandidates = useMemo(() => deriveCandidates(email, wallet), [email, wallet]);
  useEffect(() => {
    let dead = false;
    (async () => {
      const [freeDerived, freeRandom] = await Promise.all([
        initialCandidates.length ? batchCheck(initialCandidates) : Promise.resolve([]),
        batchCheck(randomArtistNames(8)),
      ]);
      if (dead) return;
      setSuggestions((prev) => (prev.length ? prev : [...freeDerived, ...freeRandom].slice(0, 5)));
      if (!touched.current && freeRandom[0]) {
        setValue(freeRandom[0]);
        setStatus("free"); // verified free by the batch check just now
      }
    })();
    return () => { dead = true; };
  }, [initialCandidates, batchCheck]);

  // Live availability check while typing (350ms debounce). Suggestions always
  // follow what's typed — variants of THEIR name, never unrelated randoms.
  const check = (raw: string) => {
    const name = raw.trim().toLowerCase();
    touched.current = true;
    setValue(name);
    setSaveError(null);
    if (debRef.current) clearTimeout(debRef.current);
    if (!name) { setStatus("idle"); return; }
    if (!VALID.test(name)) { setStatus("invalid"); return; }
    setStatus("checking");
    const mySeq = ++seq.current;
    debRef.current = setTimeout(async () => {
      try {
        const [res, freeVariants] = await Promise.all([
          fetch(`/api/users/handle?name=${encodeURIComponent(name)}`, { headers: sessionAuthHeaders() }),
          batchCheck(variantsOf(name)),
        ]);
        const data = (await res.json()) as { valid: boolean; available: boolean };
        if (seq.current !== mySeq) return; // superseded by newer keystroke
        if (!data.valid) { setStatus("invalid"); return; }
        setStatus(data.available ? "free" : "taken");
        if (freeVariants.length) setSuggestions(freeVariants.slice(0, 5));
      } catch {
        if (seq.current === mySeq) setStatus("idle");
      }
    }, 350);
  };

  const save = async () => {
    if (status !== "free" || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/users/handle", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ handle: value }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(res.status === 409 ? "taken" : status);
        throw new Error(data?.error || "Could not save");
      }
      onDone(data.handle as string);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const statusLine: Record<Status, { text: string; color: string }> = {
    idle: { text: "Letters, numbers and _ — between 3 and 20 characters.", color: "var(--enki-label-quiet)" },
    checking: { text: "Checking…", color: "var(--enki-label-quiet)" },
    free: { text: `✓ @${value} is free — it's yours if you want it.`, color: "var(--enki-green)" },
    taken: { text: `✗ @${value} is already taken.`, color: "var(--enki-danger)" },
    invalid: { text: "✗ Only letters, numbers and _ — between 3 and 20 characters.", color: "var(--enki-danger)" },
  };

  return (
    // The windows' veil (ConfirmEmailWindow's overlay) and card, in the theme's tokens.
    <div
      className="bg-black/50 backdrop-blur-[6px]"
      style={{
        position: "fixed", inset: 0, zIndex: 1500,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}
    >
      <div style={{ ...CARD, width: "100%", maxWidth: 500, borderWidth: 1, borderStyle: "solid", padding: "40px 36px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the windows' mark, an SVG: next/image adds nothing here */}
          <img src="/favicon.svg" alt="" width={16} height={16} />
          <span style={LABEL}>
            One last thing
          </span>
        </div>
        <h1 style={{ ...TITLE, margin: "0 0 10px" }}>
          Pick your name.
        </h1>
        <p style={{ ...TEXT, color: "var(--enki-ink-2)", margin: "0 0 24px" }}>
          This is how other people will see you on Enki Art. We&apos;ve picked one for you — keep it,
          or type your own. You can change it later on your profile.
        </p>

        <div
          className="st-input"
          style={{
            display: "flex", alignItems: "center", gap: 2, padding: "0 16px", height: 52,
            ...(status === "free" ? { borderColor: "var(--enki-green)" } : status === "taken" || status === "invalid" ? { borderColor: "var(--enki-danger)" } : null),
          }}
        >
          <span style={{ fontSize: 18, color: "var(--enki-label-quiet)" }}>@</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => check(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder="your_name"
            className="placeholder:text-[color:var(--enki-label-quiet)]"
            spellCheck={false}
            style={{
              flex: 1, border: "none", outline: "none", background: "transparent",
              color: "var(--enki-ink)", fontSize: 18, fontWeight: 600, letterSpacing: "0.01em",
            }}
          />
        </div>
        <p style={{ fontSize: 13, minHeight: 20, margin: "10px 0 0", color: statusLine[status].color, transition: "color 0.2s" }}>
          {statusLine[status].text}
        </p>
        {saveError && <p style={{ fontSize: 13, margin: "6px 0 0", color: "var(--enki-danger)" }}>{saveError}</p>}

        {suggestions.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <p style={{ ...LABEL, margin: "0 0 8px" }}>
              Free right now
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => check(s)}
                  style={{
                    padding: "7px 12px", borderRadius: 999, cursor: "pointer",
                    border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)",
                    color: "var(--enki-green)", fontSize: 13, fontWeight: 600,
                  }}
                >
                  @{s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 28 }}>
          <button
            onClick={save}
            disabled={status !== "free" || saving}
            // The windows' CTA; until the name is free, the PILL half see-through (EnkiCardButton's disabled look).
            style={{
              ...(status === "free" ? CTA : { ...PILL, opacity: 0.5 }), flex: 1,
              cursor: status === "free" ? "pointer" : "not-allowed", transition: "background 0.2s",
            }}
          >
            {saving ? "Saving…" : "That's me"}
          </button>
        </div>
      </div>
    </div>
  );
}
