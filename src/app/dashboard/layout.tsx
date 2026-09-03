import { ReactNode } from "react";
import { Inter } from "next/font/google";
import { ChatPanel } from "@/components/dashboard/chat/ChatPanel";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
    title: "Dashboard",
    description: "Purchasing operations",
};

export default function DashboardLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <div className={`min-h-screen bg-[#09090b] text-zinc-100 ${inter.className}`}>
            {children}
            <ChatPanel />
        </div>
    );
}
