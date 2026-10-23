/**
 * speech/speechText.js —— 多语种文本 -> 语音库音节单元。
 *
 * 移植自 Coopanion (AGPL-3.0) src/speech/index.ts（SpeechText.units），
 * 仅保留中/英/日三个语种（韩语/俄语/其他拉丁语种未移植）：
 *   - 汉字：按普通话最常用读音及声调（dict/zh.json）；句子中含假名时汉字按日语读
 *   - 假名+汉字（日语）：japanese.js 的词级词典读音
 *   - 英文：先查 CMU 发音词典（dict/en.tsv.gz），查不到走拼写规则（lang.js）
 *   - 数字：按其中文名称读
 * 词典在首次用到时才加载（懒加载）。
 */

'use strict';

const { readFileSync } = require('fs');
const { gunzipSync } = require('zlib');
const { join } = require('path');

const { ipaSyllables } = require('./ipa');
const { japanesePhonemes, isKana, isKanji, JUKUJIKUN } = require('./japanese');
const { spellEnglish } = require('./lang');
const { bankKey } = require('./syllable');

const WEAK = new Set('的了吗呢啊呀吧哦啦么着过');
const DIGITS = ['ling', 'yi', 'er', 'san', 'si', 'wu', 'liu', 'qi', 'ba', 'jiu'];
const MARKS = /[,.!?;:…~，。！？；：、～]/;
const SENTENCE = /[。！？!?\n]/;
/** ARPAbet -> IPA（原仓库 ARPA 表原样移植） */
const ARPA = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', IH: 'ɪ', IY: 'i', OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'ɹ', S: 's',
  SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};

/** 日语词典尝试的最长词长（原仓库 JA_LONGEST） */
const JA_LONGEST = 8;

class SpeechText {
  /**
   * @param dataDir 词典目录（assets/speech/dict）
   * @param bankFile 语音库清单（assets/speech/zh.json）
   */
  constructor(dataDir, bankFile) {
    this.dataDir = dataDir;
    this.bankFile = bankFile;
    this.bank = null; // Set<音节键>
    this.zh = null;   // Map<汉字, [音节, 声调]>
    this.en = null;   // Map<单词, ARPAbet 串>
    this.ja = null;   // { word, longest, kanji }
  }

  has(key) {
    if (!this.bank) {
      this.bank = new Set(Object.keys(JSON.parse(readFileSync(this.bankFile, 'utf8')).units));
    }
    return this.bank.has(key);
  }

  tsv(name) {
    const map = new Map();
    for (const line of gunzipSync(readFileSync(join(this.dataDir, name))).toString('utf8').split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab > 0) map.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return map;
  }

  /** 汉字 -> [音节, 声调1-5]（最常用读音） */
  han(ch) {
    if (!this.zh) {
      this.zh = new Map();
      const table = JSON.parse(readFileSync(join(this.dataDir, 'zh.json'), 'utf8'));
      for (const [k, chars] of Object.entries(table)) {
        for (const c of chars) this.zh.set(c, [k.slice(0, -1), Number(k.slice(-1))]);
      }
    }
    return this.zh.get(ch);
  }

  /** 日语读法：熟字训 -> IPADIC 词表 -> Unihan 单字 */
  japanese() {
    if (!this.ja) {
      const words = this.tsv('ja-ipadic.tsv.gz');
      const kanji = this.tsv('ja-unihan.tsv.gz');
      this.ja = {
        word: (w) => JUKUJIKUN[w] ?? words.get(w),
        longest: JA_LONGEST,
        kanji: (k) => {
          const v = kanji.get(k);
          if (v === undefined) return undefined;
          const [on = '', kun = ''] = v.split('|');
          return { on: on ? on.split(',') : [], kun: kun ? kun.split(',') : [] };
        },
      };
    }
    return this.ja;
  }

