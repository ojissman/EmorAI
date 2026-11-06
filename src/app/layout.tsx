import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "EmorAI — Intelligence Without Limits",
  description:
    "EmorAI is a personal AI platform: streaming chat powered by GLM models, conversation management, model registry, API keys and a developer API.",
  keywords: ["EmorAI", "AI assistant", "GLM", "chat", "developer API"],
  authors: [{ name: "EmorAI" }],
  icons: { icon: "/logo.svg" },
  openGraph: {
    title: "EmorAI — Intelligence Without Limits",
    description: "A personal AI platform with streaming chat, model management and a developer API.",
    siteName: "EmorAI",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1a1a22" },
    { media: "(prefers-color-scheme: light)", color: "#fafafc" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
          <Toaster position="bottom-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
