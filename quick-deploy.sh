#!/bin/bash

# ====================================
# DWOJ 快速部署脚本 (PM2)
# 适用于 Linux/Mac 环境
# ====================================

set -e  # 遇到错误立即退出

echo ""
echo "===================================="
echo "   DWOJ 快速部署 (PM2)"
echo "===================================="
echo ""

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "[错误] 未检测到 Node.js，请先安装 Node.js"
    echo "下载地址：https://nodejs.org/"
    exit 1
fi

echo "[信息] Node.js 版本:"
node --version
echo ""

# 检查 npm 是否安装
if ! command -v npm &> /dev/null; then
    echo "[错误] 未检测到 npm"
    exit 1
fi

echo "[信息] npm 版本:"
npm --version
echo ""

# 1. 安装依赖
echo "===================================="
echo "  [1/4] 安装项目依赖"
echo "===================================="
echo ""
npm install
echo ""

# 2. 安装 PM2
echo "===================================="
echo "  [2/4] 检查/安装 PM2"
echo "===================================="
echo ""
if ! command -v pm2 &> /dev/null; then
    echo "[信息] PM2 未安装，正在全局安装..."
    npm install -g pm2
else
    echo "[信息] PM2 已安装"
    pm2 --version
fi
echo ""

# 3. 构建项目
echo "===================================="
echo "  [3/4] 构建 TypeScript 项目"
echo "===================================="
echo ""
npm run build
echo ""

# 4. 创建目录
echo "===================================="
echo "  [4/4] 初始化目录"
echo "===================================="
echo ""
mkdir -p log data uploads plugins problems_data
echo "[信息] 目录初始化完成"
echo ""

# 停止现有进程
echo "===================================="
echo "  停止现有 PM2 进程"
echo "===================================="
echo ""
pm2 stop dwoj 2>/dev/null || echo "[信息] 无现有进程"
pm2 delete dwoj 2>/dev/null || echo "[信息] 无进程可删除"
echo ""

# 启动应用
echo "===================================="
echo "  启动 DWOJ 应用"
echo "===================================="
echo ""
pm2 start ecosystem.config.js
echo ""

# 保存进程
echo "===================================="
echo "  保存 PM2 进程列表"
echo "===================================="
echo ""
pm2 save
echo ""

# 显示状态
echo "===================================="
echo "  应用状态"
echo "===================================="
echo ""
pm2 status
echo ""

echo "===================================="
echo "  ✅ 部署完成!"
echo "===================================="
echo ""
echo "访问地址：http://localhost:3000"
echo ""
echo "常用命令:"
echo "  pm2 status        - 查看状态"
echo "  pm2 logs dwoj     - 查看日志"
echo "  pm2 monit         - 监控面板"
echo "  pm2 restart dwoj  - 重启应用"
echo "  pm2 stop dwoj     - 停止应用"
echo ""
echo "管理员账号:"
echo "  用户名：root"
echo "  密码：root"
echo "  (请登录后立即修改密码)"
echo ""
