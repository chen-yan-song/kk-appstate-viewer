'use strict';
/**
 * Windows KakaoTalk 账号 / appstate / EDB 发现
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function kakaoBaseDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Kakao', 'KakaoTalk');
}

function listAccounts() {
  const base = kakaoBaseDir();
  const usersDir = path.join(base, 'users');
  if (!fs.existsSync(usersDir)) {
    return { ok: false, reason: `未找到 users 目录：${usersDir}`, base, usersDir, accounts: [] };
  }
  const accounts = [];
  for (const name of fs.readdirSync(usersDir)) {
    const dir = path.join(usersDir, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const appstate = path.join(dir, 'appstate.dat');
    const profile = path.join(dir, 'profile.dat');
    const chatData = path.join(dir, 'chat_data');
    let appstateSize = 0;
    let edbCount = 0;
    let chatLogs = 0;
    if (fs.existsSync(appstate)) {
      try { appstateSize = fs.statSync(appstate).size; } catch { /* ignore */ }
    }
    if (fs.existsSync(chatData)) {
      try {
        for (const f of fs.readdirSync(chatData)) {
          if (/\.edb$/i.test(f)) {
            edbCount++;
            if (/chatLogs[_-]/i.test(f)) chatLogs++;
          }
        }
      } catch { /* ignore */ }
    }
    accounts.push({
      id: name,
      dir,
      appstatePath: fs.existsSync(appstate) ? appstate : null,
      profilePath: fs.existsSync(profile) ? profile : null,
      appstateSize,
      edbCount,
      chatLogs,
    });
  }
  accounts.sort((a, b) => (b.appstateSize || 0) - (a.appstateSize || 0));
  return {
    ok: accounts.length > 0,
    reason: accounts.length ? null : 'users 下没有账号目录',
    base,
    usersDir,
    accounts,
  };
}

function listEdbsForAccount(accountDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.edb$/i.test(e.name)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      const cm = e.name.match(/chatLogs[_-](\d+)\.edb$/i);
      out.push({
        name: e.name,
        path: p,
        size,
        chatId: cm ? cm[1] : null,
        relFromAccount: path.relative(accountDir, p).replace(/\//g, '\\'),
      });
    }
  };
  walk(accountDir);
  out.sort((a, b) => (b.size || 0) - (a.size || 0));
  return out;
}

function isKakaoTalkRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ running: false, pids: [] });
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq KakaoTalk.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ running: false, pids: [] });
        const pids = [];
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const m = /"KakaoTalk\.exe","(\d+)"/i.exec(line);
          if (m) pids.push(Number(m[1]));
        }
        resolve({ running: pids.length > 0, pids });
      }
    );
  });
}

module.exports = {
  kakaoBaseDir,
  listAccounts,
  listEdbsForAccount,
  isKakaoTalkRunning,
};
