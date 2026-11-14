"""Print and PDF version of an email: a clean A4 document with a letterhead, the message details and
the body. The same HTML is printed by the browser (Print) and rendered to a PDF file by WeasyPrint
(Download PDF), so both look the same.

Remote images are left out on purpose: loading them would tell the sender the mail was opened (and
from which server). Images embedded in the message itself are kept.
"""
import html as html_lib
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

REMOTE_IMG = re.compile(r"<img\b[^>]*\bsrc\s*=\s*['\"]?\s*(?:https?:)?//[^>]*>", re.I)
REMOTE_CSS_URL = re.compile(r"url\(\s*['\"]?\s*(?:https?:)?//[^)]*\)", re.I)
UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|\r\n\t]+')

CSS = """
@page {
  size: A4;
  margin: 20mm 17mm 20mm 17mm;
  @bottom-left { content: "__FOOTER__"; font: 7.5pt "Noto Sans", "DejaVu Sans", sans-serif; color: #8a8f98; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt "Noto Sans", "DejaVu Sans", sans-serif; color: #8a8f98; }
}
html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
#ms-doc { font-family: "Noto Sans", "Noto Sans Bengali", "Segoe UI", "DejaVu Sans", Arial, sans-serif !important;
  color: #1c2024 !important; font-size: 10pt; line-height: 1.5; }
#ms-head { display: flex !important; justify-content: space-between !important; align-items: flex-end !important;
  border-bottom: 2.5pt solid __ACCENT__ !important; padding-bottom: 6pt !important; margin-bottom: 14pt !important; }
#ms-brand { font-size: 13pt !important; font-weight: 700 !important; color: __ACCENT__ !important; letter-spacing: .2pt; }
#ms-printed { font-size: 8pt !important; color: #6b717c !important; text-align: right !important; }
#ms-subject { font-size: 16pt !important; font-weight: 700 !important; line-height: 1.3 !important;
  margin: 0 0 10pt 0 !important; color: #111418 !important; word-wrap: break-word; }
#ms-meta { width: 100% !important; border-collapse: collapse !important; margin: 0 0 14pt 0 !important;
  font-size: 9pt !important; background: #f6f7f9 !important; border: 0.75pt solid #e3e6ea !important; }
#ms-meta th { width: 22mm !important; text-align: left !important; vertical-align: top !important; color: #6b717c !important;
  font-weight: 600 !important; padding: 4pt 8pt !important; white-space: nowrap; }
#ms-meta td { padding: 4pt 8pt 4pt 0 !important; vertical-align: top !important; word-break: break-word; color: #1c2024 !important; }
#ms-body { font-size: 10pt; word-wrap: break-word; overflow-wrap: anywhere; }
#ms-body img { max-width: 100% !important; height: auto !important; }
#ms-body table { max-width: 100% !important; }
/* Old-style table attributes (border="1", cellpadding) that mail clients still send */
#ms-body table[border]:not([border="0"]) { border-collapse: collapse; }
#ms-body table[border]:not([border="0"]) td, #ms-body table[border]:not([border="0"]) th { border: 0.75pt solid #c9ced6; }
#ms-body table[cellpadding]:not([cellpadding="0"]) td, #ms-body table[cellpadding]:not([cellpadding="0"]) th { padding: 3pt 6pt; }
#ms-body pre, #ms-text { white-space: pre-wrap !important; word-wrap: break-word; font-family: inherit; margin: 0; }
#ms-body blockquote { margin: 6pt 0 6pt 2pt; padding-left: 9pt; border-left: 2pt solid #d5d9e0; color: #4a505a; }
#ms-att { margin-top: 16pt !important; padding-top: 8pt !important; border-top: 0.75pt solid #e3e6ea !important;
  font-size: 9pt !important; break-inside: avoid; }
#ms-att b { display: block; margin-bottom: 3pt; color: #1c2024 !important; }
#ms-att span { display: inline-block; margin: 0 6pt 3pt 0; padding: 2pt 6pt; border: 0.75pt solid #d5d9e0;
  border-radius: 3pt; color: #3a3f47 !important; }
#ms-note { margin-top: 10pt; font-size: 7.5pt; color: #8a8f98 !important; }
@media screen {
  body { background: #e9ebef !important; }
  #ms-doc { max-width: 176mm; margin: 24px auto !important; padding: 20mm 17mm !important; background: #fff;
    box-shadow: 0 2px 12px rgba(0,0,0,.12); }
}
"""


