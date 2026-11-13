"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, cx } from "@/components/ui";

export type Contact = { email: string; name: string };

// One request per page load, shared by every recipient field.
let contactsPromise: Promise<Contact[]> | null = null;
function loadContacts(): Promise<Contact[]> {
  if (!contactsPromise) contactsPromise = api<Contact[]>("/mail/contacts").catch(() => {
    contactsPromise = null;
    return [];
  });
  return contactsPromise;
}

/** The part after the last comma is what the person is typing now. */
function split(value: string): { before: string; current: string } {
  const i = Math.max(value.lastIndexOf(","), value.lastIndexOf(";"));
  return { before: i >= 0 ? value.slice(0, i + 1) : "", current: (i >= 0 ? value.slice(i + 1) : value).trim() };
}

/** Comma separated recipients with suggestions from people this user wrote to before. */
export function RecipientInput({ value, onChange, className, autoFocus, placeholder, label }: {
  value: string; onChange: (v: string) => void; className?: string; autoFocus?: boolean; placeholder?: string; label: string;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadContacts().then(setContacts);
  }, []);

  const { before, current } = split(value);
  const q = current.toLowerCase();
  const already = new Set(before.toLowerCase().split(/[,;]/).map((s) => s.trim().replace(/^.*<|>$/g, "")).filter(Boolean));
  const matches = q.length === 0 ? [] : contacts
    .filter((c) => !already.has(c.email) && (c.email.includes(q) || c.name.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.email.startsWith(q)) - Number(a.email.startsWith(q)))
    .slice(0, 8);
  const show = open && matches.length > 0;

  function pick(c: Contact) {
    onChange(`${before}${before ? " " : ""}${c.email}, `);
    setOpen(false);
    setActive(0);
    input.current?.focus();
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={input}
        className={className}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % matches.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); }
          else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]); }
          else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
        }}
      />
      {show && (
        <ul role="listbox" aria-label={`${label} suggestions`} className="absolute top-full left-0 z-50 mt-1 max-h-72 w-full min-w-64 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-modal">
          {matches.map((c, i) => (
            <li
              key={c.email}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setActive(i)}
              className={cx("flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm", i === active && "bg-hover")}
            >
              <Avatar name={c.name || c.email} size={26} />
              <span className="min-w-0">
                {c.name && <span className="block truncate font-medium">{c.name}</span>}
                <span className={cx("block truncate", c.name ? "text-xs text-muted" : "")}>{c.email}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
