'use strict';
/**
 * appstate.dat v1/v2 keystore：解析 + AES-KW 解包 DEK
 *
 * PRK = HMAC-SHA256(salt, R)
 * KEK = HKDF-Expand-SHA256(PRK, info_prefix || relpath, 32)
 * DEK = AES-KW-Unwrap(KEK, wrapped40)
 */
const crypto = require('crypto');
const fs = require('fs');
const { decodeRoot } = require('./cbor.cjs');

const DEFAULT_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

function asBytes(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) {
    return Buffer.from(v);
  }
  throw new TypeError(`无法转为字节: ${typeof v}`);
}

function aesEcbDecryptBlock(kek, block16) {
  const d = crypto.createDecipheriv('aes-256-ecb', kek, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(block16), d.final()]);
}

function aesEcbEncryptBlock(kek, block16) {
  const c = crypto.createCipheriv('aes-256-ecb', kek, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block16), c.final()]);
}

/** RFC 3394 AES Key Unwrap */
function aesKwUnwrap(kek, wrapped) {
  if (!Buffer.isBuffer(wrapped) || wrapped.length < 24 || wrapped.length % 8 !== 0) {
    throw new Error('wrapped 长度非法');
  }
  const n = wrapped.length / 8 - 1;
  let a = Buffer.from(wrapped.subarray(0, 8));
  const r = [];
  for (let i = 0; i < n; i++) r.push(Buffer.from(wrapped.subarray(8 + 8 * i, 16 + 8 * i)));
  for (let j = 5; j >= 0; j--) {
    for (let i = n; i >= 1; i--) {
      const t = n * j + i;
      const tBuf = Buffer.alloc(8);
      tBuf.writeBigUInt64BE(BigInt(t));
      const block = Buffer.concat([
        Buffer.from(a.map((b, idx) => b ^ tBuf[idx])),
        r[i - 1],
      ]);
      const pt = aesEcbDecryptBlock(kek, block);
      a = pt.subarray(0, 8);
      r[i - 1] = pt.subarray(8);
    }
  }
  if (!a.equals(DEFAULT_IV)) throw new Error('AES-KW ICV 校验失败');
  return Buffer.concat(r);
}

/** RFC 3394 AES Key Wrap（自测） */
function aesKwWrap(kek, plain) {
  if (!Buffer.isBuffer(plain) || plain.length < 16 || plain.length % 8 !== 0) {
    throw new Error('明文长度非法');
  }
  const n = plain.length / 8;
  let a = Buffer.from(DEFAULT_IV);
  const r = [];
  for (let i = 0; i < n; i++) r.push(Buffer.from(plain.subarray(8 * i, 8 * i + 8)));
  for (let j = 0; j < 6; j++) {
    for (let i = 1; i <= n; i++) {
      const block = Buffer.concat([a, r[i - 1]]);
      const ct = aesEcbEncryptBlock(kek, block);
      const t = n * j + i;
      const tBuf = Buffer.alloc(8);
      tBuf.writeBigUInt64BE(BigInt(t));
      a = Buffer.from(ct.subarray(0, 8).map((b, idx) => b ^ tBuf[idx]));
      r[i - 1] = ct.subarray(8);
    }
  }
  return Buffer.concat([a, ...r]);
}

function hkdfExpandSha256(prk, info, length = 32) {
  const hashLen = 32;
  const n = Math.ceil(length / hashLen);
  if (n > 255) throw new Error('HKDF 输出过长');
  let okm = Buffer.alloc(0);
  let t = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    okm = Buffer.concat([okm, t]);
  }
  return okm.subarray(0, length);
}

function deriveKek(rootKey, salt, infoPrefix, relpath) {
  if (rootKey.length !== 32) throw new Error('R 必须是 32 字节');
  if (salt.length !== 32) throw new Error('salt 必须是 32 字节');
  const prk = crypto.createHmac('sha256', salt).update(rootKey).digest();
  const info = Buffer.concat([infoPrefix, relpath]);
  return hkdfExpandSha256(prk, info, 32);
}

