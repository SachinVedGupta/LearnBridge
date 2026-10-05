/** Read-only entry points; each destination still owns its exact review and consent. */
export function mountOverviewUI({ root, request, element, navigate }) {
  let generation = 0, refreshId = 0;
  const destinations = [
    { path: '/focus/context', title: 'Focus', page: 'focus', describe: data => data.open_session ? `${data.open_session.data.title} · ${data.open_session.data.state}` : 'No open timer. Choose a next step when you are ready.' },
    { path: '/reminders/inbox', title: 'Reminders', page: 'reminders', describe: data => `${data.items.filter(row => row.acknowledged_at === null).length} unread local reminders` },
    { path: '/practice/due', title: 'Practice', page: 'practice', describe: data => `${data.total_due} cards due for your own review${data.unavailable?.length ? ' · some selected sources need review' : ''}` },
    { path: '/task-proposals', title: 'Task reviews', page: 'agents', describe: data => `${data.items.filter(row => row.state === 'awaiting_review').length} AI task proposals awaiting your decision` },
    { path: '/writing/items', title: 'Writing reviews', page: 'writing', describe: data => `${data.items.filter(row => ['awaiting_review', 'needs_reconciliation'].includes(row.state)).length} drafts awaiting review or reconciliation` },
  ];
  function reset() { generation++; refreshId++; root.replaceChildren(); }
  async function refresh() {
    const currentGeneration = generation, currentRefresh = ++refreshId;
    const results = await Promise.allSettled(destinations.map(item => request(item.path)));
    if (generation !== currentGeneration || refreshId !== currentRefresh) return;
    root.replaceChildren();
    for (let index = 0; index < destinations.length; index++) {
      const entry = destinations[index], result = results[index], card = element('section', 'panel small-panel');
      card.append(element('h2', '', entry.title));
      let summary = 'Could not check this part of your workspace. Open it to refresh.';
      if (result.status === 'fulfilled') { try { summary = entry.describe(result.value); } catch { /* Missing data stays unknown, never zero. */ } }
      card.append(element('p', 'field-help', summary));
      const button = element('button', 'button secondary compact', `Open ${entry.title.toLowerCase()}`); button.type = 'button';
      button.addEventListener('click', () => { if (generation === currentGeneration) navigate(entry.page); }); card.append(button); root.append(card);
    }
  }
  return { refresh, reset };
}
