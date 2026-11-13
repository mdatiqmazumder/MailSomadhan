export type Recipient = { email: string; fields: Record<string, string> };

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, commas/semicolons/tabs). */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

export function normalizeColumn(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}

/**
 * Accepts either a CSV with a header row containing an "email" column, or free text with one
 * recipient per line ("email", "Name <email>", or "email, Name, Company").
 */
export function parseRecipients(text: string): { recipients: Recipient[]; columns: string[]; invalid: string[] } {
  const rows = parseCsv(text);
  if (!rows.length) return { recipients: [], columns: [], invalid: [] };
  const header = rows[0].map(normalizeColumn);
  const emailCol = header.findIndex((h) => ["email", "e_mail", "email_address", "mail"].includes(h));
  const invalid: string[] = [];
  const recipients: Recipient[] = [];
  if (emailCol >= 0) {
    for (const r of rows.slice(1)) {
      const email = (r[emailCol] || "").replace(/^.*<|>.*$/g, "").trim();
      if (!EMAIL_RE.test(email)) { if (r.join("").trim()) invalid.push(r.join(", ").slice(0, 80)); continue; }
      const fields: Record<string, string> = {};
      header.forEach((h, i) => { if (i !== emailCol && r[i]) fields[h] = r[i]; });
      recipients.push({ email, fields });
    }
    return { recipients, columns: header.filter((_, i) => i !== emailCol), invalid };
  }
  // No header: positional "email, name, company".
  const columns = new Set<string>();
  for (const r of rows) {
    let [first, ...rest] = r;
    let name = "";
    const angle = first.match(/^(.*)<([^>]+)>$/);
    if (angle) { name = angle[1].replace(/"/g, "").trim(); first = angle[2].trim(); }
    if (!EMAIL_RE.test(first)) { invalid.push(r.join(", ").slice(0, 80)); continue; }
    const fields: Record<string, string> = {};
    if (name || rest[0]) { fields.name = name || rest[0]; columns.add("name"); }
    if (rest[name ? 0 : 1]) { fields.company = rest[name ? 0 : 1]; columns.add("company"); }
    recipients.push({ email: first, fields });
  }
  return { recipients, columns: [...columns], invalid };
}
