/**
 * The narrow formatting language for a custom check-in email.
 *
 * WHY A MARKUP SUBSET RATHER THAN A RICH-TEXT EDITOR
 *
 * The brief asks for bold, italic, lists, links and undo/redo, and to prefer an
 * existing editor dependency "when available". None is installed, and adding a
 * contentEditable editor would mean storing author-controlled HTML and then
 * sanitising it — which is the hard, failure-prone direction for something that
 * goes out to customers over email.
 *
 * Instead the body stays PLAIN TEXT, exactly as it is stored today, and markers
 * in that text are rendered into a fixed set of elements. Three things follow:
 *
 *   1. Raw HTML cannot survive, because the text is escaped BEFORE any
 *      formatting is applied. A script tag becomes visible characters, not an
 *      element. There is no sanitiser to get wrong.
 *   2. Existing drafts keep rendering identically — text with no markers is
 *      unchanged — so no migration and no backfill.
 *   3. The plain-text alternative every email needs is simply the source.
 *
 * Undo and redo are the browser's own textarea history, which is better than
 * anything re-implemented here.
 *
 * Supported, and nothing else:
 *   **bold**        *italic*
 *   - bullet item   1. numbered item
 *   [label](https://example.com)
 */

/** Only these schemes may appear in a link. */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inline formatting, applied to ALREADY-ESCAPED text.
 *
 * Order matters: links first, so a label containing emphasis still works, and
 * bold before italic so `**x**` is not read as two italics.
 */
function inline(escaped: string): string {
  return escaped
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
      // The href arrives escaped, so &amp; must be read back before testing it.
      const candidate = href.replace(/&amp;/g, "&");
      if (!SAFE_LINK.test(candidate)) return whole; // left as literal text
      return `<a href="${href}">${label}</a>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

type Block =
  | { kind: "paragraph"; html: string }
  | { kind: "list"; ordered: boolean; items: string[] };

/** Group lines into paragraphs and lists. */
function blocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push({ kind: "paragraph", html: paragraph.map((l) => inline(escapeHtml(l))).join("<br />") });
    paragraph = [];
  };

  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const item = inline(escapeHtml((bullet ?? numbered)![1]));
      const last = out[out.length - 1];
      if (last && last.kind === "list" && last.ordered === ordered) last.items.push(item);
      else out.push({ kind: "list", ordered, items: [item] });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out;
}

export type EmailStyle = { paragraph: string; list: string; item: string; link: string };

/** `style="…"`, or nothing at all when there is no style to apply. */
function attr(style: string | undefined): string {
  return style ? ` style="${style}"` : "";
}

/**
 * HTML fragments for the email template.
 *
 * Email clients need inline styles; the admin preview inherits page CSS and
 * wants none. Passing no style yields clean markup rather than empty
 * attributes.
 */
export function renderEmailHtml(text: string, style?: EmailStyle): string[] {
  return blocks(text).map((block) => {
    if (block.kind === "paragraph") {
      return `<p${attr(style?.paragraph)}>${withLinkStyle(block.html, style?.link)}</p>`;
    }
    const tag = block.ordered ? "ol" : "ul";
    const items = block.items
      .map((item) => `<li${attr(style?.item)}>${withLinkStyle(item, style?.link)}</li>`)
      .join("");
    return `<${tag}${attr(style?.list)}>${items}</${tag}>`;
  });
}

function withLinkStyle(html: string, linkStyle: string | undefined): string {
  if (!linkStyle) return html;
  return html.replace(/<a href="/g, `<a style="${linkStyle}" href="`);
}

/** Unstyled fragments, for the admin preview. */
export function renderPreviewHtml(text: string): string[] {
  return renderEmailHtml(text);
}

/**
 * The readable plain-text alternative.
 *
 * Markers are removed rather than left in, so a text-only client shows prose
 * instead of punctuation. A link becomes "label (url)", which is the only form
 * that survives without markup.
 */
export function toPlainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) =>
      SAFE_LINK.test(href) ? `${label} (${href})` : whole,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^\s*(\d+)[.)]\s+/gm, "$1. ");
}
