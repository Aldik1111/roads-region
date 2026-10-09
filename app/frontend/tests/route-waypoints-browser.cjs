// Exercises the dispatcher route planner against local API and tile mocks only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  let server;
  try {
    const appUrl = 'http://127.0.0.1:4182/tests/route-waypoints-fixture.html';
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4182', '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) { try { ready = (await fetch(appUrl)).ok; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    if (!ready) throw new Error('Vite waypoint fixture did not start on port 4182.');

    const tile = fs.readFileSync(path.resolve(process.cwd(), '../backend/demo_photos/demo-road-condition.png'));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 48, longitude: 67, accuracy: 12 });
    const page = await context.newPage();
    const previews = [], saved = [], tileUrls = [];
    const waitPreviews = async count => { for (let i=0;i<100 && previews.length<count;i++) await new Promise(resolve=>setTimeout(resolve,50)); assert.ok(previews.length>=count,`expected ${count} route previews, got ${previews.length}`); };
    let latestPreview = null;
    await page.route('https://tile.openstreetmap.org/**', route => { tileUrls.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: tile }); });
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), pathName = url.pathname;
      if (pathName === '/api/bootstrap') return route.fulfill({ json: { user: { id: 'dispatcher-test', name: 'Test dispatcher', email: 'dispatcher@example.invalid', role: 'dispatcher' }, sections: [], contractors: [], inspectors: [{ id: 'inspector-test', name: 'Inspector One', email: 'inspector@example.invalid', role: 'inspector' }] } });
      if (pathName === '/api/routes' && request.method() === 'GET') return route.fulfill({ json: saved });
      if (pathName === '/api/routes/preview' && request.method() === 'POST') {
        const body = request.postDataJSON(); previews.push(body);
        latestPreview = { id: `preview-${previews.length}`, expires_at: '2027-01-01T00:00:00Z', start: body.start, via: body.via || [], end: body.end, options: [{ id: `option-${previews.length}`, geometry: { type: 'LineString', coordinates: [body.start, ...(body.via || []), body.end].map(p => [p.lng, p.lat]) }, distance_m: 10000, duration_s: 900, summary: 'Маршрут через заданные точки' }], decision_points: [], provider: 'MockRouter' };
        return route.fulfill({ json: latestPreview });
      }
      if (pathName === '/api/routes' && request.method() === 'POST') {
        const body = request.postDataJSON(); saved.push({ id: 'saved-route-1', name: body.name, code: 'R-1', length_km: 10, geometry: latestPreview.options[0].geometry, responsible: '', is_demo: false, inspector_id: 'inspector-test', inspector_name: 'Inspector One', notes: body.notes, created_at: '2026-01-01T00:00:00Z', state: 'assigned', duration_min: 15, source: 'osrm', start: latestPreview.start, via: latestPreview.via, end: latestPreview.end });
        return route.fulfill({ json: saved[0] });
      }
      if (/\/api\/routes\/[^/]+\/results$/.test(pathName)) return route.fulfill({ json: { route: saved[0], inspections: [], defects: [] } });
      return route.fulfill({ status: 404, json: { detail: { code: 'NOT_FOUND', message: `Unexpected ${request.method()} ${pathName}` } } });
    });

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Маршруты обследования' }).waitFor();
    await page.getByText('Ввести координаты вручную').click();
    const input = async (label, value) => page.getByLabel(label).fill(value);
    await input('Широта: начало', '47'); await input('Долгота: начало', '66');
    await page.getByRole('button', { name: 'Задать точку', exact: false }).nth(0).click();
    await input('Широта: конец', '49'); await input('Долгота: конец', '68');
    await page.getByRole('button', { name: 'Задать точку', exact: false }).nth(1).click();
    await page.getByText('Маршрут через заданные точки').waitFor();
    assert.equal(previews.at(-1).start.lat, 47);
    assert.equal(previews.at(-1).end.lat, 49);
    assert.deepEqual(previews.at(-1).via, []);

    await page.getByRole('button', { name: 'Добавить промежуточную точку' }).click();
    const map = page.locator('.rp-map-frame .leaflet-container');
    await map.scrollIntoViewIfNeeded();
    let box = await map.boundingBox();
    await map.click({ position: { x: box.width * .15, y: box.height * .15 } });
    await waitPreviews(2);
    await page.getByRole('group', { name: 'Промежуточные точки' }).waitFor();
    await page.getByRole('button', { name: 'Добавить промежуточную точку' }).click();
    await map.scrollIntoViewIfNeeded();
    box = await map.boundingBox();
    await map.click({ position: { x: box.width * .18, y: box.height * .45 } });
    await waitPreviews(3);
    const beforeReorder = previews.at(-1).via;
    await page.getByRole('button', { name: 'Переместить точку 2 вверх' }).click();
    await waitPreviews(4);
    assert.equal(previews.at(-1).via.length, 2);
    assert.deepEqual(previews.at(-1).via, beforeReorder.slice().reverse(), 'reordering invalidates and rebuilds preview in the new order');
    const currentPreviewCount = previews.length;
    await page.getByRole('button', { name: 'Удалить точку 2' }).click();
    await waitPreviews(currentPreviewCount + 1);
    assert.equal(previews.at(-1).via.length, 1, 'removing a via point invalidates and rebuilds preview');
    const beforeEdit = previews.at(-1).via[0];
    await page.getByRole('button', { name: 'Изменить точку 1' }).click();
    await map.scrollIntoViewIfNeeded();
    box = await map.boundingBox();
    await map.click({ position: { x: box.width * .72, y: box.height * .73 } });
    await waitPreviews(currentPreviewCount + 2);
    assert.notDeepEqual(previews.at(-1).via[0], beforeEdit, 'editing a via point on the map invalidates and rebuilds preview');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Добавить промежуточную точку' }).click();
    await map.scrollIntoViewIfNeeded();
    box = await map.boundingBox();
    await map.click({ position: { x: box.width * .34, y: box.height * .55 } });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.rp-via-row').count(), 2, `mobile map click should add a via point (help: ${await page.locator('.rp-map-help').innerText()})`);
    await waitPreviews(previews.length);
    assert.equal(previews.at(-1).via.length, 2, 'adding a via point works on mobile');
    const mobileCount = previews.length;
    await page.getByRole('button', { name: 'Удалить точку 2' }).click();
    await waitPreviews(mobileCount + 1);
    assert.equal(previews.at(-1).via.length, 1, 'removing a via point works on mobile');
    const mobileDimensions = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: window.innerWidth, offenders: [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0,8).map(el => `${el.className?.baseVal || el.className}:${Math.round(el.getBoundingClientRect().right)}`) }));
    assert.ok(mobileDimensions.body <= mobileDimensions.viewport + 1, `no horizontal overflow while editing vias at 390px: ${JSON.stringify(mobileDimensions)}`);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('Название маршрута').fill('Малые дороги и развилки');
    await page.getByLabel('Инспектор').selectOption('inspector-test');
    await page.getByRole('button', { name: 'Сохранить маршрут и назначить' }).click();
    await page.getByText('Маршрут «Малые дороги и развилки» назначен Inspector One.').waitFor();
    assert.equal(saved[0].via.length, 1, 'saved route preserves the ordered via point from preview');
    assert.ok(tileUrls.length > 0 && tileUrls.length < 60, `only visible tiles were mocked (${tileUrls.length})`);

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 920 });
      await page.waitForTimeout(100);
      const dimensions = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: window.innerWidth }));
      assert.ok(dimensions.body <= dimensions.viewport + 1, `no horizontal overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    }
    await context.close();
    console.log(`Waypoint UI passed at 1440px and 390px; ${previews.length} previews and ${tileUrls.length} mocked visible tiles.`);
  } finally { await browser.close(); if (server) server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
