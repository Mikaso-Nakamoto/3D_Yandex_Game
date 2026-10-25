import './styles.css';
import europeMap from './data/map.json';
import atlanticMap from './data/map-atlantic.json';
import worldMap from './data/map-world.json';
import { App } from './ui/app.js';
import { platform } from './platform/yandex.js';

const app = new App({ europe: europeMap, atlantic: atlanticMap, world: worldMap });
window.__crowns = app;

platform.init().then(async (ok) => {
  if (ok) {
    const cloud = await platform.load();
    if (cloud?.save) {
      try {
        const saved = JSON.parse(cloud.save);
        if (saved?.game) app.enableContinue(saved);
      } catch {
        /* ignore malformed cloud save */
      }
    }
  }
  // К4: the first launch goes straight into the three-minute lesson — but only
  // after the cloud save has had its chance to say «this player already has a
  // match», otherwise a returning player would be taught the drag again.
  app.ready();
});
