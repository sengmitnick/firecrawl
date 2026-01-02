@echo off
REM 启动 Microsoft Edge 的 CDP 模式，用于 playwright-service-ts
REM CDP 端口: 9222

echo ========================================
echo 正在启动 Microsoft Edge CDP 模式...
echo ========================================

REM 设置 CDP 端口
set CDP_PORT=9222

REM 设置用户数据目录（避免与正常浏览器实例冲突）
set USER_DATA_DIR=%TEMP%\edge-cdp-profile

REM 尝试查找 Edge 的安装路径
set EDGE_PATH=

REM 检查 64 位系统路径
if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    set EDGE_PATH=C:\Program Files\Microsoft\Edge\Application\msedge.exe
    goto :found
)

REM 检查 32 位系统路径
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    set EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
    goto :found
)

REM 如果找不到，尝试从注册表查找
for /f "tokens=2*" %%a in ('reg query "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Edge\BLBeacon" /v version 2^>nul') do (
    if "%%b" neq "" (
        set EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
        goto :found
    )
)

REM 如果还是找不到，尝试 64 位注册表
for /f "tokens=2*" %%a in ('reg query "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Edge\BLBeacon" /v version 2^>nul') do (
    if "%%b" neq "" (
        set EDGE_PATH=C:\Program Files\Microsoft\Edge\Application\msedge.exe
        goto :found
    )
)

:not_found
echo [错误] 未找到 Microsoft Edge 安装路径
echo 请确保已安装 Microsoft Edge 浏览器
pause
exit /b 1

:found
echo [信息] 找到 Edge 路径: %EDGE_PATH%
echo [信息] CDP 端口: %CDP_PORT%
echo [信息] 用户数据目录: %USER_DATA_DIR%
echo.

REM 检查端口是否已被占用
netstat -ano | findstr ":%CDP_PORT%" >nul
if %errorlevel% equ 0 (
    echo [警告] 端口 %CDP_PORT% 已被占用
    echo 正在尝试关闭占用该端口的进程...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%CDP_PORT%"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
)

REM 创建用户数据目录（如果不存在）
if not exist "%USER_DATA_DIR%" (
    mkdir "%USER_DATA_DIR%"
)

REM 启动 Edge 并启用 CDP 模式
echo [信息] 正在启动 Edge CDP 模式...
echo [提示] 请保持此窗口打开，关闭窗口将停止 CDP 服务
echo.

start "" "%EDGE_PATH%" ^
    --remote-debugging-port=%CDP_PORT% ^
    --user-data-dir="%USER_DATA_DIR%" ^
    --no-first-run ^
    --no-default-browser-check ^
    --disable-default-apps ^
    --disable-popup-blocking ^
    --disable-translate ^
    --disable-background-timer-throttling ^
    --disable-backgrounding-occluded-windows ^
    --disable-renderer-backgrounding

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo [成功] Edge CDP 模式已启动
    echo ========================================
    echo CDP 端点: http://localhost:%CDP_PORT%
    echo.
    echo 现在可以启动 playwright-service-ts 服务
    echo 按任意键关闭此窗口（将同时关闭 Edge CDP 实例）
    pause >nul
    
    REM 关闭 Edge 进程（通过端口查找对应的进程）
    echo [信息] 正在关闭 Edge CDP 实例...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%CDP_PORT%"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    echo [信息] Edge CDP 实例已关闭
) else (
    echo.
    echo [错误] 启动 Edge CDP 模式失败
    pause
    exit /b 1
)

