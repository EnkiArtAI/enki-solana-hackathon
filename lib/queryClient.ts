import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

/* The start of lib/db-error.ts DB_UNAVAILABLE_MESSAGE, which reaches a query
   both inside "503: {...}" and verbatim through failureSentence. That module
   imports next/server, so the browser matches on the sentence. */
const DB_UNAVAILABLE_START = "The database is unreachable right now";

/**
 * A read that failed on the way, not on its merits: a 502/503/504, the
 * database's own 503 sentence, or a request the network dropped. A short
 * database blip is over before the second try (db-health, 2026-10-16); a
 * refusal (4xx) or a bug would fail again, so it is never tried twice.
 */
export function isTransientFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /^50[234]\b/.test(message)
    || message.includes(DB_UNAVAILABLE_START)
    || /failed to fetch|networkerror|load failed|fetch failed/i.test(message);
}

/** Reads try twice more on a transient failure, after 1 s and 3 s; writes never retry on their own. */
export const QUERY_RETRY = {
  retry: (failures: number, error: unknown) => failures < 2 && isTransientFailure(error),
  retryDelay: (failures: number) => (failures === 0 ? 1_000 : 3_000),
};


export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        // The APIs resolve the user from the session, never from the payload.
        ...sessionAuthHeaders(),
      },
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
    });

    await throwIfResNotOk(res);
    return res;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error));
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
    async ({ queryKey }) => {
      try {
        const url = queryKey[0] as string;
        const res = await fetch(url, {
          headers: viewerHeaders(),
          credentials: "include",
        });

        if (unauthorizedBehavior === "returnNull" && res.status === 401) {
          return null;
        }

        await throwIfResNotOk(res);
        return await res.json();
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(String(error));
      }
    };

