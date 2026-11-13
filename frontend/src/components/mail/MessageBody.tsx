"use client";

import { ImageOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui";

/**
 * Renders an email body in an isolated iframe. The HTML was already sanitised by the server;
 * the iframe sandbox (no scripts) and a strict CSP are a second line of defence, and remote
 * images stay blocked until the reader asks for them (they are commonly used for tracking).
 */
export default function MessageBody({ html, text }: { html: string; text: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [showRemote, setShowRemote] = useState(false);
  const [height, setHeight] = useState(120);

  const hasRemote = useMemo(() => /<img[^>]+src=["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html), [html]);

  const doc = useMemo(() => {
    const img = showRemote ? "data: https: http:" : "data:";
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#14171c}
  body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif;overflow-wrap:anywhere;padding:2px}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  pre{white-space:pre-wrap}
  blockquote{border-left:3px solid #d5d9e0;margin:0 0 0 4px;padding-left:12px;color:#555}
  a{color:#2f5bea}
</style></head><body>${html}</body></html>`;
  }, [html, showRemote]);

  useEffect(() => {
    setShowRemote(false);
  }, [html]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame || !html) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.max(60, body.scrollHeight + 8));
    };
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [doc, html]);

  if (!html) {
    return <pre className="font-sans text-[14px] leading-relaxed break-words whitespace-pre-wrap">{text || "(This message has no content)"}</pre>;
  }

  return (
    <div>
      {hasRemote && !showRemote && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-muted">
          <span className="flex items-center gap-1.5">
            <ImageOff className="h-4 w-4" /> Remote images are hidden to protect your privacy.
          </span>
          <Button size="sm" onClick={() => setShowRemote(true)}>Show images</Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg bg-white p-3">
        <iframe
          ref={ref}
          title="Message content"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          style={{ height }}
          className="block w-full border-0"
        />
      </div>
    </div>
  );
}
