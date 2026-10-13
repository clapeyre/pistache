(() => {
  const status = document.getElementById('setup-status');
  document.getElementById('check').addEventListener('click', async () => {
    status.textContent = 'Je vérifie…'; status.classList.remove('bad');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Vérifie la connexion et le lien vers Pistache.');
      const body = await response.json();
      if (body.status !== 'ok') throw new Error('Pistache ne répond pas. Réessaie dans un instant.');
      status.textContent = 'Pistache répond !';
    } catch (error) {
      status.textContent = error.name === 'AbortError' ? 'Pistache ne répond pas. Vérifie la connexion et réessaie.' : error.message;
      status.classList.add('bad');
    } finally { clearTimeout(timer); }
  });
})();