  /** 音节数组经最近邻映射为库中键后入列 */
  keyed(syllables, out) {
    for (const s of syllables) {
      const key = bankKey(s, (k) => this.has(k));
      if (key) out.push({ at: s.at, key, tone: 0, stress: s.stress, weak: false });
    }
  }

  /** 英文单词：词典发音，否则拼写规则（原仓库 english()） */
  english(word, at) {
    if (!this.en) this.en = this.tsv('en.tsv.gz');
    const arpa = this.en.get(word.toLowerCase());
    if (!arpa) return offset(spellEnglish(word.toLowerCase()), at);
    const phones = arpa.split(' ');
    const out = [];
    phones.forEach((a, k) => {
      const where = at + Math.floor((k * word.length) / phones.length);
      const base = a.replace(/\d$/, '');
      if (a.endsWith('1')) out.push({ p: 'ˈ', at: where });
      // 非重读的 AH 读作 schwa
      out.push({ p: base === 'AH' && a.endsWith('0') ? 'ə' : ARPA[base] ?? '', at: where });
    });
    return out.filter((p) => p.p);
  }

  /**
   * 文本 -> 语音单元数组。
   * 单元：{ at, key, tone, stress, weak, pos, of, end }
   *   at: 触发字符下标；key: 语音库音节键；tone: 1-5 中文声调（0 无）
   *   pos/of: 在短语中的位置/总数；end: 短语收尾的标点
   */
  units(text) {
    const items = [];
    // 含假名的句子中的汉字按日语读（原仓库逻辑）
    const japaneseAt = new Set();
    let from = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i < text.length && !SENTENCE.test(text[i])) continue;
      const sentence = text.slice(from, i);
      if ([...sentence].some(isKana)) for (let k = from; k < i; k++) japaneseAt.add(k);
      from = i + 1;
    }
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      const runOf = (test) => { let j = i; while (j < text.length && test(text[j])) j++; return j; };
      if (isKana(ch) || (isKanji(ch) && japaneseAt.has(i))) {
        const j = runOf((c) => isKana(c) || isKanji(c));
        this.keyed(ipaSyllables(japanesePhonemes(text.slice(i, j), i, this.japanese())), items);
        i = j; continue;
      }
      if (isKanji(ch)) {
        const h = this.han(ch);
        if (h && this.has(h[0])) items.push({ at: i, key: h[0], tone: h[1], stress: false, weak: WEAK.has(ch) });
        i++; continue;
      }
      if (/\p{Script=Latin}/u.test(ch)) {
        const j = runOf((c) => /[\p{Script=Latin}']/u.test(c));
        const word = text.slice(i, j).replace(/'+$/, '');
        this.keyed(ipaSyllables(this.english(word, i)), items);
        i = j; continue;
      }
      if (/[0-9]/.test(ch)) items.push({ at: i, key: DIGITS[Number(ch)], tone: 0, stress: false, weak: false });
      i++;
    }
    return phrases(text, items);
  }
}

/** 规则音素的下标从词内移到文本内（原仓库 offset()） */
function offset(phs, start) {
  return phs.map((p) => ({ p: p.p, at: p.at + start }));
}

/** 每个单元在短语中的位置与收尾标点（原仓库 phrases()） */
function phrases(text, items) {
  items.sort((a, b) => a.at - b.at);
  const out = [];
  let start = 0;
  for (let u = 0; u <= items.length; u++) {
    const prev = u > 0 ? items[u - 1].at : -1;
    const next = u < items.length ? items[u].at : text.length;
    const between = text.slice(prev + 1, next);
    if (u < items.length && !MARKS.test(between)) continue;
    const end = u === items.length
      ? (text.slice(prev + 1).match(/[.!?…~。！？～]+/)?.[0] ?? '。')
      : between.replace(/[^,.!?;:…~，。！？；：、～]/g, '');
    for (let k = start; k < u; k++) out.push({ ...items[k], pos: k - start, of: u - start, end });
    start = u;
  }
  return out;
}

module.exports = { SpeechText };
