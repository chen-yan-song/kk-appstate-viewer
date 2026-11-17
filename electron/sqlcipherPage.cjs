'use strict';
/**
 * SQLCipher 4 页级解密（自 kakao-chat-viewer/winKakao 精简移植）
 * 输入：32 字节 raw DEK + 加密 EDB → 明文 SQLite 字节
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SQLITE_HEAD = 'SQLite format 3\x00';
const SQLITE_HEAD_BUF = Buffer.from(SQLITE_HEAD, 'latin1');
const PGNO1_LE = Buffer.from([1, 0, 0, 0]);

function yieldLoop() {
  return new Promise((r) => setImmediate(r));
}

function trySqlCipherParams(edbBuf, keyBytes) {
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 32) return null;
  if (!Buffer.isBuffer(edbBuf) || edbBuf.length < 1024) return null;
  for (const pageSize of [4096, 1024]) {
    if (edbBuf.length < pageSize) continue;
    for (const hmacSize of [64, 32, 0]) {
      const ivOff = pageSize - hmacSize - 16;
      if (ivOff <= 16) continue;
      let d;
      try {
        d = crypto.createDecipheriv('aes-256-cbc', keyBytes, edbBuf.subarray(ivOff, ivOff + 16));
      } catch {
        return null;
      }
      d.setAutoPadding(false);
      const dec = d.update(edbBuf.subarray(16, 16 + 32));
      if (
        dec[0] === (pageSize >> 8) && dec[1] === (pageSize & 0xff) &&
        dec[4] === 16 + hmacSize &&
        dec[5] === 0x40 && dec[6] === 0x20 && dec[7] === 0x20
      ) return { pageSize, hmacSize };
    }
  }
  return null;
}

function verifySqlCipherHmac(edbBuf, keyBytes, pageSize = 4096, hmacSize = 64) {
  if (hmacSize !== 64 && hmacSize !== 32) return false;
  if (!Buffer.isBuffer(edbBuf) || edbBuf.length < pageSize) return false;
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 32) return false;
  const saltXor = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) saltXor[i] = edbBuf[i] ^ 0x3a;
  const hmacKey = crypto.pbkdf2Sync(keyBytes, saltXor, 2, 32, 'sha512');
  const h = crypto.createHmac(hmacSize === 64 ? 'sha512' : 'sha256', hmacKey);
  h.update(edbBuf.subarray(16, pageSize - hmacSize));
  h.update(PGNO1_LE);
  return h.digest().equals(edbBuf.subarray(pageSize - hmacSize, pageSize));
}

async function decryptSqlCipherEdb(buf, keyBytes, pageSize, hmacSize) {
  const dataLen = pageSize - 16 - hmacSize;
  const pages = Math.floor(buf.length / pageSize);
  const out = Buffer.alloc(pages * pageSize);
  SQLITE_HEAD_BUF.copy(out, 0);
  for (let p = 0; p < pages; p++) {
    const base = p * pageSize;
    let nonZero = -1;
    for (let i = base; i < base + pageSize; i++) {
      if (buf[i] !== 0) { nonZero = i; break; }
    }
    if (nonZero === -1) continue;
    const start = p === 0 ? 16 : base;
    const len = p === 0 ? dataLen - 16 : dataLen;
    const ivOff = base + pageSize - hmacSize - 16;
    const d = crypto.createDecipheriv('aes-256-cbc', keyBytes, buf.subarray(ivOff, ivOff + 16));
    d.setAutoPadding(false);
    const dec = Buffer.concat([d.update(buf.subarray(start, start + len)), d.final()]);
    dec.copy(out, base + (p === 0 ? 16 : 0));
    if (p === 0) out[20] = 0;
    if ((p & 511) === 511) await yieldLoop();
  }
  return out;
}

function readFileBuf(filePath) {
  return fs.readFileSync(filePath);
}

/** 简易 WAL 重放：若存在 -wal 且主库可读则合并（失败则退回主库） */
function readEdbWithWal(edbPath) {
  const main = readFileBuf(edbPath);
  const walPath = edbPath + '-wal';
  if (!fs.existsSync(walPath)) return { buf: main, walApplied: 0 };
  try {
    const wal = fs.readFileSync(walPath);
    // 最小可用：若 WAL 太小则忽略；完整帧重放较复杂，这里仅提示存在
    if (wal.length < 32) return { buf: main, walApplied: 0 };
    // 不做完整 WAL 重放（避免引入复杂依赖）；主库通常已足够浏览
    return { buf: main, walApplied: 0, walPresent: true };
  } catch {
    return { buf: main, walApplied: 0 };
  }
}

