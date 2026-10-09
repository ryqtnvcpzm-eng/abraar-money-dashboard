// The recovery key card: shows the key with Copy / Save / Share, used after sign-up and in Settings.
import { esc } from '../format.js';
import { icon, haptic, toast } from '../ui.js';

export function recoveryCardHTML(code) {
  return `
    <div class="recovery-code" aria-label="Recovery key">${esc(code).split('-').map((g) => `<span>${g}</span>`).join('')}</div>
    <div class="btn-row recovery-actions">
      <button class="btn secondary" type="button" data-rk="copy">${icon('doc')} Copy</button>
      <button class="btn secondary" type="button" data-rk="save">${icon('upload')} Save File</button>
      ${navigator.share ? `<button class="btn secondary" type="button" data-rk="share">${icon('share')} Share</button>` : ''}
    </div>`;
}

/** Wire the card's buttons. Calls onSaved() the first time the key is copied, saved or shared. */
export function wireRecoveryCard(root, code, username, onSaved) {
  const text = `Money recovery key for @${username}\n\n${code}\n\nUse it at ${location.origin}${location.pathname} if you forget your passphrase. Keep it private.`;
  const saved = () => { haptic(); onSaved?.(); };
  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-rk]')?.dataset.rk;
    if (!act) return;
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(code); toast('Recovery key copied', { icon: 'check', color: 'green' }); saved(); } catch { toast('Couldn’t copy. Write it down instead.', { icon: 'warn', color: 'orange' }); }
    }
    if (act === 'save') {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `money-recovery-${username}.txt` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      saved();
    }
    if (act === 'share') {
      try { await navigator.share({ title: 'Money recovery key', text }); saved(); } catch { /* cancelled */ }
    }
  });
}
