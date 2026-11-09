import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A Postgres-shaped fake for the payment tests: it applies every filter to the
 * rows, as PostgREST would, so a guard that lives in a filter can fail its
 * test (review round 4, 2026-10-19: a fake that ignored filters let the
 * sweep's live-unit guard go untested). An UPDATE matching nothing yields null
 * without an error; an INSERT whose id exists is refused as a duplicate key
 * (23505). A read returns only the columns it selected, so a column the code
 * reads but forgot to select fails its test (round 5, 2026-10-20). An
 * operator it does not know throws rather than matching all.
 */
export type Row = Record<string, any>;

/** Split on top-level commas, so and(...) and in.(...) groups survive intact. */
function splitClauses(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") depth--;
    else if (expr[i] === "," && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out;
}

function clauseToPredicate(clause: string): (r: Row) => boolean {
  // [\s\S] rather than the dotAll flag — the build target predates es2018.
  const and = clause.match(/^and\(([\s\S]*)\)$/);
  if (and) {
    const inner = splitClauses(and[1]).map(clauseToPredicate);
    return (r) => inner.every((p) => p(r));
  }
  const [col, ...parts] = clause.split(".");
  const negated = parts[0] === "not";
  const [op, ...rest] = negated ? parts.slice(1) : parts;
  const value = rest.join(".");
  let test: (r: Row) => boolean;
  if (op === "is" && value === "null") test = (r) => (r[col] ?? null) === null;
  else if (op === "lt") test = (r) => r[col] != null && String(r[col]) < value;
  else if (op === "in") {
    const list = value.replace(/^\(|\)$/g, "").split(",");
    test = (r) => list.includes(String(r[col]));
  } else throw new Error(`fake: unsupported or() clause "${clause}"`);
  return negated ? (r) => !test(r) : test;
}

export class Builder implements PromiseLike<{ data: any; error: any; count?: number | null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private patch: Row | null = null;
  private inserted: Row[] | null = null;
  private cap = Infinity;
  private offset = 0;
  private single = false;
  private head = false;
  private cols: string[] | null = null;
  private sort: { col: string; ascending: boolean } | null = null;

  constructor(private rows: Row[]) {}

  update(patch: Row) {
    this.patch = patch;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.inserted = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  select(cols?: string, opts?: { head?: boolean }) {
    this.head = Boolean(opts?.head);
    this.cols = cols && cols.trim() !== "*" ? cols.split(",").map((c) => c.trim()) : null;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  is(col: string, v: unknown) {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op !== "is") throw new Error(`fake: unsupported not(${op})`);
    this.filters.push((r) => (r[col] ?? null) !== v);
    return this;
  }
  lt(col: string, v: string) {
    this.filters.push((r) => r[col] != null && String(r[col]) < v);
    return this;
  }
  gte(col: string, v: string) {
    this.filters.push((r) => r[col] != null && String(r[col]) >= v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  or(expr: string) {
    const preds = splitClauses(expr).map(clauseToPredicate);
    this.filters.push((r) => preds.some((p) => p(r)));
    return this;
  }
  order(col: string, { ascending = true }: { ascending?: boolean } = {}) {
    this.sort = { col, ascending };
    return this;
  }
  limit(n: number) {
    this.cap = n;
    return this;
  }
  range(from: number, to: number) {
    this.offset = from;
    this.cap = to - from + 1;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private run(): { data: any; error: any; count?: number | null } {
    if (this.inserted) {
      if (this.inserted.some((r) => r.id !== undefined && this.rows.some((x) => x.id === r.id))) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      this.rows.push(...this.inserted.map((r) => ({ ...r })));
      return { data: null, error: null };
    }
    let matched = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.sort) {
      const { col, ascending } = this.sort;
      matched = [...matched].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (ascending ? 1 : -1));
    }
    matched = matched.slice(this.offset, this.offset + this.cap);
    if (this.patch) for (const r of matched) Object.assign(r, this.patch);
    if (this.head) return { data: null, error: null, count: matched.length };
    const shown = this.cols ? matched.map((r) => Object.fromEntries(this.cols!.map((c) => [c, r[c] ?? null]))) : matched;
    return { data: this.single ? (shown[0] ?? null) : shown, error: null };
  }

  then<A, B>(
    onfulfilled?: ((v: { data: any; error: any; count?: number | null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

/** One table's rows for every table, or a map of tables (a missing one starts empty). */
export function fakeClient(rows: Row[] | Record<string, Row[]>): SupabaseClient {
  const table = (name: string) => {
    if (Array.isArray(rows)) return rows;
    return (rows[name] ??= []);
  };
  return { from: (name: string) => new Builder(table(name)) } as unknown as SupabaseClient;
}
