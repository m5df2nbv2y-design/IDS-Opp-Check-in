"use client";

import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { setSelectionAction } from "@/app/admin/actions";

type ReviewSelectionState = {
  pending: boolean;
  revision: number;
  toggle: (id: string, selected: boolean) => void;
  setSending: (sending: boolean) => void;
};

const ReviewSelectionContext = createContext<ReviewSelectionState>({
  pending: false,
  revision: 0,
  toggle: () => {},
  setSending: () => {},
});

export function useReviewSelectionState() {
  return useContext(ReviewSelectionContext);
}

export function ReviewSelectionProvider({ children }: { children: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  function toggle(id: string, selected: boolean) {
    // Revoke send confirmation immediately, including when saving fails.
    setRevision((value) => value + 1);
    setError(null);
    startTransition(async () => {
      try {
        await setSelectionAction([id], selected);
      } catch {
        setError("We couldn't update this selection. Please try again before sending.");
      }
    });
  }

  return (
    <ReviewSelectionContext.Provider value={{ pending: pending || sending, revision, toggle, setSending }}>
      <div aria-busy={pending}>
        {error ? <p role="alert" className="mb-4 rounded-xl border border-danger/30 p-3 text-danger">{error}</p> : null}
        <p role="status" className="sr-only">{pending ? "Updating opportunity selection…" : "Selection ready for review."}</p>
        {children}
      </div>
    </ReviewSelectionContext.Provider>
  );
}

export function ReviewOpportunityCheckbox({ id, name }: { id: string; name: string }) {
  const { pending, toggle } = useReviewSelectionState();
  return (
    <input
      type="checkbox"
      checked
      disabled={pending}
      onChange={(event) => toggle(id, event.target.checked)}
      aria-label={`Include ${name} in this send`}
      className="size-4 shrink-0 accent-[var(--color-brand)] disabled:opacity-40"
    />
  );
}