# ---------------------------------------------------------------- keeping the mail's CSS inside the body
# The message's own styles share the page with our letterhead and the From/To/Date table. Unconfined, a
# sender could hide those (`#ms-meta{display:none}`) or paint a fake header over them with positioning, so
# a printed or PDF copy would show made-up details. Every rule is scoped to #ms-body and the properties
# that can move content outside its box are dropped.
STYLE_BLOCK = re.compile(r"(<style\b[^>]*>)(.*?)(</style\s*>)", re.I | re.S)
STYLE_ATTR = re.compile(r'(\sstyle=")([^"]*)(")', re.I)
BLOCKED_PROPS = {"position", "top", "right", "bottom", "left", "z-index", "transform", "translate", "scale",
                 "rotate", "zoom", "offset", "offset-path"}
BLOCKED_PREFIXES = ("inset", "transform-", "offset-")
NESTED_AT_RULES = {"media", "supports"}


def _declarations(text_or_tokens) -> str:
    import tinycss2

    out = []
    for d in tinycss2.parse_declaration_list(text_or_tokens, skip_comments=True, skip_whitespace=True):
        if d.type != "declaration":
            continue
        name = d.lower_name
        if name in BLOCKED_PROPS or name.startswith(BLOCKED_PREFIXES):
            continue
        if name.startswith("margin") and any(
                t.type in ("number", "dimension", "percentage") and t.value < 0 for t in d.value):
            continue  # negative margins pull content up over the header
        out.append(f"{name}:{tinycss2.serialize(d.value).strip()}{' !important' if d.important else ''}")
    return ";".join(out)


def _scope_rules(rules) -> str:
    import tinycss2

    out = []
    for rule in rules:
        if rule.type == "qualified-rule":
            selectors, part = [], []
            for tok in rule.prelude + [None]:
                if tok is None or (tok.type == "literal" and tok.value == ","):
                    sel = tinycss2.serialize(part).strip()
                    if sel:
                        selectors.append(f"#ms-body {sel}")
                    part = []
                else:
                    part.append(tok)
            if selectors:
                out.append(f"{', '.join(selectors)}{{{_declarations(rule.content)}}}")
        elif rule.type == "at-rule" and rule.lower_at_keyword in NESTED_AT_RULES and rule.content is not None:
            inner = tinycss2.parse_rule_list(rule.content, skip_comments=True, skip_whitespace=True)
            out.append(f"@{rule.lower_at_keyword} {tinycss2.serialize(rule.prelude).strip()}{{{_scope_rules(inner)}}}")
        # every other at-rule (@page, @import, @font-face ...) is dropped
    return "\n".join(out)


def confine_css(body_html: str) -> str:
    import tinycss2

    def block(m: re.Match) -> str:
        rules = tinycss2.parse_stylesheet(m.group(2), skip_comments=True, skip_whitespace=True)
        css = _scope_rules(rules).replace("</", "<\\/")  # never close the <style> element early
        return m.group(1) + css + m.group(3)

    def attr(m: re.Match) -> str:
        return f"{m.group(1)}{_e(_declarations(html_lib.unescape(m.group(2))))}{m.group(3)}"

    return STYLE_ATTR.sub(attr, STYLE_BLOCK.sub(block, body_html))


def _e(value: str) -> str:
    return html_lib.escape(value or "", quote=True)


