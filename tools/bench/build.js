// Builds tools/stridulation.html: the reference engine and the worklet wrapper inlined into one
// page, plus the parameter table and the test presets. Run: node tools/bench/build.js
const fs = require('fs'), path = require('path');
const d = __dirname, ref = path.join(d, '..', '..', 'reference');
const enginePath = path.join(ref, 'stridulation-engine.js');
const dsp = [enginePath, path.join(d, 'processor.js')].map(f => fs.readFileSync(f, 'utf8')).join('\n');
const presets = fs.readFileSync(path.join(ref, 'presets.js'), 'utf8');
// the page takes ranges, defaults and notches from the engine's own table, so they can't drift
const { PARAMS, MOD_TARGETS } = require(enginePath);
const params = 'window.STRIDULATION_PARAMS = ' + JSON.stringify(PARAMS) + ';\nwindow.STRIDULATION_MOD_TARGETS = ' + JSON.stringify(MOD_TARGETS) + ';';
for (const [name, src] of [['DSP', dsp], ['presets', presets]]) if (/<\/script/i.test(src)) throw new Error(name + ' source contains </script');
const tpl = fs.readFileSync(path.join(d, 'template.html'), 'utf8');
for (const ph of ['/*__DSP__*/', '/*__PRESETS__*/', '/*__PARAMS__*/']) if (tpl.split(ph).length !== 2) throw new Error('placeholder missing: ' + ph);
const out = path.join(d, '..', 'stridulation.html');
fs.writeFileSync(out, tpl.replace('/*__DSP__*/', () => dsp).replace('/*__PRESETS__*/', () => presets).replace('/*__PARAMS__*/', () => params));
console.log('tools/stridulation.html', Math.round(fs.statSync(out).size / 1024), 'KB');
