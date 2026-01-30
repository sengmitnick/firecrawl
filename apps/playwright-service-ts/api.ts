import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright';
import dotenv from 'dotenv';
// import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com'
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
}

let browser: Browser;
let context: BrowserContext;

const initializeBrowser = async () => {
  // browser = await chromium.launch({
  //   headless: true,
  //   args: [
  //     '--no-sandbox',
  //     '--disable-setuid-sandbox',
  //     '--disable-dev-shm-usage',
  //     '--disable-accelerated-2d-canvas',
  //     '--no-first-run',
  //     '--no-zygote',
  //     '--single-process',
  //     '--disable-gpu'
  //   ]
  // });
  
  // 添加用户数据目录参数来解决 Chrome 远程调试问题
  browser = await chromium.connectOverCDP('http://localhost:9222', {
    timeout: 30000,
    slowMo: 100
  });

  // let userAgent = new UserAgent().toString();
  // const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 NetType/WIFI MicroMessenger/6.8.0(0x16080000) MacWechat/3.8.10(0x13080a10) XWEB/1227 Flue';
  const viewport = { width: 1280, height: 800 };

  const contextOptions: any = {
    // userAgent,
    viewport,
  };

  if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
  } else if (PROXY_SERVER) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
    };
  }

  // context = await browser.newContext(contextOptions);
  context = browser.contexts()[0];

  if (BLOCK_MEDIA) {
    await context.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', async (route: Route, request: PlaywrightRequest) => {
      await route.abort();
    });
  }

  // Intercept all requests to avoid loading ads
  await context.route('**/*', (route: Route, request: PlaywrightRequest) => {
    const requestUrl = new URL(request.url());
    const hostname = requestUrl.hostname;

    if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      console.log(hostname);
      return route.abort();
    }
    return route.continue();
  });
};

const shutdownBrowser = async () => {
  if (context) {
    await context.close();
  }
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

// 检查页面内容是否完整和有效
const validatePageContent = async (page: Page): Promise<{ isValid: boolean; reason?: string }> => {
  const title = await page.title();

  // 检查标题是否为空或为默认值
  if (!title || title.trim() === '') {
    return { isValid: false, reason: '页面标题为空' };
  }

  if (title === '微信公众平台' || title.includes('登录') || title.includes('验证')) {
    return { isValid: false, reason: `页面标题异常: ${title}` };
  }

  // 检查是否存在验证元素（未处理）
  const verifyElement = await page.locator('a#js_verify').count();
  if (verifyElement > 0) {
    return { isValid: false, reason: '仍然存在验证元素' };
  }

  // 检查是否有内容元素
  const contentSelectors = [
    '#activity-name',
    '#js_name',
    '#js_content',
    'div.rich_media_content'
  ];

  let hasContent = false;
  for (const selector of contentSelectors) {
    const count = await page.locator(selector).count();
    if (count > 0) {
      hasContent = true;
      break;
    }
  }

  if (!hasContent) {
    return { isValid: false, reason: '未找到文章内容元素' };
  }

  return { isValid: true };
};

const scrapePage = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined) => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  // 先等待初始加载（缩短为3秒）
  await page.waitForTimeout(3 * 1000);

  // 优先检测验证元素，立即处理
  const jsVerifyElement = page.locator('a#js_verify').first();
  const hasJsVerifyElement = await jsVerifyElement.count() > 0;

  if (hasJsVerifyElement) {
    console.log('⚠️ 检测到验证元素 a#js_verify，准备点击验证按钮');
    try {
      await jsVerifyElement.click();
      console.log('✅ 已点击验证按钮，等待页面更新...');
      // 点击后等待页面重新加载
      await page.waitForLoadState('networkidle', { timeout: timeout });
      // 额外等待确保内容渲染
      await page.waitForTimeout(3 * 1000);
    } catch (error) {
      console.log('❌ 点击验证按钮失败:', error);
      // 即使点击失败，也继续等待页面稳定
      await page.waitForTimeout(3 * 1000);
    }
  } else {
    console.log('✅ 未检测到验证元素 a#js_verify');
    // 没有验证元素时，等待页面稳定
    await page.waitForTimeout(3 * 1000);
  }

  // 等待微信公众号文章的关键元素加载（多个可能的选择器）
  const contentSelectors = [
    '#activity-name',           // 文章标题（新版）
    '#js_name',                 // 文章标题（旧版）
    '#js_content',              // 文章内容
    '#img-content',             // 图文消息内容
    'div.rich_media_title',     // 富媒体标题
    'div.rich_media_content'    // 富媒体内容
  ];

  let contentFound = false;
  for (const selector of contentSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000, state: 'visible' });
      console.log(`✅ 检测到内容元素: ${selector}`);
      contentFound = true;
      break;
    } catch (error) {
      // 继续尝试下一个选择器
    }
  }

  if (!contentFound) {
    console.log('⚠️ 未检测到常见内容元素，可能不是标准的微信公众号文章页面');
  }

  // 检查自定义选择器
  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout, state: 'visible' });
      console.log(`✅ 自定义选择器已找到: ${checkSelector}`);
    } catch (error) {
      console.log(`⚠️ 自定义选择器未找到: ${checkSelector}`);
      throw new Error('Required selector not found');
    }
  }

  // 再次等待确保动态内容渲染完成
  await page.waitForTimeout(2 * 1000);

  let headers = null, content = await page.content();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(x => x[0].toLowerCase() === "content-type")?.[1];
    if (ct && (ct[1].includes("application/json") || ct[1].includes("text/plain"))) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  // 内容完整性验证
  const title = await page.title();
  console.log(`📄 页面标题: ${title}`);

  if (!title || title === '微信公众平台' || title.includes('验证')) {
    console.log('⚠️ 警告：页面标题可能不正确，内容可能不完整');
  }

  // 检查页面内容是否包含错误标识
  if (content.includes('该内容被投诉且经审核涉嫌违规') ||
      content.includes('此内容因违规无法查看') ||
      content.includes('该内容已被发布者删除')) {
    console.log('⚠️ 检测到内容违规或已删除提示');
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
  };
};

