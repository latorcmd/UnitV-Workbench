/**
 * Load every entry in a Git tree.
 *
 * GitHub may truncate a recursive tree response for very large repositories.
 * In that case, fetch each tree without recursion and walk its children so no
 * files silently disappear from a clone or historical-version view.
 */
export async function loadCompleteGitTree({
  rootSha,
  getTree,
  onProgress = () => {},
  concurrency = 6
}) {
  if (!rootSha) throw new Error('GitツリーのSHAがありません。');
  if (typeof getTree !== 'function') throw new TypeError('getTree is required');

  const recursive = await getTree(rootSha, true);
  const recursiveEntries = Array.isArray(recursive?.tree) ? recursive.tree : [];
  if (!recursive?.truncated) {
    onProgress({ mode:'recursive', entries:recursiveEntries.length, trees:1, pendingTrees:0 });
    return recursiveEntries;
  }

  const limit = Math.max(1, Math.min(12, Number(concurrency) || 6));
  const pending = [{ sha:rootSha, prefix:'' }];
  const entries = [];
  let trees = 0;

  while (pending.length) {
    const batch = pending.splice(0, limit);
    const responses = await Promise.all(batch.map(item => getTree(item.sha, false)));
    responses.forEach((response, index) => {
      const parent = batch[index];
      const children = Array.isArray(response?.tree) ? response.tree : [];
      trees += 1;
      children.forEach(child => {
        const path = parent.prefix ? `${parent.prefix}/${child.path}` : child.path;
        const entry = { ...child, path };
        entries.push(entry);
        if (child.type === 'tree') pending.push({ sha:child.sha, prefix:path });
      });
    });
    onProgress({ mode:'walk', entries:entries.length, trees, pendingTrees:pending.length });
  }

  return entries;
}
