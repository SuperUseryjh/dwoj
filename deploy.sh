#!/bin/bash

# DWOJ PM2 Deployment Script

echo "🚀 Starting DWOJ deployment..."

# Install dependencies if needed
if [ -f "package.json" ]; then
  echo "📦 Installing dependencies..."
  npm install --production
fi

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
  echo "❌ PM2 is not installed. Installing globally..."
  npm install -g pm2
fi

# Stop existing process
echo "⏹️  Stopping existing PM2 process..."
pm2 stop dwoj 2>/dev/null || true

# Start with PM2
echo "▶️  Starting application with PM2..."
pm2 start ecosystem.config.js

# Save PM2 process list
echo "💾 Saving PM2 process list..."
pm2 save

echo "✅ Deployment complete!"
echo ""
echo "Useful commands:"
echo "  pm2 status        - Check application status"
echo "  pm2 logs dwoj     - View logs"
echo "  pm2 monit         - Monitor application"
echo "  pm2 stop dwoj     - Stop application"
echo "  pm2 restart dwoj  - Restart application"
