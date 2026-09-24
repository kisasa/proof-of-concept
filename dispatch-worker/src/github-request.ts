/**
 * Shared GitHub REST client for this package's activities — extracted from
 * `create-story-branch.ts` once a second and third activity
 * (`find-pull-request.ts`, `await-pull-request-outcome.ts`) needed the exact
 * same raw-fetch shape. Mirrors `tracker.ts`'s own reasoning for existing as
 * its own small module rather than being reinvented per activity.
 */

export const GITHUB_API_URL = "https://api.github.com";

export async function githubRequest<T>(
  githubToken: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${GITHUB_API_URL}${path}`, {
    method: method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T;
  return { status: res.status, json: json };
}

export function isClientError(status: number): boolean {
  return status >= 400 && status < 500;
}
