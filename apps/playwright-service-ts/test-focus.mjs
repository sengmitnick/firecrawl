/**
 * focus-steal 诊断测试脚本
 *
 * 用途：逐步执行 newBackgroundPage() 的每个关键步骤，每步之间暂停 2 秒，
 *       让你观察哪一步导致 Chrome 窗口跑到最前面 / macOS 焦点丢失。
 *
 * 运行：node test-focus.mjs
 * 前提：Chrome 需要以 --remote-debugging-port=9222 运行
 *
 * 观测方法：
 *   运行脚本后，把焦点切到 Terminal 或其他 App，然后观察：
 *   - 每一步之间有 2s 停顿，控制台会打印"▶ 即将执行..."
 *   - 如果在某步执行期间 Chrome 弹出来，控制台会显示是哪一步导致的
 */

import pkg from './node_modules/playwright-core/index.js';
const { chromium } = pkg;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function step(label, fn) {
  console.log(`\n▶ 即将执行步骤: ${label}`);
  console.log(`  （你有 2 秒切换焦点到其他 App，然后观察这步是否抢焦点）`);
  await sleep(2000);
  console.log(`  ⚡ 执行中...`);
  const result = await fn();
  console.log(`  ✅ 完成: ${label}`);
  return result;
}

;(async () => {
  console.log('=== newBackgroundPage() 焦点抢占诊断 ===');
  console.log('请把当前焦点放在这个 Terminal 窗口，观察哪一步让 Chrome 弹出来\n');

  // ── 连接 Chrome ──
  let browser, ctx, cdpSession;
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 5000 });
    ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No existing context');
    console.log(`✅ 已连接 Chrome，当前 pages:`);
    ctx.pages().forEach((p, i) => console.log(`   [${i}] ${p.url().slice(0, 60)}`));
  } catch (e) {
    console.error('❌ 无法连接 Chrome:', e.message);
    console.error('   请确保 Chrome 以 --remote-debugging-port=9222 运行');
    process.exit(1);
  }

  const existingPages = ctx.pages();
  const firstPage = existingPages[0];
  console.log(`\n📌 记录第一个 page: ${firstPage?.url().slice(0, 60)}`);

  // ── STEP 1: newBrowserCDPSession ──
  cdpSession = await step('browser.newBrowserCDPSession()', async () => {
    return await browser.newBrowserCDPSession();
  });

  // ── STEP 2: 注册 page 事件 ──
  let resolveNewPage;
  const newPagePromise = new Promise(resolve => { resolveNewPage = resolve; });
  await step('context.once("page", ...) 注册监听', async () => {
    ctx.once('page', (page) => {
      console.log(`  🎉 page 事件触发! url=${page.url()}`);
      resolveNewPage(page);
    });
  });

  // ── STEP 3: Target.createTarget（最关键的一步）──
  // 根据 CDP 文档：background:false + focus:false 才是不抢焦点的正确组合
  // background:true 不能防止窗口被激活（Chromium bug #474238399）
  let newPage;
  await step('CDP Target.createTarget(background:false, focus:false)', async () => {
    await cdpSession.send('Target.createTarget', {
      url: 'about:blank',
      background: false,
      focus: false,
    });
    // 等待 page 事件
    newPage = await Promise.race([
      newPagePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    return newPage;
  });
  console.log(`  新 page url: ${newPage?.url()}`);

  // ── STEP 4: Target.getTargets ──
  let targetInfos;
  await step('CDP Target.getTargets()', async () => {
    const result = await cdpSession.send('Target.getTargets');
    targetInfos = result.targetInfos;
    console.log(`  共 ${targetInfos.length} 个 targets`);
    targetInfos.filter(t => t.type === 'page').forEach(t =>
      console.log(`   - [${t.targetId.slice(0,8)}] ${t.url.slice(0,50)}`)
    );
  });

  // ── STEP 5: Target.activateTarget（切回原 tab）──
  if (firstPage) {
    await step('CDP Target.activateTarget(originalTarget)', async () => {
      const firstPageUrl = firstPage.url();
      const originalTarget = targetInfos.find(t => t.type === 'page' && t.url === firstPageUrl);
      if (originalTarget) {
        console.log(`  切回 tab: ${firstPageUrl.slice(0, 50)}`);
        await cdpSession.send('Target.activateTarget', { targetId: originalTarget.targetId });
      } else {
        console.log(`  ⚠️ 找不到原始 tab (url=${firstPageUrl.slice(0,40)})`);
        console.log(`  可用的 page targets:`);
        targetInfos.filter(t => t.type === 'page').forEach(t =>
          console.log(`   - ${t.url.slice(0,50)}`)
        );
      }
    });
  }

  // ── STEP 6: cdpSession.detach ──
  await step('cdpSession.detach()', async () => {
    await cdpSession.detach();
  });

  // ── 清理 ──
  console.log('\n─── 清理阶段（关闭新 page）───');
  if (newPage) {
    await newPage.close();
    console.log('✅ 新 page 已关闭');
  }

  await browser.close();
  console.log('\n=== 诊断完成 ===');
  console.log('请告知：哪一步执行后 Chrome 弹出来了？');
})();
