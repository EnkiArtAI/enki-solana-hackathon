import type { PGlite } from "@electric-sql/pglite";

/**
 * A stand-in for the service-role supabase-js client over a real Postgres (PGlite): the query-builder calls the
 * Communities routes and the feed's Community filter make, turned into SQL, so a route meets a migration's real tables,
 * views, triggers and functions instead of a double's guess at them. Covered: select (columns, `*`, one level of embeds
 * `name(cols)` / `name!inner(cols)` found by their foreign key), insert / upsert (onConflict, ignoreDuplicates) / update /
 * delete with or without `.select()`,
 * eq neq gt gte lt lte like ilike is in not or overlaps (also on an embed's columns: "embed.col"), order, range, limit,
 * single, maybeSingle, count "exact" (head or not), and rpc (a set or a scalar). Answers as postgrest-js 2.103.3 does:
 * { data, error: { code, message, details, hint }, count, status }; a missing table is PGRST205 (a head read: no error and
 * no count, dist/index.cjs:384-386), a missing function PGRST202, no row for single() PGRST116. Not PostgREST: no schema
 * cache, no RLS (the service role has none), no column aliases, no JSON paths, an embed's own order and limit not taken.
 */
type Row = Record<string, unknown>;
type PgError = { code: string; message: string; details: string | null; hint: string | null };
type Answer = { data: unknown; error: PgError | null; count: number | null; status: number; statusText: string };
type Param = (v: unknown) => string;
type Filter = { embed: string | null; sql: (p: Param, at: string) => string };
type Fk = { from_table: string; from_col: string; to_table: string; to_col: string };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" };

/** Postgres values as PostgREST's JSON has them: a time as ISO text, an int8 as a number. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(plain);
  return v;
}
const plainRow = (r: Row) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]));

/** Splits at commas outside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** One operator over a column: what PostgREST's `col=op.value` reads as. */
function condition(col: string, op: string, value: unknown, p: Param): string {
  if (op === "is") return `${col} IS ${value === null || value === "null" ? "NULL" : value === true || value === "true" ? "TRUE" : "FALSE"}`;
  if (op === "in") {
    const list = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, "").split(",").filter((x) => x !== "");
    return list.length ? `${col} IN (${list.map(p).join(", ")})` : "FALSE";
  }
  if (op === "ov") return `${col} && ${p(value)}`;
  if (!OPS[op]) throw new Error(`pglite-postgrest: operator ${op}`);
  // PostgREST reads * in a like pattern as %.
  return `${col} ${OPS[op]} ${p(op === "like" || op === "ilike" ? String(value).replace(/\*/g, "%") : value)}`;
}

