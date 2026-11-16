import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Integration Hub",
  description: "Integration and monitoring demo: Shop orders → Warehouse shipments, with retries and incidents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen bg-zinc-100 font-sans text-zinc-900">
        <header className="border-b border-zinc-800 bg-zinc-950 text-white">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-3">
              <span className="grid h-7 w-7 place-items-center rounded bg-emerald-500 font-mono text-xs font-bold text-zinc-950">
                IH
              </span>
              <span className="font-semibold">Integration Hub</span>
              <span className="hidden font-mono text-xs text-zinc-400 sm:inline">Shop → Warehouse</span>
            </Link>
            <span className="font-mono text-xs text-zinc-400">Monitoring</span>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
