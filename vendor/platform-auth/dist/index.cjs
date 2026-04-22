"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG: () => DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG,
  PlatformAuthController: () => PlatformAuthController,
  PlatformAuthProvider: () => PlatformAuthProvider,
  YAPPR_KEY_EXCHANGE_VERSION: () => YAPPR_KEY_EXCHANGE_VERSION,
  YAPPR_NETWORK_IDS: () => YAPPR_NETWORK_IDS,
  YAPPR_STATE_TRANSITION_VERSION: () => YAPPR_STATE_TRANSITION_VERSION,
  buildYapprKeyExchangeUri: () => buildYapprKeyExchangeUri,
  buildYapprStateTransitionUri: () => buildYapprStateTransitionUri,
  clearSensitiveBytes: () => clearSensitiveBytes,
  createBrowserSecretStore: () => createBrowserSecretStore,
  createPasskeyWithPrf: () => createPasskeyWithPrf,
  decodeYapprContractId: () => decodeYapprContractId,
  decodeYapprIdentityId: () => decodeYapprIdentityId,
  decryptYapprKeyExchangeResponse: () => decryptYapprKeyExchangeResponse,
  decryptYapprLoginKey: () => decryptYapprLoginKey,
  deriveYapprAuthKeyFromLogin: () => deriveYapprAuthKeyFromLogin,
  deriveYapprEncryptionKeyFromLogin: () => deriveYapprEncryptionKeyFromLogin,
  deriveYapprSharedSecret: () => deriveYapprSharedSecret,
  generatePrfInput: () => generatePrfInput,
  generateYapprEphemeralKeyPair: () => generateYapprEphemeralKeyPair,
  getDefaultRpId: () => getDefaultRpId,
  getPasskeyAllowCredentialIds: () => getPasskeyAllowCredentialIds,
  getPasskeyPrfSupport: () => getPasskeyPrfSupport,
  getPrfAssertionForCredentials: () => getPrfAssertionForCredentials,
  getYapprPublicKey: () => getYapprPublicKey,
  hash160: () => hash160,
  parseYapprKeyExchangeUri: () => parseYapprKeyExchangeUri,
  parseYapprStateTransitionUri: () => parseYapprStateTransitionUri,
  pollForYapprKeyExchangeResponse: () => pollForYapprKeyExchangeResponse,
  selectDiscoverablePasskey: () => selectDiscoverablePasskey,
  serializeYapprKeyExchangeRequest: () => serializeYapprKeyExchangeRequest,
  usePlatformAuth: () => usePlatformAuth,
  useYapprKeyExchangeLogin: () => useYapprKeyExchangeLogin,
  useYapprKeyRegistration: () => useYapprKeyRegistration
});
module.exports = __toCommonJS(index_exports);

// src/browser/passkey-prf.ts
var import_sha2 = require("@noble/hashes/sha2.js");

