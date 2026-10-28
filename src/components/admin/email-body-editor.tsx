"use client";

import { useRef } from "react";

/**
 * The custom email body, with formatting tools.
 *
 * A plain textarea on purpose. The body is stored as text and rendered through
 * the narrow markup in @/lib/email-markup, so author-controlled HTML never
 * exists — which is what makes an email that goes to customers safe by
 * construction rather than by sanitising.
 *
 * Two things fall out of that choice and are worth keeping:
 *
 *   - UNDO AND REDO ARE THE BROWSER'S. Every edit here, including a toolbar
 *     insertion, goes through execCommand("insertText"), so it lands on the
 *     native undo stack and Cmd/Ctrl+Z behaves the way the writer expects.
 *     A re-implemented history would be worse.
 *   - What is typed is what is stored. There is no hidden document model to
 *     drift from the saved draft or the rendered email.
 */

type Props = {
  value: string;
  disabled?: boolean;
  maxLength: number;
  onChange: (next: string) => void;
};

type Tool = {
  label: string;
  hint: string;
  /** Wraps the selection, or marks each selected line. */
  apply: (selected: string) => string;
  /** Used when nothing is selected, so the caret lands somewhere sensible. */
  placeholder: string;
};

const TOOLS: Tool[] = [
  { label: "B", hint: "Bold", apply: (s) => `**${s}**`, placeholder: "bold text" },
  { label: "I", hint: "Italic", apply: (s) => `*${s}*`, placeholder: "italic text" },
  {
    label: "• List",
    hint: "Bulleted list",
    apply: (s) => s.split("\n").map((line) => (line.trim() ? `- ${line.replace(/^[-*]\s*/, "")}` : line)).join("\n"),
    placeholder: "List item",
  },
  {
    label: "1. List",
    hint: "Numbered list",
    apply: (s) => {
      const lines = s.split("\n");
      let n = 0;
      return lines
        .map((line) => (line.trim() ? `${(n += 1)}. ${line.replace(/^\d+[.)]\s*/, "")}` : line))
        .join("\n");
    },
    placeholder: "List item",
  },
  { label: "Link", hint: "Link", apply: (s) => `[${s}](https://)`, placeholder: "link text" },
];

export function EmailBodyEditor({ value, disabled, maxLength, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function applyTool(tool: Tool) {
    const field = ref.current;
    if (!field) return;

    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = value.slice(start, end) || tool.placeholder;
    const replacement = tool.apply(selected);

    field.focus();
    field.setSelectionRange(start, end);

    // insertText keeps the browser's own undo history intact. If a browser
    // refuses it, fall back to a direct edit rather than losing the change.
    const inserted = document.execCommand?.("insertText", false, replacement);
    if (!inserted) {
      const next = value.slice(0, start) + replacement + value.slice(end);
      onChange(next.slice(0, maxLength));
      requestAnimationFrame(() => field.setSelectionRange(start + replacement.length, start + replacement.length));
      return;
    }
    // Leave the inserted text selected so it can be typed straight over.
    requestAnimationFrame(() => field.setSelectionRange(start, start + replacement.length));
  }

  return (
    <div className="mt-2 rounded-xl border border-line bg-surface">
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        {TOOLS.map((tool) => (
          <button
            key={tool.hint}
            type="button"
            disabled={disabled}
            title={tool.hint}
            aria-label={tool.hint}
            onClick={() => applyTool(tool)}
            className="min-h-9 rounded-lg px-2.5 text-sm font-semibold text-ink transition-colors hover:bg-canvas disabled:opacity-40"
          >
            {tool.label}
          </button>
        ))}
        <span className="ml-auto pr-1 text-xs text-muted">Undo with {navigatorHint()}</span>
      </div>
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        rows={10}
        required
        aria-label="Email message"
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-b-xl bg-transparent p-3 text-base font-normal outline-none"
      />
      <p className="border-t border-line px-3 py-2 text-xs text-muted">
        Formatting: <code>**bold**</code>, <code>*italic*</code>, <code>- bullet</code>, <code>1. numbered</code>,{" "}
        <code>[label](https://…)</code>. Links may only be http, https or mailto.
      </p>
    </div>
  );
}

/** A small courtesy: name the right key for the platform. */
function navigatorHint(): string {
  if (typeof navigator === "undefined") return "Ctrl+Z";
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘Z" : "Ctrl+Z";
}