function tryUnwrapOne(rootKey, salt, infoPrefix, relpath, wrapped) {
  try {
    const kek = deriveKek(rootKey, salt, infoPrefix, relpath);
    return aesKwUnwrap(kek, wrapped);
  } catch {
    return null;
  }
}

function parseAppstate(filePath) {
  const raw = fs.readFileSync(filePath);
  const top = decodeRoot(raw);
  if (!top || typeof top !== 'object') throw new Error('appstate 顶层不是 CBOR map');
  if (!('info_prefix' in top) || !('salt' in top)) {
    throw new Error('缺少 info_prefix 或 salt');
  }
  const infoPrefix = asBytes(top.info_prefix);
  const salt = asBytes(top.salt);
  if (salt.length !== 32) throw new Error(`salt 长度应为 32，实际 ${salt.length}`);

  // Kakao 常见编码：字节用「0–255 整数数组」；wrapped_dek_map 是 [[pathBytes],[wrap40], ...] 成对数组
  // 也兼容真正的 CBOR map：{ "chat_data\\...": <40B> }
  let rawMap = null;
  for (const key of ['wrapped_dek_map', 'keys', 'key_map', 'dek_map']) {
    if (top[key] != null) {
      rawMap = top[key];
      break;
    }
  }
  if (rawMap == null) {
    for (const [k, v] of Object.entries(top)) {
      if (k === 'info_prefix' || k === 'salt') continue;
      if (v != null) { rawMap = v; break; }
    }
  }
  if (rawMap == null) throw new Error('未找到 wrapped DEK 映射表');

  const entries = [];
  const pushEntry = (relRaw, wrapRaw) => {
    let wrapped;
    let relpath;
    try {
      wrapped = asBytes(wrapRaw);
      relpath = asBytes(relRaw);
    } catch {
      return;
    }
    if (wrapped.length !== 40) return;
    entries.push({
      relpath,
      relpathText: relpath.toString('utf8'),
      wrapped,
    });
  };

  if (Array.isArray(rawMap)) {
    for (const item of rawMap) {
      if (Array.isArray(item) && item.length >= 2) {
        pushEntry(item[0], item[1]);
      } else if (item && typeof item === 'object') {
        // [{path, wrapped}] / [{k,v}] 等宽松形态
        const rel = item.path || item.key || item.relpath || item[0];
        const wrap = item.wrapped || item.value || item.dek || item[1];
        if (rel != null && wrap != null) pushEntry(rel, wrap);
      }
    }
  } else if (rawMap && typeof rawMap === 'object') {
    for (const [rel, wrap] of Object.entries(rawMap)) {
      pushEntry(rel, wrap);
    }
  }
  if (!entries.length) throw new Error('wrapped DEK 条目为空（请确认 appstate 为 v1/v2 keystore）');

  const chatlogEntries = entries.filter((e) => /chatLogs[_-]/i.test(e.relpathText));
  return {
    path: filePath,
    infoPrefix,
    infoPrefixText: infoPrefix.toString('utf8'),
    salt,
    saltHex: salt.toString('hex'),
    entries,
    chatlogEntries,
    entryCount: entries.length,
    chatlogCount: chatlogEntries.length,
  };
}

function unwrapAll(st, rootKey) {
  if (!Buffer.isBuffer(rootKey) || rootKey.length !== 32) {
    throw new Error('R 必须是 32 字节 Buffer');
  }
  const keys = {};
  let ok = 0;
  let fail = 0;
  for (const e of st.entries) {
    const dek = tryUnwrapOne(rootKey, st.salt, st.infoPrefix, e.relpath, e.wrapped);
    if (dek) {
      keys[e.relpathText] = dek.toString('hex');
      ok++;
    } else {
      fail++;
    }
  }
  return { keys, ok, fail, rootHex: rootKey.toString('hex') };
}

function parseRootHex(text) {
  const s = String(text || '').trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error('R 必须是 64 位十六进制（32 字节）');
  }
  return Buffer.from(s, 'hex');
}