// src/browser/secret-store.ts
var BrowserStorage = class {
  constructor(prefix) {
    this.prefix = prefix;
  }
  prefix;
  getKeysWithPrefix(storage) {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(this.prefix)) {
        keys.push(key);
      }
    }
    return keys;
  }
  getStorage() {
    if (typeof window === "undefined") return null;
    return localStorage;
  }
  getLegacyStorage() {
    if (typeof window === "undefined") return null;
    return sessionStorage;
  }
  isAvailable() {
    if (typeof window === "undefined") return false;
    try {
      const test = "__storage_test__";
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }
  set(key, value) {
    if (!this.isAvailable()) return;
    const storage = this.getStorage();
    if (!storage) return;
    try {
      storage.setItem(this.prefix + key, JSON.stringify(value));
      this.getLegacyStorage()?.removeItem(this.prefix + key);
    } catch {
    }
  }
  get(key) {
    if (!this.isAvailable()) return null;
    try {
      const storage = this.getStorage();
      if (!storage) return null;
      const item = storage.getItem(this.prefix + key);
      if (item) return JSON.parse(item);
      const legacyStorage = this.getLegacyStorage();
      const fallback = legacyStorage?.getItem(this.prefix + key);
      if (!fallback) return null;
      const parsed = JSON.parse(fallback);
      storage.setItem(this.prefix + key, fallback);
      legacyStorage?.removeItem(this.prefix + key);
      return parsed;
    } catch {
      return null;
    }
  }
  has(key) {
    if (!this.isAvailable()) return false;
    const storage = this.getStorage();
    if (!storage) return false;
    if (storage.getItem(this.prefix + key) !== null) return true;
    return this.getLegacyStorage()?.getItem(this.prefix + key) !== null;
  }
  delete(key) {
    if (!this.isAvailable()) return false;
    const existed = this.has(key);
    localStorage.removeItem(this.prefix + key);
    sessionStorage.removeItem(this.prefix + key);
    return existed;
  }
  clear() {
    if (!this.isAvailable()) return;
    this.getKeysWithPrefix(localStorage).forEach((key) => localStorage.removeItem(key));
    this.getKeysWithPrefix(sessionStorage).forEach((key) => sessionStorage.removeItem(key));
  }
  keys() {
    if (!this.isAvailable()) return [];
    const allKeys = [
      ...this.getKeysWithPrefix(localStorage),
      ...this.getKeysWithPrefix(sessionStorage)
    ];
    const uniqueKeys = new Set(allKeys.map((key) => key.slice(this.prefix.length)));
    return Array.from(uniqueKeys);
  }
  size() {
    return this.keys().length;
  }
};
function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}
function base64ToBytes(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
function generatePrfInput() {
  return crypto.getRandomValues(new Uint8Array(32));
}
function createBrowserSecretStore(options) {
  const storage = new BrowserStorage(options.prefix ?? "platform_auth_secure_");
  const storePrivateKey = (identityId, privateKey) => {
    storage.set(`pk_${identityId}`, privateKey);
  };
  const getPrivateKey = (identityId) => {
    const value = storage.get(`pk_${identityId}`);
    return typeof value === "string" ? value : null;
  };
  const clearPrivateKey = (identityId) => storage.delete(`pk_${identityId}`);
  const hasPrivateKey = (identityId) => storage.has(`pk_${identityId}`);
  const clearAllPrivateKeys = () => {
    storage.keys().filter((key) => key.startsWith("pk_")).forEach((key) => {
      storage.delete(key);
    });
  };
  const storeLoginKey = (identityId, loginKey) => {
    storage.set(`lk_${identityId}`, bytesToBase64(loginKey));
  };
  const getLoginKey = (identityId) => {
    const value = storage.get(`lk_${identityId}`);
    return typeof value === "string" ? value : null;
  };
  const getLoginKeyBytes = (identityId) => {
    const value = getLoginKey(identityId);
    return value ? base64ToBytes(value) : null;
  };
  const hasLoginKey = (identityId) => storage.has(`lk_${identityId}`);
  const clearLoginKey = (identityId) => storage.delete(`lk_${identityId}`);
  const storeAuthVaultDek = (identityId, dek) => {
    storage.set(`avd_${identityId}`, bytesToBase64(dek));
  };
  const getAuthVaultDek = (identityId) => {
    const value = storage.get(`avd_${identityId}`);
    return typeof value === "string" ? value : null;
  };
  const getAuthVaultDekBytes = (identityId) => {
    const value = getAuthVaultDek(identityId);
    return value ? base64ToBytes(value) : null;
  };
  const hasAuthVaultDek = (identityId) => storage.has(`avd_${identityId}`);
  const clearAuthVaultDek = (identityId) => storage.delete(`avd_${identityId}`);
  const storeNormalizedWif = (storageKey, privateKey) => {
    if (options.crypto.isLikelyWif(privateKey)) {
      storage.set(storageKey, privateKey);
      return;
    }
    const parsed = options.crypto.parsePrivateKey(privateKey);
    const wif = options.crypto.privateKeyToWif(parsed.privateKey, options.network, true);
    storage.set(storageKey, wif);
  };
  const getKeyBytes = (value) => {
    if (!value) return null;
    try {
      const parsed = options.crypto.parsePrivateKey(value);
      return parsed.privateKey;
    } catch {
      return null;
    }
  };
  const storeEncryptionKey = (identityId, encryptionKey) => {
    storeNormalizedWif(`ek_${identityId}`, encryptionKey);
  };
  const getEncryptionKey = (identityId) => {
    const value = storage.get(`ek_${identityId}`);
    return typeof value === "string" ? value : null;
  };
  const getEncryptionKeyBytes = (identityId) => getKeyBytes(getEncryptionKey(identityId));
  const hasEncryptionKey = (identityId) => storage.has(`ek_${identityId}`);
  const clearEncryptionKey = (identityId) => storage.delete(`ek_${identityId}`);
  const storeEncryptionKeyType = (identityId, type) => {
    storage.set(`ek_type_${identityId}`, type);
  };
  const getEncryptionKeyType = (identityId) => {
    const value = storage.get(`ek_type_${identityId}`);
    return value === "derived" || value === "external" ? value : null;
  };
  const clearEncryptionKeyType = (identityId) => storage.delete(`ek_type_${identityId}`);
  const storeTransferKey = (identityId, transferKey) => {
    storeNormalizedWif(`tk_${identityId}`, transferKey);
  };
  const getTransferKey = (identityId) => {
    const value = storage.get(`tk_${identityId}`);
    return typeof value === "string" ? value : null;
  };
  const getTransferKeyBytes = (identityId) => getKeyBytes(getTransferKey(identityId));
  const hasTransferKey = (identityId) => storage.has(`tk_${identityId}`);
  const clearTransferKey = (identityId) => storage.delete(`tk_${identityId}`);
  return {
    secureStorage: storage,
    storePrivateKey,
    getPrivateKey,
    clearPrivateKey,
    hasPrivateKey,
    clearAllPrivateKeys,
    storeLoginKey,
    getLoginKey,
    getLoginKeyBytes,
    hasLoginKey,
    clearLoginKey,
    storeAuthVaultDek,
    getAuthVaultDek,
    getAuthVaultDekBytes,
    hasAuthVaultDek,
    clearAuthVaultDek,
    storeEncryptionKey,
    getEncryptionKey,
    getEncryptionKeyBytes,
    hasEncryptionKey,
    clearEncryptionKey,
    storeEncryptionKeyType,
    getEncryptionKeyType,
    clearEncryptionKeyType,
    storeTransferKey,
    getTransferKey,
    getTransferKeyBytes,
    hasTransferKey,
    clearTransferKey
  };
}

// src/browser/passkey-prf.ts
var DEFAULT_RP_NAME = "Platform Auth";
function getDefaultRpId() {
  if (typeof window === "undefined") {
    throw new Error("Passkeys require a browser environment");
  }
  return window.location.hostname;
}
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function base64UrlEncode(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function extractPrfFirst(result) {
  if (!result?.results?.first) return null;
  return new Uint8Array(result.results.first);
}
function decodeUserHandle(userHandle) {
  if (!userHandle) return void 0;
  const decoded = new TextDecoder().decode(new Uint8Array(userHandle)).trim();
  return decoded || void 0;
}
function ensureBrowserPasskeys() {
  if (typeof window === "undefined" || !window.isSecureContext || !window.PublicKeyCredential) {
    throw new Error("Passkey enrollment requires a secure browser with WebAuthn support.");
  }
}
async function createPasskeyWithPrf(options) {
  ensureBrowserPasskeys();
  const rpId = options.rpId ?? getDefaultRpId();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = new TextEncoder().encode(options.identityId).slice(0, 64);
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        id: rpId,
        name: options.rpName ?? DEFAULT_RP_NAME
      },
      user: {
        id: userId,
        name: options.username,
        displayName: options.displayName
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -257 }
      ],
      timeout: 6e4,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      },
      extensions: {
        prf: {}
      }
    }
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Failed to create passkey credential");
  }
  const createExtensions = credential.getClientExtensionResults();
  if (createExtensions.prf?.enabled === false) {
    throw new Error("This passkey/provider did not enable PRF during registration.");
  }
  const credentialId = new Uint8Array(credential.rawId);
  const prfInput = generatePrfInput();
  const assertion = await getPrfAssertionForCredentials([{ credentialId, prfInput, rpId }]);
  return {
    ...assertion,
    label: options.label
  };
}
async function getPrfAssertionForCredentials(credentials) {
  ensureBrowserPasskeys();
  if (credentials.length === 0) {
    throw new Error("No passkey credentials available");
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = credentials[0].rpId;
  const allowCredentials = credentials.map((entry) => ({
    id: toArrayBuffer(entry.credentialId),
    type: "public-key"
  }));
  const evalByCredential = credentials.reduce((accumulator, entry) => {
    accumulator[base64UrlEncode(entry.credentialId)] = { first: entry.prfInput };
    return accumulator;
  }, {});
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      timeout: 6e4,
      userVerification: "required",
      allowCredentials,
      extensions: {
        prf: {
          evalByCredential
        }
      }
    }
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey assertion failed");
  }
  const typedCredential = credential;
  const prfOutput = extractPrfFirst(typedCredential.getClientExtensionResults().prf);
  if (!prfOutput) {
    throw new Error("This passkey/provider did not return PRF output.");
  }
  const credentialId = new Uint8Array(credential.rawId);
  const descriptor = credentials.find((entry) => base64UrlEncode(entry.credentialId) === base64UrlEncode(credentialId));
  if (!descriptor) {
    throw new Error("Selected passkey is not registered for this identity.");
  }
  return {
    credentialId,
    credentialIdHash: (0, import_sha2.sha256)(credentialId),
    prfInput: descriptor.prfInput,
    prfOutput,
    rpId: descriptor.rpId
  };
}
async function selectDiscoverablePasskey(rpId = getDefaultRpId()) {
  ensureBrowserPasskeys();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      timeout: 6e4,
      userVerification: "required"
    }
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey assertion failed");
  }
  const assertionCredential = credential;
  const credentialId = new Uint8Array(credential.rawId);
  return {
    credentialId,
    credentialIdHash: (0, import_sha2.sha256)(credentialId),
    userHandle: decodeUserHandle(assertionCredential.response.userHandle),
    rpId
  };
}
function getPasskeyAllowCredentialIds(credentials) {
  return credentials.map((entry) => new Uint8Array(toArrayBuffer(entry.credentialId)));
}

// src/browser/passkey-support.ts
function getPlatformHint() {
  if (typeof navigator === "undefined") return "unknown";
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (/iphone|ipad|ipod|mac os|macintosh/.test(userAgent) || /iphone|ipad|mac/.test(platform)) {
    return "apple";
  }
  if (/android/.test(userAgent)) {
    return "android";
  }
  if (/windows/.test(userAgent) || /win/.test(platform)) {
    return "windows";
  }
  if (userAgent) {
    return "desktop-other";
  }
  return "unknown";
}
async function getPasskeyPrfSupport() {
  if (typeof window === "undefined") {
    return {
      webauthnAvailable: false,
      conditionalUiAvailable: false,
      likelyPrfCapable: false,
      platformHint: "unknown",
      blockedReason: "Passkeys are only available in a browser context."
    };
  }
  if (!window.isSecureContext) {
    return {
      webauthnAvailable: false,
      conditionalUiAvailable: false,
      likelyPrfCapable: false,
      platformHint: getPlatformHint(),
      blockedReason: "Passkey enrollment requires a secure browser context."
    };
  }
  const publicKeyCredential = window.PublicKeyCredential;
  if (!publicKeyCredential) {
    return {
      webauthnAvailable: false,
      conditionalUiAvailable: false,
      likelyPrfCapable: false,
      platformHint: getPlatformHint(),
      blockedReason: "This browser does not support WebAuthn passkeys."
    };
  }
  const conditionalUiAvailable = typeof publicKeyCredential.isConditionalMediationAvailable === "function" ? await publicKeyCredential.isConditionalMediationAvailable().catch(() => false) : false;
  const platformAuthenticatorAvailable = typeof publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function" ? await publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false) : false;
  return {
    webauthnAvailable: true,
    conditionalUiAvailable,
    likelyPrfCapable: platformAuthenticatorAvailable || conditionalUiAvailable,
    platformHint: getPlatformHint(),
    blockedReason: platformAuthenticatorAvailable || conditionalUiAvailable ? void 0 : "This browser can use passkeys, but PRF capability still needs to be confirmed by an actual passkey assertion."
  };
}

