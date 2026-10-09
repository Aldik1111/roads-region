const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  const context=await browser.newContext({viewport:{width:390,height:900}});
  await context.addInitScript(()=>{
   Object.defineProperty(navigator,'permissions',{value:{query:async()=>({state:'granted',onchange:null})}});
   const fix=()=>({timestamp:Date.now(),coords:{latitude:44.848,longitude:65.482,accuracy:10}});
   Object.defineProperty(navigator,'geolocation',{value:{watchPosition(ok){queueMicrotask(()=>ok(fix()));return setInterval(()=>ok(fix()),5000);},clearWatch(id){clearInterval(id);},getCurrentPosition(ok){queueMicrotask(()=>ok(fix()));}}});
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const user={id:'field-test-user',role:'inspector',name:'Тест инспектора',email:'field@example.invalid'};
  const now=new Date().toISOString();
  const route={id:'field-route',name:'Маршрут без связи',code:'TEST',length_km:2,geometry:{type:'LineString',coordinates:[[65.482,44.848],[65.49,44.86]]},inspector_id:user.id,inspector_name:user.name,notes:'',state:'in_progress',duration_min:5,source:'demo'};
  const inspection={id:'field-inspection',section_id:route.id,inspector_id:user.id,started_at:now,status:'active',finished_at:null,points:[]};
  let offline=false,uploads=0,defectAttempts=0,loseFirstResponse=true;
  const created=new Map(),order=[];
  await context.route('**/api/**',async r=>{
   if(offline)return r.abort('internetdisconnected');
   const req=r.request(),u=new URL(req.url()).pathname;let body;
   if(u==='/api/health')body={ok:true,demo:true};
   else if(u==='/api/notifications')body=[];
   else if(u==='/api/me')body=user;
   else if(u==='/api/bootstrap')body={user,sections:[route],contractors:[],inspectors:[user]};
   else if(u==='/api/inspections')body=[inspection];
   else if(u==='/api/defects'&&req.method()==='GET')body=[...created.values()];
   else if(u==='/api/files'){uploads++;assert.equal(req.headers()['x-field-owner'],user.id);assert.ok(req.headers()['idempotency-key']);body={id:'field-photo',url:'/api/photos/field-photo',name:'demo-road-condition.png'};}
   else if(u==='/api/photos/field-photo')return r.fulfill({path:path.resolve(__dirname,'../../backend/demo_photos/demo-road-condition.png'),contentType:'image/png'});
   else if(u==='/api/defects'){
    defectAttempts++;order.push('defect');const key=req.headers()['idempotency-key'];assert.equal(req.headers()['x-field-owner'],user.id);
    if(!created.has(key))created.set(key,{...req.postDataJSON(),id:'saved-field-defect',number:'TEST-001',status:'new',inspector_id:user.id,received_at:now,photos:[{id:'field-photo',url:'/api/photos/field-photo',name:'Фото'}],repairs:[],history:[]});
    body=created.get(key);if(loseFirstResponse){loseFirstResponse=false;return r.abort('failed');}
   }else if(u.endsWith('/points')){
    assert.equal(inspection.status,'active','no points sent after finish');order.push('points');
    const existing=new Set(inspection.points.map(p=>p.client_id));for(const p of req.postDataJSON().points)if(!existing.has(p.client_id)){inspection.points.push(p);existing.add(p.client_id);}body=inspection;
   }else if(u.endsWith('/finish')){order.push('finish');inspection.status='finished';inspection.finished_at=req.postDataJSON().finished_at;body=inspection;}
   else throw new Error('Unexpected '+req.method()+' '+u);
   await r.fulfill({json:body});
  });
  await page.goto(process.env.APP_URL || 'http://127.0.0.1:8000',{waitUntil:'domcontentloaded'});
  await page.locator('.inspector-workspace:not([inert])').waitFor();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.getByRole('button',{name:'Продолжить осмотр',exact:false}).first().click();
  await page.getByRole('button',{name:'Зафиксировать дефект',exact:true}).click();
  await page.getByLabel('Описание',{exact:false}).fill('Черновик должен пережить закрытие страницы');
  await page.locator('input[aria-label="Добавить фото дефекта"]').setInputFiles(path.resolve(__dirname,'../../backend/demo_photos/demo-road-condition.png'));
  await page.locator('.upload-previews img').waitFor();
  await page.locator('.field-save-state').filter({hasText:'Сохранено на устройстве'}).waitFor();
  assert.equal(uploads,0,'original photo is staged locally before sending');
  offline=true;await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Продолжить черновик',exact:true}).click();
  assert.equal(await page.getByLabel('Описание',{exact:false}).inputValue(),'Черновик должен пережить закрытие страницы');
  await page.waitForFunction(()=>[...document.querySelectorAll('.upload-previews img')].every(i=>i.complete&&i.naturalWidth>0));
  await page.getByRole('button',{name:'Отправить сообщение',exact:false}).click();
  await page.locator('.field-queued-defect').waitFor();
  await page.locator('.inspector-mobile-nav').getByRole('button',{name:'Маршруты',exact:true}).click();
  await page.getByRole('button',{name:'Продолжить осмотр',exact:false}).first().click();
  await page.getByRole('button',{name:'Завершить осмотр',exact:true}).click();
  await page.getByRole('button',{name:'Завершить',exact:true}).click();
  await page.locator('.alert.success').filter({hasText:'Осмотр сохранён на устройстве'}).waitFor();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.inspector-workspace:not([inert])').waitFor();
  assert.equal(await page.getByRole('button',{name:'Продолжить осмотр',exact:false}).count(),0,'queued finish persists across reload');
  assert.equal(await page.getByRole('button',{name:'Продолжить черновик',exact:true}).count(),0,'queued draft is not resurrected');
  offline=false;await context.setOffline(false);
  await page.locator('.field-status button').click();
  await page.waitForFunction(()=>document.querySelector('.field-status button')?.disabled===false);
  await page.locator('.field-status button').click();
  await page.locator('.field-status b').filter({hasText:'Нет ожидающих отправок'}).waitFor();
  assert.equal(created.size,1);assert.equal(uploads,1);assert.equal(defectAttempts,2);
  assert.equal(inspection.status,'finished');assert.ok(inspection.points.length>0);
  assert.equal(order.at(-1),'finish');assert.deepEqual(errors,[]);
  // Simulate interruption after receipt commit but before refreshing the cached server snapshot.
  await page.evaluate(async owner=>{await new Promise((resolve,reject)=>{const open=indexedDB.open('roads-region-field-v1');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),get=store.get([owner,'snapshot']);get.onsuccess=()=>{const row=get.result;row.value.inspections.forEach(i=>{i.status='active';i.finished_at=null;});store.put(row);};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});},user.id);
  offline=true;await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.inspector-workspace:not([inert])').waitFor();
  assert.equal(await page.getByRole('button',{name:'Продолжить осмотр',exact:false}).count(),0,'confirmed finish receipt seals a stale cached active inspection');
  console.log(JSON.stringify({passed:true,offlineReload:true,draftRestored:true,uploads,defectAttempts,serverDefects:created.size,trackPoints:inspection.points.length,order,errors}));
  await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
