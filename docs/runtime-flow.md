# Service Manager 运行逻辑

本文梳理项目从启动、配置读写、进程管理到重接管的主要运行链路。

## 入口和总体结构

服务入口是 `server.js`。启动后会创建 Express HTTP 服务和 WebSocket 服务：

- HTTP 静态资源：`public/index.html`、`public/app.js`、`public/style.css`
- HTTP API：项目、服务、进程控制、未管理服务、项目扫描
- WebSocket：实时推送服务状态和日志

默认监听：

```bash
http://127.0.0.1:3456
```

可用环境变量覆盖：

```bash
PORT=3457 HOST=127.0.0.1 npm start
```

## 配置加载

项目配置存放在根目录 `config.json`，结构是：

```json
{
  "projects": [
    {
      "id": "...",
      "name": "项目名称",
      "path": "/absolute/project/path",
      "hidden": false,
      "services": [
        {
          "id": "...",
          "name": "服务名称",
          "command": "npm run dev",
          "cwd": "",
          "env": {},
          "port": "3000",
          "delayed": false
        }
      ]
    }
  ]
}
```

启动时 `loadConfig()` 读取该文件；如果不存在或无法解析，会初始化为空配置并写回。

## 前端初始化

浏览器加载 `public/app.js` 后执行 `init()`：

1. 请求 `/api/health`，确认后端可用。
2. 请求 `/api/config`，加载项目和服务配置。
3. 请求 `/api/statuses`，加载当前运行状态。
4. 执行 `render()`，渲染项目卡片、隐藏项目区域。
5. 建立 `/ws` WebSocket，接收后端实时状态和日志。
6. 自动请求 `/api/unmanaged`，渲染未管理服务列表。

页面布局顺序是：

1. 已配置项目
2. 未管理服务
3. 已隐藏项目

## 服务启动

点击服务「启动」后，前端调用：

```http
POST /api/services/:serviceId/start
```

后端 `startProcess(serviceId)` 执行：

1. 通过 `findService()` 找到服务配置。
2. 如果服务已在 `processes` Map 中，拒绝重复启动。
3. 如果配置了端口，先用 `lsof` 检查端口是否已经被监听。
4. 计算实际工作目录：
   - 优先使用 `service.cwd`
   - 否则使用 `project.path`
   - 相对路径会基于 `project.path` 解析为绝对路径
5. 合并环境变量：`process.env + service.env`
6. 使用 `spawn(command, { shell: true, detached: true })` 启动服务。
7. 记录进程身份到 `processes` Map。
8. 写入 `logs/runtime-state.json`。
9. 通过 WebSocket 广播运行状态。
10. 绑定 stdout/stderr，把日志按行推送给前端。

`detached: true` 会让服务拥有独立进程组。停止时后端会向整个进程组发信号，避免只杀掉 shell 而留下子进程。

## 运行态保存

运行中的服务会保存到：

```text
logs/runtime-state.json
```

每个服务保存的信息包括：

- `pid`：启动时记录的进程 PID
- `pgid`：进程组 ID
- `startedAt`：Service Manager 记录的启动时间
- `command`：服务配置命令
- `cwd`：解析后的绝对工作目录
- `port`：服务端口
- `processStart`：系统记录的进程启动时间
- `processCommand`：系统记录的进程命令行

这些信息用于重接管校验，避免只凭 PID 误判。

## 重接管逻辑

重接管发生在 Service Manager 非正常退出后重新启动时，例如崩溃、被强杀、系统异常中断。

启动时 `restoreRuntimeState()` 会读取 `logs/runtime-state.json`，对每个记录执行身份校验：

1. 服务配置仍存在。
2. PID 仍存在。
3. 当前进程组 ID 与保存的 `pgid` 一致。
4. 当前进程启动时间与保存的 `processStart` 一致。
5. 当前命令行与保存命令或配置命令匹配。
6. 如果配置了端口，端口监听者必须是该 PID 或同一进程组内的进程。

只有全部通过，才会放回 `processes` Map，并标记：

```js
reattached: true
```

前端会显示「重接管」标记。由于新进程无法重新绑定旧进程的 stdout/stderr，重接管后的服务不会再捕获新的日志；停止后重新启动可恢复完整日志。

