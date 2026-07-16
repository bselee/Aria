import { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";

export const metadata = {
    title: "Aria Intelligence",
    description: "Autonomous Agent System",
};

export default function RootLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <html lang="en" suppressHydrationWarning>
            <head>
                <Script src="/base64url-patch.js" strategy="beforeInteractive" />
            </head>
            <body suppressHydrationWarning>
                {children}
            </body>
        </html>
    );
}
