// 在加载任何模块之前固定测试环境的行为：
// 单元测试绝不启动 v86 虚拟机（否则要冷启动 30s+）。
process.env.JUDGE_SANDBOX = 'process';
// 单元测试直接在当前进程内跑后端，不额外拉起工作进程
process.env.JUDGE_WORKER = '0';
