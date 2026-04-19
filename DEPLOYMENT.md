# DWOJ PM2 Deployment Guide

## 快速开始 (Quick Start)

### Windows

```bash
# 1. 安装依赖
npm install

# 2. 构建项目
npm run build

# 3. 使用 PM2 启动
npm run pm2:start
```

### Linux/Mac

```bash
# 1. 安装依赖
npm install

# 2. 构建并部署
./deploy.sh
```

## 部署脚本 (Deployment Scripts)

### NPM Scripts

- `npm run pm2:start` - 启动应用
- `npm run pm2:stop` - 停止应用
- `npm run pm2:restart` - 重启应用
- `npm run pm2:delete` - 删除 PM2 进程
- `npm run pm2:logs` - 查看日志
- `npm run pm2:monit` - 监控面板
- `npm run deploy:build` - 构建并重启
- `npm run deploy:prod` - 生产环境部署

### 部署脚本

**Windows:**
```bash
deploy.bat
```

**Linux/Mac:**
```bash
chmod +x deploy.sh
./deploy.sh
```

## PM2 常用命令 (Common PM2 Commands)

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs dwoj

# 实时监控
pm2 monit

# 重启应用
pm2 restart dwoj

# 停止应用
pm2 stop dwoj

# 删除应用
pm2 delete dwoj

# 开机自启 (Linux)
pm2 startup
pm2 save
```

## 环境配置 (Environment Configuration)

复制 `.env.example` 到 `.env` 并修改配置:

```bash
cp .env.example .env
```

配置项:
- `PORT` - 服务器端口 (默认：3000)
- `JWT_SECRET` - JWT 密钥 (生产环境请修改!)
- `NODE_ENV` - 运行环境 (production/development)

## PM2 配置文件说明 (Ecosystem Config)

`ecosystem.config.js` 包含以下配置:

- **应用名称**: dwoj
- **启动脚本**: dist/app.js
- **实例数**: 1
- **自动重启**: 启用
- **内存限制**: 1GB
- **日志文件**: log/pm2-*.log

## 生产环境部署 (Production Deployment)

### 1. 首次部署

```bash
# 安装依赖
npm install --production

# 构建
npm run build

# 启动
pm2 start ecosystem.config.js

# 保存进程列表
pm2 save

# 设置开机自启 (Linux)
pm2 startup
```

### 2. 更新部署

```bash
# 拉取最新代码
git pull

# 重新构建并重启
npm run deploy:build
```

## 日志管理 (Log Management)

日志文件位置:
- 错误日志：`log/pm2-err.log`
- 输出日志：`log/pm2-out.log`
- 合并日志：`log/pm2-combined.log`

查看日志:
```bash
# 实时查看
pm2 logs dwoj

# 查看最后 100 行
pm2 logs dwoj --lines 100

# 清空日志
pm2 flush
```

## 故障排除 (Troubleshooting)

### 应用无法启动

1. 检查端口是否被占用
2. 查看日志：`pm2 logs dwoj`
3. 检查 TypeScript 编译：`npm run build`

### PM2 未安装

```bash
npm install -g pm2
```

或安装到项目:
```bash
npm install pm2 --save-dev
```

### 内存溢出

调整 `ecosystem.config.js` 中的 `max_memory_restart` 值。

## 注意事项 (Notes)

1. **生产环境** 请修改 JWT_SECRET
2. **日志文件** 定期清理，避免占用过多磁盘空间
3. **开机自启** 仅在 Linux 服务器需要
4. **端口占用** 确保 3000 端口未被其他应用占用
