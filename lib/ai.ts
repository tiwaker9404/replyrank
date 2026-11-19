import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { Lead, LeadScore, Strategy } from "./types";

/**
 * All model calls go through Vercel AI Gateway using plain "provider/model" ids.
 * On a Vercel deployment the Gateway authenticates with the project's OIDC token
 * automatically, so no API key is needed. Locally, set AI_GATEWAY_API_KEY.
 */
export const MODEL = process.env.REPLYRANK_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
const FALLBACKS = (process.env.REPLYRANK_FALLBACK_MODELS ?? "inception/mercury-3,tencent/hy4-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function aiEnabled() {
  if (process.env.REPLYRANK_MODE === "rules") return false;
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN);
}

const gatewayOptions = { gateway: { models: FALLBACKS, tags: ["replyrank"] } };

const CATEGORIES = ["sales-ready", "nurture", "support", "not-a-lead", "spam"] as const;
type Cat = (typeof CATEGORIES)[number];

/* Models don't always follow the schema's exact field names. These helpers accept the
   common variants (fit_score, fitScore, reason, "Sales Ready"...) instead of failing. */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const norm = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");

function pick(o: Obj, names: string[]): unknown {
  const wanted = names.map(norm);
  for (const [k, v] of Object.entries(o)) if (wanted.includes(norm(k))) return v;
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return undefined;
  const scaled = n > 0 && n <= 1 ? n * 100 : n > 1 && n <= 10 && Number.isInteger(n) ? n * 10 : n;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function category(v: unknown): Cat | undefined {
  if (typeof v !== "string") return undefined;
  const c = v.toLowerCase().replace(/[_\s]+/g, "-");
  if ((CATEGORIES as readonly string[]).includes(c)) return c as Cat;
  if (/sales|hot|qualified|ready|high/.test(c)) return "sales-ready";
  if (/spam|vendor|junk/.test(c)) return "spam";
  if (/support|bug|issue/.test(c)) return "support";
  if (/not|job|student|career|recruit|irrelevant/.test(c)) return "not-a-lead";
  if (/nurture|warm|low|later|medium/.test(c)) return "nurture";
  return undefined;
}

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").slice(0, 3);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** Find the array of items whether the model wrapped it in {leads: [...]}, another key, or sent it bare. */
function itemsOf(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isObj(raw)) return [];
  const direct = pick(raw, keys);
  if (Array.isArray(direct)) return direct;
  const anyArray = Object.values(raw).find(Array.isArray);
  return anyArray ?? [];
}

const aiLead = z.object({
  id: z.string(),
  fit: z.number().optional(),
  intent: z.number().optional(),
  urgency: z.number().optional(),
  category: z.enum(CATEGORIES).optional(),
  reasons: z.array(z.string()),
  route: z.string().optional(),
});
export type AiLead = z.infer<typeof aiLead>;

const leadSchema = z.preprocess(
  (raw) => ({
    leads: itemsOf(raw, ["leads", "results", "emails", "items"]).filter(isObj).map((o) => ({
      id: String(pick(o, ["id", "leadId", "emailId"]) ?? ""),
      fit: num(pick(o, ["fit", "fit_score", "fitScore", "icp_fit"])),
      intent: num(pick(o, ["intent", "intent_score", "intentScore", "buying_intent"])),
      urgency: num(pick(o, ["urgency", "urgency_score", "urgencyScore"])),
      category: category(pick(o, ["category", "label", "classification", "type"])),
      reasons: strings(pick(o, ["reasons", "reason", "rationale", "why"])),
      route: (() => { const r = pick(o, ["route", "next_step", "nextStep", "owner"]); return typeof r === "string" ? r : undefined; })(),
    })),
  }),
  z.object({ leads: z.array(aiLead) }),
);

