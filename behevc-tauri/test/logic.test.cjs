// Tests de las funciones puras del frontend (logic.js). Ejecutar: node test/logic.test.cjs
const assert = require('assert');
const { formatBytes, formatEta, verdictKey } = require('../src/logic.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// formatBytes
ok(formatBytes(2048) === '2 KB', 'formatBytes KB');
ok(formatBytes(5 * 1024 * 1024) === '5 MB', 'formatBytes MB');
ok(formatBytes(2 * 1024 ** 3) === '2.00 GB', 'formatBytes GB');

// formatEta
ok(formatEta(45) === '45s', 'eta s');
ok(formatEta(90) === '1m 30s', 'eta m');
ok(formatEta(3700) === '1h 1m', 'eta h');

// verdictKey (minVmaf=93, minSavings=15)
ok(verdictKey(-5, 96, 93, 15) === 'bad', 'no encoge');
ok(verdictKey(40, 96, 93, 15) === 'recommended', 'gran ahorro + buena calidad');
ok(verdictKey(40, 88, 93, 15) === 'loss', 'calidad por debajo del umbral-3');
ok(verdictKey(5, 96, 93, 15) === 'notworth', 'ahorro pequeño');
ok(verdictKey(12, 96, 93, 15) === 'marginal', 'ahorro intermedio');
ok(verdictKey(40, null, 93, 15) === 'recommended', 'sin VMAF, gran ahorro');
// umbrales personalizados
ok(verdictKey(40, 91, 95, 30) === 'loss', 'umbral VMAF más alto');
ok(verdictKey(20, 96, 93, 30) === 'marginal', 'umbral ahorro más alto → marginal');

console.log(`✔ ${passed} tests de logic.js pasados`);
