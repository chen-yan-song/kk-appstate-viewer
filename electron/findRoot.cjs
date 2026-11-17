'use strict';
/**
 * 在内存 dump 中搜索能解开 appstate 的 32 字节根钥 R
 */
const fs = require('fs');
const { tryUnwrapOne } = require('./appstate.cjs');
const { dumpProcessMemory } = require('./memDump.cjs');
const discover = require('./discover.cjs');

function yieldLoop() {
  return new Promise((r) => setImmediate(r));
}

/**
 * @param {object} st parseAppstate 结果
 * @param {Buffer} blob
 * @param {object} opts
 * @param {(p:{checked:number,elapsed:number,phase:string})=>void} onProgress
 */
async function scanBlobForRoot(st, blob, opts = {}, onProgress) {
  const step = opts.step || 4;
  const probes = (st.chatlogEntries && st.chatlogEntries.length
    ? st.chatlogEntries
    : st.entries
  ).slice(0, Math.max(1, opts.probeCount || 3));

  const knownMatched = opts.knownMatched || []; // [{relpath, dek:Buffer}]
  const t0 = Date.now();
  let checked = 0;

  const accept = (cand) => {
    if (cand.equals(Buffer.alloc(32, 0)) || cand.equals(Buffer.alloc(32, 0xff))) return false;
    if (knownMatched.length) {
      for (const km of knownMatched) {
        const got = tryUnwrapOne(cand, st.salt, st.infoPrefix, km.relpath, km.wrapped);
        if (got && got.equals(km.dek)) return true;
      }
      return false;
    }
    const dek0 = tryUnwrapOne(cand, st.salt, st.infoPrefix, probes[0].relpath, probes[0].wrapped);
    if (!dek0) return false;
    let okExtra = 0;
    const need = Math.max(0, Math.min(2, probes.length - 1));
    for (let i = 1; i < probes.length; i++) {
      if (tryUnwrapOne(cand, st.salt, st.infoPrefix, probes[i].relpath, probes[i].wrapped)) okExtra++;
    }
    return okExtra >= need;
  };

  const limit = blob.length - 32;
  for (let i = 0; i <= limit; i += step) {
    checked++;
    if ((checked % 200000) === 0) {
      if (onProgress) onProgress({ checked, elapsed: (Date.now() - t0) / 1000, phase: 'full' });
      await yieldLoop();
    }
    const cand = blob.subarray(i, i + 32);
    if (!accept(cand)) continue;
    return {
      ok: true,
      rootHex: Buffer.from(cand).toString('hex'),
      dumpOffset: i,
      checked,
      elapsed: (Date.now() - t0) / 1000,
    };
  }
  return {
    ok: false,
    reason: `未找到根钥。已试候选=${checked} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s dump=${blob.length}B`,
    checked,
    elapsed: (Date.now() - t0) / 1000,
  };
}

/**
 * 全自动找 R：要求 KakaoTalk 在跑
 */
async function findRootInRunningKakao(st, opts = {}, onProgress) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: '仅 Windows 支持内存搜索根钥' };
  }
  const report = onProgress || (() => {});
  const running = await discover.isKakaoTalkRunning();
  if (!running.running || !running.pids.length) {
    return { ok: false, reason: 'KakaoTalk 未运行，无法内存搜索 R。请先登录 KakaoTalk，或导入已有 root_hex' };
  }

  report({ stage: 'dump', detail: `导出进程内存 PID=${running.pids.join(',')}…` });
  let dump = await dumpProcessMemory(running.pids[0], opts.dumpTimeoutMs || 300000, { privateOnly: true });
  if (!dump.ok || (dump.size || 0) < 1024 * 1024) {
    report({ stage: 'dump', detail: '私有内存不足，回退导出全部可读私有页…' });
    dump = await dumpProcessMemory(running.pids[0], opts.dumpTimeoutMs || 300000, { privateOnly: false });
  }
  if (!dump.ok) return { ok: false, reason: dump.reason || '内存导出失败' };

  report({
    stage: 'scan',
    detail: `开始扫描 dump ${(dump.size / 1048576).toFixed(1)} MB（step=${opts.step || 4}）…`,
  });

  let blob;
  try {
    blob = fs.readFileSync(dump.dumpPath);
  } catch (e) {
    return { ok: false, reason: `读取 dump 失败：${e.message}` };
  } finally {
    try { fs.unlinkSync(dump.dumpPath); } catch { /* ignore */ }
  }

  const result = await scanBlobForRoot(st, blob, opts, (p) => {
    report({
      stage: 'scan',
      detail: `已试 ${p.checked} 个候选  elapsed=${p.elapsed.toFixed(1)}s`,
    });
  });
  if (result.ok) {
    report({ stage: 'found', detail: `命中 R @ offset=${result.dumpOffset}` });
  }
  return result;
}

module.exports = { scanBlobForRoot, findRootInRunningKakao };
