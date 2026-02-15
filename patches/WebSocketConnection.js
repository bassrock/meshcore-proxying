/**
 * WebSocketConnection — connects meshcore-web to the bridge server
 * via WebSocket instead of WebSerial/BLE.
 *
 * The bridge server proxies the serial companion protocol, so we
 * use the same frame format as SerialConnection/TCPConnection:
 *   [frameType: 1 byte] [length: 2 bytes LE] [payload: N bytes]
 *
 * Since each WebSocket message is already framed (one message = one
 * serial frame including the 3-byte header), we could skip the
 * buffering/reassembly. But we include it for robustness in case
 * the server ever streams raw bytes.
 */

import { Constants, Connection } from "@liamcottle/meshcore.js";

class WebSocketConnection extends Connection {

    constructor(url) {
        super();
        this.url = url;
        this.socket = null;
        this.readBuffer = [];
    }

    static async open(url) {
        const connection = new WebSocketConnection(url);
        await connection.connect();
        return connection;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = new WebSocket(this.url);
            this.socket.binaryType = "arraybuffer";

            this.socket.onopen = () => {
                this.onConnected();
                resolve();
            };

            this.socket.onmessage = (event) => {
                const data = new Uint8Array(event.data);
                this.onSocketDataReceived(data);
            };

            this.socket.onerror = (error) => {
                console.error("WebSocket error", error);
                reject(error);
            };

            this.socket.onclose = () => {
                this.onDisconnected();
            };
        });
    }

    onSocketDataReceived(data) {
        this.readBuffer = [...this.readBuffer, ...data];
        const frameHeaderLength = 3;

        while (this.readBuffer.length >= frameHeaderLength) {
            try {
                const frameType = this.readBuffer[0];

                // Validate frame type
                if (frameType !== Constants.SerialFrameTypes.Incoming &&
                    frameType !== Constants.SerialFrameTypes.Outgoing) {
                    this.readBuffer = this.readBuffer.slice(1);
                    continue;
                }

                const frameLength = this.readBuffer[1] | (this.readBuffer[2] << 8);
                if (!frameLength) {
                    this.readBuffer = this.readBuffer.slice(1);
                    continue;
                }

                const requiredLength = frameHeaderLength + frameLength;
                if (this.readBuffer.length < requiredLength) {
                    break; // Wait for more data
                }

                const frameData = this.readBuffer.slice(frameHeaderLength, requiredLength);
                this.readBuffer = this.readBuffer.slice(requiredLength);

                // Pass payload (without header) to base class
                this.onFrameReceived(frameData);
            } catch (e) {
                console.error("Failed to process WebSocket frame", e);
                break;
            }
        }
    }

    async close() {
        try {
            this.socket?.close();
        } catch (e) {
            // ignore
        }
    }

    async write(bytes) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(new Uint8Array(bytes));
        }
    }

    async writeFrame(frameType, frameData) {
        const len = frameData.length;
        const frame = new Uint8Array(3 + len);
        frame[0] = frameType;
        frame[1] = len & 0xff;
        frame[2] = (len >> 8) & 0xff;
        frame.set(frameData, 3);
        await this.write(frame);
    }

    async sendToRadioFrame(data) {
        this.emit("tx", data);
        // 0x3c = '<' = outgoing frame type (host → device)
        await this.writeFrame(0x3c, data);
    }
}

export default WebSocketConnection;
