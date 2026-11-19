import type { Category, Draft, DraftCheck, Lead, LeadScore, Strategy } from "./types";

/* ------------------------------------------------------------------ */
/* Lead scoring: transparent, deterministic, runs with zero API keys. */
/* ------------------------------------------------------------------ */

const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton(mail)?|pm|gmx|yandex|qq|163)\./i;
const EDU = /\.edu(\.[a-z]{2})?$|\.ac\.[a-z]{2}$/i;

const SENIOR = /\b(cto|ceo|coo|cio|founder|co-?founder|vp|vice president|head of|director|chief|principal|staff engineer|engineering manager|eng manager|platform lead|tech lead)\b/i;
const IC_TECH = /\b(engineer|developer|architect|devops|sre|frontend|full[- ]stack)\b/i;

const INTENT: Array<[RegExp, number, string]> = [
  [/\b(demo|walkthrough|talk to (sales|someone)|(set up|schedule|book|hop on|have) a (call|chat)|sales call|meeting)\b/i, 25, "Asked for a demo or a call"],
  [/\b(pricing|quote|cost estimate|price|contract|invoice terms|annual plan)\b/i, 20, "Asking about pricing or contract"],
  [/\b(enterprise|sso|saml|scim|sla|soc ?2|security review|procurement|dpa|hipaa|audit log)\b/i, 20, "Enterprise requirements (SSO, SLA, security)"],
  [/\b(migrat\w*|move (off|from|to)|switch(ing)? (from|to)|replatform|moving from)\b/i, 18, "Planning a migration"],
  [/\b(evaluat\w*|poc|proof of concept|pilot|trial|comparing|shortlist)\b/i, 12, "Actively evaluating"],
  [/\b(seats|team plan|\d+\s*(engineers|developers|devs))\b/i, 10, "Team-sized usage"],
  [/\b(budget|approved|signed off)\b/i, 10, "Mentions budget"],
];

const URGENCY: Array<[RegExp, number, string]> = [
  [/\b(asap|urgent(ly)?|immediately|right away|today|tomorrow)\b/i, 35, "Says it's urgent"],
  [/\b(this week|next week|end of (the )?(month|quarter)|eoq|deadline|by (mon|tues|wednes|thurs|fri)day)\b/i, 25, "Has a near-term deadline"],
  [/\b(launch(ing)?|go[- ]live|black friday|cyber monday|holiday (season|traffic)|peak season)\b/i, 20, "Launch or peak season coming"],
  [/\b(renewal|contract (ends|expires)|expir\w+)\b/i, 20, "Current contract renewing"],
  [/\b(outage|downtime|went down|slow(ness)?|latency|timeouts?)\b/i, 15, "Feeling performance pain now"],
];

const STACK = /\b(next\.?js|react|vercel|v0|ai sdk|netlify|aws|amplify|cloudflare|kubernetes|k8s|self[- ]host\w*|gatsby|remix|nuxt|svelte|shopify|hydrogen|headless)\b/gi;

