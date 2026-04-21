import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { initMediaSession } from './lib/mediaSession';

// Wire OS-level media controls (hardware keys via main's
// globalShortcut + navigator.mediaSession for Win SMTC / macOS Now
// Playing / Linux MPRIS / Bluetooth headsets). Safe to call before
// React mounts — it only subscribes to the player store and the
// preload bridge, both of which are already initialised.
initMediaSession();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
