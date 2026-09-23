@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 仅供本机/局域网演示；公网部署必须在平台环境变量中设置新的 SHIJIAN_ADMIN_TOKEN。
set "SHIJIAN_ADMIN_TOKEN=local-dev"
where python >nul 2>&1
if errorlevel 1 (echo 没有找到 Python，请让成员 2 协助安装； pause; exit /b 1)
start "史鉴服务器" /b python "史鉴统一网站_server.py"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8772/史鉴团队网站.html"
echo 服务器正在运行；本机地址已打开。请把黑色窗口中的“队友访问”地址发给成员 1 和成员 3。
pause
