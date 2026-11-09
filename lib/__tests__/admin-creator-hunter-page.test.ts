import { describe, it, expect } from "vitest";
import { join } from "node:path";
import ts from "typescript";
import { readSource } from "@/lib/__tests__/_read-source";
import { EMPTY_USAGE } from "@/lib/hunter/creator-config";
import { CREATOR_DEFAULTS, outcomeWords, type CreatorRunSummary } from "@/lib/hunter/creator-types";

/**
 * The Prompt Hunter tab as a list of creators (Kev, 2026-10-30: "da will ich iwann einen creator reinpacken, such
 * kriterien einstellen, und go"; "ja go ... und ja 1 und 2"; the preferred generator "der genutzt werden soll wenn
 * nicht explizit etwas dazu drin steht"). The page may export nothing but its component, so its wiring is read as
 * source, as admin-hunter.test.ts does. Its handlers (Play's rounds, Add) are cut from that source and run here with a
 * stubbed fetch (`page` below); the layout is driven in a browser bench. No paid call: vitest.setup.ts makes fetch throw.
 */
const PAGE = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));
const count = (s: string) => PAGE.split(s).length - 1;

/** A `const` of the page, as JavaScript: a module-level one (`indent` "") ends at its first `;`, a handler at `\n  };`. */
const cut = (name: string, indent = ""): string => {
  const at = [" =", ":"].map((s) => PAGE.indexOf(`\n${indent}const ${name}${s}`)).find((i) => i >= 0) ?? -1;
  const close = indent ? `\n${indent}};` : ";";
  const end = PAGE.indexOf(close, at);
  if (at < 0 || end < 0) throw new Error(`const ${name} is not in app/admin/page.tsx`);
  return ts.transpileModule(PAGE.slice(at, end + close.length), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
};
/**
 * One of the component's handlers, run as the page runs it: what it closes over is passed in `scope` (state, setters,
 * fetch, reload, post), the page's own label tables and helpers come with it.
 */
const page = <T,>(handler: string, scope: Record<string, unknown>): T => {
  const src = ["CR_STOPPED", "usd2", "videosSaved", "formOf"].map((h) => cut(h)).concat(cut(handler, "  ")).join("\n");
  return new Function(...Object.keys(scope), `${src}\nreturn ${handler};`)(...Object.values(scope)) as T;
};

describe("the creator list's gate and imports", () => {
  it("asks for SQL 56 until the API says the creator columns exist", () => {
    expect(PAGE).toContain(") : !d.hunter.creatorsReady ? (");
    expect(PAGE).toContain("The creator hunter needs SQL 56 (");
    expect(PAGE).toContain(">sql-to-run/56-creator-hunter.sql</span>");
  });

  it("reads only the client-safe hunter files: the contract and the pure config", () => {
    const hunterImports = PAGE.split("\n").filter((l) => /^import .*@\/lib\/hunter\//.test(l));
    expect(hunterImports).toEqual([
      'import { CREATOR_DEFAULTS, HUNT_PRICES, outcomeWords, parkedSaid, type CreatorConfig, type CreatorMedia, type CreatorRow, type CreatorRunSummary, type HuntFacts, type PlayStop } from "@/lib/hunter/creator-types";',
      'import { estimatePlay, parseCreatorConfig, searchChanged, searchQuery } from "@/lib/hunter/creator-config";',
      'import { RECIPE_DEFAULT, type HuntMode, type Recipe } from "@/lib/hunter/recipe";',
    ]);
  });
});

describe("adding a creator", () => {
  // Review 2026-10-30, finding 1: Add sent saveCreator with CREATOR_DEFAULTS, an upsert, so a creator another tab had
  // added (spend cap, generator, search, cursors) was reset. Add now inserts only (addAccounts: ON CONFLICT DO NOTHING,
  // SQL 56's column defaults = CREATOR_DEFAULTS); lib/__tests__/admin-creator-add.test.ts runs that route on Postgres.
  // The page's addCreator, run (review round 2, F21: it was pinned as text, so dropping `setCrNew("")` stayed green).
  // Its settings as another tab left them: not CREATOR_DEFAULTS (["prompt", "prompts"], $5).
  const own = { ...CREATOR_DEFAULTS, words: ["free prompt"], spendCapUsd: 1 };
  const adder = (crNew: string, creators: unknown[], posted: unknown, fresh: unknown) => {
    const log: string[] = [];
    const add = page<() => Promise<void>>("addCreator", {
      crNew, creators,
      say: (m: string) => log.push(`say ${m}`),
      setCrNew: (v: string) => log.push(`box "${v}"`),
      setCrEdit: (v: string) => log.push(`edit ${v}`),
      setCrForm: (f: { wordsText: string; spendCapUsd: number }) => log.push(`form ${f.wordsText} | $${f.spendCapUsd}`),
      setCrMode: (m: { mode: string }) => log.push(`mode ${m.mode}`),
      post: async (payload: unknown, okMsg: string) => { log.push(`post ${JSON.stringify(payload)} ${JSON.stringify(okMsg)}`); return posted; },
      reload: async () => { log.push("reload"); return fresh; },
    });
    return { log, add };
  };
  const server = { hunter: { creators: [{ handle: "hexmethod", config: own, mode: "recipe", recipe: {} }] } };

  it("inserts the creator without a call to X, empties the box, then opens its settings as the server holds them", async () => {
    const { log, add } = adder("  @HexMethod ", [], {}, server);
    await add();
    expect(log).toEqual([
      'post {"resource":"hunter","action":"addAccounts","handles":["hexmethod"]} ""',
      'box ""',
      "reload",
      "say @hexmethod is on the list: set its search, then Play.",
      "edit hexmethod",
      "form free prompt | $1",
      "mode recipe",
    ]);
  });

  it("keeps the handle in the box when the add fails, and says so when the fresh list cannot be read", async () => {
    const failed = adder("hexmethod", [], null, server);
    await failed.add();
    expect(failed.log).toEqual(['post {"resource":"hunter","action":"addAccounts","handles":["hexmethod"]} ""']);
    const unread = adder("hexmethod", [], {}, null);
    await unread.add();
    expect(unread.log).toEqual([
      'post {"resource":"hunter","action":"addAccounts","handles":["hexmethod"]} ""', 'box ""', "reload",
      "say @hexmethod added: reload the page to set its search.",
    ]);
  });

  it("opens a listed creator's own settings instead of adding it again, and adds nothing for an empty box", async () => {
    const listed = adder("@hexmethod", [{ handle: "hexmethod", config: own, mode: "manual", recipe: {} }], {}, server);
    await listed.add();
    // Its own mode too, never the creator opened before it (review 2026-11-01).
    expect(listed.log).toEqual(["say @hexmethod is on the list already.", "edit hexmethod", "form free prompt | $1", "mode manual"]);
    const empty = adder(" @ ", [], {}, server);
    await empty.add();
    expect(empty.log).toEqual([]);
  });

  it("reloads the view and hands it back; Enter in the box adds", () => {
    expect(PAGE).toContain("if (asked === dataEpoch.current) setData(next);\n      return next;");
    expect(PAGE).toContain('onKeyDown={(e) => { if (e.key === "Enter") void addCreator(); }}');
  });

  it("never sends the defaults over a creator's settings: only Save sends saveCreator", () => {
    expect(PAGE).not.toContain("config: CREATOR_DEFAULTS");
    expect(count('action: "saveCreator"')).toBe(1);
    expect(PAGE).toContain('if (await post({ resource: "hunter", action: "saveCreator", handle: row.handle, config }, msg, (cur) => cur)) {');
  });
});

describe("a creator's settings", () => {
  it("checks the form the way the server will, shows the live query and the error, and saves only a checked config", () => {
    expect(PAGE).toContain("return parseCreatorConfig({ ...rest, words: wordsOf(wordsText) }, d.hunter.catalogue ?? [], handle);");
    expect(PAGE).toContain("const checked = crChecked(row.handle);\n    if (!checked.ok) { say(checked.error); return; }\n    const { config } = checked;");
    expect(PAGE).toContain('if (await post({ resource: "hunter", action: "saveCreator", handle: row.handle, config }, msg, (cur) => cur)) {');
    expect(PAGE).toContain("{searchQuery(c.handle, checked.ok ? checked.config : { ...crForm, words: wordsOf(crForm.wordsText) })}");
    expect(PAGE).toContain("{!checked.ok && <p style={{ margin: \"10px 0 0\", fontSize: 11.5, color: \"var(--enki-danger)\" }}>{checked.error}</p>}");
    expect(PAGE).toContain('const wordsOf = (text: string) => text.split(",").map((w) => w.trim()).filter(Boolean);');
  });

  it("says a changed search starts over, before Save and in the toast", () => {
    expect(PAGE).toContain("{checked.ok && searchChanged(c.config, checked.config) && (");
    expect(PAGE).toContain("Changing the search starts over: posts already taken are skipped, X bills the re-read.");
    expect(PAGE).toContain("const msg = searchChanged(row.config, config) ? `@${row.handle} saved: its next Play reads from the start.` : `@${row.handle} saved.`;");
  });

  it("offers every criterion: words, media, min likes, how far back, preferred generator, posts per Play, spend cap, dry stop", () => {
    expect(PAGE).toContain('{ id: "images", label: "Images only" }, { id: "media", label: "Images or videos (videos saved for later)" }, { id: "any", label: "Everything" },');
    expect(PAGE).toContain('const CR_SINCE = [{ days: 30, label: "30 days" }, { days: 90, label: "90 days" }, { days: 365, label: "1 year" }, { days: 730, label: "2 years" }, { days: 0, label: "All of X\'s archive" }];');
    expect(PAGE).toContain("onChange={(e) => setCr({ minLikes: Number(e.target.value) })}");
    expect(PAGE).toContain("onChange={(e) => setCr({ sinceDays: Number(e.target.value) })}");
    expect(PAGE).toContain("onChange={(e) => setCr({ postsPerPlay: Number(e.target.value) })}");
    expect(PAGE).toContain("onChange={(e) => setCr({ spendCapUsd: Number(e.target.value) })}");
    expect(PAGE).toContain("onChange={(e) => setCr({ dryAfter: Number(e.target.value) })}");
    expect(PAGE).toContain("{!CR_SINCE.some((o) => o.days === crForm.sinceDays) && <option value={String(crForm.sinceDays)}>{crForm.sinceDays} days</option>}");
  });

  it("picks the preferred generator from the active catalogue, none meaning every generator, used when a post names none", () => {
    expect(PAGE).toContain('<select value={crForm.preferredGenerator ?? ""} onChange={(e) => setCr({ preferredGenerator: e.target.value || null })} style={huInput}>');
    expect(PAGE).toContain('<option value="">None: every generator</option>');
    expect(PAGE).toContain("{catalogue.map((g) => <option key={g} value={g}>{g}</option>)}");
    expect(PAGE).toContain("Used when a post names no generator");
  });
});

describe("Play", () => {
  it("shows what it may cost first: the button opens the estimate, only its own Play starts the rounds", () => {
    expect(PAGE).toContain("const est = estimatePlay(c, true);");
    expect(PAGE).toContain('<Pill kind="green" label="Play" title="Shows what it may cost first" onClick={() => setCrAsk(crAsk === c.handle ? null : c.handle)} />');
    expect(PAGE).toContain("{crAsk === c.handle && !playing && !est.blocked && (");
    expect(PAGE).toContain('Play @{c.handle}? At most {est.posts} posts, read for free{c.mode === "auto" ? `, and the checks (${usd2(est.modelUsd)}): at most ${usd2(est.totalUsd)}` : `, in ${c.mode} mode with no model: $0`}.');
    expect(count("void playCreator(c)")).toBe(2);
    expect(PAGE).toContain('<Pill kind="green" label="Play" onClick={() => void playCreator(c)} />');
    expect(PAGE).toContain('<Pill kind="red" label="Stop" title="Finishes this round, then stops" onClick={() => void playCreator(c)} />');
  });

  it("offers Play, Settings and Remove to admins only (review finding 5, R2); a moderator sees the list and its results", () => {
    expect(PAGE).toContain('{d.hunter.canEdit && (playing ? <Pill kind="red" label="Stop"');
    expect(PAGE).toContain('{d.hunter.canEdit && <Pill kind="plain" label="Settings"');
    expect(PAGE).toContain('{d.hunter.canEdit && (playing || c.state.playing ? <Pill kind="plain" label="Remove"');
    expect(PAGE).toContain("{d.hunter.canEdit && (\n                      <div style={{ display: \"flex\", flexWrap: \"wrap\", gap: 8, alignItems: \"center\" }}>\n                        <input value={crNew}");
    expect(count("<Pill kind=\"green\" label=\"Play\"")).toBe(2);
  });

  it("says why it cannot start: the spend cap, or the account is on Enki", () => {
    expect(PAGE).toContain(': est.blocked === "on_enki" ? <Pill kind="plain" label="On Enki"');
    expect(PAGE).toContain(': est.blocked === "spend_cap" ? <Pill kind="plain" label="Cap reached" title={`Spend cap reached: ${usd2(est.spentUsd)} of ${usd2(est.capUsd)} spent');
    expect(PAGE).toContain(': crPlaying || c.state.playing ? <Pill kind="plain" label="Play"');
  });

  // The page's playCreator, run (review round 2, F21: the rounds were pinned as text, so dropping the reload between
  // rounds stayed green, and the row, and with it the next Play's "Spent so far" (DEC-596), kept the old numbers).
  type Answer = { ok?: boolean; json?: unknown } | Error;
  const summary = (r: Partial<CreatorRunSummary>): CreatorRunSummary => ({
    runId: "run-1", found: 0, queued: 0, published: 0, skipped: {}, usage: { ...EMPTY_USAGE }, estUsd: 0, spentUsd: 0, stopped: "time", more: true, ...r,
  });
  /** A Play of @hexmethod: each POST takes the next answer (none left: the stub throws); what the page does lands in `log`. */
  const player = (answers: Answer[], onPost?: (n: number) => void) => {
    const log: string[] = [];
    const sent: unknown[] = [];
    const crStop = { current: false };
    const at = (crPlaying: string | null) => page<(row: { handle: string }) => Promise<void>>("playCreator", {
      crPlaying, crStop,
      setCrAsk: (v: unknown) => log.push(`ask ${v}`),
      setCrPlaying: (v: unknown) => log.push(`playing ${v}`),
      setCrLive: (v: { handle: string; text: string }) => log.push(`live @${v.handle} ${v.text}`),
      sessionAuthHeaders: () => ({ "x-session": "s" }),
      fetch: async (url: string, init: { method: string; headers: unknown; body: string }) => {
        log.push(`${init.method} ${url} ${init.body}`);
        sent.push(init.headers);
        onPost?.(sent.length);
        const a = answers.shift();
        if (!a) throw new Error("one round too many");
        if (a instanceof Error) throw a;
        return { ok: a.ok ?? true, json: async () => { if (a.json === undefined) throw new SyntaxError("not JSON"); return a.json; } };
      },
      reload: async () => { log.push("reload"); return null; },
      say: (m: string) => log.push(`say ${m}`),
    });
    // The row's Play, and its Stop: the same handler in a render where this creator plays.
    return { log, sent, start: () => at(null)({ handle: "hexmethod" }), stop: () => at("hexmethod")({ handle: "hexmethod" }) };
  };
  // "Play all" (Kev, 2026-10-31: "ja bau den alle spielen"): the page's own playAll and playCreator's answer, run.
  it("plays every playable creator in turn after one confirm, and a Stop or a failed Play ends the chain", async () => {
    const run = async (answers: boolean[]) => {
      const log: string[] = [];
      const playAll = page<() => Promise<void>>("playAll", {
        setCrAskAll: (v: unknown) => log.push(`ask all ${v}`),
        crPlayable: [{ handle: "a" }, { handle: "b" }, { handle: "c" }],
        playCreator: async (c: { handle: string }) => { log.push(`play @${c.handle}`); return answers.shift() ?? true; },
      });
      await playAll();
      return log;
    };
    expect(await run([true, true, true])).toEqual(["ask all false", "play @a", "play @b", "play @c"]);
    expect(await run([true, false])).toEqual(["ask all false", "play @a", "play @b"]);
    // The playable list and the confirm's total come from each creator's own estimate (blocked ones left out).
    expect(PAGE).toContain("const crPlayable = creators.filter((c) => !estimatePlay(c, true).blocked && !c.state.playing);");
    expect(PAGE).toContain("const crAllUsd = crPlayable.reduce((n, c) => n + estimatePlay(c, true).totalUsd, 0);");
    expect(PAGE).toContain("{`Play all ${crPlayable.length} creators, one after another? At most ${usd2(crAllUsd)} in all, each within its own spend cap.`}");
  });

  it("its closing toast counts the whole Play's posts without media, not the last round's", async () => {
    const p = player([
      { json: { summary: summary({ skipped: { no_media: 5, pictures_failed: 2 }, usage: { ...summary({}).usage, videos: 1 } }) } },
      { json: { summary: summary({ skipped: { no_media: 1 }, usage: { ...summary({}).usage, videos: 3 } }) } },
      { json: { summary: summary({ skipped: {}, stopped: "done", more: false, usage: { ...summary({}).usage, videos: 3 } }) } },
    ]);
    await p.start();
    expect(p.log.filter((l) => l.startsWith("say "))).toEqual(["say @hexmethod: nothing left to read. 3 videos saved in the Videos tab. 6 without media in the No media tab. 2 whose pictures could not be read: Start over tries them again."]);
  });

  it("says whether a creator's Play ran to its end: not after a Stop, a refusal or a network error", async () => {
    const finished = async (answers: Answer[], stopAt?: number) => {
      const p = player(answers, stopAt ? (n) => { if (n === stopAt) void p.stop(); } : undefined);
      return p.start() as unknown as Promise<boolean>;
    };
    expect(await finished([{ json: { summary: summary({}) } }, { json: { summary: summary({ stopped: "done", more: false }) } }])).toBe(true);
    expect(await finished([{ json: { summary: summary({}) } }, { json: { summary: summary({}) } }], 1)).toBe(false);
    expect(await finished([{ ok: false, json: { error: "X rate limit: press Play again in a minute" } }])).toBe(false);
    expect(await finished([new Error("offline")])).toBe(false);
  });

  // "Import .txt list" (Kev, 2026-10-31): the page's own importList, run on a list with a blank line and a comment.
  it("adds a .txt list's links one after another, says the tally at the end and opens Pending imports", async () => {
    const log: string[] = [];
    const answers = [
      { ok: true, json: { handle: "a" } },
      { ok: false, json: { error: "That post is gone." } },
      { ok: true, json: { handle: "c" } },
    ];
    const importList = page<(f: { text: () => Promise<string> }) => Promise<void>>("importList", {
      sessionAuthHeaders: () => ({}),
      fetch: async (_u: string, init: { body: string }) => { log.push(`POST ${JSON.parse(init.body).url}`); const a = answers.shift()!; return { ok: a.ok, json: async () => a.json }; },
      reload: async () => { log.push("reload"); return null; },
      say: (m: string) => log.push(`say ${m}`),
      setCrListing: (v: string | null) => log.push(`listing ${v}`),
      setTab: (v: string) => log.push(`tab ${v}`), setQuery: () => {}, setCrFinds: (v: unknown) => log.push(`finds ${v}`),
    });
    await importList({ text: async () => "https://x.com/a/status/1\r\n\n# a note\nhttps://x.com/b/status/2\n  https://x.com/c/status/3  \n" });
    expect(log).toEqual([
      "listing Importing 1 of 3…", "POST https://x.com/a/status/1",
      "listing Importing 2 of 3…", "POST https://x.com/b/status/2",
      "listing Importing 3 of 3…", "POST https://x.com/c/status/3",
      "listing null", "reload",
      "say 2 of 3 links in line: set each creator's mode, then Play links. Not: https://x.com/b/status/2: That post is gone..",
    ]);
    const empty: string[] = [];
    await page<(f: { text: () => Promise<string> }) => Promise<void>>("importList", { say: (m: string) => empty.push(m) })({ text: async () => "\n# only a note\n" });
    expect(empty).toEqual(["The list has no links."]);
  });

  const POST1 = 'POST /api/admin {"resource":"hunter","action":"play","handle":"hexmethod"}';
  const POST2 = 'POST /api/admin {"resource":"hunter","action":"play","handle":"hexmethod","runId":"run-1"}';

  it("presses round after round with the Play's run id while the server answers more, reloading the row after each", async () => {
    // A round's summary counts its own finds and the whole Play's usage (lib/hunter/creator-run: `...counts` per round,
    // `usage` and `estUsd` summed with the run row), so the finds add up here and the reads and dollars do not.
    const p = player([
      { json: { summary: summary({ found: 2, usage: { ...EMPTY_USAGE, posts: 100, replies: 1 }, estUsd: 0.51 }) } },
      { json: { summary: summary({ found: 1, usage: { ...EMPTY_USAGE, posts: 140, replies: 1, videos: 1 }, estUsd: 0.72, stopped: "done", more: false }) } },
    ]);
    await p.start();
    expect(p.log).toEqual([
      "ask null", "playing hexmethod", "live @hexmethod Round 1 · starting",
      POST1, "live @hexmethod Round 1 · 101 read · 2 found · $0.51", "reload",
      POST2, "live @hexmethod Round 2 · 141 read · 3 found · $0.72", "reload",
      "say @hexmethod: nothing left to read. 1 video saved in the Videos tab.",
      "playing null",
    ]);
    expect(p.sent).toEqual([{ "Content-Type": "application/json", "x-session": "s" }, { "Content-Type": "application/json", "x-session": "s" }]);
  });

  it("finishes the round in flight on Stop, and the next Play presses on again", async () => {
    const p = player([
      { json: { summary: summary({}) } },
      { json: { summary: summary({}) } },
      { json: { summary: summary({ stopped: "posts_cap", more: false }) } },
    ], (n) => { if (n === 1) void p.stop(); });
    await p.start();
    expect(p.log).toEqual([
      "ask null", "playing hexmethod", "live @hexmethod Round 1 · starting",
      POST1, "live @hexmethod Round 1 · 0 read · 0 found · $0.00", "reload",
      "say Stopped: press Play to go on.", "playing null",
    ]);
    p.log.length = 0;
    await p.start();
    expect(p.log).toEqual([
      "ask null", "playing hexmethod", "live @hexmethod Round 1 · starting",
      POST1, "live @hexmethod Round 1 · 0 read · 0 found · $0.00", "reload",
      POST2, "live @hexmethod Round 2 · 0 read · 0 found · $0.00", "reload",
      "say @hexmethod: posts per Play reached.", "playing null",
    ]);
  });

  it("ends the Play on a refused round with the server's reason after reloading the row", async () => {
    const refused = player([{ ok: false, json: { error: "@hexmethod is another X account now" } }]);
    await refused.start();
    expect(refused.log.slice(3)).toEqual([POST1, "reload", "say @hexmethod is another X account now", "playing null"]);
    const blank = player([{ ok: false }]);
    await blank.start();
    expect(blank.log.slice(3)).toEqual([POST1, "reload", "say The Play failed.", "playing null"]);
  });

  // A lost answer is not a round that did not run: the server may have read and billed it, so the row is read again
  // (else the next Play's confirm shows the old "Spent so far", F21's failure), without holding the Play up.
  it("ends the Play on a network error and reads the row again", async () => {
    const down = player([new TypeError("Failed to fetch")]);
    await down.start();
    expect(down.log.slice(3)).toEqual([POST1, "say Network hiccup: press Play to go on.", "reload", "playing null"]);
  });
});

describe("a creator's row and results", () => {
  it("says where it stands, what it found and spent, with its X and Enki links", () => {
    expect(PAGE).toContain("const state = c.onEnki ? `on Enki as @${c.onEnki}, not hunted` : c.state.error ? c.state.error");
    expect(PAGE).toContain(': c.state.catchingUp ? "catching up on new posts"\n                        : c.state.dry ? `stopped: ${c.config.dryAfter} posts in a row without a prompt` : c.state.backDone ? "up to date"');
    expect(PAGE).toContain(': c.state.oldestId ? `reading back to ${readBackTo(c.state.oldestId)}` : "new";');
    expect(PAGE).toContain("{c.state.postsRead} read · {c.state.found} found · {c.pending} waiting · {published} published");
    // Published = what its Plays published, not what they queued (review finding 5, R3).
    expect(PAGE).toContain("const published = c.runs.reduce((n, r) => n + r.published, 0);");
    expect(PAGE).toContain("{usd2(c.state.spentUsd)} of {usd2(c.config.spendCapUsd)}");
    expect(PAGE).toContain("{c.profile && <a href={`/creators/${c.profile.userId}`}");
    expect(PAGE).toContain("<a href={`https://x.com/${c.handle}`}");
  });

  // Kev, 2026-10-26: "i dont want no profile images on enki" (lib/ui/kit/__tests__/seal.test.ts holds every surface to it).
  it("draws the creator as its seal, by its Enki handle once it has one, never X's picture", () => {
    expect(PAGE).toContain("<Seal handle={c.profile?.handle || c.handle} />");
    expect(PAGE).not.toContain("c.profile?.avatarUrl");
  });

  it("lists its Plays with reads, finds, skips by reason, videos skipped, the estimate and why each stopped, and opens its finds", () => {
    expect(PAGE).toContain("{r.usage.posts + r.usage.replies} read · {r.found} found · {r.queued} queued · {r.published} published");
    expect(PAGE).toContain("{r.usage.videos > 0 && <span style={{ color: \"var(--enki-ink-3)\" }}> · {videosSaved(r.usage.videos)}</span>}");
    expect(PAGE).toContain('{" · "}{usd2(r.estUsd)}');
    expect(PAGE).toContain('{r.done ? `stopped: ${CR_STOPPED[r.stopped ?? "done"]}` : i === 0 && (playing || c.state.playing) ? "running" : "unfinished"}');
  });

  // Decided 2026-10-30 (D3): a post whose prompt's source is longer than the model reads (lib/hunter/distill SOURCE_MAX)
  // is not queued; lib/hunter/creator-run counts it in the Play's skipped as too_long, and the Results line says it in words.
  it("names a Play's skips by reason, too_long as a prompt too long to cut, the page's own expression run", () => {
    const at = PAGE.indexOf(" · skipped {") + " · skipped {".length;
    const skippedOf = new Function("r", "outcomeWords", `return ${PAGE.slice(at, PAGE.indexOf("}</span>}", at))};`) as (r: unknown, words: typeof outcomeWords) => string;
    expect(count(" · skipped {")).toBe(1);
    expect(skippedOf({ skipped: { too_long: 2, no_prompt: 5, seen: 0, distill_failed: 1 } }, outcomeWords)).toBe("prompt too long to cut 2, no prompt 5, distill failed 1");
  });

  // Kev, 2026-11-02: a link Enki knew already reads as he asked; one post may have two lines now, so each needs its own key.
  it("says a known link's line in words, each line with its own key", () => {
    const at = PAGE.indexOf("{ok ? `✓ ${r.outcome}`") + 1;
    const said = new Function("r", "ok", "outcomeWords", `return ${PAGE.slice(at, PAGE.indexOf("`}</span>", at) + 1)};`) as (r: { outcome: string }, ok: boolean, words: typeof outcomeWords) => string;
    expect(said({ outcome: "already_in_enki" }, false, outcomeWords)).toBe("✗ already in Enki");
    expect(said({ outcome: "already_waiting" }, false, outcomeWords)).toBe("✗ already waiting");
    // Kev, 2026-11-03: who a post leads to, on its line, whose link is the post (the line's own <a>), so he can add them.
    expect(said({ outcome: "leads_to:vox_vicious" }, false, outcomeWords)).toBe("✗ leads to @vox_vicious, not on your list");
    expect(PAGE).toContain('<a href={`https://x.com/${r.handle}/status/${r.post_id}`} target="_blank" rel="noreferrer"');
    expect(PAGE).toContain("<div key={`${r.post_id}:${r.outcome}:${r.read_at}`} style=");
  });

  // Review 2026-11-02: a Play showed $0 while its forwards paid for model calls on other creators.
  it("says what a Play's forwards cost on the creators they lead to", () => {
    expect(PAGE).toContain("followed += s.followedUsd ?? 0;");
    expect(PAGE).toContain("${usd2(s.estUsd)}${followed ? ` + $${followed.toFixed(4)} on the creators its forwards lead to` : \"\"}`");
  });

  // Kev, 2026-11-02: Start over itself spends nothing, the next Play pays for the failed posts it tries again.
  it("Start over says which failed posts it tries again and what the next Play pays for them", () => {
    expect(PAGE).toContain('label="Start over" title={`Reads every post again from the newest (free); found ones are skipped as duplicates. Posts marked distill failed, reply missing, forward could not be followed or leads to someone not on your list are tried again at the next Play: ${c.mode === "auto" ? "about $0.0007 each" : "free"}; Start over itself spends nothing`}');
    expect(PAGE).toContain('a rejected one is read again. Posts marked distill failed, reply missing, forward could not be followed or leads to someone not on your list are tried again at its next Play: ${c.mode === "auto" ? "about $0.0007 each" : "free"}.`)) void post(');
  });

  // Review finding 2: removing forgets the posts read, so X bills the re-read; the spend survives (round 2, D2: added again,
  // it counts its earlier Plays). Not mid-Play.
  it("Remove says X bills the re-read and the spend still counts, and is not offered while the creator plays", () => {
    expect(PAGE).toContain('{d.hunter.canEdit && (playing || c.state.playing ? <Pill kind="plain" label="Remove" title="Stop its Play first" />');
    expect(PAGE).toContain("if (!window.confirm(`Remove @${c.handle}? The ${c.state.postsRead} posts read from it are forgotten: added again, X bills those posts again. Its spend so far (${usd2(c.state.spentUsd)}) still counts against its cap, and its Enki profile, its prompts and its past Plays stay.`)) return;");
    // The form's floor is SQL 56's CHECK (posts_per_play BETWEEN 20 AND 1000, CREATOR_LIMITS).
    expect(PAGE).toContain('min={20} max={1000} value={crForm.postsPerPlay}');
    expect(count('action: "removeAccount"')).toBe(1);
  });
});

describe("a creator's finds (review finding 4: \"Show its finds\" was a substring search)", () => {
  /** The page's own Pending-imports filter, read from its source and run: its two lines, the two types stripped. */
  const line = (start: string) => PAGE.split("\n").map((l) => l.trim()).find((l) => l.startsWith(start)) ?? "";
  const filter = new Function("d", "q", "crFinds", "impMissed",
    `${line("const isFindOf = ").split(": Imp").join("").split(": string").join("")}\n${line("const filteredImports = ")}\nreturn filteredImports.map((r) => r.id);`,
  ) as (d: { imports: unknown[] }, q: string, crFinds: string | null, impMissed?: boolean) => string[];
  const hunt = (handle: string) => ({ from: "text", creator: { handle, xUserId: "1" } });
  const d = { imports: [
    { id: "a", name: "Foggy harbour", hunter: "art", url: "https://x.com/art/status/1", preview: { hunt: hunt("art") } },
    { id: "b", name: "Neon alley", hunter: "artbyhex", url: "https://x.com/artbyhex/status/2", preview: { hunt: hunt("artbyhex") } },
    { id: "c", name: "Street art mural", hunter: "art", url: "https://x.com/someone/status/3", preview: null },
    { id: "d", name: "Portrait", hunter: "smartprompts", url: "https://x.com/smartprompts/status/4", preview: { hunt: hunt("smartprompts") } },
    { id: "e", name: "Lighthouse", hunter: "art", url: "https://x.com/Art/status/5", preview: { hunt: hunt("Art") } },
    // Its Enki profile got another handle (the X one was taken), and the link names no handle: only the X handle finds it.
    { id: "f", name: "Dusk", hunter: "lumen_2", url: "https://x.com/i/web/status/6", preview: { hunt: hunt("lumenart") } },
  ] };

  it("shows exactly that creator's finds: not @artbyhex's, not a referral titled 'art', not a person's referral", () => {
    expect(line("const isFindOf = ")).not.toBe("");
    expect(filter(d, "", "art")).toEqual(["a", "e"]);
    expect(filter(d, "", "lumenart")).toEqual(["f"]);
    expect(filter(d, "", null)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("keeps the search by X handle, title, finder and link as it was", () => {
    expect(filter(d, "art", null)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(filter(d, "artbyhex", null)).toEqual(["b"]);
    expect(filter(d, "lumenart", null)).toEqual(["f"]);
    expect(filter(d, "dusk", null)).toEqual(["f"]);
  });

  it("is set by the creator's button, said above the queue with Show all, and let go on a search or another tab", () => {
    expect(PAGE).toContain('onClick={() => { setTab("imports"); setQuery(""); setCrFinds(c.handle); }}');
    expect(PAGE).toContain("Finds of @{crFinds} on X · {filteredImports.length}</span>");
    expect(PAGE).toContain('<Pill kind="plain" label="Show all" onClick={() => setCrFinds(null)} />');
    expect(PAGE).toContain('onChange={(e) => { setQuery(e.target.value); setCrFinds(null); }}');
    expect(PAGE).toContain('onClick={() => { setTab(t.id); setQuery(""); setCrFinds(null); }}');
    expect(PAGE).toContain('onClick={() => { setTab(s.go); setQuery(""); setCrFinds(null); }}');
    // A link or a list adds to Pending imports' count in the menu and does not jump there (Kev, 2026-10-31).
    expect(count("setTab(")).toBe(3);
  });

  // "Add link manually" (Kev, 2026-10-31): the page's own addLink, run.
  it("frees the field at once and adds the links in a line, one after another, saying each result (Kev, 2026-10-31)", async () => {
    const log: string[] = [];
    const linkQueue = { current: [] as string[] }, draining = { current: false };
    const addLink = page<() => void>("addLink", {
      crLink: "  https://x.com/a/status/1 ", linkQueue, draining,
      setCrLink: (v: string) => log.push(`link "${v}"`), setCrListing: (v: string | null) => log.push(`listing ${v}`),
      drainLinks: async () => { log.push(`drain ${linkQueue.current.join(",")}`); },
    });
    addLink();
    expect(log).toEqual(['link ""', "listing Adding 1 link…", "drain https://x.com/a/status/1"]);
    // While a line is being added, a new link joins it: no second drain.
    log.length = 0;
    draining.current = true;
    addLink();
    expect(log).toEqual(['link ""', "listing Adding 3 links…"]);

    const answers = [
      { ok: true, json: { handle: "a" } },
      { ok: false, json: { error: "That post is gone." } },
      { ok: true, json: { handle: "b" } },
    ];
    const out: string[] = [];
    const lq = { current: ["https://x.com/a/status/1", "https://x.com/b/status/2", "https://x.com/c/status/3"] }, dr = { current: false };
    const drainLinks = page<() => Promise<void>>("drainLinks", {
      linkQueue: lq, draining: dr, sessionAuthHeaders: () => ({}),
      fetch: async (_u: string, init: { body: string }) => { const b = JSON.parse(init.body); out.push(`POST ${b.action} ${b.url}`); const a = answers.shift()!; return { ok: a.ok, json: async () => a.json }; },
      reload: async () => { out.push("reload"); return null; }, say: (m: string) => out.push(`say ${m}`), setCrListing: (v: string | null) => out.push(`listing ${v}`),
    });
    await drainLinks();
    // Put in line under their creators, not played (Kev, 2026-11-01: "erst das einstellen und dann play drücken").
    expect(out).toEqual([
      "listing Adding 3 links…", "POST queueLink https://x.com/a/status/1", "reload", "say In line under @a: set its mode, then Play links.",
      "listing Adding 2 links…", "POST queueLink https://x.com/b/status/2", "reload", "say That post is gone.",
      "listing Adding 1 link…", "POST queueLink https://x.com/c/status/3", "reload", "say In line under @b: set its mode, then Play links.",
      "listing null",
    ]);
    expect(dr.current).toBe(false);
  });

  it("plays a creator's links in line one after another, in its mode, and says the tally (Kev, 2026-11-01)", async () => {
    const out: string[] = [];
    const answers = [
      { ok: true, json: { links: ["11", "12", "13", "14"] } },
      { ok: true, json: { summary: { queued: 1, skipped: {} } } },
      { ok: true, json: { summary: { queued: 0, skipped: { duplicate: 1 } } } },
      { ok: true, json: { summary: { queued: 0, skipped: { no_prompt: 1 } } } },
      { ok: true, json: { summary: { queued: 0, skipped: {} } } },
    ];
    const playLinks = page<(row: { handle: string }) => Promise<void>>("playLinks", {
      crListing: null, outcomeWords, sessionAuthHeaders: () => ({}),
      fetch: async (u: string, init?: { body?: string }) => { out.push(init?.body ? `POST ${JSON.parse(init.body).action} ${JSON.parse(init.body).url} under ${JSON.parse(init.body).handle}` : `GET ${u}`); const a = answers.shift()!; return { ok: a.ok, json: async () => a.json }; },
      reload: async () => { out.push("reload"); return null; }, say: (m: string) => out.push(`say ${m}`), setCrListing: (v: string | null) => out.push(`listing ${v}`),
    });
    await playLinks({ handle: "amirmushich" });
    expect(out).toEqual([
      "GET /api/admin?hunterWaiting=amirmushich",
      "listing Playing 1 of 4 for @amirmushich…", "POST addLink https://x.com/i/status/11 under amirmushich",
      "listing Playing 2 of 4 for @amirmushich…", "POST addLink https://x.com/i/status/12 under amirmushich",
      "listing Playing 3 of 4 for @amirmushich…", "POST addLink https://x.com/i/status/13 under amirmushich",
      "listing Playing 4 of 4 for @amirmushich…", "POST addLink https://x.com/i/status/14 under amirmushich",
      "listing null", "reload",
      "say 1 of 4 links of @amirmushich in Pending imports. Not: 12: duplicate; 13: no prompt; 14: not read.",
    ]);
    // A post with no media went somewhere: said as that, never as "not" (Kev, 2026-11-03).
    const said: string[] = [];
    const twice = (s: string) => ({ ok: true, json: () => Promise.resolve({ summary: { queued: 0, skipped: { x: 1 } }, said: s }) });
    const parkedAnswers = [{ ok: true, json: () => Promise.resolve({ links: ["1", "2", "3"] }) }, twice("It has no picture or video: saved in the No media tab."), twice("It has no picture or video: saved in the No media tab."), twice("It has a video and no picture: saved in the Videos tab.")];
    await page<(row: { handle: string }) => Promise<void>>("playLinks", {
      crListing: null, outcomeWords, sessionAuthHeaders: () => ({}), fetch: async () => parkedAnswers.shift(), reload: async () => null, say: (m: string) => said.push(m), setCrListing: () => {},
    })({ handle: "amirmushich" });
    expect(said).toEqual(["0 of 3 links of @amirmushich in Pending imports. 2 links: It has no picture or video: saved in the No media tab. It has a video and no picture: saved in the Videos tab."]);
    // While links are being added, nothing is played.
    const busy: string[] = [];
    await page<(row: { handle: string }) => Promise<void>>("playLinks", { crListing: "Adding 1 link…", say: (m: string) => busy.push(m) })({ handle: "x" });
    expect(busy).toEqual(["Links are being added: wait for them first."]);
  });

  // Kev, 2026-11-03: a wrong cut costs one click.
  it("takes a find's whole text with one click: on screen, and saved; only on the row it is open on", () => {
    const edits: unknown[] = [];
    const saves: unknown[] = [];
    const takeWhole = page<(r: { id: string }, raw: string) => void>("takeWhole", {
      setImpEdit: (f: (c: unknown) => unknown) => edits.push(f({ id: "f", prompt: "cut", category: "More" }), f({ id: "other", prompt: "x" })),
      saveImpFields: async (r: unknown, p: unknown) => { saves.push([r, p]); return {}; },
    });
    takeWhole({ id: "f" }, "the whole text");
    expect(edits).toEqual([{ id: "f", prompt: "the whole text", category: "More" }, { id: "other", prompt: "x" }]);
    expect(saves).toEqual([[{ id: "f" }, { prompt: "the whole text" }]]);
    // It shows from what the find kept, with no read of X.
    const shown: unknown[] = [];
    const asked: unknown[] = [];
    void page<(r: unknown) => Promise<void>>("showPostText", { impPost: null, setImpPost: (v: unknown) => shown.push(v), fetch: async (u: string) => { asked.push(u); return new Response("{}"); } })({ id: "f", url: "https://x.com/a/status/1", preview: { hunt: { raw: "the whole text" } } });
    expect(shown).toEqual([{ id: "f", text: "the whole text" }]);
    expect(asked).toEqual([]);
    expect(PAGE).toContain("setImpPost({ id: r.id, text: r.preview.hunt.rawWords ?? r.preview.hunt.raw });");
    expect(PAGE).toContain('{r.preview.hunt?.raw && r.preview.hunt.raw !== impEdit.prompt && <Pill kind="plain" label="Take the whole text instead"');
  });

  it("a whole text whose save failed puts the cut back on screen, in the row and in the field, not over a later edit", async () => {
    const find = { id: "f", preview: { prompt: "the cut" } };
    let edit: unknown = { id: "f", prompt: "the cut" };
    let data: unknown = { imports: [{ id: "f", preview: { prompt: "the whole text" } }, { id: "g", preview: { prompt: "other" } }] };
    // saveImpFields kept the whole text as typed words: the cut is back on screen, so nothing waits and Approve publishes it.
    const impUnsaved = { current: new Map([["f", "the whole text"]]) };
    const run = (save: Promise<unknown>) => page<(r: unknown, raw: string) => void>("takeWhole", {
      setImpEdit: (f: (c: unknown) => unknown) => { edit = f(edit); },
      setData: (f: (c: unknown) => unknown) => { data = f(data); },
      saveImpFields: () => save,
      impUnsaved,
    })(find, "the whole text");
    run(Promise.resolve(null));
    expect(edit).toEqual({ id: "f", prompt: "the whole text" });
    await new Promise((r) => setTimeout(r));
    expect(edit).toEqual({ id: "f", prompt: "the cut" });
    expect(data).toEqual({ imports: [{ id: "f", preview: { prompt: "the cut" } }, { id: "g", preview: { prompt: "other" } }] });
    expect(impUnsaved.current.size).toBe(0);
    // A save that went through leaves them.
    run(Promise.resolve({}));
    await new Promise((r) => setTimeout(r));
    expect(edit).toEqual({ id: "f", prompt: "the whole text" });
    // Typed over while it was on its way: the typing stays.
    let fail = (_: unknown) => {};
    run(new Promise((res) => { fail = res; }));
    edit = { id: "f", prompt: "typed since" };
    fail(null);
    await new Promise((r) => setTimeout(r));
    expect(edit).toEqual({ id: "f", prompt: "typed since" });
  });

  // Review 2026-11-02, from Kev's "kann ich diese brackets da nicht löschen": two ways an edit of a find's prompt was lost.
  it("waits for a find's save before an Approve clicked straight from its prompt field publishes it", async () => {
    const order: string[] = [];
    let finish = () => {};
    const impSaves = { current: Promise.resolve() as Promise<unknown> };
    const post = (b: { action: string }) => {
      order.push(`${b.action} sent`);
      if (b.action !== "edit") return Promise.resolve({});
      return new Promise((res) => { finish = () => { order.push("edit saved"); res({}); }; });
    };
    const find = { id: "f", name: "Find", tags: [], preview: { prompt: "[old]", category: "More", tags: [], generators: [], adult: false } };
    const impUnsaved = { current: new Map<string, string>() };
    page<(r: unknown, patch: unknown) => void>("saveImpFields", { impSaves, post, impUnsaved, dataEpoch: { current: 0 }, setData: () => {} })(find, { prompt: "new" });
    const approved = page<(p: unknown, m: string, a: unknown) => Promise<unknown>>("approveFinds", { impSaves, post, impUnsaved, impOpen: null, impEdit: null, data: null, say: () => {} })({ id: "f" }, "ok", (c: unknown) => c);
    await Promise.resolve();
    expect(order).toEqual(["edit sent"]);
    finish();
    await approved;
    expect(order).toEqual(["edit sent", "edit saved", "approve sent"]);
  });

  // Review of DEC-2026-11-03-50: a typed edit whose blur save failed stayed on screen, and Approve published the old prompt.
  describe("Approve, while the prompt field differs from the row", () => {
    type Find = { id: string; name: string; tags: string[]; preview: { prompt: string; title: string; tags: string[] } };
    const OLD = "the prompt the server holds";
    const TYPED = "the prompt typed by hand";
    const find = (id = "f"): Find => ({ id, name: `Find ${id}`, tags: [], preview: { prompt: OLD, title: `Find ${id}`, tags: [] } });
    /** The real saveImpFields and approveFinds over one page's state; a save's answer is the test's to give. */
    const scene = (open: { impOpen?: string | null; impEdit?: { id: string; prompt: string } | null } = {}) => {
      const st = { data: { imports: [find(), find("g")] }, sent: [] as string[], said: [] as string[], reloads: 0 };
      const impSaves = { current: Promise.resolve() as Promise<unknown> };
      const impUnsaved = { current: new Map<string, string>() };
      const answers: ((ok: unknown) => void)[] = [];
      const post = (b: { action: string }, _m: string, apply: (d: typeof st.data) => typeof st.data) => {
        st.sent.push(b.action);
        if (b.action !== "edit") return Promise.resolve({});
        return new Promise((res) => answers.push((ok) => { if (ok) st.data = apply(st.data); res(ok); }));
      };
      const scope = { impSaves, impUnsaved, post, dataEpoch: { current: 0 }, setData: (f: (d: typeof st.data) => typeof st.data) => { st.data = f(st.data); }, reload: async () => { st.reloads += 1; return null; } };
      const save = page<(r: Find, patch: Record<string, unknown>) => Promise<unknown>>("saveImpFields", scope);
      const approve = (payload: Record<string, unknown>, o = open) => page<(p: unknown, m: string, a: unknown) => Promise<unknown>>("approveFinds", { ...scope, data: st.data, say: (m: string) => st.said.push(m), impOpen: o.impOpen ?? null, impEdit: o.impEdit ?? null })(payload, "ok", (c: unknown) => c);
      const prompt = (id = "f") => st.data.imports.find((x) => x.id === id)!.preview.prompt;
      return { st, save, approve, prompt, answers, impUnsaved, settle: () => new Promise((r) => setTimeout(r)) };
    };

    it("a save that failed: the row goes back to what the server holds, the words wait, and a read cannot take them", async () => {
      const s = scene();
      void s.save(find(), { prompt: `  ${TYPED} ` });
      await s.settle();
      expect(s.prompt()).toBe(TYPED);
      s.answers[0](null);
      await s.settle();
      expect(s.prompt()).toBe(OLD);
      expect(s.impUnsaved.current.get("f")).toBe(`  ${TYPED} `);
      expect(s.st.reloads).toBe(1);
    });

    it("Approve all refused: the selection comes back, and the sentence stands long enough to read", () => {
      expect(PAGE).toContain("if (!ok) { setImpSel(new Set(ids)); void reload(); }");
      expect(PAGE).toContain("Math.max(2600, m.length * 60)");
    });

    it("refuses, in a sentence, and asks nothing of the server, once the save has failed", async () => {
      const s = scene();
      void s.save(find(), { prompt: TYPED });
      await s.settle();
      s.answers[0](null);
      await s.settle();
      s.st.sent = [];
      expect(await s.approve({ id: "f" })).toBeNull();
      expect(s.st.sent).toEqual([]);
      expect(s.st.said).toEqual(["Nothing was published: the prompt typed for “Find f” is not saved, so click into its field and out again to save it first."]);
    });

    it("the save this very click's blur sent: it waits for its answer, and refuses when it failed", async () => {
      const s = scene();
      void s.save(find(), { prompt: TYPED });
      const approved = s.approve({ id: "f" }, { impOpen: "f", impEdit: { id: "f", prompt: TYPED } });
      await s.settle();
      expect(s.st.sent).toEqual(["edit"]);
      s.answers[0](null);
      expect(await approved).toBeNull();
      expect(s.st.sent).toEqual(["edit"]);
    });

    it("the same save, answered well: published, and a later Approve is not refused", async () => {
      const s = scene();
      void s.save(find(), { prompt: TYPED });
      const approved = s.approve({ id: "f" }, { impOpen: "f", impEdit: { id: "f", prompt: TYPED } });
      await s.settle();
      s.answers[0]({});
      await approved;
      expect(s.st.sent).toEqual(["edit", "approve"]);
      expect(s.st.said).toEqual([]);
    });

    it("a save that failed, then one that went through: the words no longer wait, and it publishes", async () => {
      const s = scene();
      void s.save(find(), { prompt: TYPED });
      await s.settle();
      s.answers[0](null);
      await s.settle();
      void s.save(find(), { prompt: `${TYPED} again` });
      await s.settle();
      s.answers[1]({});
      await s.settle();
      expect(s.impUnsaved.current.size).toBe(0);
      expect(s.prompt()).toBe(`${TYPED} again`);
      await s.approve({ id: "f" });
      expect(s.st.sent).toEqual(["edit", "edit", "approve"]);
    });

    it("another field's failed save does not touch the prompt's words, nor refuse", async () => {
      const s = scene();
      void s.save(find(), { adult: true });
      await s.settle();
      s.answers[0](null);
      await s.settle();
      expect(s.impUnsaved.current.size).toBe(0);
      await s.approve({ id: "f" });
      expect(s.st.sent).toEqual(["edit", "approve"]);
    });

    it("a field that differs from the row with no save behind it (a read brought other words): refused, the words kept", async () => {
      const s = scene();
      expect(await s.approve({ id: "f" }, { impOpen: "f", impEdit: { id: "f", prompt: TYPED } })).toBeNull();
      expect(s.st.sent).toEqual([]);
      expect(s.impUnsaved.current.get("f")).toBe(TYPED);
    });

    it("the field against its row alone: spaces round it, a closed row, and another find's Approve pass", async () => {
      await (async () => { const s = scene(); await s.approve({ id: "f" }, { impOpen: "f", impEdit: { id: "f", prompt: `  ${OLD}\n` } }); expect(s.st.sent).toEqual(["approve"]); })();
      await (async () => { const s = scene(); await s.approve({ id: "f" }, { impOpen: null, impEdit: { id: "f", prompt: TYPED } }); expect(s.st.sent).toEqual(["approve"]); })();
      await (async () => { const s = scene(); await s.approve({ id: "g" }, { impOpen: "f", impEdit: { id: "f", prompt: TYPED } }); expect(s.st.sent).toEqual(["approve"]); })();
    });

    it("Approve all: any find with unsaved words refuses the whole press, and names it; without it the rest go", async () => {
      const s = scene();
      s.impUnsaved.current.set("g", TYPED);
      expect(await s.approve({ ids: ["f", "g"] })).toBeNull();
      expect(s.st.sent).toEqual([]);
      expect(s.st.said[0]).toContain("“Find g”");
      await s.approve({ ids: ["f"] });
      expect(s.st.sent).toEqual(["approve"]);
      // The open row counts in a batch too.
      const t = scene();
      expect(await t.approve({ ids: ["g", "f"] }, { impOpen: "f", impEdit: { id: "f", prompt: TYPED } })).toBeNull();
      expect(t.st.sent).toEqual([]);
    });

    it("opening the find again shows the words that wait, and another find its own prompt", () => {
      const edits: unknown[] = [];
      const open = page<(r: Find) => void>("openImp", { impOpen: null, setImpOpen: () => {}, setImpPost: () => {}, setImpEdit: (e: unknown) => edits.push(e), impUnsaved: { current: new Map([["f", TYPED]]) } });
      open({ ...find(), preview: { ...find().preview, category: "More", generators: [] } as never });
      open({ ...find("g"), preview: { ...find("g").preview, category: "More", generators: [] } as never });
      expect(edits).toMatchObject([{ id: "f", prompt: TYPED }, { id: "g", prompt: OLD }]);
    });
  });

  // DEC-2026-11-02-19, with real keys in Edge: the brackets went from the field, a save on its way; the next field's save
  // sent the row as drawn, old prompt in it, and a row closed and opened again read the old prompt and saved it back.
  it("sends only what a save changed, one save after the other, shown at once and again at its answer", async () => {
    const find = { id: "f", name: "Find", tags: ["a"], preview: { prompt: "[old prompt]", title: "Find", category: "More", tags: ["a"], generators: [], adult: false } };
    const other = { ...find, id: "g", name: "Other" };
    const before = { imports: [find, other] };
    let data: { imports: (typeof find)[] } = before;
    const sent: unknown[] = [];
    const answers: ((ok: unknown) => void)[] = [];
    let reloads = 0;
    const dataEpoch = { current: 0 };
    const save = page<(r: typeof find, patch: Record<string, unknown>) => void>("saveImpFields", {
      impSaves: { current: Promise.resolve() as Promise<unknown> }, dataEpoch, impUnsaved: { current: new Map() },
      setData: (f: (d: typeof data) => typeof data) => { data = f(data); },
      reload: async () => { reloads += 1; return null; },
      post: (b: { edit: unknown }, _m: string, apply: (d: typeof data) => typeof data) => {
        sent.push(b.edit);
        return new Promise((res) => answers.push((ok) => { if (ok) data = apply(data); res(ok); }));
      },
    });
    const settle = () => new Promise((res) => setTimeout(res));

    save(find, { prompt: "  old prompt " });
    // On screen before any answer, and a read on its way no longer shows.
    expect(data.imports[0].preview.prompt).toBe("old prompt");
    expect(dataEpoch.current).toBe(1);
    // The next field's save, from the row as it was drawn: it does not carry the old prompt, and waits for the first.
    save(find, { adult: true });
    await settle();
    expect(sent).toEqual([{ prompt: "  old prompt " }]);
    // A read that came in meanwhile with the row as it stood: the answer puts the save back on it.
    data = before;
    answers[0]({});
    await settle();
    expect(sent).toEqual([{ prompt: "  old prompt " }, { adult: true }]);
    expect(data.imports[0].preview.prompt).toBe("old prompt");
    answers[1]({});
    await settle();
    expect(data.imports[0].preview).toMatchObject({ prompt: "old prompt", adult: true });
    expect(reloads).toBe(0);

    // Tags and title as the server keeps them, in the row too.
    save(data.imports[0], { tags: [" Blue ", ""], title: " New name " });
    await settle();
    expect(sent[2]).toEqual({ tags: ["blue"], title: " New name " });
    expect(data.imports[0]).toMatchObject({ name: "New name", tags: ["blue"], preview: { title: "New name", tags: ["blue"], prompt: "old prompt" } });
    answers[2]({});
    await settle();

    // A save the server refused: what it holds comes back on screen.
    save(data.imports[0], { prompt: "short" });
    await settle();
    answers[3](null);
    await settle();
    expect(reloads).toBe(1);
    expect(data.imports[1]).toBe(other);
  });

  it("shows no read that was on its way during a save, whose answer holds what stood before it", async () => {
    const shown: unknown[] = [];
    const dataEpoch = { current: 0 };
    let answer = (_v: unknown) => {};
    const reload = page<() => Promise<unknown>>("reload", {
      dataEpoch, impShown: { current: 50 }, sessionAuthHeaders: () => ({}), setData: (d: unknown) => shown.push(d),
      fetch: () => new Promise((res) => { answer = res; }),
    });
    const late = reload();
    dataEpoch.current += 1; // a save, while the read is on its way
    answer({ ok: true, json: async () => ({ imports: "as before the save" }) });
    await late;
    expect(shown).toEqual([]);
    const fresh = reload();
    answer({ ok: true, json: async () => ({ imports: "after the save" }) });
    expect(await fresh).toEqual({ imports: "after the save" });
    expect(shown).toEqual([{ imports: "after the save" }]);
    expect(PAGE).toContain("dataEpoch.current += 1;\n      setData((cur) => (cur ? apply(cur) : cur));");
    expect(PAGE).toContain("void approveFinds({ id: r.id },");
    expect(PAGE).toContain("void approveFinds({ ids },");
  });

  it("loads Pending imports 50 at a time as the list nears its end, one page at once, and a reload keeps the scrolled ones (Kev, 2026-10-31)", async () => {
    const rows = (ids: string[]) => ids.map((id) => ({ id }));
    let data = { imports: rows(Array.from({ length: 50 }, (_, i) => `r${i}`)), importsTotal: 53 };
    const asked: string[] = [];
    const impLoading = { current: false }, impShown = { current: 50 };
    let answer = () => {};
    const scope = () => ({
      data, impLoading, impShown, IMPORTS_PAGE: 50, sessionAuthHeaders: () => ({}),
      setData: (f: (cur: typeof data) => typeof data) => { data = f(data); },
      fetch: async (u: string) => {
        asked.push(u);
        await new Promise<void>((r) => { answer = r; });
        return { ok: true, json: async () => ({ imports: rows(["r49", "r50", "r51", "r52"]), importsTotal: 53 }) };
      },
    });
    const more = page<() => Promise<void>>("loadMoreImports", scope());
    const first = more();
    await more(); // near the end again while the page is on its way: nothing asked
    answer();
    await first;
    expect(asked).toEqual(["/api/admin?importsFrom=50"]);
    expect(data.imports.map((r) => r.id).slice(48)).toEqual(["r48", "r49", "r50", "r51", "r52"]); // r49 came twice: shown once
    expect(impShown.current).toBe(53);
    // All shown: nothing more is asked.
    await page<() => Promise<void>>("loadMoreImports", scope())();
    expect(asked).toHaveLength(1);
    expect(PAGE).toContain("fetch(`/api/admin?imports=${impShown.current}`");
    expect(PAGE).toContain("if (seen[0]?.isIntersecting) void loadMoreImports();");
    expect(PAGE).toContain("{d.imports.length < d.importsTotal && (\n                      <div ref={impEnd}");
    expect(PAGE).toContain('{ label: "Pending imports", value: d.importsTotal,');
    // The 18+ tick on every find row (Kev, 2026-11-01).
    expect(PAGE).toContain('<input type="checkbox" checked={r.preview.adult} aria-label="18+" onChange={(e) => saveImpFields(r, { adult: e.target.checked })}');
    // "Generate title, category & tags": the marked finds, else every waiting one, after a confirm with the cost.
    expect(PAGE).toContain('<Pill kind="plain" label="Generate title, category & tags"');
    expect(PAGE).toContain('body: JSON.stringify({ resource: "imports", action: "describe", ids }),');
    expect(PAGE).toContain("const n = ids.length || d.importsTotal;");
    // Not inside the Mark all label, which a button in it took the clicks of (review 2026-11-01).
    const label = PAGE.slice(PAGE.indexOf('<input type="checkbox" aria-label="Mark all"') - 400, PAGE.indexOf('<input type="checkbox" aria-label="Mark all"'));
    expect(label.slice(label.lastIndexOf("<label")).includes("<Pill")).toBe(false);
    expect(PAGE).toContain("const missedImports = d.importsMissed ?? d.imports.filter((r) => !!r.preview?.hunt?.recipeMiss).length;");
  });
});

describe("Pending imports' Approve, open rows and Delete prompt (Kev, 2026-10-31)", () => {
  it("shows Publishing… while a find is published, opens a row downward with its top kept, and deletes by a prompt's link", () => {
    expect(PAGE).toContain('{impBusy.has(r.id) ? <Pill kind="plain" label="Publishing…" title="Checking and publishing: a few seconds" />');
    expect(PAGE).toContain("setImpBusy((b) => new Set(b).add(r.id));");
    expect(PAGE).toContain(".finally(() => setImpBusy((b) => { const n = new Set(b); n.delete(r.id); return n; }));");
    expect(PAGE).toContain('style={{ ...rowStyle, alignItems: "flex-start", cursor: "pointer",');
    // Opens on a click anywhere but its fields, links and buttons; "Mark all" marks every find shown (Kev, 2026-10-31).
    expect(PAGE).toContain('if (!(e.target as HTMLElement).closest("input, textarea, select, button, a, label, [data-edit]")) openImp(r);');
    expect(PAGE).toContain("onChange={(e) => setImpSel(e.target.checked ? new Set(filteredImports.map((r) => r.id)) : new Set())}");
    // Category, generator and tags right in the row, saved at once; the open prompt saved when it loses the focus.
    expect(PAGE).toContain('const saved = impSaves.current.then(() => post({ resource: "imports", action: "edit", id: r.id, edit }, "Saved.", show))');
    expect(PAGE).toContain('onChange={(e) => saveImpFields(r, { category: e.target.value })}');
    expect(PAGE).toContain('onChange={(e) => saveImpFields(r, { generators: e.target.value ? [e.target.value] : [] })}');
    expect(PAGE).toContain("onBlur={() => { if (r.preview && impEdit.prompt.trim() !== r.preview.prompt) saveImpFields(r, { prompt: impEdit.prompt }); else impUnsaved.current.delete(r.id); }}");
    expect(PAGE).toContain('if (r.preview && tags.join(",") !== r.preview.tags.join(",")) saveImpFields(r, { tags }); }}');
    expect(PAGE).toContain('void post({ resource: "prompts", action: "delete", id }, "Prompt deleted.", (cur) => cur)');
    const at = PAGE.indexOf("const id = delPrompt.match(");
    const idOf = new Function("delPrompt", `${PAGE.slice(at, PAGE.indexOf(";", at) + 1)} return id;`) as (v: string) => string | undefined;
    expect(idOf("https://enki.gallery/prompt/6d0d2169-1234-4abc-8def-0123456789ab?x=1")).toBe("6d0d2169-1234-4abc-8def-0123456789ab");
    expect(idOf("not a link")).toBeUndefined();
  });
});

describe("the queue row of a creator's find", () => {
  it("says where the prompt was found, how it was cut, which generator and why, what is not offered, and the media", () => {
    expect(PAGE).toContain("{r.preview.hunt && (");
    expect(PAGE).toContain("@{r.preview.hunt.creator.handle} on X</a>");
    expect(PAGE).toContain('{r.preview.hunt.from === "reply" && r.preview.hunt.replyUrl');
    // Every other find names its own source: an alt find says "image alt", not "post text" (review finding 5, R1).
    expect(PAGE).toContain("&apos;s reply ↗</a>\n                                      : HUNT_FROM[r.preview.hunt.from]}");
    expect(PAGE).toContain('const HUNT_FROM: Record<HuntFacts["from"], string> = { text: "post text", alt: "image alt", reply: "reply" };');
    expect(PAGE).toContain('{r.preview.hunt.how === "model" && <Badge pal={PILL.purple} label="Cut by model" />}');
    expect(PAGE).toContain("{r.preview.generators.length > 0 && ` (${GEN_FROM[r.preview.hunt.generatorFrom]})`}");
    expect(PAGE).toContain('<option value="">every generator</option>');
    // The log: searchable by a link (its id) or a username, each post's result shown (Kev, 2026-10-31).
    expect(PAGE).toContain("return r.post_id.includes(id) || r.handle.toLowerCase().includes(q);");
    expect(PAGE).toContain("{ok ? `✓ ${r.outcome}` : `✗ ${outcomeWords(r.outcome)}`}");
    expect(PAGE).toContain('const ok = r.outcome === "queued" || r.outcome === "published" || r.outcome === "forwarded";');
    // Review 2026-11-02: past 300 lines the panel read as complete while a long .txt list's lines were not shown.
    expect(PAGE).toContain("{huLogShown.length > 300 && <div style={{ padding: \"4px 0\", color: \"var(--enki-ink-3)\" }}>{`The newest 300 of ${huLogShown.length}: search to see the rest.`}</div>}");
    expect(PAGE).toContain("{huLogShown.slice(0, 300).map((r) => {");
    expect(outcomeWords("follow_failed")).toBe("forward could not be followed");
    // A find's reach: the core post, and the chain's sums when it came through forwards (Kev, 2026-10-31).
    expect(PAGE).toContain("♥ {r.preview.hunt.reach.core.likes} · ↻ {r.preview.hunt.reach.core.reposts} · ❝ {r.preview.hunt.reach.core.quotes}");
    expect(PAGE).toContain("{r.preview.hunt.reach.chain.posts > 1 && ` · chain of ${r.preview.hunt.reach.chain.posts}:");
    // A picture opens large on a click and goes back on the next (Kev, 2026-10-31), without opening the row.
    expect(PAGE).toContain("onClick={() => setImpZoom(src)}");
    expect(PAGE).toContain('<img src={origOf(impZoom)} alt="" style={{ maxWidth: "100vw", maxHeight: "100vh", objectFit: "contain" }} />');
    // X's picture at its original size (pbs.twimg.com, name=orig).
    expect(PAGE).toContain('? `${src.split("?")[0]}?name=orig` : src);');
    expect(PAGE).toContain('const GEN_FROM: Record<HuntFacts["generatorFrom"], string> = { post: "named in the post", preferred: "creator\'s preferred", all: "every generator" };');
    expect(PAGE).toContain("{r.preview.hunt.foreignGenerator && <Badge pal={PILL.amber} label={`The post names ${r.preview.hunt.foreignGenerator}, not offered here`} />}");
    expect(PAGE).toContain("{r.preview.hunt.videosSkipped > 0 && ` · ${videosSaved(r.preview.hunt.videosSkipped)}`}");
    expect(PAGE).toContain('<select data-edit value={r.preview.category} aria-label="Category" onChange={(e) => saveImpFields(r, { category: e.target.value })} style={impField}>');
  });
});

describe("the global card", () => {
  it("keeps only the mode; the accounts box, the global Run and the publisher field left the panel", () => {
    expect(PAGE).toContain('<option value="queue">queue for review</option>');
    expect(PAGE).toContain('void post({ resource: "hunter", action: "save", config }, "Mode saved."');
    expect(PAGE).not.toContain("Publisher account");
    expect(PAGE).not.toContain("Posts per round");
  });

  // Review finding 3: lib/hunter/creator-run.ts holds a find back in "publish" only when the post names a generator we do
  // not offer AND none of ours (`gen.foreign && gen.from !== "post"`); a post naming Midjourney and Nano Banana Pro goes live.
  it("says which finds wait in publish mode exactly as the run decides it", () => {
    expect(PAGE).toContain("except one whose post names a generator Enki does not offer and none that it does, which always waits.");
    expect(PAGE).not.toContain("names a generator Enki does not offer, which always waits");
  });
});
