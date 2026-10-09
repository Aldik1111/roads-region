// Real IndexedDB offline queue regression. By default this starts Vite on port 4179;
// APP_URL, when supplied, must point to a Vite dev server: npm run test:field-queue
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  let viteServer;
  try {
    const appUrl = process.env.APP_URL || 'http://127.0.0.1:4179';
    if (!process.env.APP_URL) {
      viteServer = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4179', '--strictPort'], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready; attempt++) {
        try { ready = (await fetch(appUrl)).ok; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!ready) throw new Error('Vite test server did not start on port 4179.');
    }
    const context = await browser.newContext();
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 44.8, longitude: 65.5, accuracy: 18 });
    const page = await context.newPage();
    const owner = { id: 'offline-owner-a', role: 'inspector', name: 'Offline A', email: 'a@example.invalid' };
    let fileUploads = 0, defectAttempts = 0, failFirstDefect = true, apiOwner = owner.id;
    let releaseUpload, markUploadStarted;
    const uploadStarted = new Promise(resolve => { markUploadStarted = resolve; });
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    const ownerHeaders = [];
    const idempotencyKeys = [], uploadKeys = [], sentOrder = [];
    await page.route('**/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/me') return route.fulfill({ json: { ...owner, id: apiOwner } });
      if (pathname === '/api/bootstrap') return route.fulfill({ json: { user: owner, sections: [], contractors: [], inspectors: [owner] } });
      if (pathname === '/api/inspections') return route.fulfill({ json: [] });
      if (pathname === '/api/defects' && request.method() === 'GET') return route.fulfill({ json: [] });
      if (pathname === '/api/files') {
        fileUploads++;
        ownerHeaders.push(request.headers()['x-field-owner']);
        uploadKeys.push(request.headers()['idempotency-key']);
        if (fileUploads === 1) { markUploadStarted(); await uploadGate; }
        return route.fulfill({ json: { id: `remote-photo-${fileUploads}`, name: 'road.png', url: 'https://example.invalid/photo.png' } });
      }
      if (pathname === '/api/defects' && request.method() === 'POST') {
        defectAttempts++;
        ownerHeaders.push(request.headers()['x-field-owner']);
        idempotencyKeys.push(request.headers()['idempotency-key']);
        sentOrder.push('defect');
        if (failFirstDefect) { failFirstDefect = false; return route.abort('failed'); }
        return route.fulfill({ json: { id: 'defect-created', number: 'TEST-1', photos: request.postDataJSON().photo_ids } });
      }
      if (pathname.endsWith('/points')) { ownerHeaders.push(request.headers()['x-field-owner']); sentOrder.push('points'); return route.fulfill({ json: { id: 'points-ok' } }); }
      if (pathname.endsWith('/finish')) { ownerHeaders.push(request.headers()['x-field-owner']); sentOrder.push('finish'); return route.fulfill({ json: { id: 'finish-ok' } }); }
      return route.fulfill({ status: 404, json: { code: 'NOT_FOUND', message: `Unexpected ${request.method()} ${pathname}` } });
    });

    const unavailableContext = await browser.newContext();
    const unavailablePage = await unavailableContext.newPage();
    await unavailablePage.addInitScript(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }));
    await unavailablePage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    const unavailableWrite = await unavailablePage.evaluate(async () => {
      const { fieldStorage } = await import('/src/fieldStorage.ts');
      try { await fieldStorage.set('unavailable-owner', 'draft', { text: 'must not silently succeed' }); return { succeeded: true }; }
      catch (error) { return { succeeded: false, name: error.name, message: error.message }; }
    });
    assert.equal(unavailableWrite.succeeded, false, 'storage unavailability must reject the draft write');
    assert.equal(unavailableWrite.name, 'FieldStorageError');
    assert.match(unavailableWrite.message, /недоступно/i);
    await unavailableContext.close();

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    const png = fs.readFileSync(path.resolve(__dirname, '../../backend/demo_photos/demo-road-condition.png')).toString('base64');
    const staged = await page.evaluate(async encoded => {
      const [storage, queue] = await Promise.all([import('/src/fieldStorage.ts'), import('/src/fieldQueue.ts')]);
      await storage.fieldStorage.remove('offline-owner-a', 'draft:sample');
      await storage.fieldStorage.remove('offline-owner-b', 'draft:sample');
      const fileBytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      const file = new File([fileBytes], 'road.png', { type: 'image/png' });
      await Promise.all([
        storage.fieldStorage.set('offline-owner-a', 'draft:sample', { text: 'first' }),
        storage.fieldStorage.set('offline-owner-a', 'draft:sample', { text: 'last write wins' }),
      ]);
      await storage.fieldStorage.set('offline-owner-b', 'draft:sample', { text: 'isolated' });
      const photo = await queue.stageFieldPhoto('offline-owner-a', file);
      const photoWithoutMime = await queue.stageFieldPhoto('offline-owner-a', new File([fileBytes], 'road-unknown.bin', { type: '' }));
      const storedPhoto = await storage.fieldStorage.get('offline-owner-a', `photo:${photo.id}`);
      let rejectedInvalid = false;
      try { await queue.stageFieldPhoto('offline-owner-a', new File([new Uint8Array([1, 2, 3])], 'spoof.png', { type: 'image/png' })); }
      catch { rejectedInvalid = true; }
      await queue.enqueueFieldJob('offline-owner-a', { id: 'stable-defect-job', kind: 'defect', body: { section_id: 'route-a', photo_ids: [photo.id] } });
      await queue.enqueueFieldJob('offline-owner-a', { id: 'stable-points-job', kind: 'points', inspectionId: 'inspection-a', body: { points: [{ client_id: 'point-stable-1', lat: 44.8, lng: 65.5, recorded_at: new Date().toISOString() }] } });
      await queue.enqueueFieldJob('offline-owner-a', { id: 'stable-finish-job', kind: 'finish', inspectionId: 'inspection-a', body: { confirmed: true } });
      const jobs = await queue.listFieldJobs('offline-owner-a');
      return { photo, photoWithoutMime, storedPhotoSize: storedPhoto.file.size, rejectedInvalid, jobs: jobs.map(job => ({ id: job.id, status: job.status, order: job.order })), draft: await storage.fieldStorage.get('offline-owner-a', 'draft:sample'), otherDraft: await storage.fieldStorage.get('offline-owner-b', 'draft:sample') };
    }, png);
    assert.equal(staged.draft.text, 'last write wins');
    assert.equal(staged.otherDraft.text, 'isolated');
    assert.ok(staged.photo.id.startsWith('local-photo-'));
    assert.ok(staged.photo.url.startsWith('data:image/png;base64,'));
    assert.ok(staged.photoWithoutMime.url.startsWith('data:image/png;base64,'), 'image bytes, not a missing MIME type, determine the decoded preview');
    assert.ok(staged.storedPhotoSize > 0, 'the original image blob is durably preserved');
    assert.equal(staged.rejectedInvalid, true, 'spoofed MIME is rejected when image bytes cannot decode');
    assert.deepEqual(staged.jobs.map(job => job.id), ['stable-defect-job', 'stable-points-job', 'stable-finish-job']);
    assert.deepEqual(staged.jobs.map(job => job.order), [1, 2, 3]);

    const flushPending = page.evaluate(async () => {
      const queue = await import('/src/fieldQueue.ts');
      try { await queue.flushFieldQueue('offline-owner-a'); return 'unexpected-success'; }
      catch (error) { return error.message; }
    });
    await uploadStarted;
    const concurrentEnqueue = page.evaluate(async () => {
      const queue = await import('/src/fieldQueue.ts');
      await queue.enqueueFieldJob('offline-owner-a', { id: 'during-upload-points', kind: 'points', inspectionId: 'inspection-a', body: { points: [{ client_id: 'point-stable-2', lat: 44.9, lng: 65.6, recorded_at: new Date().toISOString() }] } });
      return 'done';
    });
    const enqueueState = await Promise.race([concurrentEnqueue, new Promise(resolve => setTimeout(() => resolve('blocked-by-network'), 1500))]);
    releaseUpload();
    const firstFlush = await flushPending;
    assert.equal(enqueueState, 'done', 'durable enqueue remains available while another tab worker is uploading');
    assert.match(firstFlush, /связаться|сервер|повтор/i);
    assert.equal(fileUploads, 1, 'photo upload is confirmed before the mutation attempt');
    assert.equal(defectAttempts, 1);
    const afterLostResponse = await page.evaluate(async photoId => {
      const queue = await import('/src/fieldQueue.ts');
      const storage = await import('/src/fieldStorage.ts');
      return { jobs: await queue.listFieldJobs('offline-owner-a'), remote: await storage.fieldStorage.get('offline-owner-a', `remote-photo:${photoId}`) };
    }, staged.photo.id);
    assert.equal(afterLostResponse.jobs[0].status, 'error');
    assert.match(afterLostResponse.jobs[0].error, /связаться/i);
    assert.equal(afterLostResponse.remote.id, 'remote-photo-1', 'confirmed upload mapping is durable before defect POST');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const persisted = await page.evaluate(async photoId => {
      const queue = await import('/src/fieldQueue.ts');
      const storage = await import('/src/fieldStorage.ts');
      const jobs = await queue.listFieldJobs('offline-owner-a');
      const photo = await storage.fieldStorage.get('offline-owner-a', `photo:${photoId}`);
      return { draft: await storage.fieldStorage.get('offline-owner-a', 'draft:sample'), photoSize: photo.file.size, jobs: jobs.map(job => ({ id: job.id, status: job.status, order: job.order })) };
    }, staged.photo.id);
    assert.equal(persisted.draft.text, 'last write wins', 'draft survives a page reload');
    assert.ok(persisted.photoSize > 0, 'original staged Blob survives a page reload');
    assert.deepEqual(persisted.jobs.map(job => job.id), ['stable-defect-job', 'stable-points-job', 'stable-finish-job', 'during-upload-points']);
    assert.equal(persisted.jobs[0].status, 'error', 'failed job survives a page reload');

    apiOwner = 'offline-owner-b';
    await page.evaluate(async () => {
      const queue = await import('/src/fieldQueue.ts');
      await queue.enqueueFieldJob('offline-owner-b', { id: 'wrong-owner-job', kind: 'finish', inspectionId: 'inspection-b', body: { confirmed: true } });
    });
    const mismatch = await page.evaluate(async () => {
      const queue = await import('/src/fieldQueue.ts');
      try { await queue.flushFieldQueue('offline-owner-a'); return 'unexpected-success'; }
      catch (error) { return error.name; }
    });
    assert.equal(mismatch, 'FieldQueueOwnerMismatch');
    assert.equal(defectAttempts, 1, 'owner mismatch blocks all queued mutations');
    apiOwner = owner.id;

    await page.evaluate(async () => {
      const queue = await import('/src/fieldQueue.ts');
      await queue.flushFieldQueue('offline-owner-a');
    });
    assert.equal(fileUploads, 1, 'persisted photo mapping avoids duplicate upload after a lost mutation response');
    assert.deepEqual(uploadKeys, [staged.photo.id], 'photo retries use the stable local photo idempotency key');
    assert.equal(defectAttempts, 2);
    assert.deepEqual(idempotencyKeys, ['stable-defect-job', 'stable-defect-job']);
    assert.deepEqual(sentOrder, ['defect', 'defect', 'points', 'finish', 'points'], 'the FIFO worker processes defect, points, finish, then concurrent enqueue');
    assert.ok(ownerHeaders.every(value => value === owner.id), 'upload and mutation requests carry the queue owner header');
    const finalState = await page.evaluate(async photoId => {
      const queue = await import('/src/fieldQueue.ts');
      const storage = await import('/src/fieldStorage.ts');
      await queue.enqueueFieldJob('offline-owner-a', { id: 'stable-defect-job', kind: 'defect', body: { section_id: 'route-a', photo_ids: [photoId] } });
      let mismatch = '';
      try { await queue.enqueueFieldJob('offline-owner-a', { id: 'stable-defect-job', kind: 'defect', body: { section_id: 'changed-body', photo_ids: [photoId] } }); }
      catch (error) { mismatch = error.message; }
      return { jobs: await queue.listFieldJobs('offline-owner-a'), receipt: await storage.fieldStorage.get('offline-owner-a', 'receipt:stable-defect-job'), staged: await storage.fieldStorage.get('offline-owner-a', `photo:${photoId}`), ownerBKeys: await storage.fieldStorage.keys('offline-owner-b', 'job:'), mismatch };
    }, staged.photo.id);
    assert.equal(finalState.jobs.length, 0, 'jobs are removed only after server confirmation');
    assert.equal(finalState.receipt.result.id, 'defect-created');
    assert.equal(finalState.staged.name, 'road.png', 'staged original remains available for draft restoration after confirmation');
    assert.match(finalState.mismatch, /другими данными/, 'same job ID cannot be reused with a different payload');
    assert.deepEqual(finalState.ownerBKeys, ['job:wrong-owner-job']);
    await context.close();
    console.log(JSON.stringify({ passed: true, checks: ['unavailable storage rejects explicitly', 'real IndexedDB persistence', 'last-write serialization', 'owner isolation', 'decoded image staging', 'lost response retry keys', 'photo mapping survives retry', 'enqueue while network worker is blocked', 'FIFO finish order', 'owner verification before mutation'] }, null, 2));
  } finally { await browser.close(); viteServer?.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
