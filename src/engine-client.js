// Talks to the Rust audio engine: one JSON object per line on its stdin (commands) and stdout (events).
// EngineSupervisor keeps it alive for a monitor that runs around the clock: if the engine ends by itself it is started
// again after a short wait, and the last list of inputs is sent to the new process.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export function engineFileName(platform = process.platform) {
  return platform === 'win32' ? 'dead-air-engine.exe' : 'dead-air-engine';
}

// Where the engine binary is: DAW_ENGINE (tests, development), the installed app (resources/engine), or the cargo
// build folders of the repository (the newest of release and debug: after a build of one, the other may be stale).
export function findEngine({ resourcesPath, rootDir, platform = process.platform, env = process.env } = {}) {
  const file = engineFileName(platform);
  if (env.DAW_ENGINE && fs.existsSync(env.DAW_ENGINE)) return env.DAW_ENGINE;
  if (resourcesPath) {
    const installed = path.join(resourcesPath, 'engine', file);
    if (fs.existsSync(installed)) return installed;
  }
  if (rootDir) {
    const built = ['release', 'debug'].map((d) => path.join(rootDir, 'engine', 'target', d, file)).filter((p) => fs.existsSync(p));
    built.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (built.length) return built[0];
  }
  return null;
}

export class EngineClient extends EventEmitter {
  constructor({ binary, args = [] }) {
    super();
    this.binary = binary;
    this.args = args;
    this.child = null;
    this.stderrTail = '';
  }

  get alive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed && this.child.stdin.writable;
  }

  start() {
    const child = spawn(this.binary, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      this.emit('event', msg);
    });
    child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.emit('exit', { code: null, signal: null, error: err.message }));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.emit('exit', { code, signal, stderr: this.stderrTail });
    });
    return this;
  }

  send(cmd) {
    if (!this.alive) return false;
    this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
    return true;
  }

  // Resolves with the next event named `name`.
  request(cmd, name, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('event', on);
        reject(new Error(`The engine did not answer "${cmd.cmd}" in time`));
      }, timeoutMs);
      const on = (ev) => {
        if (ev.event !== name) return;
        clearTimeout(timer);
        this.off('event', on);
        resolve(ev);
      };
      this.on('event', on);
      if (!this.send(cmd)) {
        clearTimeout(timer);
        this.off('event', on);
        reject(new Error('The engine is not running'));
      }
    });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.send({ cmd: 'shutdown' });
    child.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export class EngineSupervisor extends EventEmitter {
  constructor({ binary, args = [], restartDelayMs = 1500 }) {
    super();
    this.binary = binary;
    this.args = args;
    this.restartDelayMs = restartDelayMs;
    this.client = null;
    this.wanted = false; // the supervisor itself is on
    this.inputs = null; // the list of inputs the engine must keep open (null = none)
    this.starts = 0;
    this.timer = null;
  }

  start() {
    this.wanted = true;
    this.#spawn();
    return this;
  }

  #spawn() {
    const client = new EngineClient({ binary: this.binary, args: this.args });
    this.client = client;
    this.starts += 1;
    client.on('event', (ev) => {
      if (ev.event === 'ready') {
        if (this.inputs) client.send({ cmd: 'sync', inputs: this.inputs });
        if (this.starts > 1) this.emit('restarted', ev);
      }
      this.emit('event', ev);
    });
    client.on('exit', (info) => {
      if (this.client === client) this.client = null;
      this.emit('exit', info);
      if (this.wanted) {
        this.timer = setTimeout(() => this.wanted && this.#spawn(), this.restartDelayMs);
      }
    });
    client.start();
  }

  send(cmd) {
    return this.client ? this.client.send(cmd) : false;
  }

  request(cmd, name, timeoutMs) {
    return this.client ? this.client.request(cmd, name, timeoutMs) : Promise.reject(new Error('The engine is not running'));
  }

  // Makes the engine keep exactly these inputs open (new ones opened, missing ones closed, changed ones opened again).
  syncInputs(inputs) {
    this.inputs = inputs;
    this.send({ cmd: 'sync', inputs });
  }

  // Closes every input; the engine stays running.
  stopInputs() {
    this.inputs = null;
    this.send({ cmd: 'stop' });
  }

  async stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    if (this.client) await this.client.stop();
  }
}

// What an engine that ended tells the person, when it is something they can fix: the engine is linked to the system library of
// sound on Linux (libasound.so.2), and a computer without it cannot even start it. Returns { kind, ... } or null.
export function engineProblem(info) {
  const err = String(info?.stderr || '') + ' ' + String(info?.error || '');
  const lib = /(libasound\.so[.\d]*)[^\n]*(cannot open shared object file|No such file)/i.exec(err);
  if (lib) return { kind: 'missing-library', lib: 'libasound.so.2' };
  if (/\b(ENOENT|EACCES|EPERM)\b/.test(err)) return { kind: 'cannot-start', detail: String(info?.error || '').slice(0, 200) };
  return null;
}
