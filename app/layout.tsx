import type { Metadata } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Aayat Profitability Portal",
    template: "%s | Aayat Profitability Portal",
  },
  description: "Internal and client dashboard for Amazon & Temu profitability",
  icons: {
    icon: "/favicon-aayat.png",
    apple: "/favicon-aayat.png",
    shortcut: "/favicon-aayat.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`}>
      <body className="font-sans antialiased bg-[var(--md-surface)] text-[var(--md-on-surface)]">
        {children}
      </body>
    </html>
  );
}