// src/key-exchange/yappr-protocol.ts
var import_bs58 = __toESM(require("bs58"), 1);
var secp256k1 = __toESM(require("@noble/secp256k1"), 1);
var import_hkdf = require("@noble/hashes/hkdf.js");
var import_legacy = require("@noble/hashes/legacy.js");
var import_sha22 = require("@noble/hashes/sha2.js");
var encoder = new TextEncoder();
var YAPPR_KEY_EXCHANGE_VERSION = 1;
var YAPPR_STATE_TRANSITION_VERSION = 1;
var YAPPR_NETWORK_IDS = {
  mainnet: "m",
  testnet: "t",
  devnet: "d"
};
var DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG = {
  label: "Login to Yappr",
  pollIntervalMs: 3e3,
  timeoutMs: 12e4
};
function hash160(data) {
  return (0, import_legacy.ripemd160)((0, import_sha22.sha256)(data));
}
function generateYapprEphemeralKeyPair() {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}
function deriveYapprSharedSecret(appEphemeralPrivateKey, walletEphemeralPublicKey) {
  const sharedPoint = secp256k1.getSharedSecret(appEphemeralPrivateKey, walletEphemeralPublicKey);
  const sharedX = sharedPoint.slice(1, 33);
  return (0, import_hkdf.hkdf)(
    import_sha22.sha256,
    sharedX,
    encoder.encode("dash:key-exchange:v1"),
    new Uint8Array(0),
    32
  );
}
async function decryptYapprLoginKey(encryptedPayload, sharedSecret) {
  if (encryptedPayload.length < 60) {
    throw new Error("Encrypted payload too short; must be at least 60 bytes");
  }
  const nonce = encryptedPayload.slice(0, 12);
  const ciphertextWithTag = encryptedPayload.slice(12);
  const key = await crypto.subtle.importKey(
    "raw",
    sharedSecret.buffer.slice(sharedSecret.byteOffset, sharedSecret.byteOffset + sharedSecret.byteLength),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertextWithTag
  );
  const result = new Uint8Array(decrypted);
  if (result.length !== 32) {
    throw new Error(`Invalid decrypted login key length: expected 32, got ${result.length}`);
  }
  return result;
}
function deriveYapprAuthKeyFromLogin(loginKey, identityIdBytes) {
  if (loginKey.length !== 32) {
    throw new Error(`Invalid login key length: expected 32, got ${loginKey.length}`);
  }
  if (identityIdBytes.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${identityIdBytes.length}`);
  }
  return (0, import_hkdf.hkdf)(
    import_sha22.sha256,
    loginKey,
    identityIdBytes,
    encoder.encode("auth"),
    32
  );
}
function deriveYapprEncryptionKeyFromLogin(loginKey, identityIdBytes) {
  if (loginKey.length !== 32) {
    throw new Error(`Invalid login key length: expected 32, got ${loginKey.length}`);
  }
  if (identityIdBytes.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${identityIdBytes.length}`);
  }
  return (0, import_hkdf.hkdf)(
    import_sha22.sha256,
    loginKey,
    identityIdBytes,
    encoder.encode("encryption"),
    32
  );
}
function getYapprPublicKey(privateKey) {
  return secp256k1.getPublicKey(privateKey, true);
}
function clearSensitiveBytes(bytes) {
  bytes.fill(0);
}
function decodeYapprIdentityId(identityIdBase58) {
  const decoded = import_bs58.default.decode(identityIdBase58);
  if (decoded.length !== 32) {
    throw new Error(`Invalid identity ID length: expected 32, got ${decoded.length}`);
  }
  return decoded;
}
function decodeYapprContractId(contractIdBase58) {
  const decoded = import_bs58.default.decode(contractIdBase58);
  if (decoded.length !== 32) {
    throw new Error(`Invalid contract ID length: expected 32, got ${decoded.length}`);
  }
  return decoded;
}
function serializeYapprKeyExchangeRequest(request) {
  if (request.appEphemeralPubKey.length !== 33) {
    throw new Error(`Invalid ephemeral public key length: expected 33, got ${request.appEphemeralPubKey.length}`);
  }
  if (request.contractId.length !== 32) {
    throw new Error(`Invalid contract ID length: expected 32, got ${request.contractId.length}`);
  }
  const labelBytes = request.label ? encoder.encode(request.label) : new Uint8Array(0);
  if (labelBytes.length > 64) {
    throw new Error(`Label too long: max 64 bytes, got ${labelBytes.length}`);
  }
  const buffer = new Uint8Array(1 + 33 + 32 + 1 + labelBytes.length);
  let offset = 0;
  buffer[offset++] = YAPPR_KEY_EXCHANGE_VERSION;
  buffer.set(request.appEphemeralPubKey, offset);
  offset += 33;
  buffer.set(request.contractId, offset);
  offset += 32;
  buffer[offset++] = labelBytes.length;
  if (labelBytes.length > 0) {
    buffer.set(labelBytes, offset);
  }
  return buffer;
}
function buildYapprKeyExchangeUri(request, network = "testnet") {
  const requestBytes = serializeYapprKeyExchangeRequest(request);
  const requestData = import_bs58.default.encode(requestBytes);
  return `dash-key:${requestData}?n=${YAPPR_NETWORK_IDS[network]}&v=${YAPPR_KEY_EXCHANGE_VERSION}`;
}
function parseYapprKeyExchangeUri(uri) {
  try {
    if (!uri.startsWith("dash-key:")) {
      return null;
    }
    const uriWithoutScheme = uri.slice(9);
    const queryStart = uriWithoutScheme.indexOf("?");
    if (queryStart === -1) {
      return null;
    }
    const requestData = uriWithoutScheme.slice(0, queryStart);
    const queryString = uriWithoutScheme.slice(queryStart + 1);
    const params = new URLSearchParams(queryString);
    const networkId = params.get("n");
    const versionStr = params.get("v");
    if (!networkId || !versionStr) {
      return null;
    }
    const version = Number.parseInt(versionStr, 10);
    if (version !== YAPPR_KEY_EXCHANGE_VERSION) {
      return null;
    }
    const network = parseYapprNetworkId(networkId);
    if (!network) {
      return null;
    }
    const requestBytes = import_bs58.default.decode(requestData);
    if (requestBytes.length < 67) {
      return null;
    }
    let offset = 0;
    const byteVersion = requestBytes[offset++];
    if (byteVersion !== YAPPR_KEY_EXCHANGE_VERSION) {
      return null;
    }
    const appEphemeralPubKey = requestBytes.slice(offset, offset + 33);
    offset += 33;
    const contractId = requestBytes.slice(offset, offset + 32);
    offset += 32;
    const labelLength = requestBytes[offset++];
    if (labelLength > 64 || offset + labelLength > requestBytes.length) {
      return null;
    }
    let label;
    if (labelLength > 0) {
      label = new TextDecoder().decode(requestBytes.slice(offset, offset + labelLength));
    }
    return {
      request: {
        appEphemeralPubKey,
        contractId,
        label
      },
      network,
      version
    };
  } catch {
    return null;
  }
}
function buildYapprStateTransitionUri(transitionBytes, network = "testnet") {
  return `dash-st:${import_bs58.default.encode(transitionBytes)}?n=${YAPPR_NETWORK_IDS[network]}&v=${YAPPR_STATE_TRANSITION_VERSION}`;
}
function parseYapprStateTransitionUri(uri) {
  try {
    if (!uri.startsWith("dash-st:")) {
      return null;
    }
    const uriWithoutScheme = uri.slice(8);
    const queryStart = uriWithoutScheme.indexOf("?");
    if (queryStart === -1) {
      return null;
    }
    const transitionData = uriWithoutScheme.slice(0, queryStart);
    const queryString = uriWithoutScheme.slice(queryStart + 1);
    const params = new URLSearchParams(queryString);
    const networkId = params.get("n");
    const versionStr = params.get("v");
    if (!networkId || !versionStr) {
      return null;
    }
    const version = Number.parseInt(versionStr, 10);
    if (version !== YAPPR_STATE_TRANSITION_VERSION) {
      return null;
    }
    const network = parseYapprNetworkId(networkId);
    if (!network) {
      return null;
    }
    return {
      transitionBytes: import_bs58.default.decode(transitionData),
      network,
      version
    };
  } catch {
    return null;
  }
}
async function pollForYapprKeyExchangeResponse(port, contractIdBytes, appEphemeralPubKeyHash, appEphemeralPrivateKey, options = {}) {
  const {
    pollIntervalMs = DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.pollIntervalMs,
    timeoutMs = DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.timeoutMs,
    signal,
    onPoll,
    logger
  } = options;
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      throw new Error("Cancelled");
    }
    onPoll?.();
    try {
      const response = await port.getResponse(contractIdBytes, appEphemeralPubKeyHash);
      logger?.info("platform-auth: yappr key exchange poll result", {
        hasResponse: !!response,
        ownerId: response?.$ownerId
      });
      if (response) {
        return await decryptYapprKeyExchangeResponse(response, appEphemeralPrivateKey);
      }
    } catch (error) {
      logger?.warn("platform-auth: yappr key exchange poll query failed", error);
    }
    await sleep(pollIntervalMs, signal);
  }
  throw new Error("Timeout waiting for key exchange response");
}
async function decryptYapprKeyExchangeResponse(response, appEphemeralPrivateKey) {
  const sharedSecret = deriveYapprSharedSecret(appEphemeralPrivateKey, response.walletEphemeralPubKey);
  try {
    const loginKey = await decryptYapprLoginKey(response.encryptedPayload, sharedSecret);
    return {
      loginKey,
      keyIndex: response.keyIndex,
      walletEphemeralPubKey: response.walletEphemeralPubKey,
      identityId: response.$ownerId
    };
  } finally {
    clearSensitiveBytes(sharedSecret);
  }
}
function parseYapprNetworkId(networkId) {
  switch (networkId) {
    case "m":
      return "mainnet";
    case "t":
      return "testnet";
    case "d":
      return "devnet";
    default:
      return null;
  }
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Cancelled"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

// src/core/controller.ts
var DEFAULT_FEATURES = {
  usernameGate: true,
  profileGate: true,
  passwordLogin: true,
  passkeyLogin: true,
  keyExchangeLogin: true,
  authVault: true,
  legacyPasswordLogin: true,
  autoDeriveEncryptionKey: true,
  postLoginTasks: true,
  balanceRefresh: true
};
var DEFAULT_BALANCE_REFRESH_MS = 3e5;
var noopLogger = {
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0
};
function sameBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
function buildIntent(kind, identityId, username) {
  if (kind === "profile-required") {
    return { kind, identityId, username };
  }
  return { kind, identityId };
}
var PlatformAuthController = class {
  constructor(deps) {
    this.deps = deps;
    this.features = { ...DEFAULT_FEATURES, ...deps.features };
    this.logger = deps.logger ?? noopLogger;
    this.balanceRefreshMs = deps.balanceRefreshMs ?? DEFAULT_BALANCE_REFRESH_MS;
  }
  deps;
  features;
  listeners = /* @__PURE__ */ new Set();
  logger;
  balanceRefreshMs;
  state = {
    user: null,
    isLoading: false,
    isAuthRestoring: true,
    error: null
  };
  balanceInterval = null;
  getState() {
    return this.state;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    if (this.balanceInterval) {
      clearInterval(this.balanceInterval);
      this.balanceInterval = null;
    }
    this.listeners.clear();
  }
  getYapprKeyExchangeConfig(overrides = {}) {
    const configured = this.deps.yapprKeyExchangeConfig ?? {};
    const appContractId = overrides.appContractId ?? configured.appContractId;
    const keyExchangeContractId = overrides.keyExchangeContractId ?? configured.keyExchangeContractId;
    if (!appContractId || !keyExchangeContractId) {
      throw new Error("Yappr key exchange is not configured");
    }
    return {
      appContractId,
      keyExchangeContractId,
      network: overrides.network ?? configured.network ?? this.deps.network,
      label: overrides.label ?? configured.label ?? DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.label,
      pollIntervalMs: overrides.pollIntervalMs ?? configured.pollIntervalMs ?? DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.pollIntervalMs,
      timeoutMs: overrides.timeoutMs ?? configured.timeoutMs ?? DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.timeoutMs
    };
  }
  async pollYapprKeyExchangeResponse(appEphemeralPubKeyHash, appEphemeralPrivateKey, overrides = {}, options = {}) {
    const { port, config } = this.requireYapprKeyExchange(overrides);
    const contractIdBytes = decodeYapprContractId(config.appContractId);
    return pollForYapprKeyExchangeResponse(
      port,
      contractIdBytes,
      appEphemeralPubKeyHash,
      appEphemeralPrivateKey,
      {
        pollIntervalMs: config.pollIntervalMs,
        timeoutMs: config.timeoutMs,
        signal: options.signal,
        onPoll: options.onPoll,
        logger: this.logger
      }
    );
  }
  async checkYapprKeysRegistered(identityId, authPublicKey, encryptionPublicKey, overrides = {}) {
    const { port } = this.requireYapprKeyExchange(overrides);
    return port.checkKeysRegistered(identityId, authPublicKey, encryptionPublicKey);
  }
  async buildYapprUnsignedKeyRegistrationTransition(request, overrides = {}) {
    const { port } = this.requireYapprKeyExchange(overrides);
    return port.buildUnsignedKeyRegistrationTransition(request);
  }
  async completeYapprKeyExchangeLogin(input) {
    return this.loginWithLoginKey(input.identityId, input.loginKey, input.keyIndex);
  }
  async restoreSession() {
    this.patchState({ isAuthRestoring: true, error: null });
    try {
      const snapshot = await this.deps.sessionStore.getSession();
      if (!snapshot) {
        this.patchState({ isAuthRestoring: false });
        return null;
      }
      const identityId = snapshot.user.identityId;
      const hasPrivateKey = await this.deps.secretStore.hasPrivateKey(identityId);
      if (!hasPrivateKey) {
        await this.deps.sessionStore.clearSession();
        this.patchState({ isAuthRestoring: false, user: null });
        return null;
      }
      this.patchState({
        user: snapshot.user,
        isAuthRestoring: false,
        error: null
      });
      await this.deps.clientIdentity?.setIdentity(identityId);
      await this.emit({ type: "session-restored", user: snapshot.user });
      if (!snapshot.user.username && this.deps.usernames) {
        void this.backfillUsername(identityId);
      }
      this.startBalanceRefresh();
      this.runPostLoginTasks(identityId, 3e3);
      return snapshot.user;
    } catch (error) {
      this.logger.error("platform-auth: failed to restore session", error);
      await this.deps.sessionStore.clearSession();
      this.patchState({
        user: null,
        error: error instanceof Error ? error.message : "Failed to restore session",
        isAuthRestoring: false
      });
      return null;
    }
  }
  async loginWithAuthKey(identityId, privateKey, options = {}) {
    const skipUsernameCheck = options.skipUsernameCheck ?? false;
    this.patchState({ isLoading: true, error: null });
    try {
      if (!identityId || !privateKey) {
        throw new Error("Identity ID and private key are required");
      }
      const identity = await this.deps.identity.getIdentity(identityId);
      if (!identity) {
        throw new Error("Identity not found");
      }
      const username = this.deps.usernames ? await this.deps.usernames.resolveUsername(identity.id) : null;
      const user = {
        identityId: identity.id,
        balance: identity.balance,
        username: username ?? void 0,
        publicKeys: identity.publicKeys
      };
      await this.persistSessionUser(user);
      await this.deps.secretStore.storePrivateKey(identity.id, privateKey);
      await this.deps.clientIdentity?.setIdentity(identity.id);
      this.patchState({
        user,
        error: null
      });
      await this.emit({ type: "login-succeeded", user });
      this.startBalanceRefresh();
      this.tryAutoDeriveEncryptionKey(identity.id, privateKey, user.publicKeys);
      if (this.features.usernameGate && !skipUsernameCheck && !user.username) {
        await this.emit({ type: "username-required", identityId: identity.id });
        return {
          user,
          intent: buildIntent("username-required", identity.id)
        };
      }
      if (this.features.profileGate && this.deps.profiles) {
        const hasProfile = await this.deps.profiles.hasProfile(identity.id, user.username);
        if (!hasProfile) {
          await this.emit({ type: "profile-required", identityId: identity.id, username: user.username });
          return {
            user,
            intent: buildIntent("profile-required", identity.id, user.username)
          };
        }
      }
      this.runPostLoginTasks(identity.id, 2e3);
      return {
        user,
        intent: buildIntent("ready", identity.id)
      };
    } catch (error) {
      this.logger.error("platform-auth: auth-key login failed", error);
      this.patchState({
        error: error instanceof Error ? error.message : "Failed to login"
      });
      throw error;
    } finally {
      this.patchState({ isLoading: false });
    }
  }
  async loginWithPassword(identityOrUsername, password) {
    if (!this.features.passwordLogin) {
      throw new Error("Password login is disabled");
    }
    this.patchState({ isLoading: true, error: null });
    try {
      let fallbackResult = null;
      let sawInvalidPassword = false;
      let lastNonPasswordError = null;
      if (this.features.authVault && this.deps.vault?.isConfigured()) {
        try {
          const unlocked = await this.deps.vault.unlockWithPassword(identityOrUsername, password);
          return await this.restoreUnlockedVaultSession(unlocked);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "Invalid password") {
            sawInvalidPassword = true;
          } else if (error instanceof Error) {
            lastNonPasswordError = error;
          }
        }
      }
      if (this.features.legacyPasswordLogin && this.deps.legacyPasswordLogins) {
        for (const adapter of this.deps.legacyPasswordLogins) {
          if (!adapter.isConfigured()) continue;
          try {
            fallbackResult = await adapter.loginWithPassword(identityOrUsername, password);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message === "Invalid password") {
              sawInvalidPassword = true;
            } else if (error instanceof Error) {
              lastNonPasswordError = error;
            }
          }
        }
      }
      if (!fallbackResult) {
        if (sawInvalidPassword) {
          throw new Error("Invalid password");
        }
        throw lastNonPasswordError ?? new Error("Password login is not configured");
      }
      return await this.loginWithAuthKey(fallbackResult.identityId, fallbackResult.privateKey, {
        skipUsernameCheck: true
      });
    } catch (error) {
      this.logger.error("platform-auth: password login failed", error);
      this.patchState({
        error: error instanceof Error ? error.message : "Failed to login with password"
      });
      throw error;
    } finally {
      this.patchState({ isLoading: false });
    }
  }
  async loginWithPasskey(identityOrUsername) {
    if (!this.features.passkeyLogin) {
      throw new Error("Passkey login is disabled");
    }
    if (!this.deps.vault?.isConfigured() || !this.deps.passkeys) {
      throw new Error("Passkey login is not configured");
    }
    this.patchState({ isLoading: true, error: null });
    try {
      const normalizedIdentity = identityOrUsername?.trim();
      const currentRpId = this.deps.passkeys.getDefaultRpId();
      let accesses = [];
      let selectedCredentialHash;
      if (normalizedIdentity) {
        const identityId = await this.deps.vault.resolveIdentityId(normalizedIdentity);
        if (!identityId) {
          throw new Error("Username not found");
        }
        accesses = (await this.deps.vault.getPasskeyAccesses(identityId)).filter((entry) => entry.rpId === currentRpId);
      } else {
        const selected = await this.deps.passkeys.selectDiscoverablePasskey(currentRpId);
        if (!selected.userHandle) {
          throw new Error("This passkey did not provide an account identifier. Try signing in with your username once, then use passkey login again.");
        }
        accesses = (await this.deps.vault.getPasskeyAccesses(selected.userHandle)).filter((entry) => entry.rpId === currentRpId);
        selectedCredentialHash = selected.credentialIdHash;
      }
      if (accesses.length === 0) {
        if (normalizedIdentity) {
          throw new Error("No passkey login is configured for this site and account");
        }
        throw new Error("No passkey login is configured for this selected passkey on this site yet");
      }
      if (selectedCredentialHash) {
        accesses = accesses.filter((entry) => sameBytes(entry.credentialIdHash, selectedCredentialHash));
        if (accesses.length === 0) {
          throw new Error("This selected passkey is not registered for this site");
        }
      }
      const descriptors = accesses.flatMap((entry) => {
        if (!entry.credentialId || !entry.prfInput || !entry.rpId) return [];
        return [{
          credentialId: entry.credentialId,
          prfInput: entry.prfInput,
          rpId: entry.rpId
        }];
      });
      const assertion = await this.deps.passkeys.getPrfAssertionForCredentials(descriptors);
      const expectedCredentialHash = selectedCredentialHash ?? assertion.credentialIdHash;
      const access = accesses.find((entry) => sameBytes(entry.credentialIdHash, expectedCredentialHash));
      if (!access) {
        throw new Error("Selected passkey is not registered for this site");
      }
      const unlocked = await this.deps.vault.unlockWithPrf(access.$ownerId, access, assertion.prfOutput);
      return await this.restoreUnlockedVaultSession(unlocked);
    } catch (error) {
      this.logger.error("platform-auth: passkey login failed", error);
      this.patchState({
        error: error instanceof Error ? error.message : "Failed to login with passkey"
      });
      throw error;
    } finally {
      this.patchState({ isLoading: false });
    }
  }
  async loginWithLoginKey(identityId, loginKey, keyIndex) {
    if (!this.features.keyExchangeLogin) {
      throw new Error("Login-key login is disabled");
    }
    if (!this.deps.crypto) {
      throw new Error("Login-key login requires crypto adapters");
    }
    this.patchState({ isLoading: true, error: null });
    try {
      const identityIdBytes = this.deps.crypto.decodeIdentityId(identityId);
      const authKey = this.deps.crypto.deriveAuthKeyFromLogin(loginKey, identityIdBytes);
      const encryptionKey = this.deps.crypto.deriveEncryptionKeyFromLogin(loginKey, identityIdBytes);
      const authKeyWif = this.deps.crypto.privateKeyToWif(authKey, this.deps.network, true);
      const encryptionKeyWif = this.deps.crypto.privateKeyToWif(encryptionKey, this.deps.network, true);
      await this.deps.secretStore.storeLoginKey(identityId, loginKey);
      this.logger.info(`platform-auth: login-key login using keyIndex=${keyIndex}`);
      const result = await this.loginWithAuthKey(identityId, authKeyWif, {
        skipUsernameCheck: false
      });
      await this.deps.secretStore.storeEncryptionKey(identityId, encryptionKeyWif);
      await this.deps.secretStore.storeEncryptionKeyType(identityId, "derived");
      await this.createOrUpdateVaultFromLoginKey(identityId, loginKey).catch((error) => {
        this.logger.warn("platform-auth: failed to create or update vault from login key", error);
      });
      await this.mergeSecretsIntoVault(identityId, {
        loginKey,
        encryptionKeyWif,
        source: "wallet-derived"
      }).catch((error) => {
        this.logger.warn("platform-auth: failed to merge login-key secrets into vault", error);
      });
      return result;
    } catch (error) {
      await this.deps.secretStore.clearPrivateKey(identityId);
      await this.deps.secretStore.clearEncryptionKey(identityId);
      await this.deps.secretStore.clearEncryptionKeyType(identityId);
      await this.deps.secretStore.clearLoginKey(identityId);
      this.logger.error("platform-auth: login-key login failed", error);
      this.patchState({
        error: error instanceof Error ? error.message : "Failed to login with key exchange"
      });
      throw error;
    } finally {
      this.patchState({ isLoading: false });
    }
  }
  async createOrUpdateVaultFromLoginKey(identityId, loginKey) {
    return this.ensureVaultForCurrentSession(identityId, {
      loginKey,
      source: "wallet-derived"
    });
  }
  async createOrUpdateVaultFromAuthKey(identityId, authKeyWif) {
    return this.ensureVaultForCurrentSession(identityId, {
      authKeyWif,
      source: "direct-key"
    });
  }
  async mergeSecretsIntoVault(identityId, partialSecrets) {
    if (!this.features.authVault || !this.deps.vault?.isConfigured()) {
      return null;
    }
    const dek = await this.deps.secretStore.getAuthVaultDek(identityId);
    if (!dek) {
      return null;
    }
    const merged = await this.deps.vault.mergeSecrets(identityId, dek, partialSecrets);
    if (!merged) {
      return null;
    }
    await this.deps.secretStore.storeAuthVaultDek(identityId, merged.dek);
    if (partialSecrets.loginKey) {
      await this.deps.secretStore.storeLoginKey(identityId, partialSecrets.loginKey);
    }
    return merged;
  }
  async addPasswordAccess(password, iterations, label = "Password") {
    const user = this.requireUser("You must be logged in to add a password unlock method.");
    if (!this.deps.vault?.isConfigured()) {
      throw new Error("Auth vault is not configured");
    }
    const ensured = await this.ensureVaultForCurrentSession(user.identityId);
    await this.deps.vault.addPasswordAccess(user.identityId, {
      vaultId: ensured.vault.$id,
      dek: ensured.dek,
      password,
      iterations,
      label
    });
  }
  async addPasskeyAccess(label = "Current device") {
    const user = this.requireUser("You must be logged in to add a passkey.");
    if (!this.deps.vault?.isConfigured() || !this.deps.passkeys) {
      throw new Error("Passkeys are not configured");
    }
    const ensured = await this.ensureVaultForCurrentSession(user.identityId);
    const username = user.username ?? user.identityId;
    const passkey = await this.deps.passkeys.createPasskeyWithPrf({
      identityId: user.identityId,
      username,
      displayName: username,
      label
    });
    await this.deps.vault.addPasskeyAccess(user.identityId, {
      vaultId: ensured.vault.$id,
      dek: ensured.dek,
      passkey
    });
  }
  async logout() {
    const identityId = this.state.user?.identityId;
    await this.deps.sessionStore.clearSession();
    if (identityId) {
      await this.deps.secretStore.clearPrivateKey(identityId);
      await this.deps.secretStore.clearEncryptionKey(identityId);
      await this.deps.secretStore.clearEncryptionKeyType(identityId);
      await this.deps.secretStore.clearTransferKey(identityId);
      await this.deps.secretStore.clearLoginKey(identityId);
      await this.deps.secretStore.clearAuthVaultDek(identityId);
      await this.deps.sideEffects?.runLogoutCleanup?.(identityId);
    }
    await this.deps.clientIdentity?.setIdentity("");
    this.stopBalanceRefresh();
    this.patchState({
      user: null,
      error: null
    });
    await this.emit({ type: "logout", identityId });
    return {
      user: null,
      intent: { kind: "logged-out" }
    };
  }
  async refreshUsername() {
    const identityId = this.state.user?.identityId;
    if (!identityId || !this.deps.usernames) {
      return;
    }
    await this.deps.usernames.clearCache?.(void 0, identityId);
    const username = await this.deps.usernames.resolveUsername(identityId);
    if (!username || username === this.state.user?.username) {
      return;
    }
    await this.updateSessionUser((current) => ({
      ...current,
      username
    }));
  }
  async setUsername(username) {
    if (!this.state.user) {
      return;
    }
    await this.updateSessionUser((current) => ({
      ...current,
      username
    }));
  }
  async refreshBalance() {
    const identityId = this.state.user?.identityId;
    if (!identityId) {
      return;
    }
    await this.deps.identity.clearCache?.(identityId);
    const balance = await this.deps.identity.getBalance(identityId);
    await this.updateSessionUser((current) => ({
      ...current,
      balance
    }));
  }
  async backfillUsername(identityId) {
    try {
      const username = await this.deps.usernames?.resolveUsername(identityId);
      if (!username) return;
      if (!this.isSessionActive(identityId)) return;
      await this.updateSessionUser((current) => ({
        ...current,
        username
      }));
    } catch (error) {
      await this.emit({ type: "background-error", operation: "backfill-username", error });
    }
  }
  async ensureVaultForCurrentSession(identityId, overrides = {}) {
    if (!this.features.authVault || !this.deps.vault?.isConfigured()) {
      throw new Error("Auth vault is not configured");
    }
    let activeDek = await this.deps.secretStore.getAuthVaultDek(identityId);
    if (!activeDek) {
      const status = await this.deps.vault.getStatus(identityId);
      if (status.hasVault && status.passkeyCount > 0) {
        if (!this.deps.passkeys) {
          throw new Error("Passkeys are required to unlock this auth vault on this device.");
        }
        const currentRpId = this.deps.passkeys.getDefaultRpId();
        const passkeyAccesses = (await this.deps.vault.getPasskeyAccesses(identityId)).filter(
          (entry) => entry.rpId === currentRpId && entry.credentialId && entry.credentialIdHash && entry.prfInput
        );
        if (passkeyAccesses.length === 0) {
          throw new Error("This auth vault has passkeys, but none are registered for this site. Use an existing unlock method for this site before updating it.");
        }
        const descriptors = passkeyAccesses.map((entry) => ({
          credentialId: entry.credentialId,
          prfInput: entry.prfInput,
          rpId: entry.rpId
        }));
        const assertion = await this.deps.passkeys.getPrfAssertionForCredentials(descriptors);
        const matchingAccess = passkeyAccesses.find((entry) => sameBytes(entry.credentialIdHash, assertion.credentialIdHash));
        if (!matchingAccess) {
          throw new Error("The selected passkey is not registered for this account on this site.");
        }
        const unlocked = await this.deps.vault.unlockWithPrf(identityId, matchingAccess, assertion.prfOutput);
        await this.deps.secretStore.storeAuthVaultDek(identityId, unlocked.dek);
        activeDek = unlocked.dek;
      } else if (status.hasVault && status.hasPasswordAccess) {
        throw new Error("This auth vault already has a password unlock method. Sign in once with that auth-vault password or an existing passkey on this device before adding another unlock method.");
      }
    }
    if (activeDek) {
      const merged = await this.deps.vault.mergeSecrets(identityId, activeDek, {
        loginKey: overrides.loginKey,
        authKeyWif: overrides.authKeyWif,
        encryptionKeyWif: overrides.encryptionKeyWif,
        transferKeyWif: overrides.transferKeyWif,
        source: overrides.source
      });
      if (merged) {
        await this.deps.secretStore.storeAuthVaultDek(identityId, merged.dek);
        if (overrides.loginKey) {
          await this.deps.secretStore.storeLoginKey(identityId, overrides.loginKey);
        }
        return merged;
      }
    }
    const hasExistingVault = await this.deps.vault.hasVault(identityId);
    if (hasExistingVault && !activeDek) {
      throw new Error("This auth vault already exists but is not unlocked on this device. Unlock it once with its current password or passkey, then try again.");
    }
    const loginKey = overrides.loginKey ?? await this.deps.secretStore.getLoginKey(identityId) ?? void 0;
    const authKeyWif = overrides.authKeyWif ?? await this.deps.secretStore.getPrivateKey(identityId) ?? void 0;
    const encryptionKeyWif = overrides.encryptionKeyWif ?? await this.deps.secretStore.getEncryptionKey(identityId) ?? void 0;
    const transferKeyWif = overrides.transferKeyWif ?? await this.deps.secretStore.getTransferKey(identityId) ?? void 0;
    if (!loginKey && !authKeyWif) {
      throw new Error("No active login secret is available for auth vault enrollment.");
    }
    const bundle = {
      version: 1,
      identityId,
      network: this.deps.network,
      secretKind: loginKey ? "login-key" : "auth-key",
      loginKey,
      authKeyWif,
      encryptionKeyWif,
      transferKeyWif,
      source: overrides.source ?? (loginKey ? "wallet-derived" : "direct-key"),
      updatedAt: this.now()
    };
    const created = await this.deps.vault.createOrUpdateVaultBundle(identityId, bundle, activeDek ?? void 0);
    await this.deps.secretStore.storeAuthVaultDek(identityId, created.dek);
    if (loginKey) {
      await this.deps.secretStore.storeLoginKey(identityId, loginKey);
    }
    return created;
  }
  async restoreUnlockedVaultSession(unlocked) {
    await this.deps.secretStore.storeAuthVaultDek(unlocked.identityId, unlocked.dek);
    let authKeyWif = unlocked.bundle.authKeyWif;
    let encryptionKeyWif = unlocked.bundle.encryptionKeyWif;
    let encryptionKeyType = "external";
    if (unlocked.bundle.secretKind === "login-key") {
      if (!this.deps.crypto || !unlocked.bundle.loginKey) {
        throw new Error("Auth vault is missing the wallet login secret.");
      }
      const identityIdBytes = this.deps.crypto.decodeIdentityId(unlocked.identityId);
      const authKey = this.deps.crypto.deriveAuthKeyFromLogin(unlocked.bundle.loginKey, identityIdBytes);
      const derivedEncryptionKey = this.deps.crypto.deriveEncryptionKeyFromLogin(unlocked.bundle.loginKey, identityIdBytes);
      authKeyWif = this.deps.crypto.privateKeyToWif(authKey, this.deps.network, true);
      const derivedEncryptionKeyWif = this.deps.crypto.privateKeyToWif(derivedEncryptionKey, this.deps.network, true);
      encryptionKeyWif = unlocked.bundle.encryptionKeyWif ?? derivedEncryptionKeyWif;
      encryptionKeyType = !unlocked.bundle.encryptionKeyWif || unlocked.bundle.encryptionKeyWif === derivedEncryptionKeyWif ? "derived" : "external";
      await this.deps.secretStore.storeLoginKey(unlocked.identityId, unlocked.bundle.loginKey);
    } else if (authKeyWif && encryptionKeyWif && this.deps.crypto) {
      try {
        const parsed = this.deps.crypto.parsePrivateKey(authKeyWif);
        const derived = this.deps.crypto.deriveEncryptionKey(parsed.privateKey, unlocked.identityId);
        const derivedWif = this.deps.crypto.privateKeyToWif(derived, this.deps.network, true);
        encryptionKeyType = derivedWif === encryptionKeyWif ? "derived" : "external";
      } catch {
        encryptionKeyType = "external";
      }
    }
    if (!authKeyWif) {
      throw new Error("Auth vault is missing the authentication key.");
    }
    const result = await this.loginWithAuthKey(unlocked.identityId, authKeyWif, {
      skipUsernameCheck: true
    });
    if (encryptionKeyWif) {
      await this.deps.secretStore.storeEncryptionKey(unlocked.identityId, encryptionKeyWif);
      await this.deps.secretStore.storeEncryptionKeyType(unlocked.identityId, encryptionKeyType);
    }
    if (unlocked.bundle.transferKeyWif) {
      await this.deps.secretStore.storeTransferKey(unlocked.identityId, unlocked.bundle.transferKeyWif);
    }
    return result;
  }
  tryAutoDeriveEncryptionKey(identityId, privateKey, publicKeys) {
    if (!this.features.autoDeriveEncryptionKey || !this.deps.crypto) {
      return;
    }
    const crypto2 = this.deps.crypto;
    void (async () => {
      try {
        const hasEncryptionKeyOnIdentity = crypto2.identityHasEncryptionKey(publicKeys);
        const hasStoredEncryptionKey = await this.deps.secretStore.hasEncryptionKey(identityId);
        if (!hasEncryptionKeyOnIdentity || hasStoredEncryptionKey) {
          return;
        }
        const parsed = crypto2.parsePrivateKey(privateKey);
        const derivedKey = crypto2.deriveEncryptionKey(parsed.privateKey, identityId);
        const matches = await crypto2.validateDerivedKeyMatchesIdentity(derivedKey, identityId);
        if (!matches || !this.isSessionActive(identityId)) {
          return;
        }
        const derivedKeyWif = crypto2.privateKeyToWif(derivedKey, this.deps.network, true);
        await this.deps.secretStore.storeEncryptionKey(identityId, derivedKeyWif);
        await this.deps.secretStore.storeEncryptionKeyType(identityId, "derived");
        const dek = await this.deps.secretStore.getAuthVaultDek(identityId);
        if (dek && this.deps.vault?.isConfigured()) {
          await this.deps.vault.mergeSecrets(identityId, dek, {
            encryptionKeyWif: derivedKeyWif
          });
        }
      } catch (error) {
        await this.emit({ type: "background-error", operation: "derive-encryption-key", error });
      }
    })();
  }
  runPostLoginTasks(identityId, delayMs) {
    if (!this.features.postLoginTasks || !this.deps.sideEffects) {
      return;
    }
    void Promise.resolve(
      this.deps.sideEffects.runPostLogin(identityId, {
        delayMs,
        isSessionActive: () => this.isSessionActive(identityId)
      })
    ).catch(async (error) => {
      await this.emit({ type: "background-error", operation: "post-login-tasks", error });
    });
  }
  startBalanceRefresh() {
    if (!this.features.balanceRefresh || !this.state.user) {
      return;
    }
    this.stopBalanceRefresh();
    this.balanceInterval = setInterval(() => {
      void this.refreshBalance().catch((error) => {
        this.logger.error("platform-auth: balance refresh failed", error);
      });
    }, this.balanceRefreshMs);
  }
  stopBalanceRefresh() {
    if (!this.balanceInterval) {
      return;
    }
    clearInterval(this.balanceInterval);
    this.balanceInterval = null;
  }
  requireYapprKeyExchange(overrides = {}) {
    if (!this.features.keyExchangeLogin) {
      throw new Error("Yappr key exchange login is disabled");
    }
    if (!this.deps.yapprKeyExchange) {
      throw new Error("Yappr key exchange is not configured");
    }
    return {
      port: this.deps.yapprKeyExchange,
      config: this.getYapprKeyExchangeConfig(overrides)
    };
  }
  requireUser(message) {
    if (!this.state.user) {
      throw new Error(message);
    }
    return this.state.user;
  }
  isSessionActive(identityId) {
    return this.state.user?.identityId === identityId;
  }
  async persistSessionUser(user) {
    const snapshot = {
      user,
      timestamp: this.now()
    };
    await this.deps.sessionStore.setSession(snapshot);
    this.patchState({ user });
  }
  async updateSessionUser(updater) {
    const current = this.state.user;
    if (!current) return;
    const updated = updater(current);
    await this.deps.sessionStore.setSession({
      user: updated,
      timestamp: this.now()
    });
    this.patchState({ user: updated });
  }
  patchState(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
  now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }
  async emit(event) {
    await this.deps.onEvent?.(event);
  }
};

