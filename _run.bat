@echo off
REM Windows 下带代理环境变量执行任意命令，例如： _run.bat npm install
REM 路径全部相对本脚本所在目录，项目搬家后依然可用。
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
set NO_PROXY=localhost,127.0.0.1
set npm_config_offline=false
set npm_config_cache=%~dp0.npm-cache
cd /d %~dp0
%*
