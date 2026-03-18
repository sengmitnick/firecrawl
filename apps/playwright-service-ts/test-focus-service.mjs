/**
 * 真实服务场景模拟测试
 *
 * 模拟 playwright-service-ts 服务的完整流程：
 * 1. 连接 Chrome（connectOverCDP）
 * 2. 获取 context（contexts()[0]）
 * 3. 调用 newBackgroundPage()（完整复制服务代码逻辑）
 * 4. 用新 page 导航到一个真实 URL
 * 5. 关闭 page
 *
 * 分两个阶段测试：
 *   Phase A: 每步暂停 2s，你观察焦点在哪步被抢
 *   Phase B: 连续执行，确认修复有效
 *
 * 运行：/Users/zhangrunsheng/.nvm/versions/node/v20.19.2/bin/node test-focus-service.mjs
 */

import pkg from './node_modules/playwright-core/index.js';
const { chromium } = pkg;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ========== 完整复制 api.ts 里的 newBackgroundPage() 逻辑 ==========
async function newBackgroundPage(browser, context) {
  let cdpSession = null;
  try {
    cdpSession = await browser.newBrowserCDPSession();

    // 1. 记录创建前已存在的 pages
    const existingPages = context.pages();
    const firstExistingPage = existingPages[0];
    console.log(`  [newBackgroundPage] 当前 pages: ${existingPages.map(p => p.url().slice(0,40))}`);

    // 2. 提前注册 page 事件
    let resolveNewPage;
    const newPagePromise = new Promise(resolve => { resolveNewPage = resolve; });
    context.once('page', (page) => {
      console.log(`  [newBackgroundPage] 🎉 page 事件触发! url=${page.url()}`);
      resolveNewPage(page);
    });

    // 3. CDP 后台创建 tab
    // 根据 CDP 文档：background:false + focus:false 才是不抢焦点的正确组合
    // background:true + focus:false 仍可能激活 Chrome 窗口（Chromium bug #474238399）
    console.log(`  [newBackgroundPage] 发送 Target.createTarget(background:false, focus:false)...`);
    await cdpSession.send('Target.createTarget', {
      url: 'about:blank',
      background: false,
      focus: false,
    });

    // 4. 等待新 page
    const page = await Promise.race([
      newPagePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
    ]);
    console.log(`  [newBackgroundPage] 捕获到新 page`);

    // 5. 切回原 tab
    if (firstExistingPage) {
      try {
        const { targetInfos } = await cdpSession.send('Target.getTargets');
        const firstPageUrl = firstExistingPage.url();
        const originalTarget = targetInfos.find(t => t.type === 'page' && t.url === firstPageUrl);
        if (originalTarget) {
          console.log(`  [newBackgroundPage] 切回原 tab: ${firstPageUrl.slice(0,40)}`);
          await cdpSession.send('Target.activateTarget', { targetId: originalTarget.targetId });
        } else {
          console.log(`  [newBackgroundPage] ⚠️ 找不到原 tab URL: ${firstPageUrl.slice(0,40)}`);
          console.log(`  可用 page targets:`);
          targetInfos.filter(t => t.type === 'page').forEach(t =>
            console.log(`    - ${t.url.slice(0,50)}`)
          );
        }
      } catch (e) {
        console.log(`  [newBackgroundPage] 切回焦点失败: ${e.message}`);
      }
    }

    await cdpSession.detach();
    console.log(`  [newBackgroundPage] ✅ 完成（焦点应该没被抢）`);
    return page;

  } catch (err) {
    if (cdpSession) { try { await cdpSession.detach(); } catch {} }
    console.warn(`  [newBackgroundPage] ⚠️ 失败，回退到 newPage():`, err.message);
    return context.newPage();
  }
}
// ================================================================

;(async () => {
  console.log('=== 服务场景完整测试 ===\n');

  // 连接 Chrome
  let browser, ctx;
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 5000 });
    ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No existing context');
    console.log(`✅ 已连接 Chrome`);
    console.log(`当前 pages: ${ctx.pages().map(p => p.url().slice(0,50))}\n`);
  } catch (e) {
    console.error('❌ 无法连接 Chrome:', e.message);
    process.exit(1);
  }

  // ─────────── Phase A: 逐步观察 ───────────
  console.log('════ Phase A: 逐步观察（每步前暂停 2 秒，请切到其他 App 观察） ════\n');
  console.log('⏳ 3 秒后开始...');
  await sleep(3000);

  console.log('\n[1/3] 调用 newBackgroundPage()（内部会逐步执行）...');
  console.log('      请切到其他 App！观察是否被抢焦点');
  await sleep(2000);

  const page1 = await newBackgroundPage(browser, ctx);
  console.log(`\n[2/3] newBackgroundPage() 返回，准备导航...`);
  console.log(`      请继续观察焦点`);
  await sleep(2000);

  // 模拟导航（这一步也可能触发焦点）
  try {
    console.log(`[3/3] page.goto('https://example.com')...`);
    await page1.goto('https://example.com', { waitUntil: 'load', timeout: 15000 });
    console.log(`      ✅ 导航完成`);
  } catch(e) {
    console.log(`      导航失败: ${e.message}`);
  }

  await sleep(2000);
  await page1.close();
  console.log(`      page 已关闭\n`);

  // ─────────── Phase B: 快速连续测试 ───────────
  console.log('════ Phase B: 快速连续测试（模拟真实服务场景） ════\n');
  console.log('⏳ 3 秒后开始，请切到其他 App...');
  await sleep(3000);

  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- 第 ${i} 次请求 ---`);
    const t = Date.now();
    const page = await newBackgroundPage(browser, ctx);
    console.log(`  newBackgroundPage 耗时: ${Date.now() - t}ms`);
    try {
      await page.goto('https://example.com', { waitUntil: 'load', timeout: 15000 });
      console.log(`  ✅ 导航完成`);
    } catch(e) {
      console.log(`  导航失败: ${e.message}`);
    }
    await page.close();
    console.log(`  page 已关闭`);
    await sleep(500);
  }

  await browser.close();

  console.log('\n=== 测试完成 ===');
  console.log('请报告：哪一步（Phase A 的哪个步骤？还是 Phase B 的哪次请求？）让 Chrome/焦点弹出来了？');
})();
