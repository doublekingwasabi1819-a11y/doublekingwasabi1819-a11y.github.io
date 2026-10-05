// The account display name is authoritative. Never label a worker as the manager.
export function workspaceBrand(user, mode = 'live', manager = null) {
  const name = user?.role === 'manager' && typeof user.name === 'string' && user.name.trim()
    ? user.name.trim()
    : typeof manager?.name === 'string' && manager.name.trim() ? manager.name.trim() : mode === 'demo' ? 'Example manager' : 'Manager';
  const initial = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(name)][0].segment
    : Array.from(name)[0];
  return {name, initial: initial.toLocaleUpperCase()};
}

export function renderWorkspaceBrand(root, user, mode, manager) {
  const {name, initial} = workspaceBrand(user, mode, manager);
  const label = root.querySelector('#project-name');
  const mark = root.querySelector('#project-initial');
  label.textContent = name;
  label.title = name;
  mark.textContent = initial;
}
