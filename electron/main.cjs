'use strict';
/**
 * kk-appstate-viewer — Electron 主进程
 * Windows：appstate + R/DEK → 解密 EDB → 交给渲染进程展示
 */
const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const appstate = require('./appstate.cjs');
const discover = require('./discover.cjs');
const sqlcipherPage = require('./sqlcipherPage.cjs');
const keyLocate = require('./keyLocate.cjs');
const findRoot = require('./findRoot.cjs');
const kakaoMedia = require('./media.cjs');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/octet-stream',
};

function handleAppScheme(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.normalize(path.join(APP_ROOT, pathname));
  if (!filePath.startsWith(APP_ROOT + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const data = fs.readFileSync(filePath);
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return new Response(data, { headers: { 'content-type': mime } });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

let mainWindow = null;
let findRootChild = null;

function sendProgress(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'KK AppState Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadURL('app://local/index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  protocol.handle('app', handleAppScheme);
  createWindow();
});

app.on('window-all-closed', () => {
  if (findRootChild) {
    try { findRootChild.kill(); } catch { /* ignore */ }
    findRootChild = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/** 把任意错误变成可展示字符串 */
function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

ipcMain.handle('selftest', () => {
  try {
    return appstate.selftest();
  } catch (e) {
    return { ok: false, message: errText(e) };
  }
});

ipcMain.handle('discover', async () => {
  try {
    const accounts = discover.listAccounts();
    const running = await discover.isKakaoTalkRunning();
    return {
      ok: accounts.ok,
      reason: accounts.reason,
      base: accounts.base,
      usersDir: accounts.usersDir,
      accounts: accounts.accounts,
      kakaoRunning: running.running,
      kakaoPids: running.pids,
      platform: process.platform,
    };
  } catch (e) {
    return { ok: false, reason: errText(e), accounts: [] };
  }
});

ipcMain.handle('inspect-appstate', (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, reason: `文件不存在：${filePath || '(空)'}` };
    }
    const st = appstate.parseAppstate(filePath);
    return {
      ok: true,
      path: st.path,
      infoPrefix: st.infoPrefixText,
      saltHex: st.saltHex,
      entryCount: st.entryCount,
      chatlogCount: st.chatlogCount,
      samplePaths: st.entries.slice(0, 5).map((x) => x.relpathText),
    };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
});

ipcMain.handle('list-edbs', (_e, accountDir) => {
  try {
    if (!accountDir || !fs.existsSync(accountDir)) {
      return { ok: false, reason: `账号目录不存在：${accountDir || '(空)'}`, edbs: [] };
    }
    const edbs = discover.listEdbsForAccount(accountDir);
    return { ok: true, edbs, count: edbs.length };
  } catch (e) {
    return { ok: false, reason: errText(e), edbs: [] };
  }
});

ipcMain.handle('pick-file', async (_e, opts) => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: (opts && opts.title) || '选择文件',
      filters: (opts && opts.filters) || [{ name: '全部', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
});

ipcMain.handle('read-text-file', (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, reason: `文件不存在：${filePath || '(空)'}` };
    }
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, text, path: filePath };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
});

ipcMain.handle('parse-keys-json', (_e, text) => {
  try {
    const obj = JSON.parse(text);
    const parsed = appstate.parseKeysPayload(obj);
    return {
      ok: true,
      rootHex: parsed.rootHex,
      keyCount: Object.keys(parsed.keys).length,
      keys: parsed.keys,
      source: parsed.source,
    };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
});

ipcMain.handle('unwrap-with-root', (_e, opts) => {
  try {
    const { appstatePath, rootHex } = opts || {};
    if (!appstatePath) return { ok: false, reason: '缺少 appstatePath' };
    const st = appstate.parseAppstate(appstatePath);
    const root = appstate.parseRootHex(rootHex);
    const result = appstate.unwrapAll(st, root);
    if (!result.ok) {
      return {
        ok: false,
        reason: `根钥未能解出任何 DEK（ok=0 fail=${result.fail}）。请确认 R 与该 appstate 匹配`,
        ...result,
      };
    }
    return {
      ok: true,
      rootHex: result.rootHex,
      keys: result.keys,
      unwrapped: result.ok,
      failed: result.fail,
      infoPrefix: st.infoPrefixText,
      saltHex: st.saltHex,
    };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
});

/**
 * 解密并返回明文 EDB（Uint8Array 经结构化克隆传给渲染进程）
 * opts: { accountDir, appstatePath?, rootHex?, keys? }
 */
ipcMain.handle('decrypt-account', async (e, opts) => {
  const report = (stage, detail) => sendProgress('decrypt-progress', { stage, detail });
  try {
    const accountDir = opts && opts.accountDir;
    if (!accountDir) return { ok: false, reason: '缺少 accountDir' };

    let keyMap = { ...(opts.keys || {}) };
    const warnings = [];

    if (opts.rootHex) {
      report('unwrap', '使用根钥 R 解包 appstate…');
      const appstatePath = opts.appstatePath || path.join(accountDir, 'appstate.dat');
      if (!fs.existsSync(appstatePath)) {
        return { ok: false, reason: `找不到 appstate.dat：${appstatePath}` };
      }
      const st = appstate.parseAppstate(appstatePath);
      const root = appstate.parseRootHex(opts.rootHex);
      const un = appstate.unwrapAll(st, root);
      if (!un.ok) {
        return {
          ok: false,
          reason: `根钥无法解包任何 DEK（失败 ${un.fail} 条）。R 可能不正确或不属于该账号`,
        };
      }
      keyMap = { ...keyMap, ...un.keys };
      report('unwrap', `已解包 ${un.ok} 条 DEK（失败 ${un.fail}）`);
    }

    if (!Object.keys(keyMap).length) {
      return { ok: false, reason: '没有可用密钥：请先粘贴 R、导入 kk-root-key.json，或导入 keys JSON' };
    }

    const edbs = discover.listEdbsForAccount(accountDir);
    if (!edbs.length) {
      return { ok: false, reason: `账号目录下未找到 .edb：${accountDir}` };
    }

    const running = await discover.isKakaoTalkRunning();
    if (running.running) {
      warnings.push(`检测到 KakaoTalk 正在运行（PID ${running.pids.join(',')}）。运行时 EDB 可能全零或被锁，建议先完全退出再解密`);
      report('warn', warnings[warnings.length - 1]);
    }

    const dec = await sqlcipherPage.decryptEdbsWithKeyMap(edbs, keyMap, report);
    if (!dec.ok) {
      return {
        ok: false,
        reason: dec.reason,
        warnings: [...warnings, ...(dec.warnings || [])],
      };
    }
    return {
      ok: true,
      files: dec.files,
      decrypted: dec.decrypted,
      skipped: dec.skipped,
      keyCount: Object.keys(keyMap).length,
      warnings: [...warnings, ...(dec.warnings || [])],
      // 统一库打开用的占位密钥（明文库仍走 sqlcipher wasm setKey）
      unifyKey: (Object.values(keyMap)[0] || '').toLowerCase(),
    };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
});

/** 可选：调用旁边的 kk-appstate-probe.exe find-root（流式进度） */
ipcMain.handle('find-root-start', async (_e, opts) => {
  try {
    if (findRootChild) {
      return { ok: false, reason: '已有 find-root 在运行，请先停止' };
    }
    const appstatePath = opts && opts.appstatePath;
    if (!appstatePath || !fs.existsSync(appstatePath)) {
      return { ok: false, reason: `appstate 不存在：${appstatePath || '(空)'}` };
    }
    const candidates = [
      opts.probePath,
      path.join(APP_ROOT, 'bin', 'kk-appstate-probe.exe'),
      path.join(APP_ROOT, 'kk-appstate-probe.exe'),
      path.join(path.dirname(process.execPath), 'kk-appstate-probe.exe'),
    ].filter(Boolean);
    let exe = null;
    for (const c of candidates) {
      if (c && fs.existsSync(c)) { exe = c; break; }
    }
    if (!exe) {
      return {
        ok: false,
        reason: '未找到 kk-appstate-probe.exe。请把它放到应用目录的 bin/ 下，或改用「粘贴 R / 导入 JSON」',
      };
    }
    const outJson = path.join(app.getPath('temp'), `kk-root-key-${Date.now()}.json`);
    const args = ['find-root', '--appstate', appstatePath, '--out', outJson];
    if (opts.knownKeysPath && fs.existsSync(opts.knownKeysPath)) {
      args.push('--known-keys', opts.knownKeysPath);
    }
    findRootChild = spawn(exe, args, { windowsHide: true });
    let stderr = '';
    findRootChild.stdout.on('data', (buf) => {
      sendProgress('find-root-progress', { line: buf.toString('utf8') });
    });
    findRootChild.stderr.on('data', (buf) => {
      const s = buf.toString('utf8');
      stderr += s;
      sendProgress('find-root-progress', { line: s, isErr: true });
    });
    findRootChild.on('error', (err) => {
      sendProgress('find-root-done', { ok: false, reason: errText(err) });
      findRootChild = null;
    });
    findRootChild.on('close', (code) => {
      findRootChild = null;
      try {
        if (fs.existsSync(outJson)) {
          const raw = fs.readFileSync(outJson, 'utf8');
          const obj = JSON.parse(raw);
          if (obj.root_hex || obj.rootHex) {
            sendProgress('find-root-done', {
              ok: true,
              rootHex: (obj.root_hex || obj.rootHex).toLowerCase(),
              path: outJson,
              code,
            });
            return;
          }
        }
      } catch (e) {
        sendProgress('find-root-done', { ok: false, reason: errText(e), code, stderr });
        return;
      }
      sendProgress('find-root-done', {
        ok: false,
        reason: stderr.trim() || `find-root 退出码 ${code}，未写出根钥`,
        code,
        stderr,
      });
    });
    return { ok: true, exe, outJson };
  } catch (e) {
    findRootChild = null;
    return { ok: false, reason: errText(e) };
  }
});

ipcMain.handle('resolve-media', async (_e, opts) => {
  try {
    return await kakaoMedia.resolveMedia(opts || {});
  } catch (e) {
    return { frames: [{ ok: false, tier: 'stub', reason: errText(e) }] };
  }
});

ipcMain.handle('find-root-stop', () => {
  if (!findRootChild) return { ok: true, stopped: false };
  try {
    findRootChild.kill();
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
  findRootChild = null;
  return { ok: true, stopped: true };
});

/**
 * 全自动流水线：
 * 发现账号 → 磁盘找钥 →（缺 R 且 Kakao 在跑）内存搜 R → 解包 → 解密
 * opts.skipFindRoot: 跳过内存搜钥
 * opts.forceAccountId: 指定账号目录名
 */
ipcMain.handle('run-auto', async (_e, opts = {}) => {
  const progress = (step, state, detail) => sendProgress('auto-progress', { step, state, detail });
  try {
    progress('account', 'active', '扫描本机 KakaoTalk 账号…');
    const accounts = discover.listAccounts();
    if (!accounts.ok || !accounts.accounts.length) {
      progress('account', 'fail', accounts.reason || '未找到账号');
      return { ok: false, reason: accounts.reason || '未找到 KakaoTalk 账号目录', step: 'account' };
    }
    let account = accounts.accounts[0];
    if (opts.forceAccountId) {
      account = accounts.accounts.find((a) => a.id === opts.forceAccountId) || account;
    }
    if (!account.appstatePath) {
      progress('account', 'fail', '账号无 appstate.dat');
      return { ok: false, reason: `账号 ${account.id} 没有 appstate.dat`, step: 'account' };
    }
    progress(
      'account',
      'ok',
      `${account.id.slice(0, 12)}… · appstate ${(account.appstateSize / 1024).toFixed(1)}KB · EDB ${account.edbCount}`
    );

    progress('appstate', 'active', '解析 appstate.dat…');
    let st;
    try {
      st = appstate.parseAppstate(account.appstatePath);
    } catch (e) {
      progress('appstate', 'fail', errText(e));
      return { ok: false, reason: errText(e), step: 'appstate' };
    }
    progress('appstate', 'ok', `prefix=${st.infoPrefixText} · 条目 ${st.entryCount}（chatLogs ${st.chatlogCount}）`);

    progress('keys', 'active', '在桌面/缓存目录自动查找根钥与 DEK…');
    const located = keyLocate.locateKeys(app.getPath('userData'));
    let rootHex = located.rootHex || null;
    let keyMap = { ...(located.keys || {}) };
    if (located.ok) {
      progress(
        'keys',
        'ok',
        `${rootHex ? '已找到 R' : '无 R'} · DEK ${Object.keys(keyMap).length} · 来自 ${located.files.slice(0, 2).join('；') || '缓存'}`
      );
    } else {
      progress('keys', 'active', located.reason || '未找到现成密钥文件');
    }

    // 缺 R：若 KakaoTalk 在跑则内存搜索
    if (!rootHex && !opts.skipFindRoot) {
      const running = await discover.isKakaoTalkRunning();
      if (running.running) {
        progress('findroot', 'active', 'KakaoTalk 运行中，开始内存搜索根钥 R（可能需要数分钟）…');
        const knownDekBytes = Object.values(keyMap)
          .filter((h) => /^[0-9a-fA-F]{64}$/.test(h))
          .slice(0, 80)
          .map((h) => Buffer.from(h, 'hex'));
        const fr = await findRoot.findRootInRunningKakao(
          st,
          { step: 4, probeCount: 3, knownDekBytes, nearRadius: 2 * 1024 * 1024 },
          (p) => {
            progress('findroot', 'active', `[${p.stage}] ${p.detail}`);
          }
        );
        if (!fr.ok) {
          progress('findroot', 'fail', fr.reason || '未找到 R');
          if (!Object.keys(keyMap).length) {
            return {
              ok: false,
              reason: fr.reason || '内存中未找到根钥，且磁盘上也没有可用 DEK',
              step: 'findroot',
              needManualRoot: true,
            };
          }
          progress('findroot', 'fail', `${fr.reason}；将尝试仅用已有 DEK 继续`);
        } else {
          rootHex = fr.rootHex;
          const saved = keyLocate.saveRootKey(app.getPath('userData'), rootHex, {
            dump_offset: fr.dumpOffset,
            checked: fr.checked,
          });
          progress('findroot', 'ok', `命中 R，已保存 ${saved}`);
        }
      } else if (!Object.keys(keyMap).length) {
        progress('findroot', 'fail', '无现成密钥，且 KakaoTalk 未运行，无法搜 R');
        return {
          ok: false,
          reason: '没有可用密钥。请先启动并登录 KakaoTalk 后点「重新自动」，或手动粘贴 root_hex',
          step: 'findroot',
          needKakaoRunning: true,
          needManualRoot: true,
        };
      } else {
        progress('findroot', 'ok', '跳过内存搜钥（已有 DEK 缓存）');
      }
    } else if (rootHex) {
      progress('findroot', 'ok', '已有根钥，跳过内存搜索');
    }

    if (rootHex) {
      progress('unwrap', 'active', '用 R 解包全部 DEK…');
      const un = appstate.unwrapAll(st, appstate.parseRootHex(rootHex));
      if (!un.ok) {
        progress('unwrap', 'fail', `解包失败 fail=${un.fail}`);
        if (!Object.keys(keyMap).length) {
          return { ok: false, reason: `根钥无法解包任何 DEK（fail=${un.fail}）`, step: 'unwrap' };
        }
      } else {
        keyMap = { ...keyMap, ...un.keys };
        progress('unwrap', 'ok', `解包成功 ${un.ok} 条（失败 ${un.fail}）`);
      }
    } else {
      progress('unwrap', 'ok', `使用已有 DEK ${Object.keys(keyMap).length} 条`);
    }

    if (!Object.keys(keyMap).length) {
      return { ok: false, reason: '解包后仍无可用 DEK', step: 'unwrap' };
    }

    progress('decrypt', 'active', '解密本地 EDB…');
    const running = await discover.isKakaoTalkRunning();
    const warnings = [];
    if (running.running) {
      warnings.push('KakaoTalk 仍在运行：若解密失败/全零，请完全退出后点「我已退出，继续」');
    }
    const edbs = discover.listEdbsForAccount(account.dir);
    const dec = await sqlcipherPage.decryptEdbsWithKeyMap(edbs, keyMap, (stage, detail) => {
      progress('decrypt', 'active', `[${stage}] ${detail}`);
    });
    if (!dec.ok) {
      progress('decrypt', 'fail', dec.reason || '解密失败');
      return {
        ok: false,
        reason: dec.reason,
        step: 'decrypt',
        warnings: [...warnings, ...(dec.warnings || [])],
        needExitKakao: running.running,
        account,
        rootHex,
        keyCount: Object.keys(keyMap).length,
        // 把密钥带回，方便「退出后续跑」不必再搜 R
        keys: keyMap,
      };
    }
    progress('decrypt', 'ok', `已解密 ${dec.decrypted} 个库（跳过 ${dec.skipped || 0}）`);
    return {
      ok: true,
      account,
      rootHex,
      keyCount: Object.keys(keyMap).length,
      files: dec.files,
      decrypted: dec.decrypted,
      skipped: dec.skipped,
      warnings: [...warnings, ...(dec.warnings || [])],
      unifyKey: (Object.values(keyMap)[0] || rootHex || '').toLowerCase(),
      keys: keyMap,
    };
  } catch (e) {
    progress('decrypt', 'fail', errText(e));
    return { ok: false, reason: errText(e), step: 'error' };
  }
});
