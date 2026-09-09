/**
 * Neutral brand tokens.
 *
 * No IDS brand assets were available when this MVP was built, so the design
 * system is deliberately neutral and lives in exactly two places:
 *   - this file (used by the email templates, which cannot read CSS variables)
 *   - the `@theme` block in src/app/globals.css (used by the UI)
 *
 * To rebrand: change the hex values here and the matching CSS variables. The
 * wordmark is text (src/components/ui/primitives.tsx) — swap it for an <img>
 * when there is a logo file to point at.
 */
export const brand = {
  companyName: "IDS",
  productName: "Opportunity Check-In",
  colors: {
    ink: "#0B1524",
    body: "#4A5768",
    muted: "#6B7A8D",
    line: "#E3E8EF",
    surface: "#FFFFFF",
    canvas: "#F6F8FB",
    primary: "#0F4C81",
    primaryDark: "#0B3A63",
    accent: "#0EA5A4",
    success: "#127A45",
    warning: "#B45309",
    danger: "#B42318",
  },
} as const;