const SUPPORT = /\b(build (is )?fail\w*|error|bug|broken|not working|refund|charged|billing issue|can't (log ?in|deploy)|500|404|dns not)\b/i;
const NOT_A_LEAD = /\b(internship|job (opening|application)|resume|cv attached|hiring\?|are you hiring|career|homework|class project|school project|university assignment)\b/i;
const SPAM = /\b(seo services|guest post|backlinks?|link building|rank (you|your site) #?1|crypto|investment opportunity|lead list|data list for sale|outsourc\w+ (team|developers) at)\b/i;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function companySize(text: string): number | null {
  const m =
    text.match(/(\d[\d,]*)\s*[- ]?(person|people|employee|staff)/i) ||
    text.match(/team of (\d[\d,]*)/i) ||
    text.match(/(\d[\d,]*)\s*(engineers|developers|devs)\b/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}

export function scoreLeadRules(lead: Lead): LeadScore {
  const text = `${lead.subject}\n${lead.body}\n${lead.title ?? ""}`;
  const reasons: string[] = [];

  // ---- Category gates first: some inbound should never reach an AE ----
  if (SPAM.test(text)) {
    return { score: 2, fit: 0, intent: 0, urgency: 0, category: "spam", reasons: ["Vendor pitch / spam pattern"], route: "Archive", source: "rules" };
  }
  if (NOT_A_LEAD.test(text)) {
    return { score: 8, fit: 5, intent: 0, urgency: 0, category: "not-a-lead", reasons: ["Job seeker or student request, not a buyer"], route: "Forward to Recruiting / community", source: "rules" };
  }

  // ---- Fit ----
  let fit = 45;
  if (FREE_MAIL.test(lead.fromEmail)) { fit -= 20; reasons.push("Personal email address"); }
  else if (EDU.test(lead.fromEmail.split("@")[1] ?? "")) { fit -= 25; reasons.push("University email"); }
  else { fit += 10; }

  const role = `${lead.title ?? ""} ${lead.body.slice(-400)}`;
  if (SENIOR.test(role) || SENIOR.test(lead.title ?? "")) { fit += 25; reasons.push("Senior technical decision maker"); }
  else if (IC_TECH.test(role)) { fit += 10; reasons.push("Technical evaluator"); }

  const size = companySize(text);
  if (size !== null) {
    if (size >= 1000) { fit += 20; reasons.push(`~${size.toLocaleString()} employees (enterprise)`); }
    else if (size >= 50) { fit += 15; reasons.push(`~${size} people (commercial sweet spot)`); }
    else if (size >= 10) { fit += 5; }
    else { fit -= 10; reasons.push("Very small team"); }
  }

  const stack = Array.from(new Set((text.match(STACK) ?? []).map((s) => s.toLowerCase())));
  if (stack.length) { fit += Math.min(15, stack.length * 5); reasons.push(`Stack: ${stack.slice(0, 3).join(", ")}`); }

  // ---- Intent ----
  let intent = 10;
  for (const [re, pts, why] of INTENT) if (re.test(text)) { intent += pts; reasons.push(why); }

  // ---- Urgency ----
  let urgency = 5;
  for (const [re, pts, why] of URGENCY) if (re.test(text)) { urgency += pts; reasons.push(why); }

  fit = clamp(fit); intent = clamp(intent); urgency = clamp(urgency);

  // Support issues from existing customers: fast, but route to support
  const isSupport = SUPPORT.test(text) && intent < 35;

  // Speed-to-lead: waiting longer nudges a lead up (max +8)
  const waitedMin = Math.max(0, (Date.now() - new Date(lead.receivedAt).getTime()) / 60000);
  const waitBonus = Math.min(8, waitedMin / 15);

  let score = 0.4 * intent + 0.35 * fit + 0.25 * urgency + waitBonus;
  let category: Category;
  let route: string;

  if (isSupport) {
    category = "support";
    route = "Hand to Support with context";
    score = Math.min(score, 45);
    reasons.unshift("Reads like a support issue");
  } else if (intent >= 35 && fit >= 50) {
    category = "sales-ready";
    route = size !== null && size >= 1000 ? "Book with Enterprise AE" : "Book with Commercial AE";
  } else {
    category = "nurture";
    route = "Personal reply + nurture sequence";
  }

  return { score: clamp(score), fit, intent, urgency, category, reasons: reasons.slice(0, 6), route, source: "rules" };
}

/* ------------------------------------------------------------------ */
/* Draft rubric: the checks a good SDR manager would apply.           */
/* ------------------------------------------------------------------ */

const FLUFF = /\b(hope (this|you) (email )?finds? you well|circle back|touch base|just checking in|synerg\w*|game[- ]changer|revolutioni[sz]e|leverage|best[- ]in[- ]class|cutting[- ]edge|world[- ]class|i wanted to reach out|quick question|per my last)\b/i;
const STOP = new Set("the a an and or but to of in on for with at by from is are was were be been it this that we you i our your my me us they them their as about have has had do does did can could would should will just so if not no yes hi hello thanks thank regards best please let know get got also very really more some any all one two".split(" "));

function words(s: string) {
  return s.toLowerCase().match(/[a-z0-9.+#-]+/g) ?? [];
}

/** Distinctive words from the prospect's email (not stopwords, length > 3). */
function distinctive(lead: Lead) {
  const counts = new Map<string, number>();
  for (const w of words(`${lead.subject} ${lead.body}`)) {
    if (w.length > 3 && !STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return new Set(counts.keys());
}

export function firstName(lead: Lead) {
  const n = lead.fromName.trim().split(/\s+/)[0];
  return n ? n[0].toUpperCase() + n.slice(1) : "there";
}

export function companyOf(lead: Lead) {
  if (lead.company) return lead.company;
  const domain = lead.fromEmail.split("@")[1] ?? "";
  if (FREE_MAIL.test(lead.fromEmail) || !domain) return "your team";
  const base = domain.split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const HARD_ASK = /\b(mon|tues|wednes|thurs|fri)day\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{2}[- ]minute|\btomorrow\b|\bnext week\b/i;

/**
 * Graded rubric (0-100). `intent` is the lead's intent score: a hot lead should get a concrete
 * meeting ask; a low-intent lead should get a low-friction question instead of a calendar push.
 */
export function scoreDraft(body: string, lead: Lead, intent = 50): { score: number; checks: DraftCheck[] } {
  const w = words(body);
  const count = w.length;
  const sentences = body.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  const avgSentence = count / Math.max(1, sentences.length);
  const questions = (body.match(/\?/g) ?? []).length;
  const ctx = distinctive(lead);
  const overlap = new Set(w.filter((x) => ctx.has(x))).size;
  const name = firstName(lead).toLowerCase();
  const hardAsk = HARD_ASK.test(body);
  const hot = intent >= 40;

  const specificsPts = overlap >= 5 ? 25 : overlap >= 3 ? 15 : overlap >= 1 ? 5 : 0;
  const lengthPts = count >= 50 && count <= 100 ? 15 : count >= 35 && count <= 125 ? 8 : 0;

  const checks: DraftCheck[] = [
    { label: `References their specifics (${overlap} matched)`, pass: specificsPts >= 15, weight: specificsPts },
    { label: hot ? "Hot lead: concrete meeting ask" : "Early lead: low-pressure ask", pass: hot ? hardAsk : !hardAsk, weight: 20 },
    { label: `Length ${count} words (best 50–100)`, pass: lengthPts === 15, weight: lengthPts },
    { label: "One clear ask (exactly 1 question)", pass: questions === 1, weight: 15 },
    { label: "Uses their first name", pass: name !== "there" && body.toLowerCase().includes(name), weight: 10 },
    { label: "No filler phrases", pass: !FLUFF.test(body), weight: 10 },
    { label: "Easy to read (avg sentence < 20 words)", pass: avgSentence < 20, weight: 5 },
  ];
  // weight = points earned for graded checks; binary checks earn their weight only when passing
  const graded = new Set([checks[0].label, checks[2].label]);
  const score = checks.reduce((s, c) => s + (graded.has(c.label) ? c.weight : c.pass ? c.weight : 0), 0);
  return { score, checks };
}

/* ------------------------------------------------------------------ */
/* Template drafts for rules mode (no LLM).                           */
/* ------------------------------------------------------------------ */

function painPhrase(lead: Lead): string {
  const t = `${lead.subject} ${lead.body}`.toLowerCase();
  if (/migrat|move (off|from)|switch/.test(t)) return "the migration you mentioned";
  if (/slow|latency|performance|core web vitals|lcp|ttfb/.test(t)) return "the performance issues you described";
  if (/sso|saml|security|soc ?2|enterprise/.test(t)) return "your security and SSO requirements";
  if (/pricing|quote|cost/.test(t)) return "pricing for your setup";
  if (/ai|agent|llm|chatbot/.test(t)) return "the AI features you're building";
  if (/launch|black friday|holiday|peak/.test(t)) return "your upcoming launch";
  return "what you're building";
}

function stackPhrase(lead: Lead): string {
  const skip = /^(vercel|v0|ai sdk|headless|react)$/i;
  const m = (`${lead.subject} ${lead.body}`.match(STACK) ?? []).find((x) => !skip.test(x));
  if (!m) return "your current stack";
  return /self[- ]host/i.test(m) ? "a self-hosted setup" : m;
}

export function templateDrafts(lead: Lead, sender = "Ashwin"): Array<{ strategy: Strategy; subject: string; body: string }> {
  const name = firstName(lead);
  const co = companyOf(lead);
  const pain = painPhrase(lead);
  const stack = stackPhrase(lead);
  const subj = lead.subject.replace(/^(re:\s*)+/i, "");
  return [
    {
      strategy: "meeting-ask",
      subject: `Re: ${subj}`,
      body: `Hi ${name},\n\nThanks for reaching out about ${pain}. Teams coming from ${stack} usually want to see their own app running on Vercel before anything else, so I'd suggest a 30-minute session with one of our solutions engineers to map your setup and timeline. Does Thursday or Friday afternoon work for you?\n\nBest,\n${sender}`,
    },
    {
      strategy: "discovery-question",
      subject: `Re: ${subj}`,
      body: `Hi ${name},\n\nThanks for the note. Before I loop in the right people at Vercel, I want to make sure we focus on ${pain} for ${co}. When your team ships a change on ${stack} today, how long does it take to get from merged to live in production?\n\nBest,\n${sender}`,
    },
    {
      strategy: "proof-led",
      subject: `Re: ${subj}`,
      body: `Hi ${name},\n\nThanks for reaching out. A similar team came to us with ${pain} on ${stack}. After moving to Vercel they got preview links on every pull request and cut time to first byte noticeably. I can share how they did it and what it would look like for ${co}. Open to a 20-minute call next week?\n\nBest,\n${sender}`,
    },
  ];
}

export function rankDrafts(
  drafts: Array<{ strategy: Strategy; subject: string; body: string; judgeScore?: number; judgeReason?: string }>,
  lead: Lead,
  intent = scoreLeadRules(lead).intent,
): Draft[] {
  const scored = drafts.map((d) => {
    const { score: rubricScore, checks } = scoreDraft(d.body, lead, intent);
    const score = d.judgeScore === undefined ? rubricScore : Math.round(0.5 * rubricScore + 0.5 * d.judgeScore);
    return { ...d, rubricScore, checks, score, rank: 0 };
  });
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((d, i) => (d.rank = i + 1));
  return scored;
}
