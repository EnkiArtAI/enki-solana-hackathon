import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readTrial, TRIAL_COOKIE } from "@/lib/trial-cookie";

// The whitelist stage gates the whole app while it is in private development.
// Everyone can see the public marketing landing ("/"), but /home and every other
// page requires a signed-in member (the cookie an admitted account's login sets)
// or a running trial. The gate is DISABLED automatically when TEAM_ACCESS_CODE
// is not set, so local dev stays open unless you opt in.
//
// Next.js 16 renamed the "middleware" convention to "proxy".
const COOKIE = "enki_team";

/** The unfurlers that fetch a pasted link's preview — never a browser. */
const LINK_PREVIEW_BOTS =
  /Twitterbot|facebookexternalhit|Facebot|Discordbot|Slackbot|LinkedInBot|TelegramBot|WhatsApp|Pinterestbot|redditbot|Embedly|iframely|Applebot|Googlebot|bingbot/i;

function isLinkPreviewBot(ua: string | null): boolean {
  return !!ua && LINK_PREVIEW_BOTS.test(ua);
}

function isPublic(pathname: string): boolean {
  // Public marketing landing + the gate flow itself
  if (pathname === "/" || pathname === "/landing.html") return true;
  if (pathname === "/gate") return true;
  if (pathname === "/api/gate") return true;
  // Anonymous visitors must be able to apply from the public landing
  if (pathname === "/api/access-request") return true;
  // x402 agent commerce: agents are OUTSIDERS by definition — they pay per
  // request instead of holding the team cookie. The endpoint itself answers
  // 402 (payment required) until a valid payment rides along, and the
  // .well-known manifest is the standard public discovery namespace
  // (Kev, 2026-08-23: agents shall reach our prompts via x402).
  if (pathname.startsWith("/api/x402/")) return true;
  if (pathname.startsWith("/.well-known/")) return true;
  // Social preview cards: the image X/Discord/Telegram fetch for a pasted
  // prompt link. A crawler has no cookie by definition (Kev, 2026-09-05).
  if (pathname.startsWith("/api/og/")) return true;
  // The landing mosaic feed must stay reachable for the public landing
  if (pathname === "/api/header-images") return true;
  // The wallet vendor's servers fetch our signing keys to validate external JWTs
  if (pathname === "/api/auth/wallet/jwks") return true;
  // Vercel's scheduler holds no cookie; each cron route checks CRON_SECRET.
  if (pathname.startsWith("/api/cron/")) return true;
  // Recovery flows are used by OUTSIDERS (guardians) and by locked-out users
  // — neither can have the team cookie. The pages/APIs are token- or
  // code-gated and rate-limited themselves.
  if (pathname === "/guardian" || pathname === "/reset-password") return true;
  // A banned account gets no team cookie, so its one door stays open
  // without it: the /banned page and exactly the APIs it calls (status,
  // appeal, balance, send, the way out for a lost factor, as its money sits
  // behind that factor). Each of those checks the session itself.
  if (
    pathname === "/banned" ||
    pathname === "/api/ban/me" ||
    pathname === "/api/ban/appeal" ||
    pathname === "/api/billing/balance" ||
    pathname.startsWith("/api/wallet/withdraw/") ||
    pathname === "/api/auth/mfa/recovery" ||
    pathname.startsWith("/api/auth/mfa/recovery/")
  ) {
    return true;
  }
  if (
    pathname === "/api/recovery/guardians/confirm" ||
    pathname === "/api/recovery/request" ||
    pathname === "/api/recovery/approve" ||
    pathname === "/api/recovery/complete" ||
    pathname === "/api/account/delete/approve" // guardians approving a deletion are outsiders
  ) {
    return true;
  }
  // Login must be reachable BEFORE the gate — a visitor logs in with a
  // whitelisted wallet/email and the login route itself grants access (sets the
  // gate cookie) or turns them away. Everything else stays gated.
  if (
    pathname === "/api/auth/nonce" ||
    pathname === "/api/auth/session" ||
    pathname === "/api/auth/wallet/jwt" ||
    pathname.startsWith("/api/auth/password/") ||
    // Sign in with Google or X: the provider redirects back with no cookie yet,
    // and /auth/complete is where the callback hands the session over.
    pathname.startsWith("/api/auth/oauth/") ||
    pathname === "/auth/complete" ||
    // Step-ups, public like the withdraw routes: a banned account loses its
    // gate cookie yet may still withdraw its own money, which takes a step-up
    // (each route checks the session itself).
    pathname === "/api/auth/stepup" ||
    pathname === "/api/auth/stepup/email" ||
    pathname.startsWith("/api/auth/passkey/stepup/")
  ) {
    return true;
  }
  // Framework internals + asset folders
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/header/") ||
    pathname.startsWith("/previews/") ||
    pathname.startsWith("/fonts/")
  ) {
    return true;
  }
  // Any static asset by extension (favicon, logo, css, js, fonts, media…)
  if (/\.(png|jpe?g|webp|gif|svg|ico|css|js|map|txt|woff2?|ttf|otf|mp4|webm|json)$/i.test(pathname)) {
    return true;
  }
  return false;
}

