module.exports = {
  apps: [{
    name: 'aria-bot',
    script: './node_modules/next/dist/bin/next',
    args: 'start -p 3000',
    cwd: 'C:/Users/BuildASoil/Documents/Projects/aria',
    interpreter: 'node',
    env: {
      NODE_ENV: 'production'
    },
    max_restarts: 10,
    restart_delay: 5000
  }]
};
