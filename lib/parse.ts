import type { Lead } from "./types";

/**
 * Parse pasted emails. Separate emails with a line containing only `---`.
 * Optional headers at the top of each block:
 *   From: Jane Doe <jane@acme.com>
 *   Subject: ...
 *   Title: ...   Company: ...   Date: ...
 */
export function parseEmails(raw: string, now = Date.now()): Lead[] {
  const blocks = raw
    .split(/^\s*-{3,}\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 25);

  return blocks.map((block, i) => {
    const lines = block.split(/\r?\n/);
    const headers: Record<string, string> = {};
    let start = 0;
    for (; start < lines.length; start++) {
      const m = lines[start].match(/^(from|subject|title|company|date|received):\s*(.*)$/i);
      if (!m) break;
      headers[m[1].toLowerCase()] = m[2].trim();
    }
    let body = lines.slice(start).join("\n").trim();

    let fromName = "";
    let fromEmail = "";
    const from = headers.from ?? "";
    const angle = from.match(/^(.*?)<([^>]+)>/);
    if (angle) {
      fromName = angle[1].replace(/"/g, "").trim();
      fromEmail = angle[2].trim();
    } else if (from.includes("@")) {
      fromEmail = from;
    } else {
      fromName = from;
    }
    if (!fromEmail) {
      const m = body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      fromEmail = m ? m[0] : "unknown@unknown.com";
    }
    if (!fromName) fromName = fromEmail.split("@")[0].replace(/[._]/g, " ");

    let subject = headers.subject ?? "";
    if (!subject) {
      const first = body.split(/\r?\n/)[0] ?? "";
      subject = first.length <= 90 ? first : first.slice(0, 87) + "...";
    }
    if (!body) body = subject;

    const parsedDate = Date.parse(headers.date ?? headers.received ?? "");
    const receivedAt = new Date(Number.isNaN(parsedDate) ? now - i * 60000 : parsedDate).toISOString();

    return {
      id: `p${i + 1}`,
      fromName,
      fromEmail,
      subject,
      body: body.slice(0, 4000),
      receivedAt,
      title: headers.title,
      company: headers.company,
    };
  });
}
