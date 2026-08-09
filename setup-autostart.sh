#!/bin/bash
# Service Manager 开机自启安装脚本
# 用法：在终端中运行 bash setup-autostart.sh

set -e

PLIST_NAME="com.service-manager.plist"
SRC_PLIST="$(cd "$(dirname "$0")" && pwd)/$PLIST_NAME"
DST_DIR="$HOME/Library/LaunchAgents"
DST_PLIST="$DST_DIR/$PLIST_NAME"
LABEL="com.service-manager"

echo "========================================="
echo "  Service Manager 开机自启安装"
echo "========================================="
echo ""

# 1. 确保 LaunchAgents 目录存在
mkdir -p "$DST_DIR"

# 2. 如果已有旧的服务在运行，先卸载
if launchctl list "$LABEL" &>/dev/null; then
    echo "[1/4] 卸载旧的服务..."
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    sleep 1
fi

# 3. 复制 plist 到 LaunchAgents 目录
echo "[2/4] 安装 LaunchAgent..."
cp "$SRC_PLIST" "$DST_PLIST"

# 4. 加载服务
echo "[3/4] 启动服务..."
launchctl bootstrap "gui/$(id -u)" "$DST_PLIST" 2>/dev/null || \
    launchctl load "$DST_PLIST" 2>/dev/null || true

sleep 2

# 5. 验证
echo "[4/4] 验证服务状态..."
if launchctl list "$LABEL" &>/dev/null; then
    echo ""
    echo "✅ 安装成功！Service Manager 已设为开机自启"
    echo "   - 服务地址：http://localhost:3456"
    echo "   - 日志文件：$(cd "$(dirname "$0")" && pwd)/logs/"
    echo "   - 崩溃后自动重启：已开启"
    echo ""
    echo "常用命令："
    echo "  查看状态：  launchctl list $LABEL"
    echo "  停止服务：  launchctl kill TERM gui/$(id -u)/$LABEL"
    echo "  卸载自启：  bash setup-autostart.sh --uninstall"
else
    echo ""
    echo "⚠️  launchctl 加载失败，尝试用 load 命令..."
    launchctl load -w "$DST_PLIST" 2>/dev/null
    if launchctl list "$LABEL" &>/dev/null; then
        echo "✅ 安装成功！"
    else
        echo "❌ 自动加载失败，请手动操作："
        echo "   1. 打开 系统设置 > 通用 > 登录项"
        echo "   2. 添加一个运行以下命令的登录项："
        echo "      cd $(cd "$(dirname "$0")" && pwd) && node server.js"
    fi
fi

# 卸载模式
if [ "$1" = "--uninstall" ]; then
    echo ""
    echo "正在卸载..."
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl unload "$DST_PLIST" 2>/dev/null || true
    rm -f "$DST_PLIST"
    echo "✅ 已卸载开机自启"
fi
