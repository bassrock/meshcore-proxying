/**
 * WebSerial Polyfill — makes our WebSocket bridge appear as a native serial port.
 *
 * When injected into a page, this overrides navigator.serial so that
 * requestPort() returns a fake SerialPort whose readable/writable streams
 * are tunneled through a WebSocket to our bridge server.
 *
 * Features:
 *   - Singleton port: requestPort() always returns the same instance
 *   - Auto-reconnect with exponential backoff on WebSocket drop
 *   - Write buffering while disconnected
 *   - "Reconnecting…" overlay
 *   - Auto-connect via Flutter semantics DOM
 *   - Service worker registration for browser push notifications
 */
(function () {
  'use strict';

  const WS_URL = 'ws://' + location.hostname + ':3000';
  const TAG = '[WebSerial Polyfill]';

  // -------------------------------------------------------------------------
  // Reconnecting overlay
  // -------------------------------------------------------------------------
  let overlayEl = null;

  function showOverlay() {
    if (overlayEl) { overlayEl.style.display = 'block'; return; }
    overlayEl = document.createElement('div');
    overlayEl.textContent = 'Connection lost. Reconnecting\u2026';
    Object.assign(overlayEl.style, {
      position: 'fixed',
      bottom: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.8)',
      color: '#fff',
      padding: '10px 24px',
      borderRadius: '8px',
      fontSize: '14px',
      zIndex: '999999',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none',
    });
    (document.body || document.documentElement).appendChild(overlayEl);
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = 'none';
  }

  // -------------------------------------------------------------------------
  // WebSocketSerialPort — singleton with auto-reconnect
  // -------------------------------------------------------------------------
  class WebSocketSerialPort {
    constructor() {
      this._ws = null;
      this._readable = null;
      this._writable = null;
      this._readableController = null;
      this._opened = false;
      this._signals = { dataTerminalReady: false, requestToSend: false };

      // Reconnect state
      this._explicitClose = false;
      this._reconnecting = false;
      this._reconnectTimer = null;
      this._reconnectAttempt = 0;
      this._reconnectStartedAt = null;
      this._gaveUp = false;

      // Write buffer (up to 50 frames while WS is down)
      this._writeBuffer = [];
      this._maxWriteBuffer = 50;
    }

    // -- EventTarget --------------------------------------------------------
    _listeners = {};
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn);
    }
    dispatchEvent(event) {
      (this._listeners[event.type] || []).forEach(fn => fn(event));
    }

    // -- Streams (created once in open(), live for port lifetime) -----------
    get readable() { return this._readable; }
    get writable() { return this._writable; }

    // -- open() — create long-lived streams + initial WS --------------------
    async open(_options) {
      if (this._opened) return;

      // Create readable stream (data FROM device) — lives until explicit close
      this._readable = new ReadableStream({
        start: (controller) => { this._readableController = controller; },
        cancel: () => { this._readableController = null; },
      });

      // Create writable stream (data TO device) — buffers while WS is down
      this._writable = new WritableStream({
        write: (chunk) => {
          if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(chunk);
          } else if (this._reconnecting) {
            // Buffer while reconnecting
            if (this._writeBuffer.length < this._maxWriteBuffer) {
              this._writeBuffer.push(chunk);
            }
          }
          // else: dropped (port not open and not reconnecting)
        },
      });

      this._opened = true;
      this._explicitClose = false;
      this._gaveUp = false;

      // Initial WS connection
      await this._connectWS();
    }

    // -- close() — explicit close, no reconnect -----------------------------
    async close() {
      this._explicitClose = true;
      this._opened = false;
      this._reconnecting = false;

      // Cancel pending reconnect
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }

      // Close readable stream
      if (this._readableController) {
        try { this._readableController.close(); } catch (_) {}
        this._readableController = null;
      }

      // Close WebSocket
      if (this._ws) {
        this._ws.close();
        this._ws = null;
      }

      hideOverlay();
    }

    // -- _connectWS() — (re)create WebSocket --------------------------------
    _connectWS() {
      return new Promise((resolve, reject) => {
        console.log(TAG, 'Connecting to', WS_URL);
        const ws = new WebSocket(WS_URL);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          console.log(TAG, 'WebSocket connected');
          this._ws = ws;

          // Reset reconnect state
          this._reconnecting = false;
          this._reconnectAttempt = 0;
          this._reconnectStartedAt = null;

          // Flush write buffer
          while (this._writeBuffer.length > 0) {
            const chunk = this._writeBuffer.shift();
            ws.send(chunk);
          }

          hideOverlay();
          resolve();
        };

        ws.onmessage = (event) => {
          if (this._readableController) {
            try {
              this._readableController.enqueue(new Uint8Array(event.data));
            } catch (e) {
              // stream closed
            }
          }
        };

        ws.onerror = (err) => {
          console.error(TAG, 'WebSocket error', err);
          // Only reject the open() promise if this is the initial connection
          if (!this._reconnecting) reject(new DOMException('Failed to connect to bridge', 'NetworkError'));
        };

        ws.onclose = () => {
          console.log(TAG, 'WebSocket closed');
          this._ws = null;

          if (!this._explicitClose && this._opened) {
            this._scheduleReconnect();
          }
        };
      });
    }

    // -- _scheduleReconnect() — exponential backoff -------------------------
    _scheduleReconnect() {
      if (this._explicitClose || this._gaveUp) return;

      if (!this._reconnecting) {
        // First disconnect
        this._reconnecting = true;
        this._reconnectAttempt = 0;
        this._reconnectStartedAt = Date.now();
        showOverlay();
      }

      // Give up after 5 minutes
      const elapsed = Date.now() - this._reconnectStartedAt;
      if (elapsed > 5 * 60 * 1000) {
        console.warn(TAG, 'Gave up reconnecting after 5 minutes');
        this._gaveUp = true;
        this._reconnecting = false;
        hideOverlay();

        // Close readable stream so the app's read() loop exits
        if (this._readableController) {
          try { this._readableController.close(); } catch (_) {}
          this._readableController = null;
        }
        this.dispatchEvent(new Event('disconnect'));
        return;
      }

      // Backoff: 1s, 2s, 4s, 8s, capped at 10s
      const delays = [1000, 2000, 4000, 8000, 10000];
      const delay = delays[Math.min(this._reconnectAttempt, delays.length - 1)];
      this._reconnectAttempt++;

      console.log(TAG, `Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);

      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._connectWS().catch(() => {
          // Connection failed — onclose will fire and schedule next attempt
        });
      }, delay);
    }

    // -- Signal methods (unchanged) -----------------------------------------
    async setSignals(signals) {
      Object.assign(this._signals, signals);
    }

    async getSignals() {
      return {
        dataCarrierDetect: true,
        clearToSend: true,
        ringIndicator: false,
        dataSetReady: true,
      };
    }

    getInfo() {
      return { usbVendorId: 0, usbProductId: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Singleton port + polyfill serial object
  // -------------------------------------------------------------------------
  const singletonPort = new WebSocketSerialPort();

  const polyfillSerial = {
    _listeners: {},

    async requestPort(_options) {
      console.log(TAG, 'requestPort called — returning singleton port');
      return singletonPort;
    },

    async getPorts() {
      return [singletonPort];
    },

    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] || []).filter(f => f !== fn);
    },
    dispatchEvent(event) {
      (this._listeners[event.type] || []).forEach(fn => fn(event));
    },
  };

  // Override navigator.serial
  Object.defineProperty(navigator, 'serial', {
    value: polyfillSerial,
    writable: false,
    configurable: true,
  });

  console.log(TAG, 'Active — serial connections will route through', WS_URL);

  // -------------------------------------------------------------------------
  // Auto-connect via Flutter semantics DOM
  // -------------------------------------------------------------------------
  function attemptAutoConnect() {
    console.log(TAG, '[Auto-connect] Searching for Flutter Serial button…');

    // Flutter renders <flt-semantics> elements with ARIA roles
    const candidates = document.querySelectorAll('flt-semantics');
    for (const el of candidates) {
      const label = el.getAttribute('aria-label') || el.textContent || '';
      if (/serial/i.test(label)) {
        console.log(TAG, '[Auto-connect] Found semantics element:', label);
        el.click();
        return true;
      }
    }

    console.log(TAG, '[Auto-connect] No Flutter semantics button found, trying connect event fallback');
    polyfillSerial.dispatchEvent(new Event('connect'));
    return false;
  }

  // Wait for DOM to settle then try auto-connect
  window.addEventListener('load', () => {
    // Give Flutter time to render semantics tree
    setTimeout(() => {
      // First attempt
      if (attemptAutoConnect()) return;

      // Watch for late-arriving semantics elements
      const observer = new MutationObserver((_mutations) => {
        const candidates = document.querySelectorAll('flt-semantics');
        for (const el of candidates) {
          const label = el.getAttribute('aria-label') || el.textContent || '';
          if (/serial/i.test(label)) {
            console.log(TAG, '[Auto-connect] Late semantics element found:', label);
            observer.disconnect();
            el.click();
            return;
          }
        }
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
      });

      // Stop watching after 10s
      setTimeout(() => observer.disconnect(), 10000);
    }, 2000);
  });

  // -------------------------------------------------------------------------
  // Service worker registration for push notifications
  // -------------------------------------------------------------------------
  async function registerPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.log(TAG, '[Push] Service worker or Push API not supported');
      return;
    }

    try {
      const reg = await navigator.serviceWorker.register('/__push-worker.js');
      console.log(TAG, '[Push] Service worker registered');

      // Request notification permission
      const permission = await Notification.requestPermission();
      console.log(TAG, '[Push] Notification permission:', permission);
      if (permission !== 'granted') return;

      // Get VAPID public key from server
      const resp = await fetch('/__push/vapid-key');
      if (!resp.ok) {
        console.warn(TAG, '[Push] Failed to get VAPID key:', resp.status);
        return;
      }
      const { publicKey } = await resp.json();

      // Convert base64url VAPID key to Uint8Array
      const vapidKey = urlBase64ToUint8Array(publicKey);

      // Subscribe to push
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });
      console.log(TAG, '[Push] Push subscription created');

      // Send subscription to server
      await fetch('/__push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      });
      console.log(TAG, '[Push] Subscription sent to server');
    } catch (err) {
      console.error(TAG, '[Push] Registration failed:', err);
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Kick off push registration after page load
  window.addEventListener('load', () => {
    // Small delay so it doesn't block initial rendering
    setTimeout(registerPushNotifications, 3000);
  });
})();
