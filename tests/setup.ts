// 在加载任何模块之前固定测试环境的行为：
// 单元测试绝不启动 v86 虚拟机（否则要冷启动 30s+）。
process.env.JUDGE_SANDBOX = 'process';
// 单元测试直接在当前进程内跑后端，不额外拉起工作进程
process.env.JUDGE_WORKER = '0';
// 所有测试共用一个独立的 SQLite 文件（preload 里设置，早于任何模块 import），
// 避免不同测试文件各自 import 时按文件顺序抢到不同的库（也会污染开发用的 data/dwoj.db）
process.env.DWOJ_DB_NAME = 'test_dwoj.db';
