import { aiEnabled, MODEL } from "@/lib/ai";

export function GET() {
  return Response.json({ ai: aiEnabled(), model: aiEnabled() ? MODEL : null });
}
