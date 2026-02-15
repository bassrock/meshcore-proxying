'use strict';

const { CommandCodes } = require('./frame-parser.js');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function loadConfig() {
  const enabled = (process.env.WEATHER_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return null;

  const haUrl = process.env.WEATHER_HA_URL;
  const haToken = process.env.WEATHER_HA_TOKEN;
  if (!haUrl || !haToken) {
    throw new Error(
      'WEATHER_ENABLED=true but WEATHER_HA_URL and/or WEATHER_HA_TOKEN are missing'
    );
  }

  // Collect configured entity IDs
  const entities = {};
  const entityKeys = [
    'TEMPERATURE', 'HUMIDITY', 'WIND_SPEED', 'WIND_GUST', 'WIND_BEARING',
    'PRESSURE', 'UV', 'RAIN_RATE', 'RAIN_DAILY', 'SOLAR_RADIATION', 'DEW_POINT',
  ];
  for (const key of entityKeys) {
    const val = process.env[`WEATHER_ENTITY_${key}`];
    if (val) entities[key.toLowerCase()] = val;
  }

  if (Object.keys(entities).length === 0) {
    throw new Error(
      'WEATHER_ENABLED=true but no WEATHER_ENTITY_* variables are configured'
    );
  }

  return {
    haUrl: haUrl.replace(/\/+$/, ''),
    haToken,
    intervalMs: (parseInt(process.env.WEATHER_INTERVAL_MINUTES, 10) || 15) * 60_000,
    channelIdx: parseInt(process.env.WEATHER_CHANNEL_IDX, 10) || 0,
    entities,
  };
}

// ---------------------------------------------------------------------------
// Home Assistant API
// ---------------------------------------------------------------------------
async function fetchEntityState(haUrl, haToken, entityId) {
  const url = `${haUrl}/api/states/${entityId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${haToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) {
    throw new Error(`HA returned 401 Unauthorized — check WEATHER_HA_TOKEN`);
  }
  if (!res.ok) {
    throw new Error(`HA returned ${res.status} for ${entityId}`);
  }

  const data = await res.json();
  return {
    state: data.state,
    unit: data.attributes?.unit_of_measurement || '',
  };
}

// ---------------------------------------------------------------------------
// Wind bearing → compass direction
// ---------------------------------------------------------------------------
const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function degreesToCompass(deg) {
  const num = parseFloat(deg);
  if (isNaN(num)) return deg; // pass through if already text
  const idx = Math.round(num / 22.5) % 16;
  return COMPASS[idx];
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------
function formatWeatherMessage(readings) {
  // readings is a Map of key → { state, unit }
  const parts = [];

  // Temperature: "72.3°F"
  const temp = readings.get('temperature');
  if (temp) parts.push(`${temp.state}${temp.unit}`);

  // Humidity: "45%"
  const hum = readings.get('humidity');
  if (hum) parts.push(`${hum.state}${hum.unit}`);

  // Wind: "NW12G18mph" — combine bearing, speed, gust
  const bearing = readings.get('wind_bearing');
  const speed = readings.get('wind_speed');
  const gust = readings.get('wind_gust');
  if (speed) {
    let wind = '';
    if (bearing) wind += degreesToCompass(bearing.state);
    wind += speed.state;
    if (gust) wind += `G${gust.state}`;
    wind += speed.unit;
    parts.push(wind);
  }

  // Pressure: "30.12inHg"
  const press = readings.get('pressure');
  if (press) parts.push(`${press.state}${press.unit}`);

  // UV: "UV4"
  const uv = readings.get('uv');
  if (uv) parts.push(`UV${uv.state}`);

  // Rain rate: "0.02in/h"
  const rainRate = readings.get('rain_rate');
  if (rainRate) parts.push(`${rainRate.state}${rainRate.unit}`);

  // Rain daily: "0.45in"
  const rainDaily = readings.get('rain_daily');
  if (rainDaily) parts.push(`${rainDaily.state}${rainDaily.unit}`);

  // Solar radiation: "850W/m²"
  const solar = readings.get('solar_radiation');
  if (solar) parts.push(`${solar.state}${solar.unit}`);

  // Dew point: "DP55.2°F"
  const dew = readings.get('dew_point');
  if (dew) parts.push(`DP${dew.state}${dew.unit}`);

  return parts.length > 0 ? `WX: ${parts.join(' ')}` : null;
}

// ---------------------------------------------------------------------------
// Protocol: build CMD_SEND_CHANNEL_TXT_MSG frame
// ---------------------------------------------------------------------------
function buildChannelTxtMsg(buildOutgoingFrame, channelIdx, text) {
  const textBuf = Buffer.from(text, 'utf8');
  const timestamp = Math.floor(Date.now() / 1000);

  // [cmd:1] [txt_type:1] [channel_idx:1] [timestamp_LE:4] [text...]
  const payload = Buffer.alloc(1 + 1 + 1 + 4 + textBuf.length);
  payload[0] = CommandCodes.SendChannelTxtMsg;
  payload[1] = 0x00; // txt_type: plain text
  payload[2] = channelIdx & 0xff;
  payload.writeUInt32LE(timestamp, 3);
  textBuf.copy(payload, 7);

  return buildOutgoingFrame(payload);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function start({ enqueueCommand, buildOutgoingFrame, isReady, log }) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error(`[WEATHER] ${err.message}`);
    return () => {};
  }
  if (!config) return () => {};

  log.info(`[WEATHER] Enabled — polling ${Object.keys(config.entities).length} entities every ${config.intervalMs / 60_000}m on channel ${config.channelIdx}`);

  let timer = null;

  async function tick() {
    if (!isReady()) {
      log.warn('[WEATHER] Device not ready, skipping cycle');
      return;
    }

    // Fetch all configured entities in parallel
    const entries = Object.entries(config.entities);
    const results = await Promise.allSettled(
      entries.map(([key, entityId]) =>
        fetchEntityState(config.haUrl, config.haToken, entityId)
          .then(val => ({ key, ...val }))
      )
    );

    const readings = new Map();
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { key, state, unit } = result.value;
        if (state !== 'unavailable' && state !== 'unknown') {
          readings.set(key, { state, unit });
        }
      } else {
        log.error(`[WEATHER] Sensor fetch failed: ${result.reason.message}`);
      }
    }

    if (readings.size === 0) {
      log.warn('[WEATHER] All sensors unavailable, skipping broadcast');
      return;
    }

    const message = formatWeatherMessage(readings);
    if (!message) return;

    log.info(`[WEATHER] Broadcasting: ${message}`);
    const frame = buildChannelTxtMsg(buildOutgoingFrame, config.channelIdx, message);
    enqueueCommand(frame, null);
  }

  // Run immediately, then on interval
  tick().catch(err => log.error(`[WEATHER] ${err.message}`));
  timer = setInterval(() => {
    tick().catch(err => log.error(`[WEATHER] ${err.message}`));
  }, config.intervalMs);

  return function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    log.info('[WEATHER] Stopped');
  };
}

module.exports = { start };
