import { renderPreviewHtml } from "@/lib/email-markup";

/**
 * Shows a custom body exactly as the email will render it.
 *
 * `dangerouslySetInnerHTML` is sound here for one specific reason: the HTML is
 * produced by renderPreviewHtml, which ESCAPES the author's text before
 * applying any formatting. Author-controlled markup therefore cannot exist in
 * the output — the same guarantee the outgoing email relies on. Passing raw
 * draft text here instead would be unsafe; passing the rendered result is not.
 */
export function FormattedBody({ text, className }: { text: string; className?: string }) {
  if (!text.trim()) {
    return <p className="text-muted">Your message will appear here.</p>;
  }
  return (
    <div
      className={className ?? "space-y-3 [&_a]:text-brand [&_a]:underline [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"}
      dangerouslySetInnerHTML={{ __html: renderPreviewHtml(text).join("") }}
    />
  );
}
