# Service Manager 开机自启配置

这份说明用于把 `service-manager` 配成系统登录后自动启动。  
项目本身只是一个本地 Node 服务，页面里只能管理项目和服务进程；要实现开机自启，必须由操作系统来拉起 `server.js`。

## 前提

1. 先在项目目录执行一次依赖安装：

```bash
npm install
```

2. 确认手动启动可用：

```bash
npm start
```

默认地址是 `http://127.0.0.1:3456`。

## 推荐方式

仓库里已经准备了安装脚本：

- macOS: `scripts/autostart/macos/install-launchagent.sh`
- Linux: `scripts/autostart/linux/install-systemd-user.sh`
- Windows: `scripts/autostart/windows/install-task.ps1`

这些脚本会自动解析当前项目路径，并把 Node 路径写入自启配置，避免手工改绝对路径。

## macOS

1. 运行安装脚本：

```bash
bash scripts/autostart/macos/install-launchagent.sh
```

2. 脚本会创建 LaunchAgent 到：

```text
~/Library/LaunchAgents/com.service-manager.plist
```

3. 安装后可用下面命令查看状态：

```bash
launchctl print gui/$UID/com.service-manager
```

4. 卸载命令：

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.service-manager.plist
rm -f ~/Library/LaunchAgents/com.service-manager.plist
```

## Linux

1. 运行安装脚本：

```bash
bash scripts/autostart/linux/install-systemd-user.sh
```

2. 脚本会创建用户级 systemd 服务：

```text
~/.config/systemd/user/service-manager.service
```

3. 查看状态：

```bash
systemctl --user status service-manager
```

4. 卸载命令：

```bash
systemctl --user disable --now service-manager
rm -f ~/.config/systemd/user/service-manager.service
systemctl --user daemon-reload
```

5. 如果你希望“开机后无人登录也自动启动”，还需要启用 linger：

```bash
sudo loginctl enable-linger "$USER"
```

## Windows

1. 用管理员或普通用户 PowerShell 运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/autostart/windows/install-task.ps1
```

2. 脚本会创建一个在用户登录时启动的计划任务。  
如果你要改成“系统启动时启动”，可以在任务计划程序里把触发器改为 `At startup`，但这通常需要更高权限，也要确认 Node 路径和项目路径对系统账户可见。

3. 查看任务：

```powershell
Get-ScheduledTask -TaskName "ServiceManager"
```

4. 卸载任务：

```powershell
Unregister-ScheduledTask -TaskName "ServiceManager" -Confirm:$false
```

## 终端能不能关

可以。  
前提是你已经把 `service-manager` 本身注册成系统自启，而不是只在当前终端里手动执行 `node server.js`。  
安装成功后，当前终端关闭不会影响下次登录或开机后的自动启动。

## 重启 Service Manager

安装成功后，如果修改了代码或需要重启服务，不需要手动杀进程，直接用 launchctl 重启即可：

```bash
launchctl kickstart -k gui/$UID/com.service-manager
```

`-k` 表示先杀掉当前进程再重新启动。执行后面板会短暂断开，刷新页面即可恢复。

Linux 对应命令：

```bash
systemctl --user restart service-manager
```

Windows 对应操作：在任务计划程序中找到 `ServiceManager` 任务，右键「运行」即可。

## 注意

- 这套配置只负责让 `service-manager` 自己启动，不会自动替你启动页面里的项目服务。
- 如果 Node 是通过 `nvm`、`fnm` 之类安装的，建议先确认安装脚本能找到正确的 `node` 路径。
- 默认监听地址仍然是 `127.0.0.1:3456`，不会对外网暴露。

## 常见问题：`uv: command not found`

如果某个服务命令在终端里能跑，但开机自启后报：

```text
/bin/sh: uv: command not found
```

原因通常是自启环境的 `PATH` 太短。`service-manager` 启动服务时用的是系统给它的环境，不会自动读取你交互终端里的 `~/.zshrc`、`~/.bashrc`、`~/.profile`。

处理方式有两种，优先推荐第一种：

1. 直接写 `uv` 的绝对路径

先在你平时的终端里执行：

```bash
which uv
```

把输出的完整路径填到服务命令里，例如：

```bash
/opt/homebrew/bin/uv run --extra web python web/app.py
```

2. 给这个服务补 `PATH`

在服务配置的“环境变量”里加一行：

```text
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

如果 `uv` 是通过 `pipx`、`cargo`、`asdf`、`pyenv` 之类装的，还要把它实际所在目录加进去。
