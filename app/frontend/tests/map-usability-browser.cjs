// Map tile feedback regression. All tile requests are intercepted and fulfilled locally.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  let server;
  try {
    const appUrl = 'http://127.0.0.1:4181/tests/map-fixture.html';
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4181', '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { try { ready = (await fetch(appUrl)).ok; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    if (!ready) throw new Error('Vite map fixture did not start on port 4181.');

    const png = fs.readFileSync(path.resolve(process.cwd(), '../backend/demo_photos/demo-road-condition.png'));
    let mode = 'normal', tileRequests = 0, releaseSlow;
    let slowGate = new Promise(resolve => { releaseSlow = resolve; });
    const context = await browser.newContext();
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 44.8, longitude: 65.5, accuracy: 15 });
    await context.addInitScript(() => sessionStorage.setItem('roads-map:browser-fixture', JSON.stringify({ center: [48.5, 67.5], zoom: 8 })));
    const page = await context.newPage();
    await page.route('https://tile.openstreetmap.org/**', async route => {
      tileRequests++;
      if (mode === 'slow') await slowGate;
      if (mode === 'error') return route.abort('failed');
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: png });
    });

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.map-tile-feedback').waitFor({ state: 'detached', timeout: 5000 });
    console.log('mocked tile load passed');
    assert.ok(tileRequests > 0 && tileRequests < 20, `only visible mocked tiles requested (${tileRequests})`);
    let viewportKey = 'browser-fixture';
    const stored = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(`roads-map:${key}`)), viewportKey);
    const assertViewportClose = (actual, expected, message) => {
      assert.ok(Math.abs(actual.center[0] - expected.center[0]) < 0.005 && Math.abs(actual.center[1] - expected.center[1]) < 0.005 && actual.zoom === expected.zoom, message);
    };
    assert.deepEqual(await stored(), { center: [48.5, 67.5], zoom: 8 }, 'restored view is retained after initial route fit');

    await page.getByRole('button', { name: 'Change route geometry' }).click();
    await page.waitForTimeout(150);
    assertViewportClose(await stored(), { center: [48.5, 67.5], zoom: 8 }, 'route geometry updates do not override restored view');
    console.log('restored viewport passed');
    await page.getByRole('button', { name: 'Change map scope' }).click();
    viewportKey = 'other-scope';
    await page.waitForFunction(() => {
      const saved = JSON.parse(sessionStorage.getItem('roads-map:other-scope') || 'null');
      return saved && Math.abs(saved.center[0] - 10) < 0.02 && Math.abs(saved.center[1] - 10.01) < 0.02;
    });
    console.log('new viewport scope fits the new route');

    const panMap = async (x1, x2) => {
      const box = await page.locator('.leaflet-container').boundingBox();
      const y = Math.round(box.y + box.height / 2), startX = Math.round(box.x + box.width / 2);
      await page.mouse.move(startX, y); await page.mouse.down(); await page.mouse.move(startX + x1, y, { steps: 5 }); await page.mouse.up();
      if (x2) { await page.mouse.move(startX, y); await page.mouse.down(); await page.mouse.move(startX + x2, y, { steps: 5 }); await page.mouse.up(); }
    };
    mode = 'error';
    await panMap(600);
    await page.waitForTimeout(300);
    console.log(`tile requests after panning into error mode: ${tileRequests}; feedback: ${await page.locator('.map-tile-feedback').innerText().catch(()=>'none')}`);
    await page.getByRole('status').filter({ hasText: 'Не удалось загрузить карту' }).waitFor({ timeout: 5000 });
    console.log('tile error passed');
    const beforeRetry = await stored();
    mode = 'normal';
    await page.getByRole('button', { name: 'Повторить' }).click();
    await page.locator('.map-tile-feedback').waitFor({ state: 'detached' });
    assert.deepEqual(await stored(), beforeRetry, 'retry redraws tiles without changing map center and zoom');
    console.log('tile retry passed');

    mode = 'slow';
    await panMap(-260);
    await page.getByRole('status').filter({ hasText: 'Карта загружается дольше обычного' }).waitFor({ timeout: 7000 });
    releaseSlow();
    await page.locator('.map-tile-feedback').waitFor({ state: 'detached' });
    console.log('slow tile passed');
    await context.close();
    console.log(`Map tile feedback checks passed; intercepted ${tileRequests} visible tile requests.`);
  } finally {
    await browser.close();
    if (server) { server.kill(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
