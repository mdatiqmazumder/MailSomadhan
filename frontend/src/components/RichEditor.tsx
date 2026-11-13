"use client";

import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, Heading1, Heading2, ImageIcon, Italic, Link2, List, ListOrdered,
  Quote, Redo2, RemoveFormatting, Strikethrough, Underline, Undo2,
} from "lucide-react";
import { useEffect } from "react";
import { cx } from "./ui";

type Props = {
  initialHtml: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  autoFocus?: boolean;
  /** Receives the editor instance (e.g. to insert merge fields at the cursor). */
  onEditor?: (editor: Editor) => void;
};

export default function RichEditor({ initialHtml, onChange, placeholder, minHeight = 180, autoFocus, onEditor }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TextStyle,
      Color,
      Image.configure({ inline: true }),
      Placeholder.configure({ placeholder: placeholder || "Write your message…" }),
    ],
    content: initialHtml,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    autofocus: autoFocus ? "start" : false,
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? "" : e.getHTML()),
  });

  useEffect(() => {
    if (editor && onEditor) onEditor(editor);
  }, [editor, onEditor]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar editor={editor} />
      <div
        className="rich min-h-0 flex-1 cursor-text overflow-y-auto px-4 py-3 text-[14px] leading-relaxed"
        style={{ minHeight }}
        onClick={() => editor && !editor.isFocused && editor.commands.focus()}
      >
        <EditorContent editor={editor} style={{ minHeight: minHeight - 24 }} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="h-10 border-b border-border" />;

  const Btn = ({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-text",
      )}
    >
      {children}
    </button>
  );
  const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
  const chain = () => editor.chain().focus();
  const icon = "h-4 w-4";

  function setLink() {
    const previous = editor!.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link address", previous || "https://");
    if (url === null) return;
    if (!url.trim()) {
      chain().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = /^(https?:|mailto:|tel:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    chain().extendMarkRange("link").setLink({ href }).run();
  }

  function addImage() {
    const url = window.prompt("Image address (must be publicly reachable, https://…)");
    if (url && /^https?:\/\//i.test(url.trim())) chain().setImage({ src: url.trim() }).run();
  }

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5" role="toolbar" aria-label="Formatting">
      <Btn label="Bold" active={editor.isActive("bold")} onClick={() => chain().toggleBold().run()}><Bold className={icon} /></Btn>
      <Btn label="Italic" active={editor.isActive("italic")} onClick={() => chain().toggleItalic().run()}><Italic className={icon} /></Btn>
      <Btn label="Underline" active={editor.isActive("underline")} onClick={() => chain().toggleUnderline().run()}><Underline className={icon} /></Btn>
      <Btn label="Strikethrough" active={editor.isActive("strike")} onClick={() => chain().toggleStrike().run()}><Strikethrough className={icon} /></Btn>
      <label title="Text colour" className="relative inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover">
        <span className="h-4 w-4 rounded-full border border-border" style={{ background: (editor.getAttributes("textStyle").color as string) || "var(--text)" }} />
        <input
          type="color"
          aria-label="Text colour"
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(e) => chain().setColor(e.target.value).run()}
        />
      </label>
      <Sep />
      <Btn label="Heading" active={editor.isActive("heading", { level: 1 })} onClick={() => chain().toggleHeading({ level: 1 }).run()}><Heading1 className={icon} /></Btn>
      <Btn label="Subheading" active={editor.isActive("heading", { level: 2 })} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2 className={icon} /></Btn>
      <Btn label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => chain().toggleBulletList().run()}><List className={icon} /></Btn>
      <Btn label="Numbered list" active={editor.isActive("orderedList")} onClick={() => chain().toggleOrderedList().run()}><ListOrdered className={icon} /></Btn>
      <Btn label="Quote" active={editor.isActive("blockquote")} onClick={() => chain().toggleBlockquote().run()}><Quote className={icon} /></Btn>
      <Sep />
      <Btn label="Align left" active={editor.isActive({ textAlign: "left" })} onClick={() => chain().setTextAlign("left").run()}><AlignLeft className={icon} /></Btn>
      <Btn label="Align centre" active={editor.isActive({ textAlign: "center" })} onClick={() => chain().setTextAlign("center").run()}><AlignCenter className={icon} /></Btn>
      <Btn label="Align right" active={editor.isActive({ textAlign: "right" })} onClick={() => chain().setTextAlign("right").run()}><AlignRight className={icon} /></Btn>
      <Sep />
      <Btn label="Link" active={editor.isActive("link")} onClick={setLink}><Link2 className={icon} /></Btn>
      <Btn label="Image from web address" onClick={addImage}><ImageIcon className={icon} /></Btn>
      <Btn label="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()}><RemoveFormatting className={icon} /></Btn>
      <Sep />
      <Btn label="Undo" onClick={() => chain().undo().run()}><Undo2 className={icon} /></Btn>
      <Btn label="Redo" onClick={() => chain().redo().run()}><Redo2 className={icon} /></Btn>
    </div>
  );
}
