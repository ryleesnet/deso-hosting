import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { Header } from "@/components/Header";
import { SiteFooter } from "@/components/SiteFooter";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DeSoHosting | VPS Hosting on DeSo",
  description: "VPS hosting — pay with DeSo, dUSDC, or PayPal and control your servers from anywhere.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[var(--background)] text-[var(--foreground)]`}
      >
        <AuthProvider>
          <Header />
          <div className="flex min-h-[calc(100dvh-7rem)] flex-col md:min-h-[calc(100dvh-4rem)]">
            <main className="flex-1 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-0">
              {children}
            </main>
            <SiteFooter />
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
