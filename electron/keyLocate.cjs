'use strict';
/**
 * 只查找「本工具」写出的根钥 R，不读取 kk-collect / win-key-cache 等历史数据。
 * 约定路径：
 * - Electron userData/kk-root-key.json
 * - %LOCALAPPDATA%\kk-appstate-viewer\kk-root-key.json
 * - 桌面 kk-root-key.json（本工具保存时同步写过）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseKeysPayload } = require('./appstate.cjs');

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function isForbiddenPath(filePath) {
  const p = String(filePath || '').toLowerCase().replace(/\//g, '\\');
  // 严禁碰 kk-collect / 如意灵插件缓存，避免污染对方开发数据解读
  if (p.includes('\\ruyiling\\')) return true;
  if (p.includes('\\kk-collect\\')) return true;
  if (p.endsWith('\\win-key-cache.json') || p.includes('\\edb-cache\\')) return true;
  return false;
}

function candidateRootFiles(userDataDir) {
  const home = os.homedir();
  const desktop = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive - VIPKID', 'Desktop'),
  ];
  const dirs = unique([
    userDataDir,
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'kk-appstate-viewer'),
    ...desktop,
  ]);
  const out = [];
  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    out.push(path.join(d, 'kk-root-key.json'));
    // 本工具解包导出（若用户保存在同目录）
    out.push(path.join(d, 'kk-unwrapped-keys.json'));
  }
  return unique(out).filter((f) => !isForbiddenPath(f));
}

function tryLoadFile(filePath) {
  try {
    if (isForbiddenPath(filePath)) return null;
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size < 8 || st.size > 20 * 1024 * 1024) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(text.replace(/^\uFEFF/, ''));
    const parsed = parseKeysPayload(obj);
    // 自动路径只认带 root_hex 的本工具产物；纯 DEK 列表不自动采用
    if (!parsed.rootHex) return null;
    return {
      path: filePath,
      rootHex: parsed.rootHex,
      keys: {}, // 自动流程不用历史 DEK，一律由 R 现解
      keyCount: 0,
      source: parsed.source,
      mtime: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * 仅定位本工具保存的 R
 */
function locateKeys(userDataDir) {
  const found = [];
  for (const f of candidateRootFiles(userDataDir)) {
    const hit = tryLoadFile(f);
    if (hit) found.push(hit);
  }
  found.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const best = found[0] || null;
  return {
    ok: !!(best && best.rootHex),
    rootHex: best ? best.rootHex : null,
    keys: {},
    keyCount: 0,
    files: found.map((f) => f.path),
    reason: best
      ? null
      : '未找到本工具保存的 kk-root-key.json（不会读取 kk-collect 缓存）',
  };
}

function saveRootKey(userDataDir, rootHex, extra = {}) {
  const dir = userDataDir || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'kk-appstate-viewer'
  );
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'kk-root-key.json');
  const payload = {
    version: 'auto',
    root_hex: String(rootHex).toLowerCase(),
    savedAt: new Date().toISOString(),
    note: '由 kk-appstate-viewer 写出；勿与 kk-collect 缓存混用',
    ...extra,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  try {
    const desk = path.join(os.homedir(), 'Desktop', 'kk-root-key.json');
    fs.writeFileSync(desk, JSON.stringify(payload, null, 2), 'utf8');
  } catch { /* ignore */ }
  return out;
}

module.exports = { locateKeys, saveRootKey, candidateRootFiles, isForbiddenPath };
