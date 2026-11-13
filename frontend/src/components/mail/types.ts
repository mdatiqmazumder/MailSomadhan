export type Addr = { name: string; email: string };

export type Folder = { name: string; role: string; total: number; unseen: number };

export type ListItem = {
  uid: number;
  subject: string;
  from: Addr[];
  to: Addr[];
  date: string | null;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  size: number;
  has_attachments: boolean;
};

export type Attachment = { index: number; filename: string; content_type: string; size: number };

export type Message = {
  uid: number;
  folder: string;
  subject: string;
  from: Addr[];
  to: Addr[];
  cc: Addr[];
  reply_to: Addr[];
  date: string | null;
  message_id: string;
  references: string;
  html: string;
  text: string;
  attachments: Attachment[];
};

export type Draft = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  /** Original message kept verbatim below the editor (reply / forward). */
  quotedHtml?: string;
  inReplyTo?: string;
  references?: string;
  draftUid?: number;
  /** Re-attach the attachments of this message (forward, or continuing a draft). */
  carryFolder?: string;
  carryUid?: number;
  carryNames?: string[];
  replyFolder?: string;
  replyUid?: number;
};

export function addrLabel(a: Addr): string {
  return a.name || a.email;
}

export function addrFull(a: Addr): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}
