import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { MemoryIdentity, MemoryPusher, MemoryStore } from './store/memory.js';
import type { Identity, Pusher, Store } from './store/types.js';

async function main() {
  const config = loadConfig();
  let store: Store;
  let pusher: Pusher;
  let identity: Identity;

  if (config.store === 'firebase') {
    const { FcmPusher, FirebaseIdentity, FirebaseStore, initFirebase } = await import('./store/firebase.js');
    const app = initFirebase({ databaseUrl: config.firebaseDatabaseUrl as string, projectId: config.firebaseProjectId });
    store = new FirebaseStore(app);
    pusher = new FcmPusher(app);
    identity = new FirebaseIdentity(app);
  } else {
    console.warn('STORE=memory: nothing is persisted and pushes are only logged. Use for local development only.');
    store = new MemoryStore();
    const memoryPusher = new MemoryPusher();
    pusher = {
      async send(tokens, data, priority) {
        console.log('push', { tokens, data, priority });
        return memoryPusher.send(tokens, data, priority);
      },
    };
    identity = new MemoryIdentity({ 'dev-user': { uid: 'dev-user', email: 'dev@example.com' } });
  }

  const app = createApp({ config, store, pusher, identity });
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`agent-notifications server listening on :${config.port} (public ${config.publicUrl}, web ${config.webUrl}, store ${config.store})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