/* ENV-01: the settings .env.example marks REQUIRED, without which no API
   call can work. On an environment missing one, every /api call answers
   this sentence instead of an empty 500 from deep inside a route. Names what
   is missing, never the variable. The crons pass: they are CRON_SECRET-gated,
   and the database alarm must still mail when the database settings are what
   is missing (review, 2026-10-17). */
const REQUIRED: [string, string][] = [
  ["SUPABASE_URL", "The database"],
  ["SUPABASE_SERVICE_ROLE_KEY", "The database"],
  ["AUTH_PEPPER", "Sign-in"],
  ["FIELD_ENCRYPTION_KEY_B64", "Encryption"],
];
function notConfigured(): NextResponse | null {
  const missing = REQUIRED.find(([key]) => !process.env[key]?.trim());
  return missing ? NextResponse.json({ error: `${missing[1]} is not configured on this environment` }, { status: 503 }) : null;
}

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/") && !req.nextUrl.pathname.startsWith("/api/cron/")) {
    const refused = notConfigured();
    if (refused) return refused;
  }
  const code = process.env.TEAM_ACCESS_CODE;
  // Gate off when no code configured.
  if (!code) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  // A signed-in member: the cookie a login signed for the account, until its session ends (lib/allowlist, DEC-434).
  // The team code itself opens nothing any more: whoever knew it could set it.
  if (readTrial("member", req.cookies.get(COOKIE)?.value, process.env.AUTH_PEPPER ?? "")) return NextResponse.next();
  // A tester's trial opens the app as the member cookie does, until it ends (lib/trial).
  if (readTrial("trial", req.cookies.get(TRIAL_COOKIE)?.value, process.env.AUTH_PEPPER ?? "")) return NextResponse.next();

  /* Link-preview crawlers may READ a prompt page's <head> (og:title,
     og:image) so a pasted /generator link unfurls with its showcase images
     (Kev, 2026-09-05). They get the server-rendered shell only: the page's
     content is client-rendered behind BetaGate, which a bot never passes.
     Humans without the code are still redirected to the gate below. */
  // The same for one image's share page (SHR, Kev 2026-10-17): /i/<id>.
  if ((pathname.startsWith("/generator/") || pathname.startsWith("/i/")) && isLinkPreviewBot(req.headers.get("user-agent"))) {
    return NextResponse.next();
  }

  // For API calls, answer with 401 instead of an HTML redirect.
  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Access code required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Otherwise the landing, whose login is the way in and opens /home (Kev, 2026-10-27: signed out, the app is not
  // shown; "immer zu home pls nach landing page").
  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Run on all routes; asset/internal filtering happens in isPublic().
  matcher: ["/((?!_next/static|_next/image).*)"],
};
