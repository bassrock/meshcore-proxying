'use strict';

// JWT token generation for LetsMesh MQTT authentication
// Uses meshcore-decoder's createAuthToken which handles
// the orlp/ed25519 signing used by MeshCore devices.

const { execFile } = require('child_process');
const path = require('path');

// Try to use meshcore-decoder as a library first, fall back to CLI
let createAuthTokenLib = null;
try {
  const decoder = require('@michaelhart/meshcore-decoder');
  createAuthTokenLib = decoder.createAuthToken;
} catch (_) {
  // Library not available, will use CLI fallback
}

/**
 * Generate a JWT auth token for MQTT authentication.
 *
 * @param {string} publicKeyHex - 32-byte public key in hex (64 chars)
 * @param {string} privateKeyHex - 64-byte private key in hex (128 chars)
 * @param {string} audience - Token audience (broker hostname)
 * @param {number} expirySeconds - Token expiry in seconds (default 3600)
 * @returns {Promise<string>} JWT token string
 */
async function generateToken(publicKeyHex, privateKeyHex, audience, expirySeconds = 3600) {
  // Use library if available
  if (createAuthTokenLib) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      publicKey: publicKeyHex.toUpperCase(),
      iat: now,
      exp: now + expirySeconds,
    };
    if (audience) {
      payload.aud = audience;
    }
    return createAuthTokenLib(payload, privateKeyHex, publicKeyHex);
  }

  // Fall back to CLI
  return generateTokenViaCLI(publicKeyHex, privateKeyHex, audience, expirySeconds);
}

function generateTokenViaCLI(publicKeyHex, privateKeyHex, audience, expirySeconds) {
  return new Promise((resolve, reject) => {
    const args = ['auth-token', publicKeyHex, privateKeyHex, '-e', String(expirySeconds)];

    if (audience) {
      args.push('-c', JSON.stringify({ aud: audience }));
    }

    execFile('meshcore-decoder', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`meshcore-decoder CLI error: ${stderr || err.message}`));
        return;
      }
      const token = stdout.trim();
      if (!token || token.split('.').length !== 3) {
        reject(new Error(`Invalid token format from CLI: ${token}`));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Build MQTT username from public key
 * @param {string} publicKeyHex
 * @returns {string}
 */
function mqttUsername(publicKeyHex) {
  return `v1_${publicKeyHex.toUpperCase()}`;
}

module.exports = { generateToken, mqttUsername };
