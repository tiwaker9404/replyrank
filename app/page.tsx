"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseEmails } from "@/lib/parse";
import { sampleLeads } from "@/lib/samples";
import type { Category, Draft, Lead, Meta, RankedLead } from "@/lib/types";

const CAT_LABEL: Record<Category, string> = {
  "sales-ready": "Sales-ready",
  nurture: "Nurture",
  support: "Support",
  "not-a-lead": "Not a lead",
  spam: "Spam",
};

const STRATEGY_LABEL = {
  "meeting-ask": "Meeting ask",
  "discovery-question": "Discovery question",
  "proof-led": "Proof-led",
} as const;

const PASTE_EXAMPLE = `From: Jane Doe <jane@acme.com>
Subject: Pricing for 20 engineers
Title: VP Engineering

Hi, we're a 300-person company on AWS Amplify and want to compare pricing. Can we talk this week?
---
From: Sam <sam@gmail.com>
Subject: hobby plan question

Is the Hobby plan enough for my blog?`;

function waited(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function Home() {
  const [source, setSource] = useState<"sample" | "paste">("sample");
  const [pasted, setPasted] = useState("");
  const [sender, setSender] = useState("Ashwin");
  const [useAi, setUseAi] = useState(true);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [ranked, setRanked] = useState<RankedLead[]>([]);
  const [rankMeta, setRankMeta] = useState<Meta | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { drafts: Draft[]; meta: Meta }>>({});
  const [busy, setBusy] = useState<"rank" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((s) => {
        setAiAvailable(Boolean(s.ai));
        if (!s.ai) setUseAi(false);
      })
      .catch(() => setAiAvailable(false));
  }, []);

  const rank = useCallback(
    async (leads: Lead[]) => {
      setBusy("rank");
      setError(null);
      try {
        const res = await fetch("/api/rank", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leads, useAi }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Ranking failed");
        setRanked(data.leads);
        setRankMeta(data.meta);
        setSelectedId(data.leads[0]?.id ?? null);
        setDrafts({});
      } catch (e) {
        setError(e instanceof Error ? e.message : "Ranking failed");
      } finally {
        setBusy(null);
      }
    },
    [useAi],
  );

  // Rank the sample inbox on first load (rules or AI, whichever is available).
  useEffect(() => {
    if (aiAvailable === null) return;
    rank(sampleLeads());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiAvailable]);

  const selected = useMemo(() => ranked.find((l) => l.id === selectedId) ?? null, [ranked, selectedId]);

  async function draft(lead: RankedLead) {
    setBusy("draft");
    setError(null);
    try {
      const { rank: _r, result: _res, ...plain } = lead;
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lead: plain, sender, useAi }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Drafting failed");
      setDrafts((d) => ({ ...d, [lead.id]: data }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Drafting failed");
    } finally {
      setBusy(null);
    }
  }

  function runRank() {
    if (source === "sample") return rank(sampleLeads());
    const leads = parseEmails(pasted);
    if (!leads.length) return setError("Paste at least one email. Separate emails with a line of ---");
    rank(leads);
  }

  async function copy(d: Draft) {
    await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.body}`);
    setCopied(d.strategy);
    setTimeout(() => setCopied(null), 1500);
  }

  const counts = useMemo(() => {
    const c: Partial<Record<Category, number>> = {};
    for (const l of ranked) c[l.result.category] = (c[l.result.category] ?? 0) + 1;
    return c;
  }, [ranked]);

  const current = selected ? drafts[selected.id] : undefined;

  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1 className="brand">replyrank</h1>
          <p className="tagline">Reply to the right lead first, with the reply most likely to get an answer.</p>
        </div>
        <div className={`mode ${rankMeta?.mode === "ai" ? "on" : ""}`}>
          <span className="dot" />
          {rankMeta?.mode === "ai" ? `AI Gateway · ${rankMeta.model}` : "Rules mode (no AI)"}
          {rankMeta ? <span className="muted"> · {rankMeta.ms} ms</span> : null}
        </div>
      </header>

      <section className="toolbar">
        <div className="seg">
          <button className={source === "sample" ? "active" : ""} onClick={() => setSource("sample")}>
            Sample inbox
          </button>
          <button className={source === "paste" ? "active" : ""} onClick={() => setSource("paste")}>
            Paste emails
          </button>
        </div>
        <label className="field">
          Sign as
          <input value={sender} onChange={(e) => setSender(e.target.value)} maxLength={60} />
        </label>
        <label className={`toggle ${aiAvailable ? "" : "disabled"}`} title={aiAvailable ? "" : "Deploy on Vercel or set AI_GATEWAY_API_KEY to enable"}>
          <input type="checkbox" checked={useAi} disabled={!aiAvailable} onChange={(e) => setUseAi(e.target.checked)} />
          Use AI
        </label>
        <button className="primary" onClick={runRank} disabled={busy !== null}>
          {busy === "rank" ? "Ranking…" : "Rank inbox"}
        </button>
      </section>

      {source === "paste" && (
        <textarea
          className="paste"
          value={pasted}
          placeholder={PASTE_EXAMPLE}
          onChange={(e) => setPasted(e.target.value)}
          spellCheck={false}
        />
      )}

      {rankMeta?.note && <p className="note">{rankMeta.note}</p>}
      {error && <p className="error">{error}</p>}

      <div className="grid">
        <aside className="queue">
          <div className="queue-head">
            <span>{ranked.length} inbound, ranked</span>
            <span className="muted">
              {counts["sales-ready"] ?? 0} sales-ready · {counts.nurture ?? 0} nurture
            </span>
          </div>
          {ranked.map((l) => (
            <button key={l.id} className={`card ${l.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(l.id)}>
              <span className="rank">{l.rank}</span>
              <span className="card-main">
                <span className="card-top">
                  <strong>{l.fromName}</strong>
                  <span className="muted">{l.company ?? l.fromEmail.split("@")[1]}</span>
                </span>
                <span className="subject">{l.subject}</span>
                <span className="card-meta">
                  <span className={`chip ${l.result.category}`}>{CAT_LABEL[l.result.category]}</span>
                  <span className="muted">waiting {waited(l.receivedAt, now)}</span>
                </span>
              </span>
              <span className={`score s${Math.floor(l.result.score / 25)}`}>{l.result.score}</span>
            </button>
          ))}
        </aside>

        <section className="detail">
          {!selected ? (
            <p className="muted">{busy === "rank" ? "Ranking your inbox…" : "Select a lead."}</p>
          ) : (
            <>
              <div className="detail-head">
                <div>
                  <h2>{selected.subject}</h2>
                  <p className="muted">
                    {selected.fromName} &lt;{selected.fromEmail}&gt;
                    {selected.title ? ` · ${selected.title}` : ""}
                  </p>
                </div>
                <div className="route">
                  <span className="muted">Next step</span> <strong>{selected.result.route}</strong>
                </div>
              </div>

              <pre className="email">{selected.body}</pre>

              <div className="bars">
                {(["fit", "intent", "urgency"] as const).map((k) => (
                  <div key={k} className="bar">
                    <span className="bar-label">{k}</span>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${selected.result[k]}%` }} />
                    </span>
                    <span className="bar-num">{selected.result[k]}</span>
                  </div>
                ))}
              </div>

              <ul className="reasons">
                {selected.result.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>

              <div className="drafts-head">
                <h3>Replies, ranked</h3>
                <button className="primary" onClick={() => draft(selected)} disabled={busy !== null || selected.result.category === "spam"}>
                  {busy === "draft" ? "Writing 3 drafts…" : current ? "Redraft" : "Draft 3 replies"}
                </button>
              </div>

              {selected.result.category === "spam" && <p className="muted small">Spam: no reply needed. Archive it.</p>}
              {current && (
                <>
                  <p className="muted small">
                    {current.meta.mode === "ai"
                      ? "Score = 50% rubric checks + 50% a separate AI judge's reply-likelihood."
                      : "Score = rubric checks (rules mode)."}
                    {current.meta.note ? ` ${current.meta.note}.` : ""}
                  </p>
                  {current.drafts.map((d) => (
                    <article key={d.strategy} className={`draft ${d.rank === 1 ? "best" : ""}`}>
                      <div className="draft-top">
                        <span className="draft-rank">#{d.rank}</span>
                        <strong>{STRATEGY_LABEL[d.strategy]}</strong>
                        {d.rank === 1 && <span className="chip sales-ready">Send this one</span>}
                        <span className="draft-score">{d.score}</span>
                      </div>
                      <p className="draft-subject">Subject: {d.subject}</p>
                      <pre className="draft-body">{d.body}</pre>
                      {d.judgeReason && (
                        <p className="judge">
                          Judge {d.judgeScore}: {d.judgeReason}
                        </p>
                      )}
                      <ul className="checks">
                        {d.checks.map((c) => (
                          <li key={c.label} className={c.pass ? "pass" : "fail"}>
                            {c.pass ? "✓" : "✗"} {c.label}
                          </li>
                        ))}
                      </ul>
                      <button className="ghost" onClick={() => copy(d)}>
                        {copied === d.strategy ? "Copied" : "Copy reply"}
                      </button>
                    </article>
                  ))}
                </>
              )}
            </>
          )}
        </section>
      </div>

      <footer className="foot muted">
        Built by Ashwin Tiwari with Next.js, the AI SDK and Vercel AI Gateway, on the free Hobby plan. Works without AI too:
        the rules ranker is transparent and runs with no keys.{" "}
        <a href="https://github.com/tiwaker9404/replyrank">Source on GitHub</a>
      </footer>
    </main>
  );
}