如果校验失败，后端会跳过接管，并把对应记录从 runtime-state 清理掉。

## 重接管后的停止保护

对 `reattached` 进程执行停止前，后端会再次执行身份校验。

如果校验失败：

- 不会发送 SIGTERM/SIGKILL
- 会从 `processes` Map 移除该服务
- 会清理 runtime-state
- 前端收到停止状态
- API 返回错误，提示进程身份已变化

这样可以降低 PID 复用导致误杀无关进程组的风险。

## 服务停止

点击「停止」后，前端调用：

```http
POST /api/services/:serviceId/stop
```

后端 `stopProcess(serviceId)`：

1. 确认服务正在运行。
2. 如果是重接管进程，先重新校验身份。
3. 标记 `proc.killing = true`，避免重复停止。
4. 向进程组发送 `SIGTERM`。
5. 5 秒后如果仍在 `processes` Map 中，发送 `SIGKILL`。
6. 普通启动的服务会通过 child `exit` 事件清理状态。
7. 重接管服务没有 child 句柄，由轮询器检测退出并清理状态。

## 重接管轮询

`pollReattachedProcesses()` 每 3 秒检查一次重接管服务。

如果身份校验仍通过，认为服务仍在运行。

如果校验失败，认为该服务已经退出或身份变化：

- 从 `processes` Map 移除
- 保存新的 runtime-state
- 广播 stopped/error 状态
- 写入一条系统日志

## 日志链路

普通启动的服务：

1. 后端监听 child stdout/stderr。
2. 按行拆分日志。
3. 追加到 `logBuffers`，每个服务最多保留 500 行。
4. 通过 WebSocket 广播给页面。
5. 新 WebSocket 客户端连接时会收到当前缓冲日志。

重接管服务：

- 不能重新接入旧进程 stdout/stderr
- 只会显示一条重接管提示日志
- 停止后重新启动可以恢复实时日志

## 未管理服务

未管理服务由 `/api/unmanaged` 扫描：

1. 使用 `lsof -iTCP -sTCP:LISTEN -P -n` 找到监听端口的进程。
2. 使用 `ps -eo pid=,pgid=,etime=,command=` 获取进程组、运行时长、命令行。
3. 排除 Service Manager 已管理的 PID 和同进程组子进程。
4. 排除 root 和系统级 PID。
5. 返回端口、PID、用户、命令、完整命令、运行时长。

未管理服务支持：

- 添加备注，保存到 `logs/unmanaged-notes.json`
- 折叠为已知服务，保存到 `logs/unmanaged-hidden.json`
- 停止单个未管理进程

## 项目扫描

点击「扫描项目」后：

1. 前端调用 `/api/folder-picker` 打开 Finder 文件夹选择器。
2. 用户选择项目目录。
3. 前端调用 `/api/projects/scan`。
4. 后端扫描根目录和一级子目录，识别常见入口：
   - `package.json` scripts
   - Docker Compose
   - Django `manage.py`
   - Flask / Streamlit / Gradio
   - Go `go.mod`
   - Rust `Cargo.toml`
   - Maven / Gradle
5. 前端弹窗显示候选服务。
6. 用户确认后调用 `/api/projects/import-scan` 导入项目和选中的服务。

## 退出和清理

Service Manager 收到 `SIGINT` 或 `SIGTERM` 时会执行 `cleanup()`：

默认行为：

1. 清理自身的重接管轮询器。
2. 保存当前 `logs/runtime-state.json`。
3. 不停止已托管服务。
4. 退出 Service Manager。

因此，正常关闭或重启 Service Manager 不会影响电脑里已经运行的服务。下次启动时，会根据 runtime-state 对仍在运行的服务做身份校验并重接管。

如果显式设置：

```bash
STOP_SERVICES_ON_EXIT=1 npm start
```

则退出时会：

1. 对所有管理中的进程组发送 `SIGTERM`。
2. 删除 `logs/runtime-state.json`。
3. 退出 Service Manager。

这种模式适合你明确希望“管理器退出时一起关闭所有托管服务”的场景，不是默认行为。
