(() => {
  const $ = id => document.getElementById(id);
  const stages = { validation: 'la validation du message', recording: 'la lecture de l’enregistrement', transcription: 'la transcription', reply: 'la réponse de Pi', speech: 'la préparation de la voix', delivery: 'la remise de la réponse' };
  const time = value => new Date(value * 1000).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const duration = ms => typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '—';
  let busy = false;
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
  function lock(value) { busy = value; for (const button of document.querySelectorAll('button')) button.disabled = value; }
  async function load(automatic = false) {
    if (busy || document.hidden || (automatic === true && (document.querySelector('details[open]') || window.scrollY > 80))) return;
    lock(true);
    try { const response = await fetch('/api/parents/activity', { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Ouvre cette page depuis ton accès privé à Pistache.' : 'Le journal n’est pas disponible pour le moment.'); const data = await response.json(); render(data); $('state').textContent = data.last_save_failed ? 'Le dernier échange n’a pas pu être enregistré. Vérifie le stockage du serveur.' : `Journal à jour · ${new Date().toLocaleTimeString('fr-FR')}`; }
    catch (error) { $('state').textContent = error.message; $('sessions').replaceChildren(); $('timings').replaceChildren(); $('models').replaceChildren(); for (const id of ['count', 'failed', 'average']) $(id).textContent = '—'; }
    finally { lock(false); }
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
  for (const [id, health] of [['conversation-tab', false], ['health-tab', true]]) $(id).addEventListener('click', () => { $('conversation-panel').hidden = health; $('health-panel').hidden = !health; $('conversation-tab').setAttribute('aria-pressed', String(!health)); $('health-tab').setAttribute('aria-pressed', String(health)); });
  setInterval(() => load(true), 15000); document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); }); load();
})();