// src/key-exchange/yappr-hooks.tsx
var import_react = require("react");
var DEFAULT_REGISTRATION_TIMEOUT_MS = 3e5;
function useYapprKeyExchangeLogin(controller, options = {}) {
  const [state, setState] = (0, import_react.useState)("idle");
  const [uri, setUri] = (0, import_react.useState)(null);
  const [remainingTime, setRemainingTime] = (0, import_react.useState)(null);
  const [keyIndex, setKeyIndex] = (0, import_react.useState)(0);
  const [needsKeyRegistration, setNeedsKeyRegistration] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const [result, setResult] = (0, import_react.useState)(null);
  const abortControllerRef = (0, import_react.useRef)(null);
  const ephemeralKeyRef = (0, import_react.useRef)(null);
  const startTimeRef = (0, import_react.useRef)(null);
  const timerIntervalRef = (0, import_react.useRef)(null);
  const lastOptionsRef = (0, import_react.useRef)({});
  const cleanup = (0, import_react.useCallback)(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (ephemeralKeyRef.current) {
      clearSensitiveBytes(ephemeralKeyRef.current);
      ephemeralKeyRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    startTimeRef.current = null;
  }, []);
  (0, import_react.useEffect)(() => cleanup, [cleanup]);
  const clearResult = (0, import_react.useCallback)((value) => {
    if (!value) return;
    clearSensitiveBytes(value.loginKey);
    clearSensitiveBytes(value.authKey);
    clearSensitiveBytes(value.encryptionKey);
  }, []);
  const start = (0, import_react.useCallback)(async (startOptions = {}) => {
    lastOptionsRef.current = startOptions;
    cleanup();
    abortControllerRef.current = new AbortController();
    try {
      const resolvedConfig = controller.getYapprKeyExchangeConfig({
        ...options.config,
        label: startOptions.label ?? options.config?.label
      });
      setState("generating");
      setError(null);
      setResult((previous) => {
        clearResult(previous);
        return null;
      });
      setNeedsKeyRegistration(false);
      const contractIdBytes = decodeYapprContractId(resolvedConfig.appContractId);
      const ephemeral = generateYapprEphemeralKeyPair();
      ephemeralKeyRef.current = ephemeral.privateKey;
      const ephemeralPubKeyHash = hash160(ephemeral.publicKey);
      setUri(buildYapprKeyExchangeUri({
        appEphemeralPubKey: ephemeral.publicKey,
        contractId: contractIdBytes,
        label: resolvedConfig.label
      }, resolvedConfig.network));
      setState("waiting");
      startTimeRef.current = Date.now();
      timerIntervalRef.current = setInterval(() => {
        if (!startTimeRef.current) {
          return;
        }
        const elapsed = Date.now() - startTimeRef.current;
        const remaining = Math.max(0, Math.ceil((resolvedConfig.timeoutMs - elapsed) / 1e3));
        setRemainingTime(remaining);
        if (remaining === 0 && timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
      }, 1e3);
      const decrypted = await controller.pollYapprKeyExchangeResponse(
        ephemeralPubKeyHash,
        ephemeral.privateKey,
        options.config,
        { signal: abortControllerRef.current.signal }
      );
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      clearSensitiveBytes(ephemeral.privateKey);
      ephemeralKeyRef.current = null;
      setState("decrypting");
      const identityId = decrypted.identityId;
      setKeyIndex(decrypted.keyIndex);
      const identityIdBytes = decodeYapprIdentityId(identityId);
      const authKey = deriveYapprAuthKeyFromLogin(decrypted.loginKey, identityIdBytes);
      const encryptionKey = deriveYapprEncryptionKeyFromLogin(decrypted.loginKey, identityIdBytes);
      setState("checking");
      const authPublicKey = getYapprPublicKey(authKey);
      const encPublicKey = getYapprPublicKey(encryptionKey);
      const keysExist = await controller.checkYapprKeysRegistered(
        identityId,
        authPublicKey,
        encPublicKey,
        options.config
      );
      const loginResult = {
        loginKey: decrypted.loginKey,
        authKey,
        encryptionKey,
        keyIndex: decrypted.keyIndex,
        needsKeyRegistration: !keysExist,
        identityId
      };
      setResult(loginResult);
      if (loginResult.needsKeyRegistration) {
        setNeedsKeyRegistration(true);
        setState("registering");
        return;
      }
      setState("complete");
    } catch (err) {
      if (ephemeralKeyRef.current) {
        clearSensitiveBytes(ephemeralKeyRef.current);
        ephemeralKeyRef.current = null;
      }
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      if (err instanceof Error) {
        if (err.message === "Cancelled") {
          setState("idle");
          return;
        }
        if (err.message.includes("Timeout")) {
          setState("timeout");
          setError("Timed out waiting for wallet response");
          return;
        }
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }
      setState("error");
    }
  }, [cleanup, clearResult, controller, options.config]);
  const cancel = (0, import_react.useCallback)(() => {
    cleanup();
    setResult((previous) => {
      clearResult(previous);
      return null;
    });
    setState("idle");
    setUri(null);
    setRemainingTime(null);
    setError(null);
    setNeedsKeyRegistration(false);
  }, [cleanup, clearResult]);
  const retry = (0, import_react.useCallback)(() => {
    start(lastOptionsRef.current);
  }, [start]);
  return {
    state,
    uri,
    remainingTime,
    keyIndex,
    needsKeyRegistration,
    error,
    result,
    start,
    cancel,
    retry
  };
}
function useYapprKeyRegistration(controller, onComplete, options = {}) {
  const [state, setState] = (0, import_react.useState)("idle");
  const [uri, setUri] = (0, import_react.useState)(null);
  const [remainingTime, setRemainingTime] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(null);
  const [result, setResult] = (0, import_react.useState)(null);
  const abortControllerRef = (0, import_react.useRef)(null);
  const identityIdRef = (0, import_react.useRef)(null);
  const authKeyRef = (0, import_react.useRef)(null);
  const encryptionKeyRef = (0, import_react.useRef)(null);
  const startTimeRef = (0, import_react.useRef)(null);
  const timerIntervalRef = (0, import_react.useRef)(null);
  const pollIntervalRef = (0, import_react.useRef)(null);
  const cancelledRef = (0, import_react.useRef)(false);
  const cleanupTimers = (0, import_react.useCallback)(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    startTimeRef.current = null;
  }, []);
  const cleanup = (0, import_react.useCallback)(() => {
    cleanupTimers();
    if (authKeyRef.current) {
      clearSensitiveBytes(authKeyRef.current);
      authKeyRef.current = null;
    }
    if (encryptionKeyRef.current) {
      clearSensitiveBytes(encryptionKeyRef.current);
      encryptionKeyRef.current = null;
    }
    identityIdRef.current = null;
  }, [cleanupTimers]);
  (0, import_react.useEffect)(() => cleanup, [cleanup]);
  const start = (0, import_react.useCallback)(async (identityId, authKey, encryptionKey) => {
    cleanup();
    identityIdRef.current = identityId;
    authKeyRef.current = new Uint8Array(authKey);
    encryptionKeyRef.current = new Uint8Array(encryptionKey);
    abortControllerRef.current = new AbortController();
    cancelledRef.current = false;
    try {
      const resolvedConfig = controller.getYapprKeyExchangeConfig(options.config);
      setState("building");
      setError(null);
      setResult(null);
      const authPublicKey = getYapprPublicKey(authKey);
      const encryptionPublicKey = getYapprPublicKey(encryptionKey);
      const transition = await controller.buildYapprUnsignedKeyRegistrationTransition({
        identityId,
        authPrivateKey: authKey,
        authPublicKey,
        encryptionPrivateKey: encryptionKey,
        encryptionPublicKey
      }, options.config);
      if (abortControllerRef.current?.signal.aborted) {
        return;
      }
      setUri(buildYapprStateTransitionUri(transition.transitionBytes, resolvedConfig.network));
      setState("waiting");
      startTimeRef.current = Date.now();
      timerIntervalRef.current = setInterval(() => {
        if (!startTimeRef.current) {
          return;
        }
        const elapsed = Date.now() - startTimeRef.current;
        const remaining = Math.max(0, Math.ceil((DEFAULT_REGISTRATION_TIMEOUT_MS - elapsed) / 1e3));
        setRemainingTime(remaining);
        if (remaining === 0) {
          cleanupTimers();
          setError("Request timed out. Please try again.");
          setState("error");
        }
      }, 1e3);
      const checkKeys = async (pendingTransition) => {
        if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
          return;
        }
        try {
          const keysFound = await controller.checkYapprKeysRegistered(
            identityId,
            authPublicKey,
            encryptionPublicKey,
            options.config
          );
          if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
            return;
          }
          if (!keysFound) {
            return;
          }
          cleanup();
          setState("verifying");
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (cancelledRef.current) {
            return;
          }
          setResult({
            authKeyId: pendingTransition.authKeyId,
            encryptionKeyId: pendingTransition.encryptionKeyId
          });
          setState("complete");
          onComplete?.();
        } catch {
        }
      };
      await checkKeys(transition);
      if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
        pollIntervalRef.current = setInterval(() => {
          void checkKeys(transition);
        }, 5e3);
      }
    } catch (err) {
      cleanupTimers();
      if (err instanceof Error) {
        if (err.message === "Cancelled") {
          setState("idle");
          return;
        }
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }
      setState("error");
    }
  }, [cleanup, cleanupTimers, controller, onComplete, options.config]);
  const cancel = (0, import_react.useCallback)(() => {
    cancelledRef.current = true;
    cleanup();
    setState("idle");
    setUri(null);
    setRemainingTime(null);
    setError(null);
    setResult(null);
  }, [cleanup]);
  const retry = (0, import_react.useCallback)(() => {
    const identityId = identityIdRef.current;
    const authKey = authKeyRef.current;
    const encryptionKey = encryptionKeyRef.current;
    if (identityId && authKey && encryptionKey) {
      start(identityId, new Uint8Array(authKey), new Uint8Array(encryptionKey));
    }
  }, [start]);
  return {
    state,
    uri,
    remainingTime,
    error,
    result,
    start,
    cancel,
    retry
  };
}

