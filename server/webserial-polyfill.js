/**
 * WebSerial Polyfill — makes our WebSocket bridge appear as a native serial port.
 *
 * When injected into a page, this overrides navigator.serial so that
 * requestPort() returns a fake SerialPort whose readable/writable streams
 * are tunneled through a WebSocket to our bridge server.
 *
 * The bridge server forwards bytes transparently to/from the real serial device.
 */
(function () {
  'use strict';

  const WS_URL = 'ws://' + location.hostname + ':3000';

  class WebSocketSerialPort {
    constructor() {
      this._ws = null;
      this._readable = null;
      this._writable = null;
      this._readableController = null;
      this._opened = false;
      this._signals = { dataTerminalReady: false, requestToSend: false };
    }

    async open(options) {
      if (this._opened) return;

      return new Promise((resolve, reject) => {
        this._ws = new WebSocket(WS_URL);
        this._ws.binaryType = 'arraybuffer';

        this._ws.onopen = () => {
          this._opened = true;

          // Create readable stream (data FROM device)
          this._readable = new ReadableStream({
            start: (controller) => {
              this._readableController = controller;
            },
            cancel: () => {
              this._readableController = null;
            },
          });

          // Create writable stream (data TO device)
          this._writable = new WritableStream({
            write: (chunk) => {
              if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                this._ws.send(chunk);
              }
            },
          });

          resolve();
        };

        this._ws.onmessage = (event) => {
          if (this._readableController) {
            try {
              this._readableController.enqueue(new Uint8Array(event.data));
            } catch (e) {
              // stream closed
            }
          }
        };

        this._ws.onerror = (err) => {
          console.error('[WebSerial Polyfill] WebSocket error', err);
          if (!this._opened) reject(new DOMException('Failed to connect to bridge', 'NetworkError'));
        };

        this._ws.onclose = () => {
          this._opened = false;
          if (this._readableController) {
            try { this._readableController.close(); } catch (_) {}
            this._readableController = null;
          }
          this.dispatchEvent(new Event('disconnect'));
        };
      });
    }

    get readable() { return this._readable; }
    get writable() { return this._writable; }

    async close() {
      this._opened = false;
      if (this._readableController) {
        try { this._readableController.close(); } catch (_) {}
        this._readableController = null;
      }
      if (this._ws) {
        this._ws.close();
        this._ws = null;
      }
    }

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

    // Minimal EventTarget
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
  }

  // Override navigator.serial
  const polyfillSerial = {
    async requestPort(options) {
      console.log('[WebSerial Polyfill] requestPort called — routing through WebSocket bridge at', WS_URL);
      return new WebSocketSerialPort();
    },

    async getPorts() {
      return [];
    },

    addEventListener() {},
    removeEventListener() {},
  };

  // Only override if there's no real serial API, or always override for bridge mode
  Object.defineProperty(navigator, 'serial', {
    value: polyfillSerial,
    writable: false,
    configurable: true,
  });

  console.log('[WebSerial Polyfill] Active — serial connections will route through', WS_URL);
})();