export function pglitePostgrest(db: PGlite) {
  const state = { unreachable: false, statements: [] as string[] };
  let fks: Promise<Fk[]> | null = null;
  const foreignKeys = () => (fks ??= db.query<Fk>(`
    select cr.relname as from_table, a.attname as from_col, tr.relname as to_table, af.attname as to_col
      from pg_constraint c
      join pg_class cr on cr.oid = c.conrelid join pg_class tr on tr.oid = c.confrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
     where c.contype = 'f' and cardinality(c.conkey) = 1`).then((r) => r.rows));

  const failure = (e: unknown): PgError => {
    const x = e as { code?: string; message?: string; detail?: string; hint?: string };
    return { code: x.code ?? "", message: x.message ?? String(e), details: x.detail ?? null, hint: x.hint ?? null };
  };
  const down = (): Answer => ({ data: null, error: { code: "", message: "TypeError: fetch failed", details: null, hint: null }, count: null, status: 0, statusText: "" });

  class Query implements PromiseLike<Answer> {
    private op: "select" | "insert" | "update" | "delete" = "select";
    private columns: string | null = "*";
    private returning = false;
    private rows: Row[] = [];
    private conflict: { on: string; ignore: boolean } | null = null;
    private values: Row = {};
    private filters: Filter[] = [];
    private orders: string[] = [];
    private cap: number | null = null;
    private skip = 0;
    private one: "single" | "maybe" | null = null;
    private counted = false;
    private head = false;
    constructor(private table: string) {}

    select(columns = "*", opts?: { count?: "exact"; head?: boolean }) {
      if (this.op === "select") {
        this.columns = columns;
        this.counted = opts?.count === "exact";
        this.head = !!opts?.head;
      } else {
        this.returning = true;
        this.columns = columns;
      }
      return this;
    }
    insert(values: Row | Row[]) { this.op = "insert"; this.rows = [values].flat(); this.columns = null; return this; }
    upsert(values: Row | Row[], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
      this.insert(values);
      this.conflict = { on: o.onConflict ?? "id", ignore: !!o.ignoreDuplicates };
      return this;
    }
    update(values: Row) { this.op = "update"; this.values = values; this.columns = null; return this; }
    delete() { this.op = "delete"; this.columns = null; return this; }

    private where(column: string, sql: (col: string, p: Param) => string) {
      const dot = column.indexOf(".");
      const embed = dot > 0 ? column.slice(0, dot) : null;
      const col = dot > 0 ? column.slice(dot + 1) : column;
      this.filters.push({ embed, sql: (p, at) => sql(`${at}.${q(col)}`, p) });
      return this;
    }
    eq(c: string, v: unknown) { return this.where(c, (col, p) => condition(col, "eq", v, p)); }
    neq(c: string, v: unknown) { return this.where(c, (col, p) => condition(col, "neq", v, p)); }
    gt(c: string, v: unknown) { return this.where(c, (col, p) => condition(col, "gt", v, p)); }
    gte(c: string, v: unknown) { return this.where(c, (col, p) => condition(col, "gte", v, p)); }
    lt(c: string, v: unknown) { return this.where(c, (col, p) => condition(col, "lt", v, p)); }
    lte(c: string, v: unknown) { return this.where(c, (col, p) => condition(col, "lte", v, p)); }
    like(c: string, v: string) { return this.where(c, (col, p) => condition(col, "like", v, p)); }
    ilike(c: string, v: string) { return this.where(c, (col, p) => condition(col, "ilike", v, p)); }
    is(c: string, v: unknown) { return this.where(c, (col, p) => condition(col, "is", v, p)); }
    in(c: string, vs: unknown[]) { return this.where(c, (col, p) => condition(col, "in", vs, p)); }
    filter(c: string, op: string, v: unknown) { return this.where(c, (col, p) => condition(col, op, v, p)); }
    overlaps(c: string, vs: unknown[]) { return this.where(c, (col, p) => condition(col, "ov", vs, p)); }
    not(c: string, op: string, v: unknown) {
      return this.where(c, (col, p) => (op === "is" ? condition(col, "is", v, p).replace(" IS ", " IS NOT ") : `NOT (${condition(col, op, v, p)})`));
    }
    /** "a.eq.1,b.is.null,and(c.lt.2,d.is.null)": the branches PostgREST's or= takes, an and() among them. */
    or(expr: string) {
      const branch = (b: string, p: Param, at: string): string => {
        const all = /^and\((.*)\)$/.exec(b);
        if (all) return `(${splitTop(all[1]).map((x) => branch(x, p, at)).join(" AND ")})`;
        const [col, op, ...rest] = b.split(".");
        return condition(`${at}.${q(col)}`, op, rest.join("."), p);
      };
      this.filters.push({ embed: null, sql: (p, at) => `(${splitTop(expr).map((b) => branch(b, p, at)).join(" OR ")})` });
      return this;
    }
    order(c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
      const nulls = o?.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
      this.orders.push(`t.${q(c)} ${o?.ascending === false ? "DESC" : "ASC"}${nulls}`);
      return this;
    }
    limit(n: number) { this.cap = n; return this; }
    range(from: number, to: number) { this.skip = from; this.cap = to - from + 1; return this; }
    single() { this.one = "single"; return this; }
    maybeSingle() { this.one = "maybe"; return this; }

    then<A = Answer, B = never>(ok?: ((v: Answer) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
      return this.run().then(ok, ko);
    }

    private async selectList(p: Param): Promise<{ list: string; inner: string[] }> {
      const inner: string[] = [];
      if (this.columns === null) return { list: "t.*", inner };
      const parts = splitTop(this.columns);
      const list: string[] = [];
      for (const part of parts) {
        const embed = /^(\w+)(!inner)?\(([^]*)\)$/.exec(part);
        if (!embed) {
          list.push(part === "*" ? "t.*" : `t.${q(part)}`);
          continue;
        }
        const [, name, isInner, cols] = embed;
        const all = await foreignKeys();
        const many = all.filter((f) => f.from_table === name && f.to_table === this.table);
        const toOne = all.filter((f) => f.from_table === this.table && f.to_table === name);
        if (many.length + toOne.length !== 1) throw new Error(`pglite-postgrest: no single relationship ${this.table} -> ${name}`);
        const join = many.length ? `e.${q(many[0].from_col)} = t.${q(many[0].to_col)}` : `e.${q(toOne[0].to_col)} = t.${q(toOne[0].from_col)}`;
        const own = this.filters.filter((f) => f.embed === name).map((f) => f.sql(p, "e"));
        const where = [join, ...own].join(" AND ");
        const shape = cols.trim() === "*" ? "to_json(e)" : `json_build_object(${splitTop(cols).map((c) => `'${c}', e.${q(c)}`).join(", ")})`;
        list.push(many.length
          ? `coalesce((SELECT json_agg(${shape}) FROM public.${q(name)} e WHERE ${where}), '[]'::json) AS ${q(name)}`
          : `(SELECT ${shape} FROM public.${q(name)} e WHERE ${where} LIMIT 1) AS ${q(name)}`);
        if (isInner) inner.push(`EXISTS (SELECT 1 FROM public.${q(name)} e WHERE ${where})`);
      }
      return { list: list.join(", "), inner };
    }

    /** The statement, with its own parameters: the rows, or (for count "exact") how many match. */
    private async compose(counting: boolean): Promise<{ sql: string; params: unknown[] }> {
      const params: unknown[] = [];
      const p: Param = (v) => { params.push(v); return `$${params.length}`; };
      const target = `public.${q(this.table)} AS t`;
      const back = async () => (this.returning ? ` RETURNING ${(await this.selectList(p)).list}` : "");
      const where = (more: string[] = []) => {
        const all = [...this.filters.filter((f) => f.embed === null).map((f) => f.sql(p, "t")), ...more];
        return all.length ? ` WHERE ${all.join(" AND ")}` : "";
      };
      if (this.op === "insert") {
        const cols = [...new Set(this.rows.flatMap((r) => Object.keys(r)))];
        const tuples = this.rows.map((r) => `(${cols.map((c) => (c in r ? p(r[c]) : "DEFAULT")).join(", ")})`);
        const on = this.conflict
          ? ` ON CONFLICT (${this.conflict.on.split(",").map((c) => q(c.trim())).join(", ")}) ${this.conflict.ignore ? "DO NOTHING" : `DO UPDATE SET ${cols.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}`}`
          : "";
        return { sql: `INSERT INTO ${target} (${cols.map(q).join(", ")}) VALUES ${tuples.join(", ")}${on}${await back()}`, params };
      }
      if (this.op === "update") {
        const set = Object.entries(this.values).map(([c, v]) => `${q(c)} = ${p(v)}`).join(", ");
        return { sql: `UPDATE ${target} SET ${set}${where()}${await back()}`, params };
      }
      if (this.op === "delete") return { sql: `DELETE FROM ${target}${where()}${await back()}`, params };
      const { list, inner } = await this.selectList(p);
      if (counting) return { sql: `SELECT count(*)::int AS n FROM ${target}${where(inner)}`, params };
      const order = this.orders.length ? ` ORDER BY ${this.orders.join(", ")}` : "";
      return { sql: `SELECT ${list} FROM ${target}${where(inner)}${order}${this.cap !== null ? ` LIMIT ${this.cap}` : ""}${this.skip ? ` OFFSET ${this.skip}` : ""}`, params };
    }

    private async run(): Promise<Answer> {
      if (state.unreachable) return down();
      try {
        const main = await this.compose(false);
        state.statements.push(main.sql);
        const rows = this.head ? [] : (await db.query<Row>(main.sql, main.params)).rows.map(plainRow);
        let count: number | null = null;
        if (this.counted) {
          const c = await this.compose(true);
          count = (await db.query<{ n: number }>(c.sql, c.params)).rows[0].n;
        }
        if (this.one) {
          if (rows.length > 1 || (rows.length === 0 && this.one === "single")) {
            return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null }, count: null, status: 406, statusText: "Not Acceptable" };
          }
          return { data: rows[0] ?? null, error: null, count, status: 200, statusText: "OK" };
        }
        const data = this.head || !(this.op === "select" || this.returning) ? null : rows;
        return { data, error: null, count, status: this.op === "insert" ? 201 : 200, statusText: "OK" };
      } catch (e) {
        const error = failure(e);
        if (error.code === "42P01") {
          if (this.head) return { data: null, error: null, count: null, status: 204, statusText: "No Content" };
          return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}' in the schema cache`, details: null, hint: null }, count: null, status: 404, statusText: "Not Found" };
        }
        return { data: null, error, count: null, status: 400, statusText: "Bad Request" };
      }
    }
  }

  async function rpc(fn: string, args: Row = {}): Promise<Answer> {
    if (state.unreachable) return down();
    const info = (await db.query<{ set: boolean }>(`select proretset as set from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn])).rows[0];
    if (!info) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache`, details: null, hint: null }, count: null, status: 404, statusText: "Not Found" };
    const names = Object.keys(args);
    const call = `public.${q(fn)}(${names.map((n, i) => `${q(n)} => $${i + 1}`).join(", ")})`;
    const sql = info.set ? `SELECT * FROM ${call}` : `SELECT ${call} AS r`;
    state.statements.push(sql);
    try {
      const rows = (await db.query<Row>(sql, names.map((n) => args[n]))).rows.map(plainRow);
      return { data: info.set ? rows : rows[0]?.r ?? null, error: null, count: null, status: 200, statusText: "OK" };
    } catch (e) {
      return { data: null, error: failure(e), count: null, status: 400, statusText: "Bad Request" };
    }
  }

  return { state, client: { from: (table: string) => new Query(table), rpc } };
}
