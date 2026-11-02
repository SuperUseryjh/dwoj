// 在加载任何模块之前固定测试环境的行为：
// 单元测试绝不启动 v86 虚拟机（否则要冷启动 30s+）。
process.env.JUDGE_SANDBOX = 'process';
