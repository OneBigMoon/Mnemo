#!/bin/sh
# Mnemo 启动器（macOS 双击入口）。逻辑委托给同目录的 start-mori.sh，避免两份实现不一致。
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || {
  printf '无法确定启动器所在目录，请勿移动本文件。\n'
  exit 1
}
exec sh "$SCRIPT_DIR/start-mori.sh" "$@"
