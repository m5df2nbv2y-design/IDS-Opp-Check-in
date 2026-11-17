"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  /** A returned `error` is an expected refusal, shown beside the button. */
  action: () => Promise<void | { error: string }>;
  children: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  confirm?: string;
};

/** Runs a server action with a pending state, without a form per button. */
export function ActionButton({
  action,
  children,
  pendingLabel = "Working…",
  variant = "secondary",
  size = "md",
  confirm,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const button = (
    <Button
      variant={variant}
      size={size}
      disabled={pending}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        setError(null);
        startTransition(async () => {
          const result = await action();
          if (result?.error) setError(result.error);
        });
      }}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
  if (!error) return button;
  return (
    <div className="flex flex-col gap-1">
      {button}
      <p role="alert" className="text-[13px] text-danger">{error}</p>
    </div>
  );
}
