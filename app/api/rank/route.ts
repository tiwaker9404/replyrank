import { z } from "zod";
import { allowAi } from "@/lib/limit";
import { rankLeads } from "@/lib/rank";

export const maxDuration = 30;

const leadSchema = z.object({
  id: z.string().max(40),
  fromName: z.string().max(200),
  fromEmail: z.string().max(200),
  subject: z.string().max(300),
  body: z.string().max(4000),
  receivedAt: z.string().max(40),
  company: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
});

const bodySchema = z.object({
  leads: z.array(leadSchema).min(1).max(25),
  useAi: z.boolean().default(true),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send 1-25 leads." }, { status: 400 });
  const { leads, useAi } = parsed.data;
  const result = await rankLeads(leads, useAi && allowAi(req));
  return Response.json(result);
}
