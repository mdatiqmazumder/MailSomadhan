import "@fontsource-variable/inter";
import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/ui";
import { themeScript } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "MailSomadhan",
  description: "Secure email hosting panel and webmail",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
