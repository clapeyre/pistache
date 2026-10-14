(() => {
  const $ = id => document.getElementById(id);
  const stages = { validation: 'la validation du message', recording: 'la lecture de l’enregistrement', transcription: 'la transcription', reply: 'la réponse de Pi', speech: 'la préparation de la voix', delivery: 'la remise de la réponse' };
  const time = value => new Date(value * 1000).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const duration = ms => typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '—';
  let busy = false;
  let profileFiles = [], selectedProfile = null, dirty = false, metricVersion = 0;
  function node(tag, text, className) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; }
  function status(turn) { return turn.status === 'ok' ? 'Réponse prête' : turn.status === 'cancelled' ? 'Interrompu' : `Arrêt pendant ${stages[turn.stage] || 'l’échange'} (HTTP ${turn.http_status})`; }
  function render(data) {
    $('count').textContent = data.summary.turns; $('failed').textContent = data.summary.failed; $('average').textContent = duration(data.summary.average_ms);
    $('retention').textContent = `Le journal reste sur le serveur : ${data.retention_days} jours, jusqu’à ${data.max_turns} échanges. Aucun audio conservé. La page montre les ${data.shown_limit} échanges les plus récents.`;
    const sessions = $('sessions'); sessions.replaceChildren();
    const groups = new Map();
    for (const turn of data.turns) { if (!groups.has(turn.session_id)) groups.set(turn.session_id, []); groups.get(turn.session_id).push(turn); }
    if (!groups.size) sessions.append(node('p', 'Le journal est vide. La prochaine discussion apparaîtra ici.', 'empty'));
    for (const [id, turns] of groups) {
      const panel = node('article', undefined, 'session'); const head = node('div', undefined, 'session-head');
      const first = turns.at(-1); head.append(node('h2', `Discussion du ${time(first.started)}`));
      const remove = node('button', 'Effacer', 'danger'); remove.addEventListener('click', () => erase(`/api/parents/sessions/${encodeURIComponent(id)}`, 'Effacer cette discussion du journal ?')); head.append(remove); panel.append(head);
      for (const turn of [...turns].reverse()) {
        const entry = node('section', undefined, 'turn'); const top = node('div', undefined, 'turn-head');
        top.append(node('span', `${time(turn.started)} · ${turn.kind === 'voice' ? 'Vocal' : 'Écrit'}`), node('span', status(turn), `badge${turn.status === 'ok' ? '' : ' error'}`), node('span', duration(turn.total_ms))); entry.append(top);
        if (turn.message) entry.append(node('p', turn.kind === 'voice' ? 'Ce que la transcription a entendu' : 'Message', 'label'), node('p', turn.message, 'speech'));
        if (turn.reply) entry.append(node('p', 'Pistache', 'label'), node('p', turn.reply, 'speech'));
        if (turn.cards.length || turn.tools.length) { const details = node('details'); details.append(node('summary', 'Mots, calculs et outils')); for (const card of turn.cards) details.append(node('p', card.type === 'word' ? `Mot : ${card.word}` : `${card.a} ${card.operation} ${card.b} = ${card.result}`)); for (const tool of turn.tools) details.append(node('p', `${tool.name} · ${typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments || '')}`)); entry.append(details); }
        const timing = node('details'); timing.append(node('summary', 'Les étapes de cet échange')); for (const [label, key] of [['Transcription', 'transcription'], ['Pi', 'reply'], ['Voix', 'speech']]) timing.append(node('p', `${label} : ${duration(turn.timings_ms[key])}`)); entry.append(timing);
        panel.append(entry);
      }
      sessions.append(panel);
    }
    $('timings').replaceChildren();
    for (const turn of data.turns) { const row = node('tr'); for (const value of [time(turn.started), turn.kind === 'voice' ? 'Vocal' : 'Écrit', status(turn), duration(turn.timings_ms.transcription), duration(turn.timings_ms.reply), duration(turn.timings_ms.speech), duration(turn.total_ms)]) row.append(node('td', value)); $('timings').append(row); }
    $('models').replaceChildren(); for (const [label, key] of [['Chat', 'chat'], ['Transcription', 'transcription'], ['Voix', 'speech']]) $('models').append(node('span', `${label} · ${data.models[key]}`));
  }
  function lock(value) { busy = value; for (const button of document.querySelectorAll('button')) button.disabled = value; $('profile-file').disabled = value; $('profile-content').disabled = value; }
  async function load(automatic = false) {
    if (busy || document.hidden || (automatic === true && (!$('profile-panel').hidden || document.querySelector('details[open]') || window.scrollY > 80))) return;
    lock(true);
    try { const response = await fetch('/api/parents/activity', { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Ouvre cette page depuis ton accès privé à Pistache.' : 'Le journal n’est pas disponible pour le moment.'); const data = await response.json(); render(data); $('state').textContent = data.last_save_failed ? 'Le dernier échange n’a pas pu être enregistré. Vérifie le stockage du serveur.' : `Journal à jour · ${new Date().toLocaleTimeString('fr-FR')}`; }
    catch (error) { $('state').textContent = error.message; $('sessions').replaceChildren(); $('timings').replaceChildren(); $('models').replaceChildren(); for (const id of ['count', 'failed', 'average']) $(id).textContent = '—'; }
    finally { lock(false); updateProfileAccess(); }
    if (!$('health-panel').hidden) await loadMetrics();
  }
  async function erase(url, question) {
    if (busy || !confirm(question)) return;
    lock(true);
    try { const response = await fetch(url, { method: 'DELETE', cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error('Le journal n’a pas pu être effacé. Réessaie.'); }
    catch (error) { $('state').textContent = error.message; return; }
    finally { lock(false); }
    await load();
  }
  $('refresh').addEventListener('click', () => load());
  $('clear').addEventListener('click', () => erase('/api/parents/activity', 'Effacer tous les échanges du journal ?'));
  for (const kind of ['conversation', 'health', 'profile']) $(`${kind}-tab`).addEventListener('click', () => { for (const other of ['conversation', 'health', 'profile']) { $(`${other}-panel`).hidden = other !== kind; $(`${other}-tab`).setAttribute('aria-pressed', String(other === kind)); } if (kind === 'profile' && !profileFiles.length) loadProfiles(); if (kind === 'health') loadMetrics(); });

  const descriptions = { 'USER.md': 'Préférences et repères pour accompagner l’enfant.', 'SOUL.md': 'Le ton et la personnalité de Pistache.', 'SYSTEM.md': 'Les consignes de base de ce profil.', 'MEMORY.md': 'Des repères ajoutés par un adulte. Pistache ne les modifie pas tout seul.', 'profile.json': 'Un profil structuré au format JSON.' };
  function updateProfileAccess() { $('profile-save').disabled = busy || !selectedProfile?.editable || !dirty; }
  function showProfile(name) { selectedProfile = profileFiles.find(file => file.name === name); $('profile-file').value = name; $('profile-description').textContent = descriptions[name] || ''; $('profile-content').value = selectedProfile?.content || ''; $('profile-content').readOnly = !selectedProfile?.editable; dirty = false; $('profile-state').textContent = selectedProfile?.hidden ? 'Ce fichier contient une clé : son contenu reste masqué.' : !selectedProfile?.editable ? 'Lecture seule sur cette installation. L’édition peut être activée pour un profil local.' : selectedProfile.exists ? 'Les changements s’appliqueront à la prochaine réponse.' : 'Ce fichier n’existe pas encore. Enregistrer le créera.'; updateProfileAccess(); }
  async function loadProfiles() { if (busy || (dirty && !confirm('Relire les fichiers et abandonner les changements non enregistrés ?'))) return; lock(true); try { const response = await fetch('/api/parents/profile', { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error('Les fichiers ne sont pas disponibles pour le moment.'); const data = await response.json(); profileFiles = data.files; const previous = selectedProfile?.name || 'USER.md'; $('profile-file').replaceChildren(); for (const file of profileFiles) { const option = node('option', file.name); option.value = file.name; $('profile-file').append(option); } showProfile(previous); } catch (error) { $('profile-state').textContent = error.message; } finally { lock(false); updateProfileAccess(); } }
  $('profile-file').addEventListener('change', () => { if (dirty && !confirm('Changer de fichier et abandonner les changements non enregistrés ?')) { $('profile-file').value = selectedProfile.name; return; } showProfile($('profile-file').value); });
  $('profile-content').addEventListener('input', () => { dirty = true; updateProfileAccess(); });
  $('profile-reload').addEventListener('click', loadProfiles);
  $('profile-save').addEventListener('click', async () => { if (!selectedProfile?.editable || busy || !dirty) return; lock(true); try { const response = await fetch(`/api/parents/profile/${encodeURIComponent(selectedProfile.name)}`, { method: 'PUT', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: $('profile-content').value, revision: selectedProfile.revision }) }); if (!response.ok) throw new Error(response.status === 409 ? 'Le fichier a changé ailleurs. Ton brouillon reste ici ; copie-le avant de relire les fichiers.' : 'Enregistrement impossible. Vérifie la taille, le format et les permissions du profil.'); profileFiles = (await response.json()).files; showProfile(selectedProfile.name); $('profile-state').textContent = 'Enregistré. Pi utilisera ce profil à la prochaine réponse.'; } catch (error) { $('profile-state').textContent = error.message; } finally { lock(false); updateProfileAccess(); } });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

  function svgNode(tag, attributes, text) { const element = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value)); if (text !== undefined) element.textContent = text; return element; }
  function chart(id, buckets, series, bars, format) {
    const svg = svgNode('svg', { viewBox: '0 0 420 190', role: 'img', 'aria-label': $(id).parentElement.querySelector('h3').textContent });
    const max = Math.max(0.000001, ...buckets.flatMap(bucket => series.map(item => bucket[item.key] || 0)));
    const x = index => 42 + (index + 0.5) * 355 / buckets.length, y = value => 152 - value / max * 118;
    svg.append(svgNode('path', { d: 'M42 30V152H400', stroke: '#dce6d9', fill: 'none' }), svgNode('text', { x: 2, y: 33 }, format(max)), svgNode('text', { x: 22, y: 156 }, '0'));
    for (const item of series) { let points = []; const flush = () => { if (points.length) svg.append(svgNode('polyline', { points: points.join(' '), fill: 'none', stroke: item.color, 'stroke-width': 2 })); points = []; }; for (let i = 0; i < buckets.length; i++) { const value = buckets[i][item.key]; if (value === null || value === undefined) { flush(); continue; } const point = bars ? svgNode('rect', { x: x(i)-Math.max(1, 250/buckets.length/2), y: y(value), width: Math.max(2, 250/buckets.length), height: Math.max(0, 152-y(value)), fill: item.color, tabindex: 0 }) : svgNode('circle', { cx: x(i), cy: y(value), r: 3, fill: item.color, tabindex: 0 }); point.append(svgNode('title', {}, `${time(buckets[i].started)} · ${format(value)}`)); svg.append(point); points.push(`${x(i)},${y(value)}`); } if (!bars) flush(); }
    const date = value => new Date(value*1000).toLocaleString('fr-FR', $('period').value === '24h' ? { hour: '2-digit' } : { day: 'numeric', month: 'short' });
    svg.append(svgNode('text', { x: 42, y: 177 }, date(buckets[0].started)), svgNode('text', { x: 398, y: 177, 'text-anchor': 'end' }, date(buckets.at(-1).started)));
    $(id).replaceChildren(svg);
  }
  async function loadMetrics() { const version = ++metricVersion; try { const response = await fetch(`/api/parents/metrics?period=${$('period').value}`, { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error('Les graphiques ne sont pas disponibles pour le moment.'); const data = await response.json(); if (version !== metricVersion) return; const buckets = data.buckets; chart('count-chart', buckets, [{ key: 'count', color: '#426951' }], true, n => `${Math.round(n)}`); chart('latency-chart', buckets, [{ key: 'average_ms', color: '#426951' }, { key: 'p95_ms', color: '#b77735' }], false, duration); chart('cost-chart', buckets, [{ key: 'cost_usd', color: '#426951' }], true, n => `$${n.toFixed(4)}`); const count = buckets.reduce((sum, b) => sum+b.count, 0), known = buckets.reduce((sum, b) => sum+b.cost_known_turns, 0); $('chart-state').textContent = `${count} échanges dans le journal pour cette période · coût chat reçu pour ${known}/${count}. Les graphiques utilisent tous les échanges encore conservés, pas seulement les 200 affichés.`; $('metric-rows').replaceChildren(); for (const b of buckets) { const row = node('tr'); for (const value of [time(b.started), b.count, b.failed, duration(b.average_ms), duration(b.p95_ms), b.cost_usd === null ? 'Indisponible' : `$${b.cost_usd.toFixed(4)}`, `${b.cost_known_turns}/${b.count}`]) row.append(node('td', value)); $('metric-rows').append(row); } } catch (error) { if (version === metricVersion) { $('chart-state').textContent = error.message; for (const id of ['count-chart', 'latency-chart', 'cost-chart', 'metric-rows']) $(id).replaceChildren(); } } }
  $('period').addEventListener('change', loadMetrics);
  setInterval(() => load(true), 15000); document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); }); load();
})();
