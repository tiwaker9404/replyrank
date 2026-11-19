import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { aiDrafts, aiJudge, aiScoreLeads, blendLeadScore } from "../lib/ai";
import { scoreLeadRules } from "../lib/rules";
import { sampleLeads } from "../lib/samples";

function mockReturning(obj: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(obj) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
      warnings: [],
    }),
  } as never);
}

const lead = sampleLeads()[0];

test("AI triage output is parsed and blended with rules", async () => {
  const model = mockReturning({ leads: [{ id: lead.id, fit: 90, intent: 95, urgency: 80, category: "sales-ready", reasons: ["Migrating before Black Friday"], route: "Book with Commercial AE" }] });
  const byId = await aiScoreLeads([lead], model);
  const blended = blendLeadScore(scoreLeadRules(lead), byId.get(lead.id));
  assert.equal(blended.source, "blend");
  assert.equal(blended.category, "sales-ready");
  assert.ok(blended.reasons[0].includes("Black Friday"));
});

test("AI drafts and judge outputs are parsed", async () => {
  const drafts = [
    { strategy: "meeting-ask", subject: "Re: x", body: "Hi Priya, ... Thursday at 11?" },
    { strategy: "discovery-question", subject: "Re: x", body: "Hi Priya, ... how long do releases take?" },
    { strategy: "proof-led", subject: "Re: x", body: "Hi Priya, ... open to 20 minutes next week?" },
  ];
  const out = await aiDrafts(lead, "Ashwin", mockReturning({ drafts }));
  assert.equal(out.length, 3);
  const judged = await aiJudge(lead, out, mockReturning({ scores: drafts.map((d, i) => ({ strategy: d.strategy, replyLikelihood: 70 - i * 10, reason: "ok" })) }));
  assert.equal(judged.get("meeting-ask")?.replyLikelihood, 70);
});

test("tolerates the field names DeepSeek actually returned (fit_score, reason, 'Sales Ready')", async () => {
  const model = mockReturning({
    leads: [{ id: lead.id, fit_score: 90, intent_score: 95, urgency_score: 90, reason: "Migrating before Black Friday", category: "Sales Ready" }],
  });
  const byId = await aiScoreLeads([lead], model);
  const ai = byId.get(lead.id)!;
  assert.equal(ai.fit, 90);
  assert.equal(ai.category, "sales-ready");
  assert.deepEqual(ai.reasons, ["Migrating before Black Friday"]);
  const blended = blendLeadScore(scoreLeadRules(lead), ai);
  assert.equal(blended.source, "blend");
  assert.ok(blended.route.length > 0, "route falls back to rules");
});

test("tolerates a bare array, other key names and a 0-1 likelihood", async () => {
  const out = await aiDrafts(lead, "Ashwin", mockReturning([{ type: "Meeting", text: "Hi Priya, Thursday at 11?" }, { type: "question", reply: "Hi Priya, how long do releases take?" }]));
  assert.deepEqual(out.map((d) => d.strategy), ["meeting-ask", "discovery-question"]);
  assert.ok(out[0].subject.startsWith("Re:"));
  const judged = await aiJudge(lead, out, mockReturning({ ratings: [{ draft: "meeting-ask", score: 0.72, why: "specific" }] }));
  assert.equal(judged.get("meeting-ask")?.replyLikelihood, 72);
});