const SYSTEM_TRIAGE = `You triage inbound emails for a Technical BDR on Vercel's commercial sales team.
Vercel is agentic infrastructure for web apps and AI agents (Next.js, v0, AI SDK, AI Gateway, hosting).
Score each email 0-100 on fit, intent and urgency. Be calibrated: hobbyists and students score low on fit;
existing customers with a broken build are "support"; recruiting, student and job requests are "not-a-lead";
vendor pitches are "spam". Reasons must cite specifics from the email (numbers, tools, dates), max 12 words each.
Return JSON exactly in this shape, with these exact keys:
{"leads":[{"id":"s1","fit":80,"intent":90,"urgency":60,"category":"sales-ready","reasons":["..."],"route":"Book with Commercial AE"}]}
category is one of: sales-ready, nurture, support, not-a-lead, spam.`;

export async function aiScoreLeads(leads: Lead[], model: LanguageModel = MODEL) {
  const payload = leads.map((l) => ({
    id: l.id,
    from: `${l.fromName} <${l.fromEmail}>`,
    title: l.title ?? null,
    company: l.company ?? null,
    subject: l.subject,
    body: l.body.slice(0, 1500),
  }));
  const { output } = await generateText({
    model,
    system: SYSTEM_TRIAGE,
    prompt: `Triage these inbound emails:\n${JSON.stringify(payload, null, 1)}`,
    output: Output.object({ schema: leadSchema }),
    providerOptions: gatewayOptions,
    temperature: 0,
    maxRetries: 1,
    timeout: 25000,
  });
  const byId = new Map(output.leads.filter((l) => l.id).map((l) => [l.id, l]));
  return byId;
}

export function blendLeadScore(rules: LeadScore, raw: AiLead | undefined): LeadScore {
  if (!raw) return rules;
  // Any field the model left out falls back to the rules value.
  const ai = {
    fit: raw.fit ?? rules.fit,
    intent: raw.intent ?? rules.intent,
    urgency: raw.urgency ?? rules.urgency,
    category: raw.category ?? rules.category,
    reasons: raw.reasons,
    route: raw.route ?? rules.route,
  };
  // Hard gates from rules (spam / not-a-lead) are cheap, precise and stay in force.
  if (rules.category === "spam" || rules.category === "not-a-lead") return rules;
  const aiComposite = 0.4 * ai.intent + 0.35 * ai.fit + 0.25 * ai.urgency;
  let score = Math.round(0.6 * aiComposite + 0.4 * rules.score);
  if (ai.category === "support" || ai.category === "not-a-lead" || ai.category === "spam") score = Math.min(score, 45);
  return {
    score,
    fit: Math.round(0.6 * ai.fit + 0.4 * rules.fit),
    intent: Math.round(0.6 * ai.intent + 0.4 * rules.intent),
    urgency: Math.round(0.6 * ai.urgency + 0.4 * rules.urgency),
    category: ai.category,
    reasons: [...ai.reasons, ...rules.reasons.filter((r) => !ai.reasons.includes(r))].slice(0, 5),
    route: ai.route,
    source: "blend",
  };
}

/* ---------------------------- Drafting ---------------------------- */

const STRATEGIES = ["meeting-ask", "discovery-question", "proof-led"] as const;

function strategy(v: unknown, i: number): (typeof STRATEGIES)[number] {
  const c = typeof v === "string" ? v.toLowerCase() : "";
  if (/meet|call|book|calendar/.test(c)) return "meeting-ask";
  if (/discover|question|qualif/.test(c)) return "discovery-question";
  if (/proof|case|social|value/.test(c)) return "proof-led";
  return STRATEGIES[i % 3];
}

const draftSchema = z.preprocess(
  (raw) => {
    const used = new Set<string>();
    const drafts = itemsOf(raw, ["drafts", "replies", "emails", "options"]).filter(isObj).slice(0, 3).map((o, i) => {
      let st = strategy(pick(o, ["strategy", "type", "approach", "style"]), i);
      if (used.has(st)) st = STRATEGIES.find((x) => !used.has(x)) ?? st;
      used.add(st);
      const body = pick(o, ["body", "text", "email", "reply", "message", "content"]);
      const subject = pick(o, ["subject", "subjectLine", "title"]);
      return { strategy: st, subject: typeof subject === "string" ? subject : "", body: typeof body === "string" ? body : "" };
    });
    return { drafts: drafts.filter((d) => d.body.trim()) };
  },
  z.object({
    drafts: z.array(z.object({ strategy: z.enum(STRATEGIES), subject: z.string(), body: z.string() })).min(1),
  }),
);