/** 从 kk-root-key.json / unwrap 导出 / win-key-cache 解析出密钥映射或 R */
function parseKeysPayload(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('密钥 JSON 无效');
  const result = { rootHex: null, keys: {}, source: 'unknown' };

  if (typeof obj.root_hex === 'string' && /^[0-9a-fA-F]{64}$/.test(obj.root_hex.trim())) {
    result.rootHex = obj.root_hex.trim().toLowerCase();
    result.source = 'root_hex';
  }
  if (typeof obj.rootHex === 'string' && /^[0-9a-fA-F]{64}$/.test(obj.rootHex.trim())) {
    result.rootHex = obj.rootHex.trim().toLowerCase();
    result.source = 'rootHex';
  }

  const skip = new Set([
    'version', 'appstate', 'info_prefix', 'salt_hex', 'root_hex', 'rootHex',
    'ok', 'fail', 'hits', 'dump_offset', 'phase', 'candidates_tried', 'elapsed_sec',
    'sample_keys',
  ]);

  const absorbMap = (map, tag) => {
    if (!map || typeof map !== 'object') return 0;
    let n = 0;
    for (const [k, v] of Object.entries(map)) {
      if (skip.has(k)) continue;
      const hex = typeof v === 'string' ? v : (v && v.keyHex) || (v && v.key) || null;
      if (typeof hex !== 'string') continue;
      const h = hex.trim().replace(/^0x/i, '');
      if (!/^[0-9a-fA-F]{64}$/.test(h)) continue;
      result.keys[k] = h.toLowerCase();
      n++;
    }
    if (n) result.source = tag;
    return n;
  };

  absorbMap(obj.keys, 'keys');
  absorbMap(obj.sample_keys, 'sample_keys');
  absorbMap(obj.dekMap, 'dekMap');
  if (Array.isArray(obj.hits)) {
    for (const h of obj.hits) {
      if (h && h.keyHex && /^[0-9a-fA-F]{64}$/.test(h.keyHex)) {
        const name = h.probe || h.name || h.path || `hit_${Object.keys(result.keys).length}`;
        result.keys[name] = h.keyHex.toLowerCase();
      }
    }
    if (Object.keys(result.keys).length) result.source = 'hits';
  }
  // win-key-cache：顶层直接 path→hex，或 { cache: [...] }
  if (!Object.keys(result.keys).length) {
    absorbMap(obj, 'flat');
  }
  if (Array.isArray(obj.cache)) {
    for (const h of obj.cache) {
      if (h && h.keyHex && /^[0-9a-fA-F]{64}$/.test(h.keyHex)) {
        result.keys[h.probe || h.name || `cache_${Object.keys(result.keys).length}`] = h.keyHex.toLowerCase();
      }
    }
    if (Object.keys(result.keys).length) result.source = 'cache';
  }

  if (!result.rootHex && !Object.keys(result.keys).length) {
    throw new Error('JSON 中未找到 root_hex 或任何 32 字节密钥');
  }
  return result;
}

function selftest() {
  const root = crypto.randomBytes(32);
  const salt = crypto.randomBytes(32);
  const prefix = Buffer.from('v2:');
  const path = Buffer.from('chat_data\\chatLogs_123.edb');
  const dek = crypto.randomBytes(32);
  const kek = deriveKek(root, salt, prefix, path);
  const wrapped = aesKwWrap(kek, dek);
  if (wrapped.length !== 40) throw new Error('wrap 长度应为 40');
  const out = aesKwUnwrap(kek, wrapped);
  if (!out.equals(dek)) throw new Error('KW 往返失败');
  const out2 = tryUnwrapOne(root, salt, prefix, path, wrapped);
  if (!out2 || !out2.equals(dek)) throw new Error('tryUnwrapOne 失败');
  const bad = tryUnwrapOne(root, salt, prefix, Buffer.from('chat_data/chatLogs_123.edb'), wrapped);
  if (bad) throw new Error('路径敏感性失败：斜杠不应解出');
  return { ok: true, message: 'appstate 自检通过（KW 往返 + 路径敏感）' };
}

module.exports = {
  parseAppstate,
  unwrapAll,
  tryUnwrapOne,
  deriveKek,
  aesKwUnwrap,
  aesKwWrap,
  parseRootHex,
  parseKeysPayload,
  selftest,
};
