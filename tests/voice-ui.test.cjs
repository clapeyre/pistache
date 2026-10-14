const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page() {
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.textContent = ''; this.value = ''; this.dataset = {}; this.classes = new Set(); this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x), toggle: (x, on) => on ? this.classes.add(x) : this.classes.delete(x) }; }
    append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    scrollIntoView() {}
    focus() {}
    play() { return Promise.resolve(); }
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const body = new Element();
  let recorder, complete, reject;
  class Recorder extends Element {
    static isTypeSupported() { return true; }
    constructor() { super(); recorder = this; this.mimeType = 'audio/webm'; }
    start() {}
    stop() { queueMicrotask(() => { if (!this.empty) this.handlers.dataavailable({ data: new Blob(['synthetic']) }); this.handlers.stop(); }); }
  }
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../dist/app.js'), 'utf8'), {
    document: { body, getElementById: get, createElement: () => new Element() },
    sessionStorage: { getItem: () => null, setItem() {} }, crypto: { randomUUID: () => 'synthetic-session' },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    window: { MediaRecorder: Recorder }, MediaRecorder: Recorder, Blob, FormData, Uint8Array, URL, atob,
    fetch: () => new Promise((resolve, fail) => { complete = result => resolve({ ok: true, json: async () => result }); reject = fail; }),
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { get, body, flush, recorder: () => recorder, complete: result => complete(result), reject: () => reject(new Error('Synthetic failure')) };
}

test('tap start/finish shows thinking until the reply and replaces the exact voice bubble with literal transcription', async () => {
  const p = page();
  p.get('talk').handlers.click(); await p.flush();
  assert.equal(p.body.dataset.voice, 'listening');
  assert.equal(p.get('voiceStatus').textContent, 'Je t’écoute…');
  assert.equal(p.get('talk').disabled, false);
  assert.equal(p.body.classes.has('thinking'), false);
  p.get('talk').handlers.click(); await p.flush();
  assert.equal(p.body.dataset.voice, 'thinking');
  assert.equal(p.body.classes.has('thinking'), true);
  assert.equal(p.get('talk').disabled, true);
  assert.equal(p.get('voiceStatus').textContent, 'Pistache réfléchit…');
  assert.equal(p.get('statusText').textContent, 'Pistache réfléchit…');
  p.complete({ transcript: 'Un <petit> papillon', reply: 'Voici !' }); await p.flush();
  assert.equal(p.get('conversation').children[0].children[1].textContent, 'Un <petit> papillon');
  assert.equal(p.get('conversation').children[1].children[1].textContent, 'Voici !');
  assert.equal(p.body.classes.has('thinking'), false);
  assert.equal(p.get('talk').disabled, false);
  assert.equal(p.get('buttonLabel').textContent, 'Parler à Pistache');
});

test('empty recording and failed request both restore the next tap', async () => {
  for (const empty of [true, false]) {
    const p = page(); p.get('talk').handlers.click(); await p.flush();
    p.recorder().empty = empty; p.get('talk').handlers.click(); await p.flush();
    if (!empty) { p.reject(); await p.flush(); }
    assert.equal(p.body.dataset.voice, 'ready');
    assert.equal(p.body.classes.has('thinking'), false);
    assert.equal(p.get('talk').disabled, false);
    assert.equal(p.get('buttonLabel').textContent, 'Parler à Pistache');
  }
});

test('typed turn also puts Pistache in the thinking pose until the reply', async () => {
  const p = page(); p.get('message').value = 'Bonjour';
  const submitted = p.get('textForm').handlers.submit({ preventDefault() {} });
  assert.equal(p.body.classes.has('thinking'), true);
  assert.equal(p.get('talk').disabled, true);
  p.complete({ reply: 'Salut !' }); await submitted;
  assert.equal(p.body.classes.has('thinking'), false);
  assert.equal(p.get('talk').disabled, false);
});