const SYSTEM_DRAFT = (sender: string) => `You are ${sender}, a Technical BDR at Vercel replying to an inbound email.
Write exactly three replies, one per strategy:
- meeting-ask: propose a specific 30-minute meeting with an AE/solutions engineer and two time options.
- discovery-question: ask the single most useful qualifying question before booking.
- proof-led: one concrete, relevant proof point (a pattern or feature, never invented customer numbers), then a small ask.
Rules for every reply: 50-110 words, greet them by first name, reference at least two specifics from their email,
end with exactly one question, plain human tone, no filler ("hope this finds you well", "touch base", "leverage"),
no invented facts about the prospect, sign off as ${sender}.
Return JSON exactly in this shape:
{"drafts":[{"strategy":"meeting-ask","subject":"Re: ...","body":"..."},{"strategy":"discovery-question","subject":"...","body":"..."},{"strategy":"proof-led","subject":"...","body":"..."}]}`;

export async function aiDrafts(lead: Lead, sender: string, model: LanguageModel = MODEL) {
  const { output } = await generateText({
    model,
    system: SYSTEM_DRAFT(sender),
    prompt: `Inbound email:\nFrom: ${lead.fromName} <${lead.fromEmail}>\nTitle: ${lead.title ?? "unknown"}\nCompany: ${lead.company ?? "unknown"}\nSubject: ${lead.subject}\n\n${lead.body.slice(0, 2500)}`,
    output: Output.object({ schema: draftSchema }),
    providerOptions: gatewayOptions,
    temperature: 0.7,
    maxRetries: 1,
    timeout: 25000,
  });
  return output.drafts.map((d) => ({ ...d, subject: d.subject || `Re: ${lead.subject.replace(/^(re:\s*)+/i, "")}` })) as Array<{
    strategy: Strategy;
    subject: string;
    body: string;
  }>;
}

const judgeSchema = z.preprocess(
  (raw) => ({
    scores: itemsOf(raw, ["scores", "ratings", "results", "drafts"]).filter(isObj).map((o, i) => ({
      strategy: strategy(pick(o, ["strategy", "type", "approach", "draft"]), i),
      replyLikelihood: num(pick(o, ["replyLikelihood", "reply_likelihood", "likelihood", "score", "probability"])),
      reason: (() => { const r = pick(o, ["reason", "rationale", "why", "explanation"]); return typeof r === "string" ? r : ""; })(),
    })),
  }),
  z.object({
    scores: z.array(z.object({ strategy: z.enum(STRATEGIES), replyLikelihood: z.number().optional(), reason: z.string() })),
  }),
);

/** A separate call judges the drafts, so the writer is not grading itself. */
export async function aiJudge(lead: Lead, drafts: Array<{ strategy: Strategy; body: string }>, model: LanguageModel = MODEL) {
  const { output } = await generateText({
    model,
    system: `You are a demanding sales development manager. Given an inbound email and three candidate replies,
estimate for each how likely the prospect is to reply positively (0-100). Reward relevance to what they actually asked,
specificity, brevity and an easy next step. Penalize generic copy, pushiness for low-intent leads, and invented facts.
Return JSON exactly in this shape:
{"scores":[{"strategy":"meeting-ask","replyLikelihood":70,"reason":"..."},{"strategy":"discovery-question","replyLikelihood":55,"reason":"..."},{"strategy":"proof-led","replyLikelihood":60,"reason":"..."}]}`,
    prompt: `Inbound email (subject: ${lead.subject}):\n${lead.body.slice(0, 2000)}\n\nCandidates:\n${drafts
      .map((d) => `[${d.strategy}]\n${d.body}`)
      .join("\n\n")}`,
    output: Output.object({ schema: judgeSchema }),
    providerOptions: gatewayOptions,
    temperature: 0,
    maxRetries: 1,
    timeout: 20000,
  });
  return new Map(output.scores.map((s) => [s.strategy, s]));
}
