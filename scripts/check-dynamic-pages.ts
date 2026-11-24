import { readFileSync } from "node:fs";

/**
 * Fails the build when a page was prerendered. Only pages rendered per request
 * get the CSP nonce from src/proxy.ts; a prerendered page's scripts carry none
 * and the policy blocks them. Guards `await connection()` in src/app/layout.tsx.
 *
 * /_global-error is Next's own fallback, shown only if the root layout crashes;
 * /icon.png and /apple-icon.png are images, not pages. A new static non-page route (robots.txt,
 * sitemap) belongs in ALLOWED.
 */
const ALLOWED = new Set(["/_global-error", "/icon.png", "/apple-icon.png"]);

export function prerenderedPages(manifest: { routes: Record<string, unknown>; dynamicRoutes?: Record<string, unknown> }): string[] {
  // dynamicRoutes holds prerendered shells of [param] pages (generateStaticParams).
  return [...Object.keys(manifest.routes), ...Object.keys(manifest.dynamicRoutes ?? {})].filter((route) => !ALLOWED.has(route));
}

if (process.argv[1]?.endsWith("check-dynamic-pages.ts")) {
  const pages = prerenderedPages(JSON.parse(readFileSync(".next/prerender-manifest.json", "utf8")));
  if (pages.length) {
    console.error(`These pages were prerendered, so their scripts would carry no CSP nonce and be blocked:\n  ${pages.join("\n  ")}\nRender them per request (see await connection() in src/app/layout.tsx).`);
    process.exit(1);
  }
  console.log("CSP check: every page renders per request.");
}
