import type { SupabaseClient } from "@supabase/supabase-js";
import { usableHandle } from "@/lib/handle-rules";
import type { XUser } from "@/lib/hunter/x-api";
import { FX_LIST_TRIES } from "@/lib/hunter/fx-api";

/**
 * An X author's Enki account (Kev, 2026-10-30: "dabei muss dann account fürn creator angelegt werden, damit
 * generierungen auf seinen namen ihm später guthaben generieren können"): one per X author, found and made by X's
 * numeric id (users.imported_x_id, SQL 56), never by the handle, which changes hands. Nobody signs in to it: no email,
 * password, wallet or auth_identities row. Its prompts are the author's on Enki; what their renders earn goes to the
 * author vault of that X id, or to whoever claims it by connecting that X account (lib/referral/shares.ts): the account
 * holds no wallet, so Enki never holds money for anyone (Kev: no custody). Its picture is X's, taken once when the
 * account is made (Kev, 2026-10-31: "für importierte profile bitte auch profilbilder ziehen ... nur 1x beim ersten
 * import"); without one it draws its seal, as every account without a picture does.
 */

/**
 * The account's bio: the author linked by their X id, which X resolves to whoever holds that account now, and the
 * handle as it was at the import. A link by handle sent visitors, and the invitation to claim, to whoever took the
 * handle after a rename (review 2026-10-30, F19).
 */
export const importedBio = (handle: string, xUserId: string) =>
  `Prompts by the X account https://x.com/i/user/${xUserId} (@${handle} when Enki imported them). Is this you? Connect your X account in Settings to claim what they earn.`;

export interface CreatorProfile {
  userId: string;
  handle: string | null;
}

/** The Enki handle of the account that logs in with this X account, or null: its posts are its own to publish. */
export async function onEnki(supabase: SupabaseClient, xUserId: string): Promise<string | null> {
  const { data, error } = await supabase.from("auth_identities").select("user_id").eq("provider", "x").eq("subject", xUserId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: user, error: userErr } = await supabase.from("users").select("handle").eq("id", data.user_id).maybeSingle();
  if (userErr) throw userErr;
  return typeof user?.handle === "string" && user.handle ? user.handle : "an Enki account";
}

const byXId = (supabase: SupabaseClient, xUserId: string) =>
  supabase.from("users").select("id, handle").eq("imported_x_id", xUserId).maybeSingle();
const profileOf = (row: { id: unknown; handle: unknown }): CreatorProfile => ({ userId: String(row.id), handle: (row.handle as string | null) ?? null });

const FX_PROFILE = "https://api.fxtwitter.com/2/profile/";

/**
 * X's picture of the account, or null: read for free through FxTwitter, the profile only when it is still this X id
 * (a handle changes hands), never X's default picture, and only one that loads. Not judged again: X already checks
 * profile pictures, and the image check bills (Kev, 2026-10-31: "auf x und instagram werden die bereits geprüft, von
 * daher wäre das unsinnig"). Linked where X serves it, at 400 px: pbs.twimg.com gives every picture its own address.
 */
export async function xAvatar(x: XUser, fetchFn: typeof fetch = fetch, waitMs = 1500): Promise<string | null> {
  try {
    // FxTwitter answers a profile now and 404 the next moment (live 2026-10-31: 2 in 5): asked as a timeline page is.
    let res = await fetchFn(FX_PROFILE + encodeURIComponent(x.handle));
    for (let i = 1; res.status === 404 && i < FX_LIST_TRIES; i++) {
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetchFn(FX_PROFILE + encodeURIComponent(x.handle));
    }
    const u = res.ok ? ((await res.json()) as { user?: { id?: unknown; avatar_url?: unknown } }).user : null;
    const raw = u?.id === x.id && typeof u.avatar_url === "string" ? u.avatar_url : "";
    if (!raw.startsWith("https://pbs.twimg.com/profile_images/")) return null;
    const url = raw.replace(/_normal(\.\w+)$/, "_400x400$1");
    return (await fetchFn(url, { method: "HEAD" })).ok ? url : null;
  } catch {
    return null;
  }
}

/**
 * The X author's account: the one made before for this X id, else a new one named as on X (the handle when it is a
 * usable Enki name and free, else SQL 46's trigger picks one), with X's picture when `avatar` finds one. Two Plays
 * making it at once meet on the unique X id (23505): the second reads the first's.
 */
export async function ensureCreatorProfile(supabase: SupabaseClient, x: XUser, avatar?: (x: XUser) => Promise<string | null>): Promise<CreatorProfile> {
  const found = await byXId(supabase, x.id);
  if (found.error) throw found.error;
  if (found.data) return profileOf(found.data);

  const wanted = x.handle.toLowerCase();
  let handle: string | null = null;
  if (usableHandle(wanted)) {
    const { data: taken, error } = await supabase.from("users").select("id").eq("handle", wanted).maybeSingle();
    if (error) throw error;
    if (!taken) handle = wanted;
  }
  const row = (h: string | null) => ({
    origin: "imported", imported_x_id: x.id, account_status: "active", is_creator: true,
    display_name: (x.name || x.handle).slice(0, 80), bio: importedBio(x.handle, x.id),
    // Enki picked the name, as SQL 46's trigger marks its own: the author may pick another once they hold the account.
    handle_auto: true, ...(h ? { handle: h } : {}),
  });
  let made = await supabase.from("users").insert(row(handle)).select("id, handle").single();
  if (made.error?.code === "23505") {
    const again = await byXId(supabase, x.id);
    if (again.error) throw again.error;
    if (again.data) return profileOf(again.data);
    // The handle was taken in between: SQL 46 names it instead.
    if (handle) made = await supabase.from("users").insert(row(null)).select("id, handle").single();
  }
  if (made.error || !made.data) throw made.error ?? new Error("the creator's account was not made");
  // Once, as the account is made; a picture its holder sets later is never replaced.
  const picture = avatar ? await avatar(x) : null;
  if (picture) {
    const { error } = await supabase.from("users").update({ avatar_url: picture }).eq("id", made.data.id).is("avatar_url", null);
    if (error) console.warn("[creator-profile] the picture was not saved:", error.message);
  }
  return profileOf(made.data);
}
