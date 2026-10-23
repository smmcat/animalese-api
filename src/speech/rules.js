/**
 * speech/rules.js —— 拼写规则引擎。
 *
 * 移植自 Coopanion (Pal-AI-Lab/Coopanion, AGPL-3.0) src/speech/rules.ts：
 * eSpeak NG 风格的 `<lang>_rules` 规则匹配。规则写作 `left)group(right`：
 *   - `#` 词边界，`A` 元音字母，`C` 辅音字母，`[...]` 字符集，其余为字面字母
 *   - 音素为 IPA，空格分隔；元音前的 `ˈ` 标记重音；空输出 = 不发音
 *   - 每个字母处取「最长 group 且规则先列出」的匹配
 *   - 辅音字母双写只读一次（除非规则吃掉一对）
 */

'use strict';

const cache = new WeakMap();

function compile(set) {
  let hit = cache.get(set);
  if (hit) return hit;
  const v = escapeClass(set.vowels);
  const ctx = (s, left) => s.replace(/\[[^\]]*\]|./gsu, (t) =>
    t === '#' ? (left ? '^' : '$')
      : t === 'A' ? `[${v}]`
        : t === 'C' ? `[^${v}\\P{L}]`
          : t.startsWith('[') ? t
            : escapeChar(t));
  const byFirst = new Map();
  for (const [pattern, phonemes] of set.rules) {
    const m = /^(?:(.*)\))?([^()]+)(?:\((.*))?$/u.exec(pattern);
    if (!m) throw new Error(`bad rule ${pattern}`);
    const [, left = '', group = '', right = ''] = m;
    const re = new RegExp(`${left ? `(?<=${ctx(left, true)})` : ''}${escapeChar(group)}${right ? `(?=${ctx(right, false)})` : ''}`, 'uy');
    const first = group[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push({ group, re, out: phonemes.split(' ').filter(Boolean) });
  }
  // 最长 group 优先；稳定排序保持同长度内的列出顺序
  for (const list of byFirst.values()) list.sort((a, b) => b.group.length - a.group.length);
  hit = { byFirst, vowels: new Set(set.vowels) };
  cache.set(set, hit);
  return hit;
}

const escapeChar = (s) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const escapeClass = (s) => s.replace(/[\\\]^-]/g, '\\$&');

/** `word`（小写）-> 音素数组 [{p, at}]；无规则可读的字母跳过 */
function applyRules(word, set) {
  const { byFirst, vowels } = compile(set);
  const out = [];
  let i = 0;
  let prev = '';
  while (i < word.length) {
    const ch = word[i];
    if (ch === prev && !vowels.has(ch) && /\p{L}/u.test(ch)) { i++; prev = ''; continue; }
    let done = false;
    for (const r of byFirst.get(ch) ?? []) {
      r.re.lastIndex = i;
      if (!r.re.test(word)) continue;
      for (const p of r.out) out.push({ p, at: i });
      prev = r.group.length === 1 ? ch : '';
      i += r.group.length;
      done = true;
      break;
    }
    if (!done) { i++; prev = ''; }
  }
  return out;
}

module.exports = { applyRules };
