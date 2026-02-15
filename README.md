# MeshCore Proxying

A bridge server that connects a USB MeshCore companion device to multiple interfaces simultaneously — web UI, Home Assistant, and the LetsMesh observer network.

```
┌─────────────────────────────────────────────────────────┐
│  meshcore-proxying (Node.js)                            │
│                                                         │
│  Serial ↔ /dev/ttyACM0 (companion device)               │
│                                                         │
│  :8080  HTTP  → proxied app.meshcore.nz + WebSerial     │
│                 polyfill (no USB needed in browser)      │
│  :3000  WS    → companion protocol for browser clients  │
│  :5000  TCP   → companion protocol for meshcore-ha      │
│         MQTT  → LetsMesh observer (packet publishing)   │
└─────────────────────────────────────────────────────────┘
```

## Features

- **Web UI** — Proxies the official [app.meshcore.nz](https://app.meshcore.nz) Flutter app with an injected WebSerial polyfill. Click "Connect via Serial" and it routes through the bridge instead of requiring a local USB device. Access from any device on your network.
- **Home Assistant** — Exposes a TCP companion protocol server on port 5000, compatible with [meshcore-ha](https://github.com/meshcore-dev/meshcore-ha). Point it at your bridge host and it works as if the radio were directly connected.
- **LetsMesh Observer** — Publishes received packets to the LetsMesh MQTT broker (`mqtt-us-v1.letsmesh.net`) with proper Ed25519 JWT authentication. Your node appears on [analyzer.letsmesh.net](https://analyzer.letsmesh.net).
- **Shared Serial** — All interfaces share a single serial connection. No port conflicts between the web UI, Home Assistant, and MQTT publishing.

## Quick Start

### Docker (Linux)

```bash
# Copy and edit the config
cp env.local.example env.local
# Edit env.local with your serial port, IATA code, etc.

docker compose up -d
```

### Docker (Pull from GHCR)

```bash
docker pull ghcr.io/bassrock/meshcore-proxying:latest
```

### Native (macOS / Linux)

Docker Desktop on macOS can't pass USB serial devices. Run natively instead:

```bash
cp env.local.example env.local
# Edit env.local — set SERIAL_PORT to your device (e.g. /dev/tty.usbmodemXXXX)

cd server
npm install
node index.js
```

## Configuration

Copy `env.local.example` to `env.local` and adjust:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERIAL_PORT` | `/dev/ttyACM0` | Serial device path |
| `SERIAL_BAUD` | `115200` | Serial baud rate |
| `IATA` | `XXX` | Your 3-letter IATA airport code (for MQTT topics) |
| `MQTT_ENABLED` | `true` | Enable LetsMesh MQTT publishing |
| `MQTT_SERVER` | `mqtt-us-v1.letsmesh.net` | MQTT broker hostname |
| `MQTT_PORT` | `443` | MQTT broker port |
| `MQTT_TRANSPORT` | `websockets` | MQTT transport (`websockets` or `tcp`) |
| `MQTT_USE_TLS` | `true` | Use TLS for MQTT |
| `PACKETCAPTURE_OWNER_PUBLIC_KEY` | _(unset)_ | Your companion node's 64-char hex public key |
| `PACKETCAPTURE_OWNER_EMAIL` | _(unset)_ | Email associated with your LetsMesh account |
| `HTTP_PORT` | `8080` | Web UI port |
| `WS_PORT` | `3000` | WebSocket bridge port |
| `TCP_PORT` | `5000` | TCP companion protocol port |
| `DEBUG` | _(unset)_ | Set to `1` for verbose logging |

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 8080 | HTTP | Web UI (proxied app.meshcore.nz) |
| 3000 | WebSocket | Browser companion protocol bridge |
| 5000 | TCP | Companion protocol for meshcore-ha |

## Home Assistant Setup

1. Install the [meshcore-ha](https://github.com/meshcore-dev/meshcore-ha) integration in Home Assistant
2. Add the integration and select **TCP** connection type
3. Enter the IP/hostname of the machine running this bridge
4. Port: **5000** (default)

## How It Works

The server opens the serial port to your MeshCore companion device and speaks the [companion binary protocol](https://github.com/meshcore-dev/MeshCore/wiki/Companion-Radio-Protocol) (0x3C/0x3E framed messages).

At startup it sends an `AppStart` command to retrieve the device's public key and name, then an `ExportPrivateKey` command to get the signing key for MQTT authentication.

Incoming frames from the device are:
1. Forwarded to all connected WebSocket and TCP clients
2. Inspected for push notifications (advertisements, received packets) and published to MQTT

Outgoing frames from any client (browser or TCP) are forwarded directly to the serial device.

The web UI works by proxying app.meshcore.nz and injecting a JavaScript polyfill that overrides `navigator.serial`. When the Flutter app calls `requestPort()`, the polyfill returns a fake serial port backed by a WebSocket connection to this bridge.

## MQTT Authentication

The server authenticates to the LetsMesh MQTT broker using JWT tokens signed with the device's Ed25519 private key (via the [@michaelhart/meshcore-decoder](https://www.npmjs.com/package/@michaelhart/meshcore-decoder) package). Tokens are automatically renewed every 50 minutes before their 1-hour expiry.

- **Username:** `v1_{PUBLIC_KEY}`
- **Password:** Ed25519-signed JWT
- **Topics:** `meshcore/{IATA}/{PUBLIC_KEY}/packets` and `meshcore/{IATA}/{PUBLIC_KEY}/status`

To associate the observer with your account, set `PACKETCAPTURE_OWNER_PUBLIC_KEY` to your companion node's 64-character hex public key and `PACKETCAPTURE_OWNER_EMAIL` to your account email. These are included as JWT claims in the auth token.

## License

MIT
