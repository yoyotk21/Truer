import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Truer",
  description: "Fast answers, verified by the top models from OpenAI, Anthropic, and Google.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
