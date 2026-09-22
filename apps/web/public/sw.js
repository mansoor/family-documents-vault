/* Service worker: notifications only. Offline caching of Essentials is
   Phase 4 (the mobile app); this file deliberately does not intercept
   fetches, so nothing about the vault is cached where it should not be. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Family Document Vault', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Family Document Vault';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'fdv',
      badge: '/icon-192.png',
      icon: '/icon-192.png',
      data: { url: data.url || '/reminders' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/reminders';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
