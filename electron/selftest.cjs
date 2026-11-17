'use strict';
/** 命令行自检：node electron/selftest.cjs */
const appstate = require('./appstate.cjs');
try {
  const r = appstate.selftest();
  console.log('[OK]', r.message);
  process.exit(0);
} catch (e) {
  console.error('[FAIL]', e.message || e);
  process.exit(1);
}
