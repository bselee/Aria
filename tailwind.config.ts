import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                background: "var(--background)",
                foreground: "var(--foreground)",
                "neon-blue": "#3b82f6",
                "neon-purple": "#a855f7",
                "neon-green": "#10b981",
                "neon-amber": "#f59e0b",
            },
        },
    },
    plugins: [],
};
export default config;
