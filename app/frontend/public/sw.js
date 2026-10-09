// Cache only the application shell. Authenticated API data is stored per user in IndexedDB.
const SHELL = 'roads-shell-field-v1';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const response = await fetch('/', {cache:'reload'});
    if (!response.ok) throw new Error('Shell unavailable');
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m => m[1]);
    await cache.addAll(assets);
    await cache.put('/', response);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async()=>{
      const cache=await caches.open(SHELL);
      try {
        const response=await fetch(event.request);
        if(response.ok){
          const html=await response.clone().text();
          const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m=>m[1]);
          // Keep the previous complete shell if fetching any new asset fails.
          try{await cache.addAll(assets);await cache.put('/',response.clone());}catch{}
        }
        return response;
      }catch{
        return await cache.match('/') || new Response('Откройте приложение при подключении к сети перед выездом.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
      }
    })());
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request,response.clone());
      return response;
    })());
  }
});
