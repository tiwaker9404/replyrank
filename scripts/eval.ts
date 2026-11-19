/**
 * Offline eval of the ranker against hand-labelled inbound (lib/samples.ts).
 *   npm run eval            -> rules mode, no network, no keys
 *   REPLYRANK_EVAL_AI=1 AI_GATEWAY_API_KEY=... npm run eval   -> blended AI mode
 */
import { SAMPLES, sampleLeads } from "../lib/samples";
import { rankLeads } from "../lib/rank";
import { rankDrafts, templateDrafts } from "../lib/rules";

async function main() {
  const useAi = process.env.REPLYRANK_EVAL_AI === "1";
  const leads = sampleLeads();
  const { leads: ranked, meta } = await rankLeads(leads, useAi);
  const truth = new Map(SAMPLES.map((s) => [s.id, s]));

  // 1. Pairwise ordering: for every pair with different expected tiers, is the better one ranked higher?
  let pairs = 0;
  let correct = 0;
  for (const a of ranked) {
    for (const b of ranked) {
      const ta = truth.get(a.id)!.expectedTier;
      const tb = truth.get(b.id)!.expectedTier;
      if (ta < tb) {
        pairs++;
        if (a.rank < b.rank) correct++;
      }
    }
  }

  // 2. Precision@k where k = number of tier-1 leads
  const tier1 = SAMPLES.filter((s) => s.expectedTier === 1).length;
  const topK = ranked.slice(0, tier1).filter((l) => truth.get(l.id)!.expectedTier === 1).length;

  // 3. Category accuracy
  const catCorrect = ranked.filter((l) => l.result.category === truth.get(l.id)!.expectedCategory).length;

  // 4. Template drafts pass the rubric
  const draftScores = leads.map((l) => rankDrafts(templateDrafts(l), l)[0].score);
  const avgDraft = draftScores.reduce((a, b) => a + b, 0) / draftScores.length;

  console.log(`\nreplyrank eval  (mode: ${meta.mode}${meta.model ? `, ${meta.model}` : ""})\n`);
  console.log("rank  score  category      expected        lead");
  for (const l of ranked) {
    const t = truth.get(l.id)!;
    const ok = l.result.category === t.expectedCategory ? " " : "x";
    console.log(
      `${String(l.rank).padStart(4)}  ${String(l.result.score).padStart(5)}  ${l.result.category.padEnd(12)} ${ok} T${t.expectedTier} ${t.expectedCategory.padEnd(12)} ${l.fromName} - ${l.subject.slice(0, 50)}`,
    );
  }
  const pairwise = correct / pairs;
  console.log(`\nPairwise ordering accuracy: ${(pairwise * 100).toFixed(1)}%  (${correct}/${pairs})`);
  console.log(`Tier-1 precision@${tier1}:      ${topK}/${tier1}`);
  console.log(`Category accuracy:          ${catCorrect}/${ranked.length}`);
  console.log(`Avg best template draft:    ${avgDraft.toFixed(0)}/100\n`);

  const min = Number(process.env.REPLYRANK_MIN_PAIRWISE ?? 0.85);
  if (pairwise < min) {
    console.error(`FAIL: pairwise accuracy below ${min}`);
    process.exit(1);
  }
}

main();
