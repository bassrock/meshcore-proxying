# MeshCore Proxying

A bridge server that connects a USB MeshCore companion device to multiple interfaces simultaneously — web UI, Home Assistant, and the LetsMesh observer network.

```
┌─────────────────────────────────────────────────────────────┐
│  meshcore-proxying (Node.js)                                │
│                                                             │
│  Serial ↔ /dev/ttyACM0 (companion device)                   │
│                                                             │
│  :8080  HTTP  → proxied app.meshcore.nz + WebSerial         │
│                 polyfill (no USB needed in browser)          │
│  :3000  WS    → companion protocol for browser clients      │
│  :5000  TCP   → companion protocol for meshcore-ha          │
│                 and meshcore-packet-capture                  │
└─────────────────────────────────────────────────────────────┘
```

## Features

- **Web UI** — Proxies the official [app.meshcore.nz](https://app.meshcore.nz) Flutter app with an injected WebSerial polyfill. Click "Connect via Serial" and it routes through the bridge instead of requiring a local USB device. Access from any device on your network.
- **Home Assistant** — Exposes a TCP companion protocol server on port 5000, compatible with [meshcore-ha](https://github.com/meshcore-dev/meshcore-ha). Point it at your bridge host and it works as if the radio were directly connected.
- **LetsMesh Observer** — Works with [meshcore-packet-capture](https://github.com/agessaman/meshcore-packet-capture) which connects via TCP to publish packets to the LetsMesh MQTT broker. Your node appears on [analyzer.letsmesh.net](https://analyzer.letsmesh.net).
- **Shared Serial** — All interfaces share a single serial connection with a command queue that serializes access. No port conflicts between the web UI, Home Assistant, and packet capture.

## Quick Start

### Docker (Linux)

```bash
# Copy and edit the config
cp env.local.example env.local
# Edit env.local — set SERIAL_PORT, IATA, OWNER key/email, etc.

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

### Bridge Server

| Variable | Default | Description |
|----------|---------|-------------|
| `SERIAL_PORT` | `/dev/ttyACM0` | Serial device path |
| `SERIAL_BAUD` | `115200` | Serial baud rate |
| `HTTP_PORT` | `8080` | Web UI port |
| `WS_PORT` | `3000` | WebSocket bridge port |
| `TCP_PORT` | `5000` | TCP companion protocol port |
| `PUSH_BUFFER_SIZE` | `1000` | Max buffered push notifications for WebSocket replay |
| `DEBUG` | _(unset)_ | Set to `1` for verbose logging |

### Packet Capture (meshcore-packet-capture)

The `env.local.example` includes defaults for [meshcore-packet-capture](https://github.com/agessaman/meshcore-packet-capture) — all `PACKETCAPTURE_*` variables are passed through. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `PACKETCAPTURE_CONNECTION_TYPE` | `tcp` | Connection type (pre-configured for bridge) |
| `PACKETCAPTURE_TCP_HOST` | `localhost` | TCP host (the bridge) |
| `PACKETCAPTURE_TCP_PORT` | `5000` | TCP port (matches bridge TCP port) |
| `PACKETCAPTURE_IATA` | _(unset)_ | Your 3-letter IATA airport code |
| `PACKETCAPTURE_OWNER_PUBLIC_KEY` | _(unset)_ | Your companion node's 64-char hex public key |
| `PACKETCAPTURE_OWNER_EMAIL` | _(unset)_ | Email associated with your LetsMesh account |
| `PACKETCAPTURE_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARNING, ERROR) |

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 8080 | HTTP | Web UI (proxied app.meshcore.nz) |
| 3000 | WebSocket | Browser companion protocol bridge |
| 5000 | TCP | Companion protocol for meshcore-ha and packet capture |

## Home Assistant Setup

1. Install the [meshcore-ha](https://github.com/meshcore-dev/meshcore-ha) integration in Home Assistant
2. Add the integration and select **TCP** connection type
3. Enter the IP/hostname of the machine running this bridge
4. Port: **5000** (default)

## How It Works

The server opens the serial port to your MeshCore companion device and speaks the [companion binary protocol](https://github.com/meshcore-dev/MeshCore/wiki/Companion-Radio-Protocol) (0x3C/0x3E framed messages).

At startup it sends an `AppStart` command to retrieve the device's public key and name.

Incoming frames from the device are forwarded to all connected WebSocket and TCP clients. A command queue serializes access to the serial port — since the companion protocol has no request IDs, commands are processed one at a time with responses routed back to the originating client. Push notifications (code >= 0x80) are broadcast to all clients.

The web UI works by proxying app.meshcore.nz and injecting a JavaScript polyfill that overrides `navigator.serial`. When the Flutter app calls `requestPort()`, the polyfill returns a fake serial port backed by a WebSocket connection to this bridge.

MQTT publishing is handled by [meshcore-packet-capture](https://github.com/agessaman/meshcore-packet-capture), which connects to the bridge's TCP port as a companion protocol client.

## License

MIT
