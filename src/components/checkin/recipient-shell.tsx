import Image from "next/image";
import type { ReactNode } from "react";

/** Shared presentation only; token authorization stays in the recipient routes. */
export function RecipientShell({ children }: { children: ReactNode }) {
  return (
    <div className="ids-recipient relative isolate min-h-dvh">
      <div aria-hidden="true" className="ids-recipient-background pointer-events-none fixed inset-0 -z-10">
        <Image
          src="/brand/ids-client-background.webp"
          alt=""
          fill
          preload
          sizes="100vw"
          className="object-cover object-bottom"
        />
      </div>
      <div className="mx-auto flex max-w-lg justify-center px-5 pb-2 pt-5">
        <div className="rounded-2xl bg-white/95 px-5 py-3 shadow-sm">
          <Image src="/brand/ids-orange-logo.png" alt="IDS Sculpture" width={112} height={78} />
        </div>
      </div>
      {children}
    </div>
  );
}
