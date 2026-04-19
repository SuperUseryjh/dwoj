module.exports = {
  apps: [
    {
      name: 'dwoj-db',
      script: 'dist/lib/database-service.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        USE_SEPARATE_DB_PROCESS: 'true'
      },
      error_file: './log/pm2-db-err.log',
      out_file: './log/pm2-db-out.log',
      log_file: './log/pm2-db-combined.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000
    },
    {
      name: 'dwoj',
      script: 'dist/app.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        JWT_SECRET: process.env.JWT_SECRET || 'your_jwt_secret_key',
        USE_SEPARATE_DB_PROCESS: 'true'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
        JWT_SECRET: 'your_jwt_secret_key',
        USE_SEPARATE_DB_PROCESS: 'false'
      },
      depends_on: ['dwoj-db'],
      error_file: './log/pm2-err.log',
      out_file: './log/pm2-out.log',
      log_file: './log/pm2-combined.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000
    }
  ]
};
