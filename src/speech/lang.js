/**
 * speech/lang.js —— 英文拼写规则（词典查不到时的兜底）。
 *
 * 移植自 Coopanion (AGPL-3.0) src/speech/lang.ts，仅保留英文（EN）规则集与重音逻辑；
 * 其他拉丁/西里尔语种的规则未移植（本服务只面向中/英/日）。
 */

'use strict';

const { applyRules } = require('./rules');
const { isVowel } = require('./ipa');

/** 原仓库 EN RuleSet 原样移植 */
const EN = {
  vowels: 'aeiouy',
  rules: [
    ['tion', 'ʃ ə n'], ['sion', 'ʒ ə n'], ['ture', 't ʃ ə'], ['igh', 'aɪ'], ['ough', 'ɔ'], ['augh', 'ɔ'], ['eigh', 'eɪ'],
    ['ee', 'i'], ['ea', 'i'], ['oo', 'u'], ['ou', 'aʊ'], ['ow', 'oʊ'], ['oa', 'oʊ'], ['ai', 'eɪ'], ['ay', 'eɪ'], ['oi', 'ɔɪ'], ['oy', 'ɔɪ'],
    ['au', 'ɔ'], ['aw', 'ɔ'], ['ew', 'j u'], ['ie(#', 'i'],
    ['ch', 'tʃ'], ['sh', 'ʃ'], ['th', 'θ'], ['ph', 'f'], ['wh', 'w'], ['ck', 'k'], ['ng(#', 'ŋ'], ['qu', 'k w'], ['#)kn', 'n'], ['#)wr', 'ɹ'],
    ['c([eiy]', 's'], ['c', 'k'], ['g([eiy]', 'dʒ'], ['g', 'ɡ'], ['x', 'k s'], ['j', 'dʒ'], ['y(A', 'j'], ['C)y(#', 'i'], ['y', 'ɪ'],
    ['a(Ce#', 'eɪ'], ['i(Ce#', 'aɪ'], ['o(Ce#', 'oʊ'], ['u(Ce#', 'j u'], ['e(Ce#', 'i'], ['AC)e(#', ''], ['AC)es(#', 'z'],
    ['a', 'æ'], ['e', 'ɛ'], ['i', 'ɪ'], ['o', 'ɑ'], ['u', 'ʌ'],
    ['b', 'b'], ['d', 'd'], ['f', 'f'], ['h', 'h'], ['k', 'k'], ['l', 'l'], ['m', 'm'], ['n', 'n'], ['p', 'p'], ['r', 'ɹ'], ['s', 's'],
    ['t', 't'], ['v', 'v'], ['w', 'w'], ['z', 'z'],
  ],
};

/**
 * 原仓库 spell()（英文分支）：规则未标重音时按英文习惯落在第一个元音上。
 * @returns {Array<{p: string, at: number}>}
 */
function spellEnglish(word) {
  const phs = applyRules(word, EN);
  if (phs.some((p) => p.p === 'ˈ')) return phs;
  const vowels = phs.map((p, i) => (isVowel(p.p) ? i : -1)).filter((i) => i >= 0);
  const k = vowels.length > 0 ? 0 : null; // STRESS.en = 第一个元音
  if (k === null || vowels[k] === undefined) return phs;
  const at = vowels[k];
  return [...phs.slice(0, at), { p: 'ˈ', at: phs[at].at }, ...phs.slice(at)];
}

module.exports = { spellEnglish };