app.get('/health', async (req: Request, res: Response) => {
  try {
    if (!browser || !context) {
      await initializeBrowser();
    }
    
    const testPage = await context.newPage();
    await testPage.close();
    
    res.status(200).json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'unhealthy', 
      error: error instanceof Error ? error.message : 'Unknown error occurred' 
    });
  }
});

app.post('/scrape', async (req: Request, res: Response) => {
  const { url, wait_after_load = 0, timeout = 60000, headers, check_selector }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!PROXY_SERVER) {
    console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.');
  }

  if (!browser || !context) {
    await initializeBrowser();
  }

  const page = await context.newPage();

  // Set headers if provided
  if (headers) {
    await page.setExtraHTTPHeaders(headers);
  }

  let result: Awaited<ReturnType<typeof scrapePage>>;
  try {
    // Strategy 1: Normal
    console.log('Attempting strategy 1: Normal load');
    result = await scrapePage(page, url, 'load', wait_after_load, timeout, check_selector);
  } catch (error) {
    console.log('Strategy 1 failed, attempting strategy 2: Wait until networkidle');
    try {
      // Strategy 2: Wait until networkidle
      result = await scrapePage(page, url, 'networkidle', wait_after_load, timeout, check_selector);
    } catch (finalError) {
      await page.close();
      return res.status(500).json({ error: 'An error occurred while fetching the page.' });
    }
  }

  // 验证页面内容完整性
  const validation = await validatePageContent(page);
  if (!validation.isValid) {
    console.log(`⚠️ 页面内容验证失败: ${validation.reason}`);
  } else {
    console.log(`✅ 页面内容验证通过`);
  }

  const pageError = result.status !== 200 ? getError(result.status) : undefined;

  if (!pageError) {
    console.log(`✅ Scrape successful!`);
  } else {
    console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`);
  }

  await page.close();

  res.json({
    content: result.content,
    pageStatusCode: result.status,
    contentType: result.contentType,
    contentValid: validation.isValid,
    ...(validation.reason && { validationWarning: validation.reason }),
    ...(pageError && { pageError })
  });
});

// 收集页面后，将结果直接 POST 到回调地址，减少经由公网的响应体传输
app.post('/scrape-and-post', async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load = 0,
    timeout = 60000,
    headers,
    check_selector,
    callback_url,
    callback_headers,
    metadata
  }: UrlModel & {
    callback_url: string;
    callback_headers?: { [key: string]: string };
    metadata?: unknown;
  } = req.body;

  console.log(`================= Scrape&Post Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Callback URL: ${callback_url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Callback Headers: ${callback_headers ? JSON.stringify(callback_headers) : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`========================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!callback_url) {
    return res.status(400).json({ error: 'callback_url is required' });
  }
  if (!isValidUrl(callback_url)) {
    return res.status(400).json({ error: 'Invalid callback_url' });
  }

  if (!PROXY_SERVER) {
    console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.');
  }

  if (!browser || !context) {
    await initializeBrowser();
  }

  const page = await context.newPage();
  if (headers) {
    await page.setExtraHTTPHeaders(headers);
  }

  let result: Awaited<ReturnType<typeof scrapePage>>;
  try {
    console.log('Attempting strategy 1: Normal load');
    result = await scrapePage(page, url, 'load', wait_after_load, timeout, check_selector);
  } catch (error) {
    console.log('Strategy 1 failed, attempting strategy 2: Wait until networkidle');
    try {
      result = await scrapePage(page, url, 'networkidle', wait_after_load, timeout, check_selector);
    } catch (finalError) {
      await page.close();
      return res.status(500).json({ error: 'An error occurred while fetching the page.' });
    }
  }

  // 验证页面内容完整性
  const validation = await validatePageContent(page);
  if (!validation.isValid) {
    console.log(`⚠️ 页面内容验证失败: ${validation.reason}`);
  } else {
    console.log(`✅ 页面内容验证通过`);
  }

  const pageError = result.status !== 200 ? getError(result.status) : undefined;
  await page.close();

  const payload = {
    url,
    content: result.content,
    pageStatusCode: result.status,
    contentType: result.contentType,
    contentValid: validation.isValid,
    ...(validation.reason && { validationWarning: validation.reason }),
    ...(pageError && { pageError }),
    ...(metadata !== undefined ? { metadata } : {})
  };

  try {
    const resp = await fetch(callback_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(callback_headers || {})
      },
      body: JSON.stringify(payload)
    });

    console.log(`Posted to callback. Status: ${resp.status}`);
    return res.status(200).json({ ok: true, callbackStatus: resp.status });
  } catch (postErr) {
    console.error('Failed to POST to callback:', postErr);
    return res.status(502).json({ error: 'Failed to POST to callback' });
  }
});

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port}`);
  });
});

process.on('SIGINT', () => {
  shutdownBrowser().then(() => {
    console.log('Browser closed');
    process.exit(0);
  });
});