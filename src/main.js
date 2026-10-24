import './styles.css';
import europeMap from './data/map.json';
import atlanticMap from './data/map-atlantic.json';
import { App } from './ui/app.js';
import { platform } from './platform/yandex.js';

const app = new App({ europe: europeMap, atlantic: atlanticMap });
window.__crowns = app;

platform.init().then(async (ok) => {
  if (!ok) return;
  const cloud = await platform.load();
  if (!cloud?.save) return;
  try {
    const saved = JSON.parse(cloud.save);
    if (saved?.game) app.enableContinue(saved);
  } catch {
    /* ignore malformed cloud save */
  }
});
