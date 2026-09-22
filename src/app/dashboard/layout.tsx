import { ReactNode } from "react";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
    title: "Agent Dashboard",
    description: "Live monitoring of autonomous agents",
};

export default function DashboardLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <div className={`min-h-screen bg-[#09090b] text-zinc-100 ${inter.className}`}>
            {children}
        </div>
    );
}
