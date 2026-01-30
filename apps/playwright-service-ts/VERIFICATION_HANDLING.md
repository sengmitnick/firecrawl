# 微信验证处理说明

## 问题背景

微信公众号文章有时会被拦截，需要进行人机验证。如果不处理验证，会获取到空白内容，页面标题显示为"微信公众平台"。

## 验证检测与处理

### 验证元素识别
- 验证按钮: `a#js_verify`
- 当页面出现此元素时，说明需要验证

### 处理流程

1. **初始等待** (3秒)
   - 等待页面初始加载，让验证元素有时间出现

2. **验证检测与点击** (最多2次尝试)
   - 检测 `a#js_verify` 元素
   - 如果存在，点击该元素
   - 等待页面重新加载（networkidle，最多15秒）
   - 再次检查验证元素是否消失
   - 如果仍然存在，重试一次

3. **内容元素等待** (最多8秒)
   - 等待以下任一内容元素出现：
     - `#activity-name` (文章标题-新版)
     - `#js_content` (文章内容-核心)
     - `div.rich_media_content` (富媒体内容-核心)
     - `div#page-content` (页面内容)

4. **内容完整性验证**
   - 检查页面标题是否正常（不是"微信公众平台"、"登录"、"验证"等）
   - 检查是否仍有验证元素
   - 检查HTML内容长度（正常文章应该>5KB）

## 返回信息

API 返回的数据中包含以下验证相关字段：

```json
{
  "content": "...",
  "pageTitle": "文章标题",
  "contentLoaded": true/false,
  "isBlocked": true/false,
  "hasVerifyElement": true/false,
  "contentLength": 12345
}
```

### 字段说明

- `pageTitle`: 页面标题，如果是"微信公众平台"说明被拦截
- `contentLoaded`: 是否检测到内容元素
- `isBlocked`: 根据标题判断是否被拦截
- `hasVerifyElement`: 是否仍存在验证元素（验证失败的标志）
- `contentLength`: HTML内容字节数，正常文章应该>5KB

## 失败场景

如果返回数据中：
- `isBlocked = true` 或
- `hasVerifyElement = true` 或
- `contentLength < 5000`

说明获取失败，可能原因：
1. 微信验证未通过
2. IP被限制
3. 验证按钮点击失败
4. 页面加载超时

## 建议

1. **使用代理**：配置 `PROXY_SERVER` 环境变量，避免IP被封
2. **检查返回标志**：根据 `isBlocked`、`hasVerifyElement` 判断是否需要重试
3. **增加延迟**：如果频繁失败，可以在调用前增加延迟
4. **监控日志**：查看 PM2 日志了解详细的验证过程
