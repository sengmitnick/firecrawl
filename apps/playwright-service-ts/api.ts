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

const scrapePage = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined) => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  // 缩短初始等待，优先检测验证元素
  await page.waitForTimeout(3 * 1000);

  // 检测并处理微信验证（最多尝试2次）
  let verifyAttempts = 0;
  const maxVerifyAttempts = 2;

  while (verifyAttempts < maxVerifyAttempts) {
    const jsVerifyElement = page.locator('a#js_verify').first();
    const hasJsVerifyElement = await jsVerifyElement.count() > 0;

    if (hasJsVerifyElement) {
      verifyAttempts++;
      console.log(`⚠️ 检测到验证元素 a#js_verify (尝试 ${verifyAttempts}/${maxVerifyAttempts})，准备点击验证按钮`);

      try {
        // 点击验证按钮
        await jsVerifyElement.click();
        console.log('✅ 已点击验证按钮，等待页面加载...');

        // 等待页面可能的导航/刷新
        try {
          await page.waitForLoadState('networkidle', { timeout: 15000 });
          console.log('✅ 页面已重新加载');
        } catch (e) {
          console.log('⚠️ 页面加载超时，继续处理');
        }

        // 等待验证元素消失或内容元素出现
        await page.waitForTimeout(3 * 1000);

        // 检查验证是否成功（验证元素应该消失）
        const verifyStillExists = await page.locator('a#js_verify').count() > 0;
        if (!verifyStillExists) {
          console.log('✅ 验证成功，验证元素已消失');
          break;
        } else {
          console.log('⚠️ 验证元素仍然存在，可能需要重试');
          if (verifyAttempts < maxVerifyAttempts) {
            await page.waitForTimeout(2 * 1000);
          }
        }
      } catch (error) {
        console.log(`❌ 点击验证按钮失败 (尝试 ${verifyAttempts}):`, error);
        await page.waitForTimeout(3 * 1000);
      }
    } else {
      console.log('✅ 未检测到验证元素 a#js_verify');
      break;
    }
  }

  // 等待微信公众号文章的关键内容元素加载（更加准确的选择器）
  const contentSelectors = [
    '#activity-name',                    // 文章标题（新版）
    '#js_content',                       // 文章内容（核心）
    'div.rich_media_content',            // 富媒体内容（核心）
    'div#page-content',                  // 页面内容
  ];

  let contentLoaded = false;
  for (const selector of contentSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 8000, state: 'visible' });
      console.log(`✅ 内容元素已加载: ${selector}`);
      contentLoaded = true;
      break;
    } catch (error) {
      // 继续尝试下一个选择器
    }
  }

  if (!contentLoaded) {
    console.log('⚠️ 未检测到标准内容元素，可能不是微信公众号文章或被拦截');
    // 即使没有检测到标准元素，也等待一段时间让页面完全加载
    await page.waitForTimeout(3 * 1000);
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

  // 最后等待一小段时间确保动态内容渲染
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

  // 验证内容完整性
  const title = await page.title();
  console.log(`📄 页面标题: ${title}`);

  // 检查是否仍然被拦截或验证失败
  const isBlocked = !title || title === '微信公众平台' || title.includes('登录') || title.includes('验证');
  const hasVerifyElement = await page.locator('a#js_verify').count() > 0;

  if (isBlocked) {
    console.log('❌ 页面标题异常，内容可能不完整或被拦截');
  }

  if (hasVerifyElement) {
    console.log('❌ 验证元素仍然存在，验证未成功完成');
  }

  // 检查HTML内容是否实际有内容（非空白）
  const htmlLength = content.length;
  const hasSubstantialContent = htmlLength > 5000; // 正常的微信文章HTML应该至少有5KB
  console.log(`📊 HTML内容长度: ${htmlLength} bytes`);

  if (!hasSubstantialContent) {
    console.log('⚠️ 警告：HTML内容过短，可能获取不完整');
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
    pageTitle: title,
    contentLoaded,
    isBlocked,
    hasVerifyElement,
    contentLength: htmlLength,
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

  const pageError = result.status !== 200 ? getError(result.status) : undefined;
  await page.close();

  const payload = {
    url,
    content: result.content,
    pageStatusCode: result.status,
    contentType: result.contentType,
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