// ================= SERVICE WORKER (sw.js) - ÇEVRİMDIŞI ÖNBELLEK YÖNETİMİ =================

const CACHE_NAME = 'endlessr-reader-v5';

// Önbelleğe alınacak kaynaklar (Yerel dosyalar ve CDN kütüphaneleri)
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './css/styles.css',
    './js/db.js',
    './js/utils.js',
    './js/translate.js',
    './js/reader.js',
    './js/gdrive.js',
    './js/app.js',
    './manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/epubjs/dist/epub.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js',
    'https://unpkg.com/lucide@latest',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Outfit:wght@400;500;600;700;800&display=swap'
];

// 1. Kurulum (Install) Aşaması - Dosyaları Önbelleğe Al
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Service Worker: Dosyalar önbelleğe alınıyor...');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting())
    );
});

// 2. Etkinleştirme (Activate) Aşaması - Eski Önbellekleri Temizle
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('Service Worker: Eski önbellek temizleniyor:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// 3. İstekleri Yakalama (Fetch) - Akıllı Çevrimdışı Çalışma Stratejisi
self.addEventListener('fetch', (e) => {
    // API çağrılarını veya çeviri isteklerini önbelleğe alma (sadece statik kaynakları al)
    if (e.request.url.includes('translate.googleapis.com') || 
        e.request.url.includes('generativelanguage.googleapis.com') || 
        e.request.url.includes('api.openai.com')) {
        return; // Doğrudan ağa git
    }

    const isLocalRequest = e.request.url.startsWith(self.location.origin);

    if (isLocalRequest) {
        // Yerel dosyalar için Network-First (Önce Ağ, Çevrimdışıyken Önbellek)
        e.respondWith(
            fetch(e.request).then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(e.request, responseToCache);
                    });
                }
                return response;
            }).catch(() => {
                // Çevrimdışı durumunda önbellekten al
                return caches.match(e.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // Eğer sayfa navigasyon isteğiyse ve bulunamadıysa ana sayfaya düşür
                    if (e.request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                });
            })
        );
    } else {
        // Harici CDN kütüphaneleri için Cache-First (Hızlı Yükleme)
        e.respondWith(
            caches.match(e.request).then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(e.request).then((response) => {
                    if (response && response.status === 200) {
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            if (e.request.url.startsWith('http')) {
                                cache.put(e.request, responseToCache);
                            }
                        });
                    }
                    return response;
                });
            })
        );
    }
});
