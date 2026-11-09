# Change management

Every coding change, by a person or an agent, follows this file. The dev server on port 3008 serves this
working tree, and Kev tests on it while we build. A broken build costs his time; a wrong change that ships
costs money. Each rule below exists because of an incident in the log at the end.

## Rules for every change

1. **The served tree compiles after every single edit.** Turbopack compiles every save, so the state between
   two of your edits is what Kev sees. Order edits as *add, then switch, then remove*:
   - Add the new export, file or prop first.
   - Then change every importer and caller.
   - Remove the old one last.

   Before removing or renaming an export, list its users first:
   `grep -rn "NAME" --include=*.ts --include=*.tsx components hooks lib app`.
   Never delete a file, export or CSS file that another file still imports, not even "for a minute" (incident 2).

2. **A new import points at a file that already exists.** Create the CSS, module or asset first, then the
   `import` that names it (incident 2's follow-up: `components/studio/*.tsx` imported `./studio.css` before it
   existed).

3. **Run the two gates after every batch of edits, not only at the end:**
   - `npx tsc --noEmit`: exit 0. This catches missing exports, wrong types and unresolved TS imports.
   - `node scripts/check-imports.mjs <files you touched>`: 0 unresolved. It resolves every import the way
     tsconfig's `paths` do, **CSS included**. tsc never checks `import "x.css"` (incident 1).

4. **Import paths use the alias that exists.** `@/components/*`, `@/hooks/*` and `@/lib/*` map to their folders.
   `@/*` maps only to `./client/src/*` and `./app/*`, so `@/app/...` resolves to `app/app/...` and fails.
   Import from `app/` with a relative path, as `components/EnkiMobileGenerateModal.tsx` does.

5. **A test bundle resolves like Next does, or it proves nothing about imports.** A bench page or harness that
   maps `@/` to the repo root accepts paths Next refuses (incident 1). Mirror tsconfig's `paths`, or run
   `scripts/check-imports.mjs` on the same files.

6. **Before saying "done", show:**
   - tsc exit 0;
   - `check-imports` with 0 unresolved;
   - the test files that read what you changed, with their counts;
   - in-memory mutants for each new behaviour, all killed;
   - the real-app check, or the reason it could not run.

   Tag every claim VERIFIED, REPORTED or INFERRED. Quote the output. A red full-suite file that passes alone
   (timeouts under load) is reported as exactly that.

7. **Parallel agents own disjoint files.**
   - Shared files are re-read right before a minimal hunk.
   - Never remove something another agent's files still import.
   - Never land a half-done rename in the shared tree.
   - When a build may run for minutes, its first edits are additive only.

8. **Mutate in memory, never on disk** in this tree. A mutant saved to disk is served to Kev like any other edit.

## Known blind spots

- `/home` and `/editor` sit behind the access gate. The agents' browser pane is redirected to the landing
  page, so agents cannot see the real page. Benches stand in for it, and they cover only what they bundle.
  A dev-only way through the gate for the agent browser would close this. That is Kev's call; not built.
- Turbopack errors that tsc and `check-imports` cannot see are not covered: CSS syntax, `"use client"`
  boundaries, server-only imports in client files. Not evaluated yet.

## Incident log

### 2026-10-30-01: Module not found `@/app/editor/mobile-modal.css`

