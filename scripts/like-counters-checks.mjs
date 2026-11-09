/** Offline like-counter contract checks (migrations/2026-10-15-like-counters.sql). Run: node scripts/like-counters-checks.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

export const likeCountersSql = fs.readFileSync(new URL('../migrations/2026-10-15-like-counters.sql', import.meta.url), 'utf8');
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const I1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The live shape (probed 2026-10-15), with the two likes stored before the migration. */
const LIVE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  -- Supabase grants every new function to these roles by default; the migration must take it back.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE TABLE public.users (id uuid PRIMARY KEY);
  CREATE TABLE public.prompts (id uuid PRIMARY KEY, title text);
  CREATE TABLE public.generated_images (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.reactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type text NOT NULL CONSTRAINT reactions_target_type_check CHECK (target_type IN ('prompt','comment','generated_image','review')),
    target_uuid uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    reaction_type text NOT NULL CONSTRAINT reactions_reaction_type_check CHECK (reaction_type IN ('like','bookmark')),
    created_at timestamptz NOT NULL DEFAULT now());
  INSERT INTO public.users VALUES ('${U1}'), ('${U2}');
  INSERT INTO public.prompts VALUES ('${P1}', 'one'), ('${P2}', 'two');
  INSERT INTO public.generated_images VALUES ('${I1}', '${U1}');
  INSERT INTO public.reactions (target_type, target_uuid, user_id, reaction_type) VALUES
    ('prompt', '${P1}', '${U1}', 'like'), ('prompt', '${P1}', '${U2}', 'like'), ('prompt', '${P2}', '${U1}', 'bookmark');
`;

export async function checkLikeCounters(sql = likeCountersSql) {
  const db = await PGlite.create();
  let passed = 0;
  const count = async (table, id) => (await db.query(`SELECT like_count FROM public.${table} WHERE id = $1`, [id])).rows[0].like_count;
  const like = (type, target, user, kind = 'like') =>
    db.query('INSERT INTO public.reactions (target_type, target_uuid, user_id, reaction_type) VALUES ($1,$2,$3,$4)', [type, target, user, kind]);
  const unlike = (type, target, user, kind = 'like') =>
    db.query('DELETE FROM public.reactions WHERE target_type=$1 AND target_uuid=$2 AND user_id=$3 AND reaction_type=$4', [type, target, user, kind]);
  const check = async (name, body) => { await body(); passed++; console.log(`PASS like counters: ${name}`); };
  try {
    await db.exec(LIVE);
    await db.exec(sql);

    await check('likes stored before the migration are counted once; a bookmark is not a like', async () => {
      assert.equal(await count('prompts', P1), 2);
      assert.equal(await count('prompts', P2), 0);
      assert.equal(await count('generated_images', I1), 0);
    });

    await check('a like and an unlike move the count in the same statement, for prompts and images', async () => {
      await like('generated_image', I1, U1);
      assert.equal(await count('generated_images', I1), 1);
      await like('generated_image', I1, U2);
      assert.equal(await count('generated_images', I1), 2);
      await unlike('generated_image', I1, U1);
      assert.equal(await count('generated_images', I1), 1);
      await like('prompt', P2, U2);
      assert.equal(await count('prompts', P2), 1);
    });

    await check('a second like by the same user on the same target is refused and the count stays', async () => {
      await assert.rejects(like('generated_image', I1, U2), (e) => e.code === '23505');
      assert.equal(await count('generated_images', I1), 1);
      // A bookmark beside the like is a different reaction, not a duplicate.
      await like('generated_image', I1, U2, 'bookmark');
      assert.equal(await count('generated_images', I1), 1);
    });

    await check('an update that moves a like to another target moves the count with it', async () => {
      await db.query(`UPDATE public.reactions SET target_uuid = $1 WHERE target_type='prompt' AND target_uuid = $2 AND user_id = $3 AND reaction_type='like'`, [P2, P1, U1]);
      assert.equal(await count('prompts', P1), 1);
      assert.equal(await count('prompts', P2), 2);
      // A like turned into a bookmark stops counting.
      await db.query(`UPDATE public.reactions SET reaction_type='bookmark' WHERE target_type='prompt' AND target_uuid=$1 AND user_id=$2`, [P1, U2]);
      assert.equal(await count('prompts', P1), 0);
    });

    await check('a deleted account takes its likes and their counts along', async () => {
      const before = await count('prompts', P2);
      await db.query('DELETE FROM public.users WHERE id = $1', [U2]);
      assert.equal(await count('prompts', P2), before - 1);
      assert.equal(await count('generated_images', I1), 0);
    });

    await check('the count never goes below zero, and the column refuses a negative value', async () => {
      // A count that drifted to 0 while a like still exists: the unlike stays at 0 instead of failing or going below.
      await like('generated_image', I1, U1);
      await db.query('UPDATE public.generated_images SET like_count = 0 WHERE id = $1', [I1]);
      await unlike('generated_image', I1, U1);
      assert.equal(await count('generated_images', I1), 0);
      // The same for a prompt.
      await db.query(`DELETE FROM public.reactions WHERE target_type='prompt' AND target_uuid=$1`, [P1]);
      await like('prompt', P1, U1);
      await db.query('UPDATE public.prompts SET like_count = 0 WHERE id = $1', [P1]);
      await unlike('prompt', P1, U1);
      assert.equal(await count('prompts', P1), 0);
      await assert.rejects(db.query('UPDATE public.prompts SET like_count = -1 WHERE id = $1', [P1]), (e) => e.code === '23514');
    });

    await check('running the migration again changes nothing and keeps one trigger', async () => {
      const before = [await count('prompts', P1), await count('prompts', P2)];
      await db.exec(sql);
      assert.deepEqual([await count('prompts', P1), await count('prompts', P2)], before);
      await like('prompt', P1, U1);
      assert.equal(await count('prompts', P1), before[0] + 1);
      const triggers = (await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'reactions_like_count'`)).rows[0].n;
      assert.equal(triggers, 1);
    });

    await check('nobody can call the trigger function directly', async () => {
      const grants = (await db.query(`SELECT has_function_privilege('anon', 'public.reactions_like_count()', 'EXECUTE') AS a,
        has_function_privilege('authenticated', 'public.reactions_like_count()', 'EXECUTE') AS b`)).rows[0];
      assert.deepEqual(grants, { a: false, b: false });
    });
  } finally {
    await db.close();
  }
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = await checkLikeCounters();
  console.log(`PASS ${n} like-counter checks; live database was not used.`);
}
