// Local TLS is independently verified by tools/phone_test.py check.
// This isolated Chrome process trusts only the generated leaf SPKI; OS trust is unchanged.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const connection=JSON.parse(fs.readFileSync(path.join(root,'.phone-test/connection.json'),'utf8'));
const certificate=new crypto.X509Certificate(fs.readFileSync(path.join(root,'.phone-test/server.pem')));
const pin=crypto.createHash('sha256').update(certificate.publicKey.export({type:'spki',format:'der'})).digest('base64');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome',args:[`--ignore-certificate-errors-spki-list=${pin}`]});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['geolocation'],geolocation:{latitude:44.848,longitude:65.482,accuracy:9}});
  const page=await context.newPage();const errors=[];const mutations=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()!=='GET')mutations.push(request.url());});
  await page.route('**/api/me',route=>route.fulfill({status:401,json:{detail:{code:'UNAUTHORIZED',message:'Test logged out'}}}));
  await page.goto(connection.app_url+'/phone-check.html');
  await page.locator('#health-value.good').waitFor();
  assert.equal(await page.evaluate(()=>window.isSecureContext),true);
  await page.getByRole('button',{name:'Проверить геопозицию',exact:true}).click();
  await page.locator('#geo-result.good').waitFor();
  assert.match(await page.locator('#geo-result').innerText(),/9 м/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  fs.mkdirSync(path.join(root,'docs/screenshots/phone'),{recursive:true});
  await page.screenshot({path:path.join(root,'docs/screenshots/phone/diagnostics-390.png'),fullPage:true});
  await page.goto(connection.app_url+'/');
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.goto(connection.app_url+'/phone-check.html');
  await page.locator('#health-value.good').waitFor();
  const shell=await page.evaluate(async()=>{const response=await caches.match('/');return response?.text();});
  assert.ok(shell.includes('id="root"'),'diagnostics must not replace offline app HTML');
  await context.setOffline(true);
  await page.goto(connection.app_url+'/');
  await page.locator('#root').waitFor();
  assert.equal(await page.locator('#health-value').count(),0,'offline root remains the app');
  assert.deepEqual(mutations,[],'diagnostics must not send location or mutate live data');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,secureContext:true,simulatedGps:true,offlineShellPreserved:true,mutations:0,errors}));
  await context.close();
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
