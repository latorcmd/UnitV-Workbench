const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function basename(path) {
  const value = String(path || '');
  return value.slice(value.lastIndexOf('/') + 1);
}

export function parentPath(path) {
  const value = String(path || '');
  const slash = value.lastIndexOf('/');
  return slash < 0 ? '' : value.slice(0, slash);
}

export function joinPath(parent, child) {
  return parent ? `${parent}/${child}` : child;
}

/** Build the visible explorer rows in depth-first order. */
export function flattenProjectTree(entries, expandedFolders = new Set()) {
  const root = { type:'root', path:'', children:new Map() };
  const folders = new Map([['', root]]);

  const ensureFolder = path => {
    if (folders.has(path)) return folders.get(path);
    const parent = ensureFolder(parentPath(path));
    const node = { type:'folder', path, file:null, children:new Map() };
    parent.children.set(basename(path), node);
    folders.set(path, node);
    return node;
  };

  for (const entry of entries.filter(item => !item.deleted)) {
    const directory = parentPath(entry.path);
    ensureFolder(directory);
    if (entry.kind === 'folder') {
      ensureFolder(entry.path).file = entry;
    } else {
      folders.get(directory).children.set(basename(entry.path), { type:'file', path:entry.path, file:entry });
    }
  }

  const rows = [];
  const visit = (folder, depth) => {
    const children = [...folder.children.values()].sort((left, right) => {
      if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
      return collator.compare(basename(left.path), basename(right.path));
    });
    for (const child of children) {
      rows.push({ ...child, depth });
      if (child.type === 'folder' && expandedFolders.has(child.path)) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

export function nextAvailablePath(existingPaths, requested) {
  const used = existingPaths instanceof Set ? existingPaths : new Set(existingPaths);
  if (!used.has(requested)) return requested;
  const directory = parentPath(requested);
  const filename = basename(requested);
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  let number = 2;
  while (used.has(joinPath(directory, `${stem}-${number}${extension}`))) number += 1;
  return joinPath(directory, `${stem}-${number}${extension}`);
}

/**
 * Calculate an atomic file/folder move. Throws when the move is recursive or
 * collides with another entry. Implicit folders are supported.
 */
export function planEntryMove(entries, sourcePath, targetFolder) {
  const visible = entries.filter(entry => !entry.deleted);
  const exact = visible.find(entry => entry.path === sourcePath);
  const descendants = visible.filter(entry => entry.path.startsWith(`${sourcePath}/`));
  const isFolder = exact?.kind === 'folder' || descendants.length > 0;
  if (!exact && !isFolder) throw new Error('移動するファイルまたはフォルダが見つかりません。');
  if (isFolder && (targetFolder === sourcePath || targetFolder.startsWith(`${sourcePath}/`))) {
    throw new Error('フォルダを自分自身または子フォルダの中へ移動できません。');
  }
  const destination = joinPath(targetFolder, basename(sourcePath));
  if (destination === sourcePath) return { destination, changes:[], isFolder };
  const affected = visible.filter(entry => entry.path === sourcePath || entry.path.startsWith(`${sourcePath}/`));
  const affectedIds = new Set(affected.map(entry => entry.id));
  const changes = affected.map(entry => ({ entry, path:`${destination}${entry.path.slice(sourcePath.length)}` }));
  const occupied = new Set();
  visible.filter(entry => !affectedIds.has(entry.id)).forEach(entry => {
    occupied.add(entry.path);
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index += 1) occupied.add(parts.slice(0, index).join('/'));
  });
  if (isFolder && occupied.has(destination)) throw new Error('移動先に同じ名前のファイルまたはフォルダがあります。');
  if (changes.some(change => occupied.has(change.path))) throw new Error('移動先に同じ名前のファイルまたはフォルダがあります。');
  return { destination, changes, isFolder };
}

export function remapExpandedFolders(expandedFolders, sourcePath, destination) {
  const next = new Set();
  for (const path of expandedFolders) {
    next.add(path === sourcePath || path.startsWith(`${sourcePath}/`)
      ? `${destination}${path.slice(sourcePath.length)}`
      : path);
  }
  return next;
}
