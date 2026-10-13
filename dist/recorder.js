'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const record = $('record'), cancel = $('cancel'), status = $('record-status');
  const clips = new Map(), urls = new Set();
  let db, stream, recorder, chunks = [], started = 0, clock, limit, state = 'idle', generation = 0;
  let saving = Promise.resolve(), discard = false, supported = false;
  const format = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  function controls(next) {
    state = next;
    record.disabled = !db || !supported || !['idle', 'recording'].includes(next);
    record.textContent = next === 'recording' ? 'Terminer et conserver' : next === 'opening' ? 'Autorise le microphone…' : next === 'saving' ? 'Sauvegarde…' : 'Commencer';
    record.setAttribute('aria-pressed', String(next === 'recording'));
    cancel.hidden = !['recording', 'opening'].includes(next);
    $('prompt').disabled = next !== 'idle';
    $('export').disabled = next !== 'idle' || clips.size === 0;
  }
  function release() {
    clearInterval(clock); clearTimeout(limit);
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('clips', mode), request = action(tx.objectStore('clips'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Storage failed'));
    });
  }
  function persist(clip) {
    // Serialize edits so an older transcript can never overwrite a newer one.
    const snapshot = {...clip}; delete snapshot.saved;
    const task = saving.catch(() => {}).then(() => transaction('readwrite', store => store.put(snapshot)));
    saving = task;
    return task;
  }
  function objectURL(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function render() {
    const root = $('clips'); root.replaceChildren();
    // Stop playback and release URLs from the previous library rendering.
    urls.forEach(url => URL.revokeObjectURL(url)); urls.clear();
    if (!clips.size) { root.textContent = 'Aucune phrase pour le moment.'; return; }
    [...clips.values()].sort((a,b) => b.created_at.localeCompare(a.created_at)).forEach(clip => {
      const card = document.createElement('article'); card.className = 'clip';
      const title = document.createElement('h3'); title.textContent = `${new Date(clip.created_at).toLocaleString('fr-FR')} · ${format(Math.round(clip.duration_seconds))}`;
      const context = document.createElement('p'); context.textContent = clip.prompt ? `Phrase proposée / contexte : ${clip.prompt}` : 'Phrase libre';
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = objectURL(clip.audio);
      const label = document.createElement('label'); label.htmlFor = `text-${clip.id}`; label.textContent = 'Transcription manuelle (ce qui a vraiment été dit)';
      const text = document.createElement('textarea'); text.id = label.htmlFor; text.rows = 3; text.value = clip.transcript;
      const note = document.createElement('p'); note.className = 'save-status'; note.setAttribute('role', 'status');
      note.textContent = clip.saved ? 'Sauvegardé sur cet appareil.' : 'Sauvegarde impossible. Télécharge le clip ou réessaie avant de quitter.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Réessayer la sauvegarde'; retry.hidden = clip.saved;
      let revision = 0;
      async function save() {
        const current = ++revision;
        clip.saved = false;
        note.textContent = 'Sauvegarde…';
        try { await persist(clip); if (current !== revision) return; clip.saved = true; note.textContent = 'Sauvegardé sur cet appareil.'; retry.hidden = true; }
        catch { if (current !== revision) return; clip.saved = false; note.textContent = 'Sauvegarde impossible. Exporte avant de quitter.'; retry.hidden = false; }
      }
      text.addEventListener('input', () => { clip.transcript = text.value; save(); });
      retry.addEventListener('click', save);
      const actions = document.createElement('div'); actions.className = 'clip-actions';
      const link = document.createElement('a'); link.className = 'download'; link.href = audio.src; link.download = clip.filename; link.textContent = 'Télécharger l’audio';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete'; remove.textContent = 'Supprimer';
      remove.addEventListener('click', async () => {
        if (!window.confirm('Supprimer cet enregistrement et sa transcription de cet appareil ?')) return;
        remove.disabled = true; text.disabled = true; retry.disabled = true;
        try { await saving.catch(() => {}); await transaction('readwrite', store => store.delete(clip.id)); clips.delete(clip.id); render(); controls(state); }
        catch { note.textContent = 'Suppression impossible. Réessaie.'; remove.disabled = false; text.disabled = false; retry.disabled = false; }
      });
      actions.append(link, retry, remove); card.append(title, context, audio, label, text, note, actions); root.append(card);
    });
  }
  async function start() {
    const attempt = ++generation; controls('opening'); status.textContent = 'Ouverture du microphone…';
    document.querySelectorAll('audio').forEach(audio => audio.pause());
    let acquired;
    try {
      // Use the same capture processing as the conversation page for comparable benchmarks.
      acquired = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
      if (attempt !== generation || document.hidden) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      const captureSettings = stream.getAudioTracks?.()[0]?.getSettings?.() || {};
      const mime = ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = mime ? new MediaRecorder(stream, {mimeType:mime}) : new MediaRecorder(stream);
      chunks = []; discard = false;
      const context = $('prompt').value.trim(), created = new Date().toISOString();
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { discard = true; stop(); status.textContent = 'Le microphone a été interrompu. Réessaie.'; };
      recorder.onstop = async () => {
        const duration = (performance.now() - started) / 1000;
        const type = recorder.mimeType || chunks[0]?.type || 'application/octet-stream';
        const blob = new Blob(chunks, {type}); chunks = []; release();
        if (discard || !blob.size) { controls('idle'); status.textContent = discard ? 'Enregistrement annulé.' : 'Aucun audio reçu. Réessaie.'; return; }
        controls('saving');
        const id = crypto.randomUUID(), extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('webm') ? 'webm' : 'bin';
        const clip = {id, created_at:created, duration_seconds:duration, mime_type:type, capture_settings:captureSettings, filename:`pistache-${created.replace(/[:.]/g,'-')}-${id.slice(0,8)}.${extension}`, prompt:context, transcript:'', audio:blob, saved:false};
        clips.set(id, clip);
        try { await persist(clip); clip.saved = true; status.textContent = 'Phrase conservée. Tu peux l’écouter et la transcrire.'; }
        catch { status.textContent = 'Le stockage est indisponible ou plein. Exporte ce clip avant de quitter.'; }
        render(); controls('idle');
      };
      recorder.start(1000); started = performance.now(); controls('recording'); $('timer').textContent = '00:00';
      status.textContent = 'Tu peux parler. Touche Terminer quand il a fini.';
      clock = setInterval(() => { $('timer').textContent = format(Math.floor((performance.now() - started) / 1000)); }, 250);
      limit = setTimeout(stop, 300000);
    } catch (error) {
      acquired?.getTracks().forEach(track => track.stop());
      if (attempt !== generation) return;
      release(); controls('idle');
      status.textContent = error.name === 'NotAllowedError' ? 'Autorise le microphone dans Safari ou les réglages du navigateur, puis réessaie.' : 'Microphone indisponible. Ferme les autres applications qui l’utilisent et réessaie.';
    }
  }
  function stop() {
    clearInterval(clock); clearTimeout(limit);
    if (recorder && recorder.state !== 'inactive') { controls('saving'); recorder.stop(); }
  }
  record.addEventListener('click', () => state === 'recording' ? stop() : state === 'idle' ? start() : undefined);
  cancel.addEventListener('click', () => {
    discard = true; ++generation;
    if (state === 'opening') { release(); controls('idle'); status.textContent = 'Enregistrement annulé.'; }
    else stop();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (state === 'recording') stop(); // Keep an interrupted clip rather than losing Pistache's sentence.
    if (state === 'opening') { ++generation; release(); controls('idle'); status.textContent = 'Ouverture du microphone annulée. Réessaie.'; }
  });
  window.addEventListener('beforeunload', event => {
    if (state !== 'idle' || [...clips.values()].some(clip => !clip.saved)) { event.preventDefault(); event.returnValue = ''; }
  });
  // Uncompressed ZIP preserves the original microphone bytes without a library or upload.
  async function zip(entries) {
    const encoder = new TextEncoder(), parts = [], central = []; let offset = 0;
    const table = new Uint32Array(256);
    for (let n=0;n<256;n++) { let c=n; for(let j=0;j<8;j++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; table[n]=c>>>0; }
    for (const entry of entries) {
      const bytes = new Uint8Array(await entry.blob.arrayBuffer()), name = encoder.encode(entry.name);
      let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc^byte)&255]^(crc>>>8); crc=(crc^0xffffffff)>>>0;
      const local = new Uint8Array(30 + name.length), view = new DataView(local.buffer);
      view.setUint32(0,0x04034b50,true); view.setUint16(4,20,true); view.setUint16(6,0x800,true); view.setUint16(12,33,true);
      view.setUint32(14,crc,true); view.setUint32(18,bytes.length,true); view.setUint32(22,bytes.length,true); view.setUint16(26,name.length,true); local.set(name,30);
      const dir = new Uint8Array(46 + name.length), dv = new DataView(dir.buffer);
      dv.setUint32(0,0x02014b50,true); dv.setUint16(4,20,true); dv.setUint16(6,20,true); dv.setUint16(8,0x800,true); dv.setUint16(14,33,true);
      dv.setUint32(16,crc,true); dv.setUint32(20,bytes.length,true); dv.setUint32(24,bytes.length,true); dv.setUint16(28,name.length,true); dv.setUint32(42,offset,true); dir.set(name,46);
      parts.push(local, bytes); central.push(dir); offset += local.length + bytes.length;
    }
    const size = central.reduce((sum,dir)=>sum+dir.length,0), end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0,0x06054b50,true); ev.setUint16(8,entries.length,true); ev.setUint16(10,entries.length,true); ev.setUint32(12,size,true); ev.setUint32(16,offset,true);
    return new Blob([...parts,...central,end],{type:'application/zip'});
  }
  $('export').addEventListener('click', async () => {
    controls('exporting'); status.textContent = 'Préparation de l’export…';
    try {
      await saving.catch(() => {});
      const snapshot = [...clips.values()].map(clip => ({...clip}));
      const metadata = {schema_version:1, language:'fr', exported_at:new Date().toISOString(), clips:snapshot.map(({audio,saved,...fields}) => fields)};
      const entries = [{name:'transcriptions.json',blob:new Blob([JSON.stringify(metadata,null,2)],{type:'application/json'})}, ...snapshot.map(clip=>({name:clip.filename,blob:clip.audio}))];
      download(await zip(entries), `pistache-phrases-${new Date().toISOString().slice(0,10)}.zip`);
      status.textContent = 'Export prêt. Conserve le fichier ZIP dans Fichiers ou Téléchargements.';
    } catch { status.textContent = 'Export impossible. Télécharge les audios individuellement et réessaie.'; }
    controls('idle');
  });
  async function init() {
    supported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
    try {
      db = await new Promise((resolve,reject) => {
        const request = indexedDB.open('pistache-benchmark-recordings',1);
        request.onupgradeneeded = () => request.result.createObjectStore('clips',{keyPath:'id'});
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      db.onversionchange = () => { db.close(); db = null; controls(state); status.textContent = 'Ferme puis rouvre cette page pour continuer.'; };
      (await transaction('readonly', store=>store.getAll())).forEach(clip => clips.set(clip.id,{...clip,saved:true}));
      render(); controls('idle');
      status.textContent = supported ? 'Prêt pour une nouvelle phrase.' : 'Ce navigateur ne permet pas l’enregistrement. Ouvre cette page en HTTPS dans Safari ou un navigateur récent.';
    } catch { controls('idle'); status.textContent = 'Le stockage local est indisponible. Ouvre la page dans un navigateur autorisant les données locales.'; }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
  }
  init();
})();
