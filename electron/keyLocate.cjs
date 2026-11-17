'use strict';
/**
 * 自动在常见位置查找 root_hex / keys JSON
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseKeysPayload } = require('./appstate.cjs');

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function candidateFiles(userDataDir) {
  const home = os.homedir();
  const desktop = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive - VIPKID', 'Desktop'),
  ];
  const names = [
    'kk-root-key.json',
    'kk-unwrapped-keys.json',
    'kk-known-keys.json',
    'win-key-cache.json',
  ];
  const dirs = unique([
    userDataDir,
    os.tmpdir(),
    ...desktop,
    home,
    'C:\\',
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'RuyiLing', 'scripts', 'kk-collect', 'data', 'edb-cache'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'kk-appstate-viewer'),
  ]);
  const out = [];
  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    for (const n of names) {
      out.push(path.join(d, n));
    }
    // 桌面 kk-appstate-* 目录里也可能有
    try {
      if (/Desktop/i.test(d)) {
        for (const ent of fs.readdirSync(d)) {
          if (/^kk-root-key.*\.json$/i.test(ent)) out.push(path.join(d, ent));
        }
      }
    } catch { /* ignore */ }
  }
  return unique(out);
}

function tryLoadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size < 8 || st.size > 50 * 1024 * 1024) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    // 去掉可能的 BOM
    const obj = JSON.parse(text.replace(/^\uFEFF/, ''));
    const parsed = parseKeysPayload(obj);
    return {
      path: filePath,
      rootHex: parsed.rootHex,
      keys: parsed.keys,
      keyCount: Object.keys(parsed.keys).length,
      source: parsed.source,
      mtime: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * 搜索并合并：优先带 rootHex 且较新的文件
 */
function locateKeys(userDataDir) {
  const found = [];
  for (const f of candidateFiles(userDataDir)) {
    const hit = tryLoadFile(f);
    if (hit) found.push(hit);
  }
  found.sort((a, b) => {
    const ar = a.rootHex ? 1 : 0;
    const br = b.rootHex ? 1 : 0;
    if (br !== ar) return br - ar;
    if ((b.keyCount || 0) !== (a.keyCount || 0)) return (b.keyCount || 0) - (a.keyCount || 0);
    return (b.mtime || 0) - (a.mtime || 0);
  });

  const merged = { rootHex: null, keys: {}, files: found.map((f) => f.path) };
  for (const f of found) {
    if (!merged.rootHex && f.rootHex) merged.rootHex = f.rootHex;
    Object.assign(merged.keys, f.keys || {});
  }
  return {
    ok: !!(merged.rootHex || Object.keys(merged.keys).length),
    rootHex: merged.rootHex,
    keys: merged.keys,
    keyCount: Object.keys(merged.keys).length,
    files: merged.files,
    reason: found.length ? null : '常见路径未找到 kk-root-key.json / win-key-cache.json',
  };
}

function saveRootKey(userDataDir, rootHex, extra = {}) {
  const dir = userDataDir || path.join(os.homedir(), 'AppData', 'Local', 'kk-appstate-viewer');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'kk-root-key.json');
  const payload = {
    version: 'auto',
    root_hex: String(rootHex).toLowerCase(),
    savedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  // 同步写一份到桌面，方便用户备份
  try {
    const desk = path.join(os.homedir(), 'Desktop', 'kk-root-key.json');
    fs.writeFileSync(desk, JSON.stringify(payload, null, 2), 'utf8');
  } catch { /* ignore */ }
  return out;
}

module.exports = { locateKeys, saveRootKey, candidateFiles };
