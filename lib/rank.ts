import { aiDrafts, aiEnabled, aiJudge, aiScoreLeads, blendLeadScore, MODEL } from "./ai";
import { rankDrafts, scoreLeadRules, templateDrafts } from "./rules";
import type { Draft, Lead, Meta, RankedLead } from "./types";

const CATEGORY_ORDER = { "sales-ready": 0, nurture: 1, support: 2, "not-a-lead": 3, spam: 4 } as const;

export function sortLeads(leads: Array<Lead & { result: RankedLead["result"] }>): RankedLead[] {
  const sorted = [...leads].sort((a, b) => {
    // Sales-ready and nurture compete on score; support/not-a-lead/spam sink below them.
    const ca = CATEGORY_ORDER[a.result.category] >= 2 ? 1 : 0;
    const cb = CATEGORY_ORDER[b.result.category] >= 2 ? 1 : 0;
    return ca - cb || b.result.score - a.result.score;
  });
  return sorted.map((l, i) => ({ ...l, rank: i + 1 }));
}

export async function rankLeads(leads: Lead[], useAi: boolean): Promise<{ leads: RankedLead[]; meta: Meta }> {
  const t0 = Date.now();
  const rules = leads.map((l) => ({ ...l, result: scoreLeadRules(l) }));
  if (!useAi || !aiEnabled()) {
    return { leads: sortLeads(rules), meta: { mode: "rules", ms: Date.now() - t0, note: aiEnabled() ? "AI limit reached, rules mode" : undefined } };
  }
  try {
    const ai = await aiScoreLeads(leads);
    const blended = rules.map((l) => ({ ...l, result: blendLeadScore(l.result, ai.get(l.id)) }));
    return { leads: sortLeads(blended), meta: { mode: "ai", model: MODEL, ms: Date.now() - t0 } };
  } catch (err) {
    console.error("[replyrank] AI scoring failed, using rules", err);
    return { leads: sortLeads(rules), meta: { mode: "rules", ms: Date.now() - t0, note: "AI unavailable, used rules" } };
  }
}

export async function draftReplies(lead: Lead, sender: string, useAi: boolean): Promise<{ drafts: Draft[]; meta: Meta }> {
  const t0 = Date.now();
  if (!useAi || !aiEnabled()) {
    return { drafts: rankDrafts(templateDrafts(lead, sender), lead), meta: { mode: "rules", ms: Date.now() - t0 } };
  }
  try {
    const drafts = await aiDrafts(lead, sender);
    let judged = drafts.map((d) => ({ ...d, judgeScore: undefined as number | undefined, judgeReason: undefined as string | undefined }));
    try {
      const scores = await aiJudge(lead, drafts);
      judged = drafts.map((d) => ({ ...d, judgeScore: scores.get(d.strategy)?.replyLikelihood, judgeReason: scores.get(d.strategy)?.reason }));
    } catch (err) {
      console.error("[replyrank] judge failed, rubric only", err);
    }
    return { drafts: rankDrafts(judged, lead), meta: { mode: "ai", model: MODEL, ms: Date.now() - t0 } };
  } catch (err) {
    console.error("[replyrank] AI drafting failed, using templates", err);
    return { drafts: rankDrafts(templateDrafts(lead, sender), lead), meta: { mode: "rules", ms: Date.now() - t0, note: "AI unavailable, used templates" } };
  }
}
