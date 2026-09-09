"use client";

import { useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  action: () => Promise<void>;
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

  return (
    <Button
      variant={variant}
      size={size}
      disabled={pending}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        startTransition(async () => {
          await action();
        });
      }}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
