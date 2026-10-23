/**
 * speech/ipa.js —— IPA 音素 -> 音节。
 *
 * 移植自 Coopanion (AGPL-3.0) src/speech/ipa.ts：
 * 每个元音一个音节；其声母是前面的辅音（塞音后的流音保留塞音，如 pl/tr），
 * 之间的滑音（j/w/腭化）是其介音，后面无元音跟随的鼻音是其韵尾；
 * 元音后的其他辅音不发音。
 */

'use strict';

const TILDE = '̃';
/** 不改变发音归属的标记：长音、送气、紧喉、连音等 */
const MARKS = /[ːˑʰ͈̞̝̹̜̩̯͜͡‍]/g;

/** 辅音 -> 最接近的声母；能产生滑音的带 glide */
const CONSONANTS = {
  p: { c: 'p' }, b: { c: 'b' }, t: { c: 't' }, d: { c: 'd' }, k: { c: 'k' }, ɡ: { c: 'g' }, g: { c: 'g' }, q: { c: 'k' }, ʔ: { c: '' },
  f: { c: 'f' }, ɸ: { c: 'f' }, v: { c: 'w' }, β: { c: 'w' }, ʋ: { c: 'w' }, θ: { c: 's' }, ð: { c: 'd' }, s: { c: 's' }, z: { c: 'z' },
  ʃ: { c: 'sh' }, ʂ: { c: 'sh' }, ʒ: { c: 'r' }, ʐ: { c: 'r' }, ɕ: { c: 'x' }, ʑ: { c: 'x' }, ç: { c: 'x' }, x: { c: 'h' }, χ: { c: 'h' },
  h: { c: 'h' }, ɦ: { c: 'h' }, ʁ: { c: 'h' }, ʀ: { c: 'l' }, m: { c: 'm' }, n: { c: 'n' }, ŋ: { c: 'n' }, l: { c: 'l' }, ɫ: { c: 'l' },
  ɭ: { c: 'l' }, r: { c: 'l' }, ɾ: { c: 'l' }, ɹ: { c: 'r' }, tʃ: { c: 'ch' }, dʒ: { c: 'zh' }, ts: { c: 'c' }, dz: { c: 'z' },
  tɕ: { c: 'q' }, dʑ: { c: 'j' }, pf: { c: 'f' }, ɲ: { c: 'n', glide: 'i' }, ʎ: { c: 'l', glide: 'i' },
};
const GLIDES = { j: 'i', ʝ: 'i', ɥ: 'i', ʲ: 'i', w: 'u', ɰ: 'u' };
const LIQUIDS = new Set(['l', 'r', 'h']);
const NASAL_CODA = { n: 'n', m: 'n', ŋ: 'ng', ɴ: 'ng', N: 'n' };

/** 元音（去标记后）-> 韵核；双元音在前 */
const VOWELS = [
  ['aɪ', 'ai'], ['ai', 'ai'], ['äi', 'ai'], ['ɑɪ', 'ai'], ['aj', 'ai'], ['aʊ', 'ao'], ['au', 'ao'], ['ɑʊ', 'ao'], ['eɪ', 'ei'], ['ei', 'ei'],
  ['ɛɪ', 'ei'], ['oʊ', 'ou'], ['əʊ', 'ou'], ['ou', 'ou'], ['ɔɪ', 'ou'], ['ɔʏ', 'ou'], ['oi', 'ou'],
  ['a', 'a'], ['ä', 'a'], ['ɐ', 'a'], ['ɑ', 'a'], ['æ', 'a'], ['ɒ', 'a'], ['e', 'ei'], ['ɛ', 'ei'], ['ə', 'e'], ['ʌ', 'e'], ['ɜ', 'e'],
  ['ɝ', 'e'], ['ɚ', 'e'], ['ɘ', 'e'], ['ɤ', 'e'], ['ø', 'e'], ['œ', 'e'], ['ɵ', 'e'], ['i', 'i'], ['ɪ', 'i'], ['ɨ', 'i'],
  ['o', 'o'], ['ɔ', 'o'], ['u', 'u'], ['ʊ', 'u'], ['ɯ', 'u'], ['ʉ', 'u'], ['y', 'v'], ['ʏ', 'v'],
];
const VOWEL_CHARS = new Set('aäɐɑæɒeɛəʌɜɝɚɘɤøœɵiɪɨoɔuʊɯʉyʏ');
/** 鼻化元音的韵核与韵尾 */
const NASAL_VOWEL = {
  ɛ: ['a', 'n'], œ: ['a', 'n'], e: ['ei', 'n'], i: ['i', 'n'], u: ['u', 'n'], ɑ: ['a', 'ng'], a: ['a', 'ng'], ɐ: ['a', 'ng'],
  ɔ: ['o', 'ng'], o: ['o', 'ng'],
};

/** 去掉长音/送气等标记；预组字符（ẽ、õ）先 NFD 拆成字母 + tilde */
const bareOf = (p) => p.normalize('NFD').replace(MARKS, '');
const isVowel = (p) => VOWEL_CHARS.has(bareOf(p)[0] ?? '');

function vowel(p) {
  const bare = bareOf(p);
  if (bare.includes(TILDE)) {
    const base = bare.replace(TILDE, '')[0] ?? 'a';
    return NASAL_VOWEL[base] ?? ['a', 'ng'];
  }
  for (const [v, n] of VOWELS) if (bare.startsWith(v)) return [n, ''];
  return ['e', ''];
}

/**
 * IPA 音素序列（重读元音前带 `ˈ`）-> 音节数组。
 * 音节：{ at, initial, glide, nucleus, coda, stress }
 */
function ipaSyllables(phs) {
  const out = [];
  let onset = null; // { c, at }
  let glide = null; // { g, at }
  let stress = false;
  // `i` 之后第一个非重音标记的音素下标
  const after = (i) => { let j = i + 1; while (phs[j] && (phs[j].p === 'ˈ' || phs[j].p === 'ˌ')) j++; return j; };
  for (let i = 0; i < phs.length; i++) {
    const { p, at } = phs[i];
    if (p === 'ˈ') { stress = true; continue; }
    if (p === 'ˌ') continue;
    if (isVowel(p)) {
      let [nucleus, coda] = vowel(p);
      const n = after(i);
      const next = phs[n] && bareOf(phs[n].p);
      const beyond = phs[after(n)];
      if (!coda && next && NASAL_CODA[next] && !(beyond && isVowel(beyond.p))) { coda = NASAL_CODA[next]; i = n; }
      out.push({ at: onset?.at ?? glide?.at ?? at, initial: onset?.c ?? '', glide: glide?.g ?? '', nucleus, coda, stress });
      onset = null; glide = null; stress = false;
      continue;
    }
    const bare = bareOf(p);
    if (GLIDES[bare] && (bare === 'ʲ' || (phs[after(i)] && isVowel(phs[after(i)].p)))) {
      glide = { g: GLIDES[bare], at: onset?.at ?? at };
      continue;
    }
    const c = CONSONANTS[bare] ?? CONSONANTS[bare[0] ?? ''];
    if (!c) continue;
    // 塞音后接流音时保留塞音
    if (onset && onset.c && LIQUIDS.has(c.c) && !LIQUIDS.has(onset.c)) continue;
    onset = { c: c.c, at };
    glide = c.glide ? { g: c.glide, at } : null;
  }
  return out;
}

module.exports = { isVowel, ipaSyllables };
