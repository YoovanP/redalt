import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

async function clearDevServiceWorkerState() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // Ignore service-worker cleanup failures in development.
  }

  if (!('caches' in window)) {
    return;
  }

  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('redalt-')).map((key) => caches.delete(key)));
  } catch {
    // Ignore cache cleanup failures in development.
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.DEV) {
      void clearDevServiceWorkerState();
      return;
    }

    let reloadingForWorker = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloadingForWorker) {
        reloadingForWorker = true;
        window.location.reload();
      }
    });

    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        registration.waiting?.postMessage({ type: 'redalt-skip-waiting' });
        return registration.update();
      })
      .catch(() => {
        // The app remains usable when service-worker registration is blocked.
      });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
