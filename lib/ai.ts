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

const leadSchema = z.object({
  leads: z.array(
    z.object({
      id: z.string(),
      fit: z.number().min(0).max(100).describe("ICP fit: company size, seniority, business domain, relevant stack"),
      intent: z.number().min(0).max(100).describe("Buying intent: demo, pricing, migration, enterprise needs"),
      urgency: z.number().min(0).max(100).describe("Time pressure: deadlines, launches, outages, renewals"),
      category: z.enum(CATEGORIES),
      reasons: z.array(z.string()).max(3).describe("Short, specific reasons quoting details from the email"),
      route: z.string().describe("Who should own the reply, e.g. 'Book with Commercial AE'"),
    }),
  ),
});

const SYSTEM_TRIAGE = `You triage inbound emails for a Technical BDR on Vercel's commercial sales team.
Vercel is agentic infrastructure for web apps and AI agents (Next.js, v0, AI SDK, AI Gateway, hosting).
Score each email 0-100 on fit, intent and urgency. Be calibrated: hobbyists and students score low on fit;
existing customers with a broken build are "support"; recruiting, student and job requests are "not-a-lead";
vendor pitches are "spam". Reasons must cite specifics from the email (numbers, tools, dates), max 12 words each.`;

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
  const byId = new Map(output.leads.map((l) => [l.id, l]));
  return byId;
}

export function blendLeadScore(rules: LeadScore, ai: z.infer<typeof leadSchema>["leads"][number] | undefined): LeadScore {
  if (!ai) return rules;
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

const draftSchema = z.object({
  drafts: z
    .array(
      z.object({
        strategy: z.enum(["meeting-ask", "discovery-question", "proof-led"]),
        subject: z.string(),
        body: z.string(),
      }),
    )
    .length(3),
});

const SYSTEM_DRAFT = (sender: string) => `You are ${sender}, a Technical BDR at Vercel replying to an inbound email.
Write exactly three replies, one per strategy:
- meeting-ask: propose a specific 30-minute meeting with an AE/solutions engineer and two time options.
- discovery-question: ask the single most useful qualifying question before booking.
- proof-led: one concrete, relevant proof point (a pattern or feature, never invented customer numbers), then a small ask.
Rules for every reply: 50-110 words, greet them by first name, reference at least two specifics from their email,
end with exactly one question, plain human tone, no filler ("hope this finds you well", "touch base", "leverage"),
no invented facts about the prospect, sign off as ${sender}.`;

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
  return output.drafts as Array<{ strategy: Strategy; subject: string; body: string }>;
}

const judgeSchema = z.object({
  scores: z.array(
    z.object({
      strategy: z.enum(["meeting-ask", "discovery-question", "proof-led"]),
      replyLikelihood: z.number().min(0).max(100).describe("How likely this prospect is to reply positively"),
      reason: z.string().describe("One sentence, max 20 words"),
    }),
  ),
});

/** A separate call judges the drafts, so the writer is not grading itself. */
export async function aiJudge(lead: Lead, drafts: Array<{ strategy: Strategy; body: string }>, model: LanguageModel = MODEL) {
  const { output } = await generateText({
    model,
    system: `You are a demanding sales development manager. Given an inbound email and three candidate replies,
estimate for each how likely the prospect is to reply positively (0-100). Reward relevance to what they actually asked,
specificity, brevity and an easy next step. Penalize generic copy, pushiness for low-intent leads, and invented facts.`,
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
