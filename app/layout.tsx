import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Virtual Office",
  description:
    "A 3D office where AI agents and people hold seats, roles and permissions, and work moves between rooms.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
