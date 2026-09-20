export class LatestBranchLoader {
  #generation = 0;

  invalidate() {
    this.#generation += 1;
  }

  async load(repository, loader) {
    const generation = ++this.#generation;
    try {
      const branches = await loader(repository);
      return { branches, error:null, stale:generation !== this.#generation };
    } catch (error) {
      return { branches:[], error, stale:generation !== this.#generation };
    }
  }
}
