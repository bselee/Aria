import { ReactNode } from "react";
import "./globals.css";
// BUILD-SENTINEL:2

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
            </head>
            <body suppressHydrationWarning>
                {children}
            </body>
        </html>
    );
}
