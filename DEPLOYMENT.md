# Docker Compose 部署

1. 将 `.env.example` 复制为 `.env`。
2. 为 `JWT_SECRET` 和 `JUDGE_TOKEN` 设置长随机字符串。
3. 使用 `docker compose up --build -d` 启动服务栈。
4. 在浏览器中打开 `http://localhost:3000`。

该应用程序与 Ubuntu C++17 评测机（Judge）作为独立的两个服务运行。评测机未暴露宿主机端口，以非特权用户身份运行，且使用只读文件系统以及用于存放编译产物的临时文件系统（tmpfs）。提交的代码仅运行在极简环境中，不会继承评测机的 Token。

评测机 Endpoint 被故意固定为 Compose 私有服务地址 `http://judge:8080`。请在 `.env` 中配置共享 Token；修改此 Token 需要重启 Compose 服务栈。管理员可在 Web 管理页面中调整应用侧的最大并发评测任务数。