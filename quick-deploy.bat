@echo off
REM ====================================
REM   DWOJ 快速部署脚本 (PM2)
REM   适用于 Windows 环境
REM ====================================

echo.
echo ====================================
echo    DWOJ 快速部署 (PM2)
echo ====================================
echo.

REM 检查 Node.js 是否安装
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)

echo [信息] Node.js 版本:
node --version
echo.

REM 检查 npm 是否安装
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未检测到 npm
    pause
    exit /b 1
)

echo [信息] npm 版本:
npm --version
echo.

REM 1. 安装依赖
echo ====================================
echo   [1/4] 安装项目依赖
echo ====================================
echo.
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)
echo.

REM 2. 安装 PM2
echo ====================================
echo   [2/4] 检查/安装 PM2
echo ====================================
echo.
where pm2 >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [信息] PM2 未安装，正在全局安装...
    call npm install -g pm2
    if %ERRORLEVEL% NEQ 0 (
        echo [错误] PM2 安装失败
        pause
        exit /b 1
    )
) else (
    echo [信息] PM2 已安装
    call pm2 --version
)
echo.

REM 3. 构建项目
echo ====================================
echo   [3/4] 构建 TypeScript 项目
echo ====================================
echo.
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 构建失败
    pause
    exit /b 1
)
echo.

REM 4. 创建日志目录
echo ====================================
echo   [4/4] 初始化目录
echo ====================================
echo.
if not exist "log" (
    mkdir log
    echo [信息] 创建 log 目录
)
if not exist "data" (
    mkdir data
    echo [信息] 创建 data 目录
)
if not exist "uploads" (
    mkdir uploads
    echo [信息] 创建 uploads 目录
)
if not exist "plugins" (
    mkdir plugins
    echo [信息] 创建 plugins 目录
)
if not exist "problems_data" (
    mkdir problems_data
    echo [信息] 创建 problems_data 目录
)
echo.

REM 停止现有进程
echo ====================================
echo   停止现有 PM2 进程
echo ====================================
echo.
call pm2 stop dwoj 2>nul || echo [信息] 无现有进程
call pm2 delete dwoj 2>nul || echo [信息] 无进程可删除
echo.

REM 启动应用
echo ====================================
echo   启动 DWOJ 应用
echo ====================================
echo.
call pm2 start ecosystem.config.js
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 启动失败
    pause
    exit /b 1
)
echo.

REM 保存进程
echo ====================================
echo   保存 PM2 进程列表
echo ====================================
echo.
call pm2 save
echo.

REM 显示状态
echo ====================================
echo   应用状态
echo ====================================
echo.
call pm2 status
echo.

echo ====================================
echo   ✅ 部署完成!
echo ====================================
echo.
echo 访问地址：http://localhost:3000
echo.
echo 常用命令:
echo   pm2 status        - 查看状态
echo   pm2 logs dwoj     - 查看日志
echo   pm2 monit         - 监控面板
echo   pm2 restart dwoj  - 重启应用
echo   pm2 stop dwoj     - 停止应用
echo.
echo 管理员账号:
echo   用户名：root
echo   密码：root
echo   (请登录后立即修改密码)
echo.

pause