/**
 * 用 path→hex 或裸 hex 列表解密 EDB 列表
 * @param {Array<{path:string,name:string,chatId?:string,size?:number}>} edbs
 * @param {Record<string,string>} keyMap relpath 或 文件名 → 64hex
 * @param {(stage:string,detail:string)=>void} onProgress
 */
async function decryptEdbsWithKeyMap(edbs, keyMap, onProgress) {
  const report = onProgress || (() => {});
  const hexSet = new Set();
  const byBase = new Map();
  for (const [k, hex] of Object.entries(keyMap || {})) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) continue;
    const h = hex.toLowerCase();
    hexSet.add(h);
    const base = path.basename(String(k).replace(/\//g, '\\'));
    byBase.set(base.toLowerCase(), h);
    byBase.set(String(k).toLowerCase(), h);
  }
  if (!hexSet.size) return { ok: false, reason: '没有可用的 32 字节 DEK', files: [], warnings: [] };

  const usable = (edbs || []).filter((e) => (e.size == null ? true : e.size >= 4096));
  if (!usable.length) return { ok: false, reason: '没有可解密的 EDB（需 ≥4KB）', files: [], warnings: [] };

  report('decrypt', `准备用 ${hexSet.size} 把密钥解密 ${usable.length} 个 EDB…`);
  const files = [];
  const warnings = [];
  let skipped = 0;

  for (let i = 0; i < usable.length; i++) {
    const edb = usable[i];
    report('decrypt', `解密 ${edb.name}（${i + 1}/${usable.length}）…`);
    try {
      const { buf, walPresent } = readEdbWithWal(edb.path);
      if (walPresent) report('warn', `${edb.name} 存在 -wal，本次仅用主库（未做完整 WAL 重放）`);

      let isZeroed = buf.length >= 4096;
      if (isZeroed) {
        for (let z = 0; z < 4096; z++) if (buf[z] !== 0) { isZeroed = false; break; }
      }
      if (isZeroed) {
        const msg = `${edb.name} 当前为全零（KakaoTalk 运行时保护）——请退出 KakaoTalk 后重试`;
        warnings.push(msg);
        report('warn', msg);
        skipped++;
        continue;
      }

      // 优先文件名精确匹配，再遍历全部密钥
      const preferred = byBase.get(edb.name.toLowerCase());
      const ordered = preferred
        ? [preferred, ...[...hexSet].filter((h) => h !== preferred)]
        : [...hexSet];

      let plain = null;
      let used = null;
      for (const hex of ordered) {
        const keyBytes = Buffer.from(hex, 'hex');
        const params = trySqlCipherParams(buf, keyBytes) ||
          (verifySqlCipherHmac(buf, keyBytes, 4096, 64) ? { pageSize: 4096, hmacSize: 64 } : null) ||
          (verifySqlCipherHmac(buf, keyBytes, 4096, 32) ? { pageSize: 4096, hmacSize: 32 } : null);
        if (!params) continue;
        const out = await decryptSqlCipherEdb(buf, keyBytes, params.pageSize, params.hmacSize);
        if (out.subarray(0, 16).equals(SQLITE_HEAD_BUF)) {
          plain = out;
          used = hex;
          break;
        }
      }
      if (plain) {
        files.push({
          name: edb.name,
          path: edb.path,
          chatId: edb.chatId || null,
          size: edb.size,
          data: new Uint8Array(plain),
          keyHexPrefix: used.slice(0, 12),
        });
      } else {
        skipped++;
        warnings.push(`${edb.name}：密钥集中无一匹配`);
      }
    } catch (e) {
      const locked = /EBUSY|EPERM|EACCES/i.test(String(e.code || e.message));
      const msg = `${edb.name} 解密失败：${locked ? '文件被 KakaoTalk 独占锁定（请退出后重试）' : e.message}`;
      warnings.push(msg);
      report('warn', msg);
    }
  }

  if (!files.length) {
    return {
      ok: false,
      reason: '没有任何 EDB 解密成功。' + (warnings[0] || '请确认已退出 KakaoTalk，且密钥与账号匹配'),
      files: [],
      warnings,
      skipped,
    };
  }
  if (skipped) {
    const msg = `${skipped} 个 EDB 未能解密（可能密钥缺失或文件被保护）`;
    warnings.push(msg);
    report('warn', msg);
  }
  return { ok: true, files, warnings, skipped, decrypted: files.length };
}

module.exports = {
  trySqlCipherParams,
  decryptSqlCipherEdb,
  verifySqlCipherHmac,
  decryptEdbsWithKeyMap,
};
