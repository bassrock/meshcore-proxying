'use strict';

const mqtt = require('mqtt');
const { generateToken, mqttUsername } = require('./auth.js');

class MQTTPublisher {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.client = null;
    this.connected = false;
    this.publicKey = null;
    this.privateKey = null;
    this.tokenRenewalTimer = null;
  }

  async start(publicKey, privateKey) {
    if (!this.config.enabled) {
      this.log.info('[MQTT] Publishing disabled');
      return;
    }

    this.publicKey = publicKey;
    this.privateKey = privateKey;

    await this.connect();
  }

  async connect() {
    const { server, port, transport, useTls } = this.config;
    const audience = server;

    let password;
    try {
      password = await generateToken(this.publicKey, this.privateKey, audience, 3600);
      this.log.info('[MQTT] Auth token generated');
    } catch (err) {
      this.log.error(`[MQTT] Failed to generate auth token: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    const username = mqttUsername(this.publicKey);
    const protocol = useTls ? 'wss' : 'ws';
    const url = `${protocol}://${server}:${port}/`;

    const statusTopic = this.statusTopic();
    const offlinePayload = JSON.stringify(this.buildStatusMessage('offline'));

    const opts = {
      username,
      password,
      clientId: `meshcore_${this.publicKey.substring(0, 16)}`,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 0, // We handle reconnection ourselves
      will: {
        topic: statusTopic,
        payload: offlinePayload,
        qos: 0,
        retain: true,
      },
    };

    this.log.info(`[MQTT] Connecting to ${url}`);
    this.client = mqtt.connect(url, opts);

    this.client.on('connect', () => {
      this.connected = true;
      this.log.info('[MQTT] Connected');

      // Publish online status
      const onlinePayload = JSON.stringify(this.buildStatusMessage('online'));
      this.client.publish(statusTopic, onlinePayload, { qos: 0, retain: true });

      // Schedule token renewal (50 minutes, well before 1-hour expiry)
      this.scheduleTokenRenewal(50 * 60 * 1000);
    });

    this.client.on('error', (err) => {
      this.log.error(`[MQTT] Error: ${err.message}`);
    });

    this.client.on('close', () => {
      if (this.connected) {
        this.log.warn('[MQTT] Disconnected');
        this.connected = false;
        this.scheduleReconnect();
      }
    });

    this.client.on('offline', () => {
      this.connected = false;
    });
  }

  scheduleReconnect(delayMs = 10000) {
    setTimeout(() => {
      if (!this.connected && this.config.enabled) {
        this.log.info('[MQTT] Attempting reconnect...');
        this.cleanup();
        this.connect().catch((err) => {
          this.log.error(`[MQTT] Reconnect failed: ${err.message}`);
        });
      }
    }, delayMs);
  }

  scheduleTokenRenewal(delayMs) {
    if (this.tokenRenewalTimer) clearTimeout(this.tokenRenewalTimer);
    this.tokenRenewalTimer = setTimeout(async () => {
      this.log.info('[MQTT] Renewing auth token...');
      this.cleanup();
      try {
        await this.connect();
      } catch (err) {
        this.log.error(`[MQTT] Token renewal reconnect failed: ${err.message}`);
        this.scheduleReconnect();
      }
    }, delayMs);
  }

  packetsTopic() {
    const iata = this.config.iata || 'XXX';
    return `meshcore/${iata}/${this.publicKey.toUpperCase()}/packets`;
  }

  statusTopic() {
    const iata = this.config.iata || 'XXX';
    return `meshcore/${iata}/${this.publicKey.toUpperCase()}/status`;
  }

  buildStatusMessage(status) {
    return {
      status,
      timestamp: new Date().toISOString(),
      origin_id: this.publicKey ? this.publicKey.toUpperCase() : 'UNKNOWN',
      client_version: 'meshcore-station/1.0.0',
    };
  }

  // Publish a parsed push notification as a packet event
  publishPacket(pushData) {
    if (!this.connected || !this.client) return;

    const message = {
      origin_id: this.publicKey ? this.publicKey.toUpperCase() : 'UNKNOWN',
      timestamp: new Date().toISOString(),
      ...pushData,
    };

    const topic = this.packetsTopic();
    this.client.publish(topic, JSON.stringify(message), { qos: 0 }, (err) => {
      if (err) {
        this.log.error(`[MQTT] Publish error: ${err.message}`);
      }
    });
  }

  cleanup() {
    if (this.tokenRenewalTimer) {
      clearTimeout(this.tokenRenewalTimer);
      this.tokenRenewalTimer = null;
    }
    if (this.client) {
      try {
        this.client.end(true);
      } catch (_) {}
      this.client = null;
    }
    this.connected = false;
  }

  stop() {
    if (this.connected && this.client) {
      const offlinePayload = JSON.stringify(this.buildStatusMessage('offline'));
      this.client.publish(this.statusTopic(), offlinePayload, { qos: 0, retain: true });
    }
    this.cleanup();
  }
}

module.exports = { MQTTPublisher };
