/**
 * GET /api/auth/oauth/providers → { google, x }
 *
 * Which sign-in providers this server is configured for, so the landing and
 * Settings offer only buttons that can work. Public (the landing asks before
 * login); it says nothing but two booleans.
 */
import { NextResponse } from "next/server";
import { providerConfigured } from "@/lib/auth/oauth";

export async function GET() {
  return NextResponse.json({ google: providerConfigured("google"), x: providerConfigured("x") }, { headers: { "Cache-Control": "no-store" } });
}
