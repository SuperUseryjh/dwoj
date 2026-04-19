module.exports = {
  apps: [{
    name: 'dwoj',
    script: 'dist/app.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      JWT_SECRET: process.env.JWT_SECRET || 'your_jwt_secret_key'
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000,
      JWT_SECRET: 'your_jwt_secret_key'
    },
    error_file: './log/pm2-err.log',
    out_file: './log/pm2-out.log',
    log_file: './log/pm2-combined.log',
    time: true,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000
  }]
};
