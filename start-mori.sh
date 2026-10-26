#!/bin/sh
# Mnemo 启动器（macOS / Linux，可双击或在终端运行）。
# 支持安装路径含空格或中文字符；找不到 Node.js 时给出可读提示，不会自动下载任何东西。
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || {
  printf '无法确定启动器所在目录，请勿移动本文件。\n'
  exit 1
}

# 便携客户端包内置了 Node 运行时（runtime/）；普通安装没有该目录，走系统 PATH。
if [ -x "$SCRIPT_DIR/runtime/bin/node" ]; then
  PATH="$SCRIPT_DIR/runtime/bin:$PATH"
  export PATH
fi

pause_before_close() {
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\n按回车键关闭窗口...'
    IFS= read -r _mori_discard || true
    printf '\n'
  fi
}

if ! command -v node >/dev/null 2>&1; then
  printf '未找到 Node.js。\n\n'
  printf 'Mnemo 需要 Node.js 22.13.0 或更高版本（自带 npm）。\n'
  printf '请手动安装：https://nodejs.org/zh-cn\n'
  printf '本启动器不会自动下载任何软件。\n'
  pause_before_close
  exit 1
fi

# local.mjs 以自身位置定位项目根目录，与双击时的工作目录无关；
# start 会先检查依赖是否已安装，未安装时给出中文安装步骤。
node "$SCRIPT_DIR/scripts/local.mjs" start "$@"
status=$?

if [ "$status" -ne 0 ]; then
  printf '\nMnemo 启动器退出，退出码 %s。\n' "$status"
  printf '可先运行自检：node scripts/local.mjs doctor\n'
fi
pause_before_close
exit "$status"
