import { sample } from '../core/utils.js';
import { MAX_SLOTS } from './weapons.js';

/**
 * Перки между волнами — второй контур прогрессии (после слияния оружия).
 *
 * Рогалик-выбор «1 из 3» даёт игроку ощущение агентства и заставляет
 * перезапускать забег: именно это поднимает возвращаемость, а на Яндекс Играх
 * возвращаемость напрямую влияет на место в каталоге и, значит, на доход.
 */

export const PERKS = [
  {
    id: 'dmg',
    name: 'Усилитель',
    glyph: '⚔',
    css: '#ff3ea5',
    desc: '+18% к урону всего оружия',
    max: 8,
    apply: (s) => { s.damage *= 1.18; },
  },
  {
    id: 'rate',
    name: 'Скорострельность',
    glyph: '⏩',
    css: '#35e6ff',
    desc: '−10% к перезарядке оружия',
    max: 8,
    apply: (s) => { s.cooldown *= 0.9; },
  },
  {
    id: 'speed',
    name: 'Сервоприводы',
    glyph: '➤',
    css: '#7dff5e',
    desc: '+12% к скорости движения',
    max: 6,
    apply: (s) => { s.speed *= 1.12; },
  },
  {
    id: 'hp',
    name: 'Бронеплита',
    glyph: '❤',
    css: '#ff5566',
    desc: '+28 к максимальной прочности, сразу чинит',
    max: 8,
    apply: (s) => { s.maxHpBonus += 28; },
    after: (game) => {
      game.player.maxHp += 28;
      game.player.heal(28);
    },
  },
  {
    id: 'regen',
    name: 'Ремонтный контур',
    glyph: '✚',
    css: '#7dff5e',
    desc: '+1.2 прочности в секунду',
    max: 6,
    apply: (s) => { s.regen += 1.2; },
  },
  {
    id: 'magnet',
    name: 'Магнит',
    glyph: '⊛',
    css: '#35e6ff',
    desc: '+45% к радиусу сбора трофеев',
    max: 5,
    apply: (s) => { s.magnet *= 1.45; },
  },
  {
    id: 'pierce',
    name: 'Бронебой',
    glyph: '➶',
    css: '#a06bff',
    desc: '+1 к пробитию всех снарядов',
    max: 4,
    apply: (s) => { s.pierce += 1; },
  },
  {
    id: 'multi',
    name: 'Расщепитель',
    glyph: '✦',
    css: '#ffc23d',
    desc: '+1 снаряд у каждого оружия',
    max: 3,
    apply: (s) => { s.extraProjectiles += 1; },
  },
  {
    id: 'crit',
    name: 'Точный глаз',
    glyph: '✷',
    css: '#ffc23d',
    desc: '+9% шанс двойного урона',
    max: 6,
    apply: (s) => { s.crit += 0.09; },
  },
  {
    id: 'armor',
    name: 'Экран',
    glyph: '⬢',
    css: '#35e6ff',
    desc: '−13% получаемого урона',
    max: 5,
    apply: (s) => { s.armor = 1 - (1 - s.armor) * 0.87; },
  },
  {
    id: 'aura',
    name: 'Плазменное поле',
    glyph: '◎',
    css: '#ff8a3d',
    desc: 'Бьёт врагов вокруг героя каждые 0.55 c',
    max: 5,
    apply: (s) => { s.aura += 15; },
  },
  {
    id: 'coins',
    name: 'Алчность',
    glyph: '⬤',
    css: '#ffc23d',
    desc: '+30% к собираемым монетам',
    max: 4,
    apply: (s) => { s.coinMul *= 1.3; },
  },
  {
    id: 'slot',
    name: 'Модуль расширения',
    glyph: '▣',
    css: '#a06bff',
    desc: '+1 слот под оружие',
    max: 2,
    special: 'slot',
    apply: null,
    after: (game) => { game.weapons.addSlot(); },
  },
  {
    id: 'thorns',
    name: 'Шипы',
    glyph: '✵',
    css: '#ff5566',
    desc: 'Враги в упор получают 22 урона',
    max: 4,
    apply: (s) => { s.thorns += 22; },
  },
];

/** Базовые характеристики забега, которые перки модифицируют. */
export function defaultStats() {
  return {
    damage: 1,
    cooldown: 1,
    speed: 1,
    maxHpBonus: 0,
    regen: 0,
    magnet: 1,
    pierce: 0,
    extraProjectiles: 0,
    crit: 0,
    armor: 0,
    aura: 0,
    thorns: 0,
    coinMul: 1,
  };
}

export function perkById(id) {
  return PERKS.find((p) => p.id === id);
}

/**
 * Три предложения на выбор.
 * Учитываем уже взятые уровни и отсекаем максимум; «Модуль расширения»
 * не предлагаем, если слоты уже на пределе.
 */
export function rollChoices(levels, weapons) {
  const available = PERKS.filter((p) => {
    const cur = levels[p.id] ?? 0;
    if (cur >= p.max) return false;
    if (p.special === 'slot' && weapons.slotCount >= MAX_SLOTS + 2) return false;
    return true;
  });

  // Если выбирать не из чего (редко, на длинном забеге) — лечим.
  if (available.length === 0) {
    return [{ id: 'heal', name: 'Ремонт', glyph: '✚', css: '#7dff5e', desc: 'Полное восстановление прочности', max: 99, special: 'heal', apply: null }];
  }

  // Чуть смещаем баланс в пользу уже начатых веток: собирать билд интереснее,
  // чем каждый раз брать новое.
  const weighted = available.map((p) => ({ perk: p, w: (levels[p.id] ?? 0) > 0 ? 1.7 : 1 }));
  const chosen = [];
  const poolCopy = weighted.slice();
  const need = Math.min(3, poolCopy.length);
  for (let i = 0; i < need; i++) {
    let total = 0;
    for (const item of poolCopy) total += item.w;
    let r = Math.random() * total;
    let idx = 0;
    for (let j = 0; j < poolCopy.length; j++) {
      r -= poolCopy[j].w;
      if (r <= 0) { idx = j; break; }
    }
    chosen.push(poolCopy[idx].perk);
    poolCopy.splice(idx, 1);
  }
  return chosen;
}

export { sample };
