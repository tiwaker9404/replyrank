import { z } from "zod";
import { allowAi } from "@/lib/limit";
import { draftReplies } from "@/lib/rank";

export const maxDuration = 45;

const bodySchema = z.object({
  lead: z.object({
    id: z.string().max(40),
    fromName: z.string().max(200),
    fromEmail: z.string().max(200),
    subject: z.string().max(300),
    body: z.string().max(4000),
    receivedAt: z.string().max(40),
    company: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
  }),
  sender: z.string().max(60).default("Ashwin"),
  useAi: z.boolean().default(true),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid lead." }, { status: 400 });
  const { lead, sender, useAi } = parsed.data;
  const result = await draftReplies(lead, sender.trim() || "Ashwin", useAi && allowAi(req));
  return Response.json(result);
}
