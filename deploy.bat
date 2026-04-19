@echo off
REM DWOJ PM2 Deployment Script for Windows

echo.
echo ====================================
echo   DWOJ PM2 Deployment
echo ====================================
echo.

REM Install dependencies if needed
if exist "package.json" (
    echo [1/5] Installing dependencies...
    call npm install --production
)

REM Build TypeScript
echo.
echo [2/5] Building TypeScript...
call npm run build

REM Check if PM2 is installed
echo.
echo [3/5] Checking PM2 installation...
where pm2 >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo PM2 is not installed. Installing globally...
    call npm install -g pm2
)

REM Stop existing process
echo.
echo [4/5] Stopping existing PM2 process...
call pm2 stop dwoj 2>nul || echo No existing process to stop

REM Start with PM2
echo.
echo [5/5] Starting application with PM2...
call pm2 start ecosystem.config.js

REM Save PM2 process list
echo.
echo Saving PM2 process list...
call pm2 save

echo.
echo ====================================
echo   Deployment Complete!
echo ====================================
echo.
echo Useful commands:
echo   pm2 status        - Check application status
echo   pm2 logs dwoj     - View logs
echo   pm2 monit         - Monitor application
echo   pm2 stop dwoj     - Stop application
echo   pm2 restart dwoj  - Restart application
echo.
