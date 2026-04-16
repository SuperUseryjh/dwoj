#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { exec, spawn } from 'child_process';
import crypto from 'crypto';

const configPath = path.join(__dirname, 'config', 'index.js');
const logFilePath = path.join(__dirname, 'dwoj.log');

const generateJwtSecret = (): string => {
    return crypto.randomBytes(64).toString('hex');
};

const updateJwtSecret = (secret: string): void => {
    let configContent = fs.readFileSync(configPath, 'utf8');
    configContent = configContent.replace(
        /JWT_SECRET: process.env.JWT_SECRET \|\| '(.*?)'/,
        `JWT_SECRET: process.env.JWT_SECRET || '${secret}'`
    );
    fs.writeFileSync(configPath, configContent, 'utf8');
    console.log('JWT 密钥已更新。');
};

const init = async (interactive: boolean): Promise<void> => {
    let secret = '';
    if (interactive) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const answer = await new Promise<string>(resolve => {
            rl.question('是否使用自动生成的 JWT 密钥？(y/n): ', resolve);
        });
        rl.close();

        if (answer.toLowerCase() === 'y') {
            secret = generateJwtSecret();
            console.log('已自动生成 JWT 密钥。');
        } else {
            const manualSecret = await new Promise<string>(resolve => {
                const rl2 = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                rl2.question('请输入您的 JWT 密钥：', resolve);
                rl2.close();
            });
            secret = manualSecret;
        }
    } else {
        secret = generateJwtSecret();
        console.log('已自动生成 JWT 密钥。');
    }
    updateJwtSecret(secret);
};

const start = (port: number): void => {
    let configContent = fs.readFileSync(configPath, 'utf8');
    if (configContent.includes("JWT_SECRET: process.env.JWT_SECRET || 'your_jwt_secret_key'")) {
        console.log('dwoj 未初始化，正在进行无交互初始化...');
        init(false);
    }

    console.log(`正在端口 ${port} 启动 dwoj...`);
    const child = spawn('node', ['app.js'], {
        detached: true,
        stdio: ['ignore', fs.openSync(logFilePath, 'a'), fs.openSync(logFilePath, 'a')],
        env: { ...process.env, PORT: port.toString() }
    });
    child.unref();
    console.log(`dwoj 已在后台启动。日志文件：${logFilePath}`);
};

const link = (): void => {
    console.log('正在链接 dwoj 日志 (Ctrl+C 退出)...');
    const tail = spawn('tail', ['-f', logFilePath], { stdio: 'inherit' });

    tail.on('error', (err: any) => {
        if (err.code === 'ENOENT') {
            console.error(`错误：日志文件 ${logFilePath} 不存在。请先使用 'dwoj start' 启动 dwoj。`);
        } else {
            console.error(`tail 命令出错：${err.message}`);
        }
    });

    process.on('SIGINT', () => {
        console.log('正在退出日志链接...');
        tail.kill();
        process.exit();
    });
};

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'init':
            const interactive = args.includes('-inter');
            await init(interactive);
            break;
        case 'start':
            let port = 3000;
            const portIndex = args.indexOf('-i');
            if (portIndex > -1 && args[portIndex + 1]) {
                port = parseInt(args[portIndex + 1]);
                if (isNaN(port)) {
                    console.error('错误：无效的端口号。');
                    process.exit(1);
                }
            }
            start(port);
            break;
        case 'link':
            link();
            break;
        default:
            console.log('用法:');
            console.log('  dwoj init [-inter] -> 提供 dwoj 初始化工具');
            console.log('  dwoj start [-i 端口号] -> 在指定端口启动 dwoj');
            console.log('  dwoj link -> 链接 dwoj，在终端显示本次启动日志');
            break;
    }
};

main();
