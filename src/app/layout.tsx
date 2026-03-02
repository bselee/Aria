import { ReactNode } from "react";
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
            <body suppressHydrationWarning>
                {children}
            </body>
        </html>
    );
}
