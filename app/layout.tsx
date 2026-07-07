import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Sans, Zilla_Slab } from "next/font/google";
import "./globals.css";

const display = Zilla_Slab({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

const body = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Northwind Outfitters — Returns Desk",
  description:
    "AI customer-support agent demo: policy-grounded refund decisions with a live reasoning trace.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        {children}
      </body>
    </html>
  );
}
