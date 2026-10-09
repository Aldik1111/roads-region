const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
 for(const width of [1440,390]) {
 const context=await browser.newContext({viewport:{width,height:1000}});
 const page=await context.newPage(); page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install();
 await page.addInitScript(()=>{
  const callbacks=new Map();let next=0;
  const permission={state:'granted',onchange:null};
  Object.defineProperty(navigator,'permissions',{value:{query:async()=>permission}});
  Object.defineProperty(navigator,'geolocation',{value:{watchPosition(ok,error){const id=++next;callbacks.set(id,{ok,error});return id;},clearWatch(id){callbacks.delete(id);},getCurrentPosition(ok,error){callbacks.set(++next,{ok,error});}}});
  window.fix=()=>{for(const c of [...callbacks.values()])c.ok({timestamp:Date.now(),coords:{latitude:44.848,longitude:65.482,accuracy:12}});};
  window.lose=()=>{for(const c of [...callbacks.values()])c.error({code:2});};
  window.deny=()=>{permission.state='denied';permission.onchange?.();};
 });
 const user={id:'test-inspector',role:'inspector',name:'Тест инспектора',email:'test@example.invalid'};
 const section={id:'test-route',name:'Тестовый маршрут',code:'TEST',length_km:2,geometry:{type:'LineString',coordinates:[[65.482,44.848],[65.49,44.86]]},responsible:'test',is_demo:true,inspector_id:user.id,inspector_name:user.name,notes:'',state:'in_progress',duration_min:5,source:'demo'};
 const inspection={id:'test-inspection',section_id:section.id,inspector_id:user.id,started_at:new Date().toISOString(),finished_at:null,status:'active',confirmed:false,points:[]};
 let pointRequests=0,uploads=0;
 await page.route('**/api/**',async r=>{
  const u=new URL(r.request().url()).pathname;
  let body;
  if(u==='/api/health')body={ok:true,demo:true};
   else if(u==='/api/notifications')body=[];
   else if(u==='/api/me')body=user;
  else if(u==='/api/bootstrap')body={user,sections:[section],contractors:[],inspectors:[user]};
  else if(u==='/api/inspections')body=[inspection];
  else if(u==='/api/defects')body=[];
  else if(u.endsWith('/points')){pointRequests++;inspection.points.push(...r.request().postDataJSON().points);body=inspection;}
  else if(u==='/api/files'){uploads++;body={id:'test-photo-'+uploads,name:'test.png',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII='};}
  else throw new Error('Unexpected request '+u);
  await r.fulfill({json:body});
 });
 await page.goto(process.env.APP_URL || 'http://127.0.0.1:8000',{waitUntil:'domcontentloaded'});await page.locator('.inspector-gps-gate').waitFor();
 await page.evaluate(()=>window.fix());await page.locator('.inspector-workspace:not([inert])').waitFor();
 await page.getByRole('button',{name:'Продолжить осмотр',exact:false}).first().click();
 await page.getByRole('button',{name:'Зафиксировать дефект',exact:true}).click();
 await page.getByLabel('Описание',{exact:false}).fill('Сохраняем текст во время потери GPS');
 await page.evaluate(()=>window.lose());
 await page.clock.runFor(3000);
 assert.equal(await page.locator('.inspector-gps-gate').count(),0);
 assert.equal(await page.locator('.inspector-gps-recovery').count(),0);
 await page.evaluate(()=>window.fix());
 await page.clock.runFor(1000);
 assert.equal(await page.locator('.inspector-gps-recovery').count(),0,'3-second outage stays silent');
 await page.evaluate(()=>window.lose());
 const lossTime=await page.evaluate(()=>Date.now());
 await page.locator('input[aria-label="Добавить фото дефекта"]').setInputFiles(path.resolve(__dirname,'../../backend/demo_photos/demo-road-condition.png'));
 await page.locator('.upload-previews img').waitFor();assert.equal(uploads,0,'photo persists locally during grace before submission');
 assert.equal(await page.locator('button[type=submit]').isDisabled(),true);
 await page.clock.runFor(16000);await page.locator('.inspector-gps-recovery').waitFor();
 assert.equal(await page.locator('.inspector-gps-gate').count(),0);
 assert.ok(inspection.points.every(p=>Date.parse(p.recorded_at)<=lossTime),'no fabricated track points during recovery');
 if(process.env.GPS_SCREENSHOTS) await page.screenshot({path:path.resolve(process.env.GPS_SCREENSHOTS,`gps-recovery-${width}.png`),fullPage:true});
 await page.clock.runFor(45000);await page.locator('.inspector-gps-gate').waitFor();
 assert.equal(await page.getByLabel('Описание',{exact:false}).inputValue(),'Сохраняем текст во время потери GPS');
 await page.evaluate(()=>window.fix());await page.locator('.inspector-workspace:not([inert])').waitFor();
 assert.equal(await page.locator('.upload-previews img').count(),1);
 assert.equal(await page.locator('button[type=submit]').isDisabled(),false);
 await page.evaluate(()=>window.deny());await page.locator('.inspector-gps-gate').waitFor();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({width,passed:true,uploads,pointRequests,errors}));await context.close();
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
