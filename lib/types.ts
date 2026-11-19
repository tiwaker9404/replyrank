export type Category = "sales-ready" | "nurture" | "support" | "not-a-lead" | "spam";

export interface Lead {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  /** ISO timestamp the email arrived */
  receivedAt: string;
  /** Optional form-fill fields */
  company?: string;
  title?: string;
}

export interface LeadScore {
  score: number; // 0-100, higher = reply first
  fit: number; // 0-100
  intent: number; // 0-100
  urgency: number; // 0-100
  category: Category;
  reasons: string[];
  route: string; // who should own it
  source: "ai" | "rules" | "blend";
}

export interface RankedLead extends Lead {
  rank: number;
  result: LeadScore;
}

export type Strategy = "meeting-ask" | "discovery-question" | "proof-led";

export interface DraftCheck {
  label: string;
  pass: boolean;
  weight: number;
}

export interface Draft {
  strategy: Strategy;
  subject: string;
  body: string;
  rubricScore: number; // 0-100 from deterministic checks
  judgeScore?: number; // 0-100 from LLM judge
  judgeReason?: string;
  score: number; // final blended
  checks: DraftCheck[];
  rank: number;
}

export interface Meta {
  mode: "ai" | "rules";
  model?: string;
  note?: string;
  ms: number;
}
