import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import { brand } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: `${brand.companyName} ${brand.productName}`,
  description: "Bi-annual sales opportunity status check-in.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the check-in's fixed action bar respect the iPhone home indicator.
  viewportFit: "cover",
  themeColor: brand.colors.canvas,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request so it can carry the CSP nonce from proxy.ts;
  // a prerendered page (e.g. the global not-found) would have its scripts blocked.
  await connection();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
