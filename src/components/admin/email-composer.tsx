"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { saveCampaignEmailAction } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { readEmailCopy, validateEmailCopy, type EmailCopy, type SavedEmailCopy } from "@/lib/check-in-copy";
import { brand } from "@/lib/brand";

export function EmailPreview({ copy }: { copy: EmailCopy }) {
  return (
    <section aria-label="Email preview" className="rounded-xl border border-line bg-canvas p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Email preview</p>
      <p className="mt-3 break-words text-sm font-semibold text-ink">Subject: {copy.subject || "Your subject"}</p>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-body">
        <p>Hi [first name],</p>
        <p className="whitespace-pre-wrap break-words">{copy.body || "Your message will appear here."}</p>
        <p>Please take a quick moment to update their current status — [selected opportunity count] open opportunities, about 60 seconds.</p>
        <span className="inline-flex rounded-full bg-brand px-5 py-3 text-xs font-semibold text-white">UPDATE MY OPPORTUNITIES</span>
        <p>Thanks,<br />{brand.companyName}</p>
        <p className="text-xs text-muted">Each recipient gets their own personal check-in link. This preview contains no active link.</p>
      </div>
    </section>
  );
}

export function EmailComposer({ campaignId, initial, selectedCount }: { campaignId: string; initial: SavedEmailCopy; selectedCount: number }) {
  const [saved, setSaved] = useState(() => ({ revision: initial.emailRevision, copy: readEmailCopy(initial) }));
  const [copy, setCopy] = useState(saved.copy);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dirty = copy.mode !== saved.copy.mode || (copy.mode === "custom" && (copy.subject !== saved.copy.subject || copy.body !== saved.copy.body));

  function save() {
    setMessage(""); setError("");
    let validated: EmailCopy;
    try { validated = validateEmailCopy(copy); } catch (e) { setError((e as Error).message); return; }
    startTransition(async () => {
      try {
        const result = await saveCampaignEmailAction(campaignId, saved.revision, validated);
        setSaved(result); setCopy(result.copy); setMessage("Email saved for this campaign. Nothing has been sent.");
      } catch {
        setError("Could not save. The shared draft may have changed; reload and try again.");
      }
    });
  }

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-xl font-semibold text-ink">Prepare your check-in email</h2>
      <p className="mt-2 text-sm text-muted">Choose the standard invitation or write a custom message for this campaign. This shared draft is visible to the other admins.</p>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="mt-5 space-y-5">
        <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-ink">Email type</legend>
          {(["standard", "custom"] as const).map((mode) => (
            <label key={mode} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${copy.mode === mode ? "border-brand bg-brand-soft" : "border-line"}`}>
              <input type="radio" name="email-type" value={mode} checked={copy.mode === mode} onChange={() => { setCopy(mode === "standard" ? readEmailCopy({ emailSubject: null, emailBody: null, emailRevision: 0 }) : { ...copy, mode }); setMessage(""); setError(""); }} className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]" />
              <span><strong className="block text-sm text-ink">{mode === "standard" ? "Standard check-in email" : "Custom email"}</strong><span className="text-xs text-muted">{mode === "standard" ? "Use the ready-to-go IDS invitation." : "Write your own subject and opening message."}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            {copy.mode === "custom" ? <>
              <label className="block text-sm font-semibold text-ink">Subject<input value={copy.subject} disabled={pending} maxLength={200} onChange={(e) => { setCopy({ ...copy, subject: e.target.value }); setMessage(""); }} required className="mt-2 h-11 w-full rounded-xl border border-line bg-surface px-3 text-base font-normal" /></label>
              <label className="block text-sm font-semibold text-ink">Message<textarea value={copy.body} disabled={pending} maxLength={5000} rows={9} onChange={(e) => { setCopy({ ...copy, body: e.target.value }); setMessage(""); }} required className="mt-2 w-full rounded-xl border border-line bg-surface p-3 text-base font-normal" /></label>
              <p className="text-xs text-muted">Plain text. The greeting, opportunity count, check-in button and IDS sign-off are added automatically.</p>
            </> : <p className="text-sm leading-relaxed text-body">The standard email asks contacts to update the status of the opportunities you select. You can switch to Custom email to tailor the opening message.</p>}
            <Button type="submit" disabled={pending || !dirty}>{pending ? "Saving…" : "Save email choice"}</Button>
            <p role="status" className="text-sm text-success">{message}</p>
            {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
            {dirty ? <p className="text-sm text-warning">Save these changes before reviewing recipients.</p> : selectedCount > 0 ? <Link href="/admin/campaigns/review" className="inline-flex text-sm font-semibold text-brand underline">Review {selectedCount} selected opportunities →</Link> : <Link href="/admin" className="inline-flex text-sm font-semibold text-brand underline">Choose opportunities on the Dashboard →</Link>}
          </div>
          <EmailPreview copy={copy} />
        </div>
      </form>
    </Card>
  );
}