- **What:** Kev's dev server failed to build `/home`: `Module not found: Can't resolve
  '@/app/editor/mobile-modal.css'` at `components/create/image/ImageBar.tsx:16`.
- **Root cause (VERIFIED):** A review-fix agent made the Create > Image bar import Quick Create's stylesheet
  as `@/app/editor/mobile-modal.css`. tsconfig maps `@/*` to `./client/src/*` and `./app/*`, so the path
  resolves to `app/app/editor/...`, which does not exist.
- **Why every check passed (VERIFIED):**
  - tsc does not check side-effect imports of CSS.
  - The unit tests read the source as text.
  - The headless-Edge bench bundled with Vite and an alias `^@/ → repo root`
    (`scratchpad/cifix/bench/build.mjs:49`), so the wrong path resolved there.
  - No check ran Next's own resolution.
- **Fix:** `9df58655`, a relative import (`../../../app/editor/mobile-modal.css`).
- **Prevention:** rules 3, 4 and 5. `scripts/check-imports.mjs` flags the old file
  (`UNRESOLVED ...: @/app/editor/mobile-modal.css`, VERIFIED 2026-10-30) and passes the fixed one.

### 2026-10-30-02: Export `STUDIO_TABS` doesn't exist in target module

- **What:** Kev's dev server failed to build `/home`: `Export STUDIO_TABS doesn't exist in target module` at
  `components/enki-shell/EnkiHome.tsx:31`.
- **Root cause (VERIFIED):** The Studio UI agent (workflow `wkiizyweg`, still running) deleted `STUDIO_TABS`
  from `lib/ui/kit/shell-nav.ts` first and had not yet rewritten its importer.
  `EnkiHome.tsx:32` and `:474` still used it (grep at the time). The served tree was broken from that edit
  until the importer changed. Kev reloaded inside that window.
- **Why nothing stopped it:** The agent's gates (tsc, tests) run when its work ends, not between its edits,
  and the edit order was *remove, then switch*.
- **Fix:** A temporary re-export of `STUDIO_TABS` at the end of `shell-nav.ts` (main agent). tsc went back
  to exit 0 and `/home` answered 200 in the dev server log. The re-export goes once `EnkiHome` no longer
  imports it.
- **Prevention:** rules 1, 2, 3 and 7. The same build also had four Studio files importing a `./studio.css`
  that did not exist yet (`check-imports`, VERIFIED). They were not served yet, but the same risk applies.

### 2026-10-30-03 (near miss, main agent): a name replaced before its callers, twice

- **What:** Twice the main agent itself broke rule 1 for a short while; no build error was reported or served.
  - Analytics move: `EnkiHome.tsx` used `STUDIO_TABS` one edit before its import line existed (seconds).
  - Submenu change: `setStudioOpen` was replaced while two callers still named it, about a minute (the preview
    server was stopped; `preview_logs`: no error).
- **Root cause:** Edits ordered by reading position in the file (declaration at the top first), not by rule 1's
  order. The gates ran after the batch, as rule 3 says, but rule 1 asks for each single edit.
- **Prevention:** Before an edit that renames or removes, write the new name and switch every caller first, and
  delete last. Within one file, put the import or declaration in before its first use.

### 2026-10-30-04: the image prompt box would not grow (layout regression, main agent)

- **What:** Kev could not drag Create > Image's prompt box taller, by the edge or the corner.
- **Root cause (VERIFIED on a bench page):** `adb0ec62` wrapped the field in a column box for its grip.
  The bar's `.ci-text { flex: 1 }`, meant for its row, then sized the field by its flex basis, so its height was
  ignored: the drag (style 200px, drawn 40) and the text's own growth (style 42px, drawn 40) both.
- **Why the checks missed it:** The unit tests and mutants check props and CSS text, not layout, and the change
  shipped without a browser look. The report said "not seen in a browser", which was true and not enough for a
  change that moves an element into another layout context.
- **Fix:** `567bf8ef`.
- **Prevention:** Before reporting a change that wraps an element or changes its layout context (a new parent,
  flex or grid direction, positioning), measure it in a bench page in the browser (scratchpad `gripbench/` is
  the pattern: the real component, the real stylesheets, served from `public/previews/__bench-*` and deleted
  after).

### Incident 05 (2026-10-31): hooks below an early return
e45aa7d4 added two `useRef` calls next to the handler that used them, below AdminPage's early returns. React reported "a change in the order of Hooks" in Kev's console. The page's tests read its handlers as source text, so they could not see it, and tsc does not check hook order.
Fixed in 3c339777 (the refs moved up with the other hooks).
Rule added: after editing a React component, run `npx eslint <file> --rule '{"react-hooks/rules-of-hooks": "error"}'` and require no rules-of-hooks error; a new hook goes with the component's other hooks, never next to the handler that uses it.
