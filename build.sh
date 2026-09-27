#!/bin/bash
# Hermes UI Android 构建脚本

set -e

echo "=== Hermes UI Android Build Script ==="
echo ""

# 1. 构建 Vite 应用
echo "[1/4] 构建 hermes-ui..."
export PATH="/root/.bun/bin:$PATH"
cd /root/hermes-ui-repo/app
if [ ! -d "node_modules" ] || [ bun.lock -nt node_modules ]; then
  echo "  安装依赖..."
  bun install
fi
bun run build
echo "  ✓ 构建完成: app/dist/"

# 2. 复制构建产物到 www
echo ""
echo "[2/4] 复制构建产物到 www..."
rm -rf /root/hermes-ui-android/www
mkdir -p /root/hermes-ui-android/www
cp -r /root/hermes-ui-repo/app/dist/* /root/hermes-ui-android/www/
echo "  ✓ 已复制到 www/"

# 3. 同步到 Android
echo ""
echo "[3/5] 同步到 Android..."
cd /root/hermes-ui-android
npx cap sync android
echo "  ✓ 同步完成"

# 4. 清理 Cordova 兼容性空文件 (Capacitor 会自动生成这些无用文件)
echo ""
echo "[4/5] 清理 Cordova 兼容性文件..."
rm -f /root/hermes-ui-android/android/app/src/main/assets/public/cordova.js
rm -f /root/hermes-ui-android/android/app/src/main/assets/public/cordova_plugins.js
echo "  ✓ 已清理"

# 5. 构建 APK
echo ""
echo "[5/5] 构建 APK..."
cd android
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
./gradlew assembleDebug --no-daemon
echo "  ✓ 构建完成"

APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_PATH" ]; then
  echo ""
  echo "=== 构建成功 ==="
  echo "APK 位置: $APK_PATH"
  ls -lh "$APK_PATH"
else
  echo "错误: APK 未找到"
  exit 1
fi
