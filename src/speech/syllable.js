/**
 * speech/syllable.js —— 音节在语音库中的拼写与最近邻匹配。
 *
 * 移植自 Coopanion (AGPL-3.0) src/speech/syllable.ts：
 * 所有语言的音节（经 IPA）都映射为语音库中「最接近的无声调普通话音节」，
 * 由拼音部件拼出：声母（b..s 或空）、介音（i/u 或空）、韵核与鼻音韵尾。
 */

'use strict';

const RHYME = {
  // 双元音在鼻音后保留介音
  a: { '': 'a', n: 'an', ng: 'ang' }, ai: { '': 'ai', n: 'ai', ng: 'ai' }, ao: { '': 'ao', n: 'ao', ng: 'ao' },
  e: { '': 'e', n: 'en', ng: 'eng' }, ei: { '': 'ei', n: 'en', ng: 'eng' }, i: { '': 'i', n: 'in', ng: 'ing' },
  o: { '': 'o', n: 'ong', ng: 'ong' }, ou: { '': 'ou', n: 'ou', ng: 'ou' }, u: { '': 'u', n: 'un', ng: 'ong' },
  v: { '': 'v', n: 'vn', ng: 'iong' },
};
/** 介音后的韵母，按拼音在声母后的拼写 */
const AFTER_I = {
  a: 'ia', an: 'ian', ang: 'iang', ao: 'iao', ai: 'ia', e: 'ie', ei: 'ie', en: 'in', eng: 'ing', o: 'iu', ou: 'iu', ong: 'iong',
  u: 'iu', un: 'in', i: 'i', in: 'in', ing: 'ing', v: 'v', vn: 'vn', iong: 'iong',
};
const AFTER_U = {
  a: 'ua', an: 'uan', ang: 'uang', ai: 'uai', ao: 'uo', e: 'uo', ei: 'ui', en: 'un', eng: 'ong', o: 'uo', ou: 'uo', ong: 'ong',
  i: 'ui', in: 'un', ing: 'ong', u: 'u', un: 'un', v: 'v', vn: 'vn', iong: 'iong',
};
/** 不能接 i 韵的声母，及其在 i 前的腭化发音 */
const PALATAL = { k: 'q', g: 'j', h: 'x', s: 'x', sh: 'x', z: 'j', zh: 'j', c: 'q', ch: 'q' };

/** 无声母的韵母按拼音的写法 */
function bare(f) {
  if (f === 'i' || f === 'in' || f === 'ing') return 'y' + f;
  if (f === 'u') return 'wu';
  if (f === 'v') return 'yu';
  if (f === 'vn') return 'yun';
  if (f === 'iu') return 'you';
  if (f === 'ui') return 'wei';
  if (f === 'un') return 'wen';
  if (f === 'ong') return 'weng';
  if (f.startsWith('i')) return 'y' + f.slice(1);
  if (f.startsWith('u')) return 'w' + f.slice(1);
  return f;
}

/** 语音库中与 `s` 最接近的音节键；`has` 判断库中是否存在 */
function bankKey(s, has) {
  const rhyme = RHYME[s.nucleus][s.coda];
  let c = s.initial;
  let glide = s.glide;
  // w 和 y 在拼音里是介音，不是声母
  if ((c === 'w' || c === 'y') && !glide) { glide = c === 'w' ? 'u' : 'i'; c = ''; }
  let f = glide === 'i' ? (AFTER_I[rhyme] ?? rhyme) : glide === 'u' ? (AFTER_U[rhyme] ?? rhyme) : rhyme;
  if (f.startsWith('i') && PALATAL[c]) c = PALATAL[c];
  // ü 在 j/q/x 后写作 u；在 n/l 以外的声母后也读作 u
  if (f.startsWith('v') && c && c !== 'n' && c !== 'l') f = 'u' + f.slice(1);
  // j/q/x 只接 i 韵和 ü 韵
  if ((c === 'j' || c === 'q' || c === 'x') && !f.startsWith('i') && !f.startsWith('u')) f = AFTER_I[f] ?? 'i' + f;
  const join = (i, fin) => (i ? i + fin : bare(fin));
  const plain = RHYME[s.nucleus][''];
  // 最近邻优先：同韵 -> 另一元音的同韵尾 -> 单独元音
  const nasal = s.coda ? [RHYME.e[s.coda], RHYME.a[s.coda], RHYME.u[s.coda]] : [];
  const tries = [join(c, f), join(c, rhyme), c && join(c, 'u' + plain), c && join(c, plain + 'i'), ...nasal.map((r) => c && join(c, r)),
    join(c, plain), c && join(c, 'e'), c && join(c, 'u'), c && join(c, 'a'), bare(f), bare(rhyme), 'a'];
  return tries.find((k) => k && has(k)) ?? null;
}

module.exports = { bankKey };
