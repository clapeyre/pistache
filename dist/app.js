(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('textForm'), input = $('message'), send = $('send'), talk = $('talk');
  const state = { recorder: null, stream: null, chunks: [], session: sessionStorage.getItem('pistache_demo_session') || crypto.randomUUID(), busy: false, audioUrl: null };
  sessionStorage.setItem('pistache_demo_session', state.session);

  function addBubble(who, value) {
    const row = document.createElement('p'); row.className = `bubble ${who}`;
    const label = document.createElement('strong'); label.textContent = who === 'child' ? 'Toi' : 'Pistache';
    const body = document.createElement('span'); body.textContent = value;
    row.append(label, body); $('conversation').append(row); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function renderCards(cards) {
    const root = $('cards'); root.replaceChildren();
    for (const card of Array.isArray(cards) ? cards.slice(0, 8) : []) {
      const panel = document.createElement('article'); panel.className = 'play-card';
      const title = document.createElement('h2');
      const content = document.createElement('p');
      if (card?.type === 'word' && typeof card.word === 'string') {
        title.textContent = 'Un mot à explorer'; content.textContent = `${card.word} · ${(Array.isArray(card.letters) ? card.letters : []).join(' · ')}`;
      } else if (card?.type === 'math') {
        title.textContent = 'Petit défi'; content.textContent = `${card.a} ${card.operation} ${card.b} = ${card.result}`;
      } else continue;
      panel.append(title, content); root.append(panel);
    }
  }
  function renderTools(items) {
    const root = $('tools'), list = $('tool-list'); list.replaceChildren();
    const safe = Array.isArray(items) ? items.slice(0, 8) : [];
    if (!safe.length) { root.hidden = true; return; }
    const title = document.createElement('strong'); title.textContent = 'Outils utilisés'; list.append(title);
    for (const item of safe) {
      if (!item || typeof item !== 'object') continue;
      const line = document.createElement('p');
      const name = document.createElement('span'); name.textContent = String(item.name || 'outil').slice(0, 80);
      const values = Object.entries(item).filter(([key]) => key !== 'name').map(([key, value]) => `${key}: ${String(value).slice(0, 120)}`).join(' · ');
      const detail = document.createElement('span'); detail.textContent = values;
      line.append(name, detail); list.append(line);
    }
    root.hidden = false;
  }
  function setBusy(value) { state.busy = value; send.disabled = value; input.disabled = value; talk.disabled = value && document.body.dataset.voice !== 'listening'; }
  async function requestTurn(path, payload) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(payload) });
    if (!response.ok) {
      if (response.status === 503) throw new Error('Pistache est occupée. Réessaie dans un instant.');
      if (response.status === 401 || response.status === 403) throw new Error('Pistache ne peut pas traiter la requête.');
      throw new Error(`Le serveur a répondu ${response.status}.`);
    }
    return response.json();
  }
  function showReply(result) {
    addBubble('pistache', result.reply || 'Je n’ai pas trouvé les mots.');
    renderCards(result.cards); renderTools(result.toolCalls);
    $('statusText').textContent = 'Pistache a une idée pour toi !';
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); const text = input.value.trim(); if (text.length < 2 || state.busy) return;
    addBubble('child', text); input.value = ''; setBusy(true); $('voiceStatus').textContent = 'Pistache réfléchit…';
    try { showReply(await requestTurn('/api/text-turn', { text, session_id: state.session })); $('voiceStatus').textContent = 'À toi de jouer !'; }
    catch (error) { addBubble('pistache', error.message || 'Pistache ne répond pas.'); $('voiceStatus').textContent = 'Réessaie quand tu veux.'; }
    finally { setBusy(false); input.focus(); }
  });
  function mimeType() { return ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type)) || ''; }
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { $('voiceStatus').textContent = 'Le micro n’est pas disponible ici. Essaie le message écrit.'; return; }
    document.body.dataset.voice = 'starting'; setBusy(true); talk.disabled = true; $('voiceStatus').textContent = 'Préparation du micro…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      state.stream = stream; state.chunks = [];
      const type = mimeType(); state.recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      state.recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) state.chunks.push(event.data); });
      state.recorder.addEventListener('stop', () => { const clip = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' }); stream.getTracks().forEach((track) => track.stop()); state.stream = null; if (clip.size) sendVoice(clip); });
      state.recorder.start(250); document.body.dataset.voice = 'listening'; talk.disabled = false; talk.classList.add('listening'); talk.setAttribute('aria-pressed', 'true'); $('buttonLabel').textContent = 'Terminer'; $('voiceStatus').textContent = 'Je t’écoute…'; $('hint').textContent = 'Prends ton temps. Touche Terminer quand tu as fini.';
    } catch (error) { document.body.dataset.voice = 'ready'; setBusy(false); $('voiceStatus').textContent = error?.name === 'NotAllowedError' ? 'Demande à un adulte d’autoriser le micro.' : 'Impossible d’ouvrir le micro. Réessaie.'; }
  }
  async function sendVoice(clip) {
    const data = new FormData(); data.append('audio', clip, clip.type.includes('mp4') ? 'clip.m4a' : 'clip.webm'); data.append('session_id', state.session);
    addBubble('child', '🎙️ Message vocal'); setBusy(true); document.body.dataset.voice = 'thinking'; $('voiceStatus').textContent = 'Pistache écoute…';
    try {
      const response = await fetch('/api/voice', { method: 'POST', body: data, credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`Le serveur a répondu ${response.status}.`);
      const result = await response.json(); showReply(result);
      if (result.audio_base64) { const raw = atob(result.audio_base64); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); state.audioUrl = URL.createObjectURL(new Blob([bytes], { type: result.audio_mime || 'audio/mpeg' })); $('audio').src = state.audioUrl; $('audio').hidden = false; $('replay').hidden = false; $('audio').play().catch(() => { $('voiceStatus').textContent = 'Pistache a une réponse. Appuie sur Écouter.'; }); }
      $('voiceStatus').textContent = 'À toi de jouer !';
    } catch (error) { addBubble('pistache', error.message || 'La réponse vocale est momentanément indisponible.'); $('voiceStatus').textContent = 'Réessaie quand tu veux.'; }
    finally { document.body.dataset.voice = 'ready'; talk.classList.remove('listening'); talk.setAttribute('aria-pressed', 'false'); $('buttonLabel').textContent = 'Je parle'; $('hint').textContent = 'Touche pour commencer, puis touche pour terminer.'; setBusy(false); }
  }
  talk.addEventListener('click', () => {
    if (state.busy && document.body.dataset.voice !== 'listening') return;
    if (document.body.dataset.voice === 'listening') { state.recorder.stop(); document.body.dataset.voice = 'thinking'; talk.disabled = true; talk.classList.remove('listening'); talk.setAttribute('aria-pressed', 'false'); $('buttonLabel').textContent = 'Je parle'; $('voiceStatus').textContent = 'Merci, Pistache réfléchit…'; return; }
    if (['starting', 'thinking'].includes(document.body.dataset.voice)) return;
    startRecording();
  });
  $('replay').addEventListener('click', () => $('audio').play());
  $('audio').addEventListener('ended', () => { $('voiceStatus').textContent = 'À toi de jouer !'; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js?rev=pistache-pi-demo-20261013').catch(() => {});
  }
})();
