/* 出店募集モニター Service Worker (Web Push) */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: '出店募集モニター', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || '出店募集モニター';
  const body = data.body || '';
  const options = {
    body,
    icon: '/kitchencar-monitor/icon.png',
    badge: '/kitchencar-monitor/icon.png',
    data: data.url ? { url: data.url } : {},
    tag: 'kitchencar',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
