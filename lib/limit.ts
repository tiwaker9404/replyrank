/**
 * Tiny in-memory rate limit to protect the free AI Gateway credit on a public demo.
 * Per serverless instance only, which is fine for a demo: when the limit is hit
 * the app keeps working in rules mode instead of erroring.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_CALLS = Number(process.env.REPLYRANK_AI_CALLS_PER_10MIN ?? 20);
const hits = new Map<string, number[]>();

export function allowAi(req: Request): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_CALLS) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}
