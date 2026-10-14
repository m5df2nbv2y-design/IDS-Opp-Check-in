"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/admin/outbox", label: "Outbox" },
  { href: "/admin/analytics", label: "Measurement" },
  { href: "/admin/audit", label: "Audit trail" },
  { href: "/admin/salesforce", label: "Salesforce" },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin navigation" className="ids-nav">
      {LINKS.map((link) => {
        const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`ids-nav-link ${
              active
                ? "ids-nav-active"
                : ""
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