def _addresses(items: list[dict]) -> str:
    out = []
    for a in items:
        name, email = a.get("name") or "", a.get("email") or ""
        out.append(f"{_e(name)} &lt;{_e(email)}&gt;" if name and name != email else _e(email))
    return ", ".join(out)


def _when(msg: dict) -> datetime | None:
    raw = msg.get("date")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        try:
            return parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None


def _size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return ""


def filename(msg: dict) -> str:
    when = _when(msg)
    subject = UNSAFE_FILENAME.sub(" ", msg.get("subject") or "No subject").strip()[:80] or "Email"
    return f"{when:%Y-%m-%d} - {subject}.pdf" if when else f"{subject}.pdf"


def render(msg: dict, *, brand: str, printed_by: str, accent: str = "#2a62d6", script_nonce: str = "") -> str:
    """Full HTML document for one message (output of MailSession.get_message)."""
    when = _when(msg)
    now = datetime.now(timezone.utc)
    removed = False
    if msg.get("html"):
        body_html = msg["html"]
        cleaned = REMOTE_CSS_URL.sub("none", REMOTE_IMG.sub("", body_html))
        removed = cleaned != body_html
        body = f'<div id="ms-body">{confine_css(cleaned)}</div>'
    else:
        body = f'<div id="ms-body"><div id="ms-text">{_e(msg.get("text", ""))}</div></div>'

    rows = [("From", _addresses(msg.get("from", []))), ("To", _addresses(msg.get("to", [])))]
    if msg.get("cc"):
        rows.append(("Cc", _addresses(msg["cc"])))
    if when:
        offset = when.strftime("%z")
        zone = f" (GMT{offset[:3]}:{offset[3:]})" if offset else ""
        rows.append(("Date", _e(f"{when:%A, %d %B %Y, %I:%M %p}{zone}")))
    else:
        rows.append(("Date", "—"))
    meta = "".join(f"<tr><th>{k}</th><td>{v or '—'}</td></tr>" for k, v in rows)

    attachments = msg.get("attachments") or []
    att = ""
    if attachments:
        items = "".join(f"<span>{_e(a.get('filename', 'attachment'))} · {_size(int(a.get('size', 0)))}</span>" for a in attachments)
        att = f'<div id="ms-att"><b>{len(attachments)} attachment{"s" if len(attachments) > 1 else ""}</b>{items}</div>'
    note = '<div id="ms-note">Images from the internet were not loaded.</div>' if removed else ""

    footer = re.sub(r'[\\"<>\r\n]', "", f"{brand} · {printed_by}")  # goes into a CSS string inside <style>
    css = CSS.replace("__ACCENT__", accent).replace("__FOOTER__", footer)
    script = (f'<script nonce="{script_nonce}">window.addEventListener("load",function(){{setTimeout(function(){{window.print()}},250)}});</script>'
              if script_nonce else "")
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_e(msg.get("subject") or "(no subject)")}</title><style>{css}</style></head>
<body><div id="ms-doc">
<div id="ms-head"><div id="ms-brand">{_e(brand)}</div>
<div id="ms-printed">{_e(printed_by)}<br>Printed {now:%d %b %Y, %H:%M} UTC</div></div>
<h1 id="ms-subject">{_e(msg.get("subject") or "(no subject)")}</h1>
<table id="ms-meta">{meta}</table>
{body}{att}{note}
</div>{script}</body></html>"""


def to_pdf(document: str) -> bytes:
    """Render with WeasyPrint. Only data: URLs are fetched (embedded images); nothing from the network."""
    from weasyprint import HTML, URLFetcher  # imported lazily: needs Pango from the OS

    # data: only. Never http(s) (tracking, server-side requests) and never file: (mail HTML is untrusted
    # and must not be able to pull files from this server into the PDF).
    fetcher = URLFetcher(allowed_protocols={"data"}, timeout=5)
    return HTML(string=document, url_fetcher=fetcher, base_url="about:blank").write_pdf()
