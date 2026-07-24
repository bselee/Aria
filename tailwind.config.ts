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
                "dash-l1": "var(--dash-l1)",
                "dash-l2": "var(--dash-l2)",
                "dash-l3": "var(--dash-l3)",
                "dash-ts": "var(--dash-ts)",
                "dash-ts-stale": "var(--dash-ts-stale)",
            },
        },
    },
    plugins: [],
};
export default config;
