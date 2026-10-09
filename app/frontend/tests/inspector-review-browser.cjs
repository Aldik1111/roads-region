// Run against a built local app. API writes are intercepted; no user data changes.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try { for(const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:900},permissions:['geolocation'],geolocation:{latitude:44.848,longitude:65.482,accuracy:10}});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const user={id:'review-inspector',role:'inspector',name:'Тест инспектора',email:'test@example.invalid'};
  const now=new Date().toISOString();
  const section={id:'review-route',name:'Тестовый маршрут',code:'TEST',length_km:2,geometry:{type:'LineString',coordinates:[[65.482,44.848],[65.49,44.86]]},inspector_id:user.id,inspector_name:user.name,notes:'',state:'assigned',duration_min:5,source:'demo'};
  const report=()=>({id:'review-report',created_at:now,comment:'Покрытие восстановлено',photos:[],decision:null,decision_comment:null});
  const defect={id:'review-defect',number:'TEST-001',section_id:section.id,inspection_id:null,type:'Выбоина',description:'Проверка ремонта',status:'review',lat:44.848,lng:65.482,location_source:'gps',accuracy_m:10,observed_at:now,received_at:now,inspector_id:user.id,contractor_id:'test-contractor',contractor_name:'Тест подрядчика',due_at:null,overdue:false,version:1,photos:[],repairs:[report()],history:[]};
  let published=false;const actions=[];
  await page.route('**/api/**',async r=>{
   const u=new URL(r.request().url()).pathname;let body;
   if(u==='/api/me')body=user;
   else if(u==='/api/bootstrap')body={user,sections:[section],contractors:[],inspectors:[user]};
   else if(u==='/api/inspections')body=[];
   else if(u==='/api/defects')body=published?[defect]:[];
   else if(u==='/api/defects/'+defect.id)body=defect;
   else if(u.endsWith('/actions')){
    const data=r.request().postDataJSON();actions.push(data);
    assert.equal(data.version,defect.version);
    assert.ok(['reject','approve'].includes(data.action));
    defect.status=data.action==='approve'?'closed':'rework';defect.version++;
    defect.repairs[0].decision=data.action==='approve'?'accepted':'rejected';
    defect.repairs[0].decision_comment=data.comment || null;body=defect;
   }else throw new Error('Unexpected request '+u);
   await r.fulfill({json:body});
  });
  await page.goto(process.env.APP_URL || 'http://127.0.0.1:8000',{waitUntil:'domcontentloaded'});
  await page.locator('.inspector-workspace:not([inert])').waitFor();
  const navigation=page.locator(width>700?'.inspector-desktop-nav':'.inspector-mobile-nav');
  const review=navigation.getByRole('button',{name:/Проверка работ/});
  assert.ok(await review.isVisible());const box=await review.boundingBox();assert.ok(box.y>=0 && box.y+box.height<=900,'review is in initial viewport');
  await review.click();await page.getByText('Нет работ на проверке',{exact:true}).waitFor();
  published=true;await page.getByRole('button',{name:'Обновить',exact:true}).click();
  await page.locator('.inspector-defect-row').waitFor();assert.match(await review.innerText(),/1/);
  await page.locator('.inspector-defect-row').click();
  await page.getByRole('button',{name:'Принять ремонт',exact:true}).waitFor();
  const reject=page.getByRole('button',{name:'Отправить на доработку',exact:true});assert.equal(await reject.isDisabled(),true);
  await page.locator('.inspector-review-actions textarea').fill('Исправить край покрытия');await reject.click();
  await page.locator('.alert.success').filter({hasText:'Работа отправлена на доработку.'}).waitFor();
  assert.equal(actions[0].comment,'Исправить край покрытия');
  await review.click();await page.getByText('Нет работ на проверке',{exact:true}).waitFor();
  defect.status='review';defect.repairs=[report()];await page.getByRole('button',{name:'Обновить',exact:true}).click();
  await page.locator('.inspector-defect-row').click();await page.getByRole('button',{name:'Принять ремонт',exact:true}).click();
  await page.locator('.alert.success').filter({hasText:'Дефект принят и закрыт.'}).waitFor();assert.equal(actions[1].action,'approve');
  await review.click();await page.getByText('Нет работ на проверке',{exact:true}).waitFor();
  defect.status='review';defect.repairs=[];await page.getByRole('button',{name:'Обновить',exact:true}).click();
  await page.locator('.inspector-defect-row').click();await page.getByText('Отчёт подрядчика отсутствует',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Принять ремонт',exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,passed:true,actions:actions.map(a=>a.action),errors}));
  await context.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
