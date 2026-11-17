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
function mergeRegions(spans) {
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const out = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const [a, b] = spans[i];
    if (a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

function regionsNearNeedles(blob, needles, radius) {
  const spans = [];
  for (const nd of needles) {
    if (!nd || nd.length < 16) continue;
    let start = 0;
    while (true) {
      const pos = blob.indexOf(nd, start);
      if (pos < 0) break;
      spans.push([Math.max(0, pos - radius), Math.min(blob.length, pos + nd.length + radius)]);
      start = pos + 1;
    }
  }
  return mergeRegions(spans);
}

async function scanBlobForRoot(st, blob, opts = {}, onProgress) {
  const step = opts.step || 4;
  const probes = (st.chatlogEntries && st.chatlogEntries.length
    ? st.chatlogEntries
    : st.entries
  ).slice(0, Math.max(1, opts.probeCount || 3));

  // 优先：ICV 通过即可（补全全量）；有 knownDekBytes 时先扫邻域加速
  const knownDekBytes = (opts.knownDekBytes || []).filter((b) => Buffer.isBuffer(b) && b.length === 32);
  const t0 = Date.now();
  let checked = 0;

  const accept = (cand) => {
    if (cand.every((b) => b === 0) || cand.every((b) => b === 0xff)) return false;
    const dek0 = tryUnwrapOne(cand, st.salt, st.infoPrefix, probes[0].relpath, probes[0].wrapped);
    if (!dek0) return false;
    const need = Math.max(0, Math.min(2, probes.length - 1));
    if (!need) return true;
    let okExtra = 0;
    for (let i = 1; i < probes.length; i++) {
      if (tryUnwrapOne(cand, st.salt, st.infoPrefix, probes[i].relpath, probes[i].wrapped)) okExtra++;
    }
    return okExtra >= need;
  };

  const scanRange = async (from, to, phase) => {
    for (let i = from; i + 32 <= to; i += step) {
      checked++;
      if ((checked % 200000) === 0) {
        if (onProgress) onProgress({ checked, elapsed: (Date.now() - t0) / 1000, phase });
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
        phase,
      };
    }
    return null;
  };

  if (knownDekBytes.length) {
    const radius = opts.nearRadius || 2 * 1024 * 1024;
    const regions = regionsNearNeedles(blob, knownDekBytes, radius);
    if (onProgress) {
      onProgress({
        checked,
        elapsed: (Date.now() - t0) / 1000,
        phase: 'near',
        detail: `已知 DEK 邻域段数=${regions.length} 半径=${radius}`,
      });
    }
    for (const [a, b] of regions) {
      const hit = await scanRange(a, b, 'near');
      if (hit) return hit;
    }
  }

  const hit = await scanRange(0, blob.length, 'full');
  if (hit) return hit;
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
      detail: p.detail || `已试 ${p.checked} 个候选  elapsed=${p.elapsed.toFixed(1)}s phase=${p.phase || ''}`,
    });
  });
  if (result.ok) {
    report({ stage: 'found', detail: `命中 R @ offset=${result.dumpOffset} phase=${result.phase || ''}` });
  }
  return result;
}

module.exports = { scanBlobForRoot, findRootInRunningKakao };
