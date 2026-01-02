# Playwright Scrape API

This is a simple web scraping service built with Express and Playwright.

## Features

- Scrapes HTML content from specified URLs.
- Blocks requests to known ad-serving domains.
- Blocks media files to reduce bandwidth usage.
- Uses random user-agent strings to avoid detection.
- Strategy to ensure the page is fully rendered.

## Install
```bash
npm install
npx playwright install
```

## RUN

### 标准模式
```bash
npm run build
npm start
```
OR
```bash
npm run dev
```

### Windows CDP 模式（使用 Microsoft Edge）

当使用 CDP 模式时，需要先启动 Edge 浏览器并启用远程调试端口，然后再启动服务。

#### 方法 1: 使用批处理文件（推荐）

1. **在终端（CMD 或 PowerShell）中运行：**
   ```cmd
   start-edge-cdp.bat
   ```
   或者直接双击 `start-edge-cdp.bat` 文件

2. **等待 Edge 启动后，在另一个终端窗口启动服务：**
   ```bash
   npm run build
   npm start
   ```
   或
   ```bash
   npm run dev
   ```

3. **停止服务时，在 bat 文件窗口按任意键关闭 Edge CDP 实例**

#### 方法 2: 手动启动 Edge CDP

在终端（CMD 或 PowerShell）中运行：

```cmd
"C:\Program Files\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\edge-cdp-profile"
```

或者如果 Edge 安装在 32 位路径：

```cmd
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\edge-cdp-profile"
```

**注意：**
- CDP 模式默认使用端口 `9222`
- 确保端口 `9222` 未被其他程序占用
- 启动 Edge CDP 后，保持该窗口打开，然后启动服务

## USE

```bash
curl -X POST http://localhost:3000/scrape \
-H "Content-Type: application/json" \
-d '{
  "url": "https://example.com",
  "wait_after_load": 1000,
  "timeout": 15000,
  "headers": {
    "Custom-Header": "value"
  },
  "check_selector": "#content"
}'
```

## USING WITH FIRECRAWL

Add `PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` to `/apps/api/.env` to configure the API to use this Playwright microservice for scraping operations.
