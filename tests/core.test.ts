import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmails } from "../lib/parse";
import { scoreDraft, scoreLeadRules } from "../lib/rules";
import type { Lead } from "../lib/types";

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: "t", fromName: "Jo Park", fromEmail: "jo@acme.com", subject: "Demo request",
  body: "We are a 200-person company on Netlify and want a demo and pricing this week.",
  receivedAt: new Date().toISOString(), ...over,
});

test("parses headers and splits on ---", () => {
  const leads = parseEmails("From: Jane Doe <jane@acme.com>\nSubject: Pricing\nTitle: CTO\n\nHi, pricing please.\n---\nJust a body line from bob@x.io");
  assert.equal(leads.length, 2);
  assert.equal(leads[0].fromName, "Jane Doe");
  assert.equal(leads[0].fromEmail, "jane@acme.com");
  assert.equal(leads[0].title, "CTO");
  assert.equal(leads[1].fromEmail, "bob@x.io");
});

test("caps pasted input at 25 emails", () => {
  assert.equal(parseEmails(Array(40).fill("hello").join("\n---\n")).length, 25);
});

test("spam and job seekers are gated out", () => {
  assert.equal(scoreLeadRules(lead({ body: "We offer SEO services and backlinks." })).category, "spam");
  assert.equal(scoreLeadRules(lead({ body: "Are you hiring? I attached my resume." })).category, "not-a-lead");
});

test("a high-intent business lead outranks a hobbyist", () => {
  const hot = scoreLeadRules(lead());
  const cold = scoreLeadRules(lead({ fromEmail: "kid@gmail.com", body: "Is hobby free for my portfolio?" }));
  assert.equal(hot.category, "sales-ready");
  assert.ok(hot.score > cold.score + 20);
});

test("rubric prefers a soft question over a calendar push for low-intent leads", () => {
  const l = lead({ body: "Curious how the hobby plan handles bandwidth for my portfolio site." , fromEmail: "kim@gmail.com", fromName: "Kim"});
  const soft = scoreDraft("Hi Kim,\n\nThanks for asking about bandwidth on the hobby plan. For a portfolio site the included bandwidth is usually plenty, and you can watch usage in the dashboard as traffic grows. What kind of traffic are you expecting once the portfolio goes live?\n\nBest,\nAshwin", l, 15);
  const pushy = scoreDraft("Hi Kim,\n\nThanks for asking about bandwidth on the hobby plan for your portfolio. I'd love to set up a 30-minute call with our team to walk through plans and usage in detail for your site. Does Thursday at 2pm work for you?\n\nBest,\nAshwin", l, 15);
  assert.ok(soft.score > pushy.score, `soft=${soft.score} pushy=${pushy.score}`);
});

test("rubric rewards specific, short, single-ask replies", () => {
  const l = lead();
  const good = scoreDraft("Hi Jo,\n\nThanks for reaching out about moving off Netlify. With 200 people, preview links on every pull request usually matter most, so I'd like to show you that with one of our solutions engineers. Would Thursday at 11 or Friday at 2 work for a 30-minute demo?\n\nBest,\nAshwin", l, 70);
  const bad = scoreDraft("Hello! I hope this email finds you well! I wanted to reach out to touch base. Can we talk? Are you free? Let me know!", l, 70);
  assert.ok(good.score >= 80, `good=${good.score}`);
  assert.ok(bad.score <= 40, `bad=${bad.score}`);
});
