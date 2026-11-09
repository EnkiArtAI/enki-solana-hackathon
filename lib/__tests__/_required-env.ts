import { vi } from "vitest";

/**
 * The settings proxy.ts requires for every /api call (ENV-01), as dummies
 * for tests that run the proxy. vi.unstubAllEnvs() puts the real ones back.
 */
export function stubRequiredEnv(): void {
  vi.stubEnv("SUPABASE_URL", process.env.SUPABASE_URL || "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role");
  vi.stubEnv("AUTH_PEPPER", process.env.AUTH_PEPPER || Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("FIELD_ENCRYPTION_KEY_B64", process.env.FIELD_ENCRYPTION_KEY_B64 || Buffer.alloc(32, 9).toString("base64"));
}
