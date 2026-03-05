module.exports = {
    apps: [
        {
            name: "aria-dashboard",
            script: "node_modules/next/dist/bin/next",
            args: "start -p 3000",
            env: {
                NODE_ENV: "production",
            }
        },
        {
            name: "aria-bot",
            script: "node_modules/tsx/dist/cli.mjs",
            args: "src/cli/start-bot.ts",
            env: {
                NODE_ENV: "production"
            }
        }
    ]
};