// src/react/context.tsx
var import_react2 = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var PlatformAuthContext = (0, import_react2.createContext)(void 0);
function PlatformAuthProvider({
  controller,
  children
}) {
  const [state, setState] = (0, import_react2.useState)(controller.getState());
  (0, import_react2.useEffect)(() => controller.subscribe(setState), [controller]);
  const value = (0, import_react2.useMemo)(() => ({
    ...state,
    controller,
    restoreSession: controller.restoreSession.bind(controller),
    loginWithAuthKey: controller.loginWithAuthKey.bind(controller),
    loginWithPassword: controller.loginWithPassword.bind(controller),
    loginWithPasskey: controller.loginWithPasskey.bind(controller),
    loginWithLoginKey: controller.loginWithLoginKey.bind(controller),
    createOrUpdateVaultFromLoginKey: controller.createOrUpdateVaultFromLoginKey.bind(controller),
    createOrUpdateVaultFromAuthKey: controller.createOrUpdateVaultFromAuthKey.bind(controller),
    addPasswordAccess: controller.addPasswordAccess.bind(controller),
    addPasskeyAccess: controller.addPasskeyAccess.bind(controller),
    logout: controller.logout.bind(controller),
    setUsername: controller.setUsername.bind(controller),
    refreshUsername: controller.refreshUsername.bind(controller),
    refreshBalance: controller.refreshBalance.bind(controller)
  }), [controller, state]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlatformAuthContext.Provider, { value, children });
}
function usePlatformAuth() {
  const value = (0, import_react2.useContext)(PlatformAuthContext);
  if (!value) {
    throw new Error("usePlatformAuth must be used within a PlatformAuthProvider");
  }
  return value;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG,
  PlatformAuthController,
  PlatformAuthProvider,
  YAPPR_KEY_EXCHANGE_VERSION,
  YAPPR_NETWORK_IDS,
  YAPPR_STATE_TRANSITION_VERSION,
  buildYapprKeyExchangeUri,
  buildYapprStateTransitionUri,
  clearSensitiveBytes,
  createBrowserSecretStore,
  createPasskeyWithPrf,
  decodeYapprContractId,
  decodeYapprIdentityId,
  decryptYapprKeyExchangeResponse,
  decryptYapprLoginKey,
  deriveYapprAuthKeyFromLogin,
  deriveYapprEncryptionKeyFromLogin,
  deriveYapprSharedSecret,
  generatePrfInput,
  generateYapprEphemeralKeyPair,
  getDefaultRpId,
  getPasskeyAllowCredentialIds,
  getPasskeyPrfSupport,
  getPrfAssertionForCredentials,
  getYapprPublicKey,
  hash160,
  parseYapprKeyExchangeUri,
  parseYapprStateTransitionUri,
  pollForYapprKeyExchangeResponse,
  selectDiscoverablePasskey,
  serializeYapprKeyExchangeRequest,
  usePlatformAuth,
  useYapprKeyExchangeLogin,
  useYapprKeyRegistration
});
//# sourceMappingURL=index.cjs.map