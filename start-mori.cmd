@echo off
rem Mnemo 启动器（Windows，可双击或在命令行运行）。
rem 支持安装路径含空格或中文字符；找不到 Node.js 时给出可读提示，不会自动下载任何东西。
rem 说明：本启动器不转发命令行参数（cmd 无法安全转义任意参数）；如需传参请运行
rem   node scripts\local.mjs start [参数]
setlocal
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"

rem 便携客户端包内置了 Node 运行时（runtime\）；普通安装没有该目录，走系统 PATH。
if exist "%SCRIPT_DIR%runtime\node.exe" set "PATH=%SCRIPT_DIR%runtime;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。
  echo.
  echo Mnemo 需要 Node.js 22.13.0 或更高版本（自带 npm）。
  echo 请手动安装：https://nodejs.org/zh-cn
  echo 本启动器不会自动下载任何软件。
  echo.
  pause
  exit /b 1
)

rem local.mjs 以自身位置定位项目根目录，与当前目录无关（也避免 UNC 路径下 cd 失败）；
rem start 会先检查依赖是否已安装，未安装时给出中文安装步骤。
rem local.mjs 通过 Node 自带的 npm-cli.js 或 npm_execpath 直调 npm，不经 shell。
node "%SCRIPT_DIR%scripts\local.mjs" start
set "MORI_EXIT_CODE=%ERRORLEVEL%"

if not "%MORI_EXIT_CODE%"=="0" (
  echo.
  echo Mnemo 启动器退出，退出码 %MORI_EXIT_CODE%。
  echo 可先运行自检：node scripts\local.mjs doctor
)
echo.
echo 按任意键关闭窗口...
pause >nul
exit /b %MORI_EXIT_CODE%
