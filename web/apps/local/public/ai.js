export function mountAiUI({ root, request, element, busy, message }) {
  let generation = 0;
  const panel = element('section', 'panel');
  panel.append(element('h2', '', 'Use your local Codex subscription'), element('p', '', 'Sign in to ChatGPT for this LearnBridge installation. Then select specific notes or tasks in Agent & review and create a Codex sharing grant. Every request uses that selection; proposed changes await your review.'));
  const state = element('p', 'field-help'); state.id = 'ai-state';
  const connect = element('button', 'button primary', 'Sign in with ChatGPT'); connect.type = 'button';
  const check = element('button', 'button secondary', 'Check sign-in'); check.type = 'button';
  const disconnect = element('button', 'button secondary', 'Sign out of LearnBridge Codex'); disconnect.type = 'button';
  const link = element('a', 'button secondary', 'Continue official ChatGPT sign-in'); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.hidden = true;
  const note = element('p', 'field-help'); note.id = 'ai-message'; note.hidden = true;
  panel.append(state, connect, link, check, disconnect, note, element('p', 'field-help', 'Codex CLI 0.154.0 is required. Login and refresh are managed by the official CLI in a separate private profile. No API key or exported desktop token is used. Claude users can connect the four-tool MCP bridge in their Claude app; embedded Claude execution is not enabled.'));
  root.append(panel);
  const draw = value => { state.textContent = `${value.state.replaceAll('_', ' ')} · ${value.detail}`; };
  const run = (button, path) => busy(button, async () => { const current = generation; try { const value = await request(path, { method: 'POST', body: { confirmed: true } }); if (current !== generation) return; draw(value); if (value.auth_url) { const url = new URL(value.auth_url); if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new Error(); link.href = url.href; link.hidden = false; } else { link.hidden = true; link.removeAttribute('href'); } message('ai-message', value.login_in_progress ? 'Open the official sign-in link, complete sign-in, then check its status here.' : 'Status updated.'); } catch (error) { if (current === generation) message('ai-message', error.message, true); } });
  connect.addEventListener('click', () => run(connect, '/ai/connect'));
  check.addEventListener('click', () => run(check, '/ai/check'));
  disconnect.addEventListener('click', () => run(disconnect, '/ai/disconnect'));
  return { async refresh() { const current = generation; try { const value = await request('/ai/status'); if (current === generation) draw(value); } catch (error) { if (current === generation) message('ai-message', error.message, true); } }, reset() { generation++; state.textContent = ''; link.hidden = true; link.removeAttribute('href'); message('ai-message', ''); } };
}
