/**
 * Service Worker for MeshCore browser push notifications.
 *
 * Receives push events from the Web Push API and shows OS-level notifications.
 * Clicking a notification focuses or opens the app tab.
 */
'use strict';

self.addEventListener('push', (event) => {
  let title = 'MeshCore';
  let body = 'New mesh message';
  let data = {};

  if (event.data) {
    try {
      const payload = event.data.json();
      title = payload.title || title;
      body = payload.body || body;
      data = payload.data || data;
    } catch (_) {
      body = event.data.text() || body;
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/Icon-192.png',
      badge: '/icons/Icon-192.png',
      data,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing tab if found
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      return clients.openWindow('/');
    })
  );
});
