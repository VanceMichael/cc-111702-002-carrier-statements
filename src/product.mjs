import { readFile } from 'node:fs/promises';
import { Store } from './store.mjs';
import { Source } from './source.mjs';
import { prepare } from './fees.mjs';
import { collectMonth } from './collection.mjs';
import { present } from './periods.mjs';
export async function createProduct({ sourceUrl, statePath = null, now }) {
  const config = JSON.parse(await readFile(new URL('./domain.json', import.meta.url), 'utf8'));
  const store = new Store(config.initial, statePath); await store.open();
  const source = new Source(sourceUrl, config.routes.statement);
  const clock = now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async collect(input) {
      return store.update(async state => { const request = prepare(state, input); await collectMonth(state, source, config.routes, request, clock); return present(state); });
    },
    view() { return present(store.snapshot()); },
  };
}
