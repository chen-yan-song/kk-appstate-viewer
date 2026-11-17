'use strict';
/**
 * 轻量 CBOR 解码（仅支持 appstate.dat 所需：整数/字节/文本/数组/映射）
 */

function decode(data, i = 0) {
  function take(n) {
    if (i + n > data.length) throw new Error('CBOR 截断');
    const b = data.subarray(i, i + n);
    i += n;
    return b;
  }
  if (i >= data.length) throw new Error('CBOR 空输入');
  const ai = data[i++];
  const major = ai >> 5;
  let add = ai & 31;

  function arg() {
    if (add < 24) return add;
    if (add === 24) return take(1)[0];
    if (add === 25) return take(2).readUInt16BE(0);
    if (add === 26) return take(4).readUInt32BE(0);
    if (add === 27) {
      const hi = take(4).readUInt32BE(0);
      const lo = take(4).readUInt32BE(0);
      return hi * 0x100000000 + lo;
    }
    throw new Error(`不支持的 CBOR 附加值 add=${add}`);
  }

  if (major === 0) return { value: arg(), i };
  if (major === 1) return { value: -1 - arg(), i };
  if (major === 2) {
    const n = arg();
    return { value: Buffer.from(take(n)), i };
  }
  if (major === 3) {
    const n = arg();
    return { value: take(n).toString('utf8'), i };
  }
  if (major === 4) {
    const n = arg();
    const out = [];
    for (let k = 0; k < n; k++) {
      const r = decode(data, i);
      out.push(r.value);
      i = r.i;
    }
    return { value: out, i };
  }
  if (major === 5) {
    const n = arg();
    const out = Object.create(null);
    for (let k = 0; k < n; k++) {
      const kr = decode(data, i);
      i = kr.i;
      const vr = decode(data, i);
      i = vr.i;
      let key = kr.value;
      if (Buffer.isBuffer(key)) key = key.toString('utf8');
      else if (Array.isArray(key)) key = Buffer.from(key).toString('utf8');
      out[key] = vr.value;
    }
    return { value: out, i };
  }
  if (major === 7) {
    if (add === 20) return { value: false, i };
    if (add === 21) return { value: true, i };
    if (add === 22) return { value: null, i };
  }
  throw new Error(`不支持的 CBOR major=${major} add=${add}`);
}

function decodeRoot(buf) {
  const { value } = decode(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), 0);
  return value;
}

module.exports = { decodeRoot };
