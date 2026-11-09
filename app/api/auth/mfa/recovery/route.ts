/**
 * GET /api/auth/mfa/recovery -> { available, codesLeft, addresses, mailRefused, guardians }
 *
 * What Settings' Recovery area shows (components/settings/RecoveryCodes.tsx). available is false until SQL 74 ran.
 * lib/mfa-recovery.ts recoveryStatus.
 */
import { NextResponse } from "next/server";
import { recoveryRoute, recoveryStatus } from "@/lib/mfa-recovery";

export const GET = recoveryRoute("status", async (_req, supabase, userId) => NextResponse.json(await recoveryStatus(supabase, userId)));
