self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (error) {
      console.warn('Push notification did not contain JSON.', error);
      payload = { body: event.data.text() };
    }
  }
  const title = typeof payload.title === 'string' ? payload.title : 'Fieldnotes community update';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'A subscribed data monitor has a new update.',
    tag: typeof payload.tag === 'string' ? payload.tag : 'fieldnotes-guardian',
    data: { url: typeof payload.url === 'string' ? payload.url : './index.html#guardian' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = new URL(event.notification.data && event.notification.data.url || './index.html#guardian', self.location.href);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => new URL(client.url).origin === destination.origin);
    if (existing) return existing.navigate(destination.href).then(() => existing.focus());
    return self.clients.openWindow(destination.href);
  }));
});
