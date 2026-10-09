const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
(async()=>{let server;const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const base='http://127.0.0.1:4182';server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4182','--strictPort'],{cwd:process.cwd(),stdio:'ignore',windowsHide:true});
 let ready=false;for(let i=0;i<60&&!ready;i++){try{ready=(await fetch(base)).ok}catch{await new Promise(r=>setTimeout(r,100))}}assert.ok(ready);
 const png=fs.readFileSync('../backend/demo_photos/demo-road-condition.png');
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'UTC',permissions:['geolocation'],geolocation:{latitude:44.85,longitude:65.49,accuracy:3000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://tile.openstreetmap.org/**',r=>r.fulfill({contentType:'image/png',body:png}));
  await page.goto(base+'/tests/track-fixture.html');await page.getByRole('heading',{name:'Фактический путь инспектора'}).waitFor();
  await page.getByText(/30 точек ·/).waitFor();assert.ok(await page.locator('.leaflet-container canvas').count());
  await page.getByRole('slider',{name:'Позиция по времени'}).fill('15');
  assert.match(await page.locator('.track-selected').innerText(),/3000 м.*приблизительная/);
  await page.waitForFunction(()=>{const view=JSON.parse(sessionStorage.getItem('roads-map:track-history:history-one')||'null');return view&&Math.abs(view.center[0]-44.8515)<.0001&&view.zoom===10});
  await page.getByText('Все GPS-точки и время (30)',{exact:true}).click();assert.equal(await page.locator('.track-point-list button').count(),25);
  await page.getByRole('button',{name:'Далее',exact:true}).click();assert.equal(await page.locator('.track-point-list button').count(),5);
  await page.locator('.track-point-list button').last().click();assert.match(await page.locator('.track-selected').innerText(),/65.492900/);
  await page.getByText(/Причины разрывов/).click();assert.match(await page.locator('.track-history').innerText(),/Перерыв записи более минуты/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const out=path.resolve('../docs/screenshots/history');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,`history-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'Другой осмотр'}).click();await page.getByText(/1 точек ·/).waitFor();assert.match(await page.locator('.track-selected').innerText(),/Выберите время/);
  await page.getByRole('button',{name:'Карта устройства',exact:true}).click();
  await page.getByText('Приблизительная позиция: ±3000 м',{exact:true}).waitFor();
  await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('roads-map:device-fixture')||'null')?.zoom===10);
  await context.setGeolocation({latitude:44.87,longitude:65.51,accuracy:8});
  await page.getByText('Точность позиции: ±8 м',{exact:true}).waitFor();
  await page.waitForFunction(()=>{const v=JSON.parse(sessionStorage.getItem('roads-map:device-fixture')||'null');return v&&v.zoom===15&&Math.abs(v.center[0]-44.87)<.0001});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,history:true,selection:true,gaps:true,pagination:true,errors}));await context.close();
 }
 }finally{await browser.close();server?.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
