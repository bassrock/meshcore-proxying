'use strict';

// MeshCore companion protocol frame parser
// Frame format:
//   Device→Host (incoming): [0x3E '>'] [len_lo] [len_hi] [payload...]
//   Host→Device (outgoing): [0x3C '<'] [len_lo] [len_hi] [payload...]

const FRAME_INCOMING = 0x3e; // '>'
const FRAME_OUTGOING = 0x3c; // '<'
const FRAME_HEADER_LEN = 3;

// Push notification codes (first byte of payload)
const PushCodes = {
  Advert: 0x80,
  PathUpdated: 0x81,
  SendConfirmed: 0x82,
  MsgWaiting: 0x83,
  RawData: 0x84,
  LoginSuccess: 0x85,
  LoginFail: 0x86,
  StatusResponse: 0x87,
  LogRxData: 0x88,
};

// Response codes
const ResponseCodes = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  SelfInfo: 5,
  Sent: 6,
  ContactMsgRecv: 7,
  ChannelMsgRecv: 8,
  CurrTime: 9,
  NoMoreMessages: 10,
  ExportContact: 11,
  BatteryVoltage: 12,
  DeviceInfo: 13,
  PrivateKey: 14,
  Disabled: 15,
};

// Command codes
const CommandCodes = {
  AppStart: 1,
  DeviceQuery: 22,
  ExportPrivateKey: 23,
};

class FrameParser {
  constructor() {
    this.buffer = [];
  }

  // Feed raw serial bytes, returns array of parsed frames
  // Each frame is { type, payload: Buffer }
  feed(data) {
    this.buffer.push(...data);
    const frames = [];

    while (this.buffer.length >= FRAME_HEADER_LEN) {
      const frameType = this.buffer[0];

      if (frameType !== FRAME_INCOMING && frameType !== FRAME_OUTGOING) {
        // Skip unexpected byte
        this.buffer.shift();
        continue;
      }

      const lenLo = this.buffer[1];
      const lenHi = this.buffer[2];
      const payloadLen = lenLo | (lenHi << 8);

      if (payloadLen === 0) {
        this.buffer.shift();
        continue;
      }

      const totalLen = FRAME_HEADER_LEN + payloadLen;
      if (this.buffer.length < totalLen) {
        break; // Wait for more data
      }

      const payload = Buffer.from(this.buffer.slice(FRAME_HEADER_LEN, totalLen));
      this.buffer.splice(0, totalLen);

      frames.push({ type: frameType, payload });
    }

    return frames;
  }

  // Build a raw frame (including header) from payload bytes
  static buildFrame(frameType, payload) {
    const len = payload.length;
    const frame = Buffer.alloc(FRAME_HEADER_LEN + len);
    frame[0] = frameType;
    frame[1] = len & 0xff;
    frame[2] = (len >> 8) & 0xff;
    payload.copy ? payload.copy(frame, FRAME_HEADER_LEN) : frame.set(payload, FRAME_HEADER_LEN);
    return frame;
  }

  // Build a raw frame bytes (as Uint8Array) for sending to serial
  static buildOutgoingFrame(payload) {
    return FrameParser.buildFrame(FRAME_OUTGOING, Buffer.from(payload));
  }

  // Extract push notification data from a frame payload
  static parsePushNotification(payload) {
    if (!payload || payload.length === 0) return null;
    const code = payload[0];

    if (code === PushCodes.Advert) {
      // Advert push: [0x80] [32 bytes publicKey]
      if (payload.length < 33) return null;
      return {
        type: 'advert',
        code,
        publicKey: payload.slice(1, 33).toString('hex'),
      };
    }

    if (code === PushCodes.LogRxData) {
      // LogRxData push: [0x88] [int8 snr*4] [int8 rssi] [remaining: raw packet]
      if (payload.length < 3) return null;
      const snr = payload.readInt8(1) / 4;
      const rssi = payload.readInt8(2);
      const raw = payload.slice(3);
      return {
        type: 'log_rx_data',
        code,
        snr,
        rssi,
        raw: raw.toString('hex'),
      };
    }

    if (code === PushCodes.RawData) {
      // RawData push: [0x84] [int8 snr*4] [int8 rssi] [1 byte reserved] [remaining: data]
      if (payload.length < 4) return null;
      return {
        type: 'raw_data',
        code,
        snr: payload.readInt8(1) / 4,
        rssi: payload.readInt8(2),
        data: payload.slice(4).toString('hex'),
      };
    }

    if (code === PushCodes.PathUpdated) {
      if (payload.length < 33) return null;
      return {
        type: 'path_updated',
        code,
        publicKey: payload.slice(1, 33).toString('hex'),
      };
    }

    if (code === PushCodes.MsgWaiting) {
      return { type: 'msg_waiting', code };
    }

    if (code === PushCodes.SendConfirmed) {
      if (payload.length < 9) return null;
      return {
        type: 'send_confirmed',
        code,
        ackCode: payload.readUInt32LE(1),
        roundTrip: payload.readUInt32LE(5),
      };
    }

    return null; // Unknown push code
  }

  // Parse SelfInfo response payload
  // [0x05] [type(1)] [txPower(1)] [maxTxPower(1)] [pubKey(32)] [lat(4)] [lon(4)] [reserved(4)] [freq(4)] [bw(4)] [sf(1)] [cr(1)] [name...]
  // Offsets: 0=code, 1=type, 2=txPower, 3=maxTxPower, 4-35=pubKey, 36-39=lat, 40-43=lon, 44-47=reserved, 48-51=freq, 52-55=bw, 56=sf, 57=cr, 58+=name
  static parseSelfInfo(payload) {
    if (!payload || payload.length < 58) return null;
    const code = payload[0];
    if (code !== ResponseCodes.SelfInfo) return null;

    const publicKey = payload.slice(4, 36).toString('hex');
    // Name starts at offset 58 (1+1+1+1+32+4+4+4+4+4+1+1 = 58)
    const nameBytes = payload.slice(58);
    const nullIdx = nameBytes.indexOf(0);
    const name = nameBytes.slice(0, nullIdx >= 0 ? nullIdx : nameBytes.length).toString('utf8');

    return { publicKey, name };
  }

  // Parse PrivateKey response payload
  // [0x0E] [64 bytes private key]
  static parsePrivateKey(payload) {
    if (!payload || payload.length < 65) return null;
    if (payload[0] !== ResponseCodes.PrivateKey) return null;
    return payload.slice(1, 65).toString('hex');
  }

  // Check if payload is a DeviceInfo response
  static isDeviceInfo(payload) {
    return payload && payload.length > 0 && payload[0] === ResponseCodes.DeviceInfo;
  }

  // Check if payload is a push notification
  static isPushNotification(payload) {
    return payload && payload.length > 0 && payload[0] >= 0x80;
  }
}

module.exports = {
  FrameParser,
  PushCodes,
  ResponseCodes,
  CommandCodes,
  FRAME_INCOMING,
  FRAME_OUTGOING,
  FRAME_HEADER_LEN,
};
