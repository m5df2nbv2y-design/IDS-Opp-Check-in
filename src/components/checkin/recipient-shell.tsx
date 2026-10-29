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
        <Image src="/brand/ids-orange-logo.png" alt="IDS Sculpture" width={219} height={128} unoptimized className="ids-recipient-logo h-auto w-[180px]" />
      </div>
      {children}
    </div>
  );
}
