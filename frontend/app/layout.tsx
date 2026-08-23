import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Underhood — see what code does",
  description:
    "Turns code into plain-language visual flows for product people, junior developers, and anyone working around code.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
