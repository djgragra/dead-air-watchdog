import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineSupervisor, engineFileName, findEngine } from '../src/engine-client.js';
import { enginePath } from './helpers.js';

const skip = enginePath ? false : 'engine not built (npm run engine)';

test('findEngine prefers DAW_ENGINE, then the installed app, then the newest cargo build', () => {
  assert.equal(findEngine({ env: { DAW_ENGINE: process.execPath } }), process.execPath);
  assert.equal(findEngine({ resourcesPath: '/nowhere', rootDir: '/nowhere', env: {} }), null);
  assert.equal(engineFileName('win32'), 'dead-air-engine.exe');
  assert.equal(engineFileName('linux'), 'dead-air-engine');
});

test('if the engine dies it is started again and gets the last list of inputs', { skip }, async () => {
  const sup = new EngineSupervisor({ binary: enginePath, args: ['--test-sources'], restartDelayMs: 200 });
  const seen = [];
  sup.on('event', (e) => seen.push(e));
  sup.start();
  await new Promise((r) => setTimeout(r, 400));
  sup.syncInputs([{ id: 'a', source: { kind: 'tone', script: [{ ms: 60_000, db: -30 }] } }]);
  const waitLevels = (n) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no levels after the ${n === 1 ? 'start' : 'restart'}`)), 8000);
    const iv = setInterval(() => {
      if (seen.filter((e) => e.event === 'levels').length >= n) { clearTimeout(t); clearInterval(iv); resolve(); }
    }, 50);
  });
  await waitLevels(5);
  const restarted = new Promise((r) => sup.once('restarted', r));
  process.kill(sup.client.child.pid, 'SIGKILL');
  await restarted;
  const before = seen.filter((e) => e.event === 'levels').length;
  await waitLevels(before + 5); // the new engine measures the same input again
  assert.equal(sup.starts, 2);
  await sup.stop();
});

test('stopInputs forgets the list: a restarted engine opens nothing', { skip }, async () => {
  const sup = new EngineSupervisor({ binary: enginePath, args: ['--test-sources'], restartDelayMs: 200 });
  sup.start();
  await new Promise((r) => setTimeout(r, 300));
  sup.syncInputs([{ id: 'a', source: { kind: 'tone', script: [{ ms: 60_000, db: -30 }] } }]);
  sup.stopInputs();
  assert.equal(sup.inputs, null);
  await sup.stop();
});

test('engineProblem: a missing libasound is said, a refused start is said, other ends are not a problem to fix', async () => {
  const { engineProblem } = await import('../src/engine-client.js');
  assert.deepEqual(engineProblem({ code: 127, stderr: 'engine: error while loading shared libraries: libasound.so.2: cannot open shared object file: No such file or directory' }), { kind: 'missing-library', lib: 'libasound.so.2' });
  assert.equal(engineProblem({ code: null, error: 'spawn /x/engine EACCES' }).kind, 'cannot-start');
  assert.equal(engineProblem({ code: 1, stderr: 'something else' }), null);
  assert.equal(engineProblem({ code: null, signal: 'SIGKILL' }), null);
});
