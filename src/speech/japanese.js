/**
 * speech/japanese.js —— 日语文本 -> IPA 音素。
 *
 * 移植自 Coopanion (AGPL-3.0) src/speech/japanese.ts 与 jukujikun.ts：
 *   - 汉字读法：先查「最长前缀词」词典（熟字训 JUKUJIKUN，然后 IPADIC 词表）；
 *     不在词中的汉字取自身读音（Unihan）：与其他汉字相邻取音读，单独时取训读
 *     并截断到送假名起始处，否则取第一个训读。
 *   - 假名按拍（mora）读：小 ゃゅょ 腭化前一拍，っ 不产生音节，
 *     o 段后接 う/ー、e 段后接 い/ー 时拉长为 ou/ei。
 */

'use strict';

/** 熟字训/当て字（常用汉字表付表），原仓库 jukujikun.ts 原样移植 */
const JUKUJIKUN = {
  明日: 'あす', 小豆: 'あずき', 海女: 'あま', 海士: 'あま', 硫黄: 'いおう', 意気地: 'いくじ', 田舎: 'いなか', 息吹: 'いぶき',
  海原: 'うなばら', 乳母: 'うば', 浮気: 'うわき', 浮つく: 'うわつく', 笑顔: 'えがお', 叔父: 'おじ', 伯父: 'おじ', 大人: 'おとな',
  乙女: 'おとめ', 叔母: 'おば', 伯母: 'おば', お巡りさん: 'おまわりさん', お神酒: 'おみき', 母屋: 'おもや', 母家: 'おもや',
  母さん: 'かあさん', 神楽: 'かぐら', 河岸: 'かし', 鍛冶: 'かじ', 風邪: 'かぜ', 固唾: 'かたず', 仮名: 'かな', 蚊帳: 'かや',
  為替: 'かわせ', 河原: 'かわら', 川原: 'かわら', 昨日: 'きのう', 今日: 'きょう', 果物: 'くだもの', 玄人: 'くろうと', 今朝: 'けさ',
  景色: 'けしき', 心地: 'ここち', 居士: 'こじ', 今年: 'ことし', 早乙女: 'さおとめ', 雑魚: 'ざこ', 桟敷: 'さじき',
  差し支える: 'さしつかえる', 五月: 'さつき', 早苗: 'さなえ', 五月雨: 'さみだれ', 時雨: 'しぐれ', 尻尾: 'しっぽ', 竹刀: 'しない',
  老舗: 'しにせ', 芝生: 'しばふ', 清水: 'しみず', 三味線: 'しゃみせん', 砂利: 'じゃり', 数珠: 'じゅず', 上手: 'じょうず', 白髪: 'しらが',
  素人: 'しろうと', 師走: 'しわす', 数寄屋: 'すきや', 数奇屋: 'すきや', 相撲: 'すもう', 草履: 'ぞうり', 山車: 'だし', 太刀: 'たち',
  立ち退く: 'たちのく', 七夕: 'たなばた', 足袋: 'たび', 稚児: 'ちご', 一日: 'ついたち', 築山: 'つきやま', 梅雨: 'つゆ', 凸凹: 'でこぼこ',
  手伝う: 'てつだう', 伝馬船: 'てんません', 投網: 'とあみ', 父さん: 'とうさん', 十重二十重: 'とえはたえ', 読経: 'どきょう', 時計: 'とけい',
  友達: 'ともだち', 仲人: 'なこうど', 名残: 'なごり', 雪崩: 'なだれ', 兄さん: 'にいさん', 姉さん: 'ねえさん', 野良: 'のら',
  祝詞: 'のりと', 博士: 'はかせ', 二十歳: 'はたち', 二十日: 'はつか', 波止場: 'はとば', 一人: 'ひとり', 日和: 'ひより', 二人: 'ふたり',
  二日: 'ふつか', 吹雪: 'ふぶき', 下手: 'へた', 部屋: 'へや', 迷子: 'まいご', 真面目: 'まじめ', 真っ赤: 'まっか', 真っ青: 'まっさお',
  土産: 'みやげ', 息子: 'むすこ', 眼鏡: 'めがね', 猛者: 'もさ', 紅葉: 'もみじ', 木綿: 'もめん', 最寄り: 'もより', 八百長: 'やおちょう',
  八百屋: 'やおや', 大和: 'やまと', 弥生: 'やよい', 浴衣: 'ゆかた', 行方: 'ゆくえ', 寄席: 'よせ', 若人: 'わこうど',
};

const ROWS = [
  ['あいうえお', ['a', 'i', 'ɯ', 'e', 'o']],
  ['かきくけこ', ['k a', 'k i', 'k ɯ', 'k e', 'k o']], ['がぎぐげご', ['ɡ a', 'ɡ i', 'ɡ ɯ', 'ɡ e', 'ɡ o']],
  ['さしすせそ', ['s a', 'ɕ i', 's ɯ', 's e', 's o']], ['ざじずぜぞ', ['z a', 'dʑ i', 'z ɯ', 'z e', 'z o']],
  ['たちつてと', ['t a', 'tɕ i', 'ts ɯ', 't e', 't o']], ['だぢづでど', ['d a', 'dʑ i', 'z ɯ', 'd e', 'd o']],
  ['なにぬねの', ['n a', 'ɲ i', 'n ɯ', 'n e', 'n o']], ['はひふへほ', ['h a', 'ç i', 'ɸ ɯ', 'h e', 'h o']],
  ['ばびぶべぼ', ['b a', 'b i', 'b ɯ', 'b e', 'b o']], ['ぱぴぷぺぽ', ['p a', 'p i', 'p ɯ', 'p e', 'p o']],
  ['まみむめも', ['m a', 'm i', 'm ɯ', 'm e', 'm o']], ['らりるれろ', ['ɾ a', 'ɾ i', 'ɾ ɯ', 'ɾ e', 'ɾ o']],
  ['やゆよ', ['j a', 'j ɯ', 'j o']], ['わゐゑを', ['w a', 'i', 'e', 'o']], ['ゔ', ['v ɯ']], ['ん', ['N']],
];
const MORA = new Map();
for (const [kana, ps] of ROWS) [...kana].forEach((k, i) => MORA.set(k, ps[i].split(' ')));
const SMALL_Y = { 'ゃ': 'a', 'ゅ': 'ɯ', 'ょ': 'o' };
const SMALL_V = { 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'ɯ', 'ぇ': 'e', 'ぉ': 'o' };
const PALATAL = new Set(['ɕ', 'dʑ', 'tɕ', 'ç', 'ɲ']);

/** 片假名 -> 平假名，其他不变 */
const hira = (ch) => {
  const cp = ch.codePointAt(0);
  return cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : ch;
};
const isKana = (ch) => /[ぁ-ゖァ-ヺー]/.test(ch);
const isKanji = (ch) => /[㐀-䶿一-鿿々]/.test(ch);

/** 假名（各自带来源下标）-> 音素 */
function kanaPhonemes(kana) {
  const out = [];
  let lastVowel = -1;
  for (const [raw, at] of kana) {
    const k = hira(raw);
    if (k === 'っ') continue;
    if (k === 'ー') {
      const v = lastVowel >= 0 ? out[lastVowel].p : '';
      if (v === 'o' || v === 'e') out[lastVowel].p = v === 'o' ? 'ou' : 'ei';
      continue;
    }
    if (SMALL_Y[k] && lastVowel >= 0) {
      const v = out[lastVowel];
      const cons = out[lastVowel - 1];
      v.p = SMALL_Y[k];
      if (cons && !PALATAL.has(cons.p)) { out.splice(lastVowel, 0, { p: 'j', at: cons.at }); lastVowel++; }
      continue;
    }
    if (SMALL_V[k] && lastVowel >= 0) { out[lastVowel].p = SMALL_V[k]; continue; }
    const prev = lastVowel >= 0 ? out[lastVowel].p : '';
    if ((k === 'う' && (prev === 'o' || prev === 'ɯ')) || (k === 'い' && prev === 'e')) {
      out[lastVowel].p = prev === 'o' ? 'ou' : prev === 'e' ? 'ei' : 'ɯː';
      continue;
    }
    const m = MORA.get(k);
    if (!m) continue;
    for (const p of m) out.push({ p, at });
    lastVowel = m[m.length - 1] === 'N' ? -1 : out.length - 1;
  }
  return out;
}

/** 不在任何词中的汉字的读音：见模块头注释 */
function ownReading(run, i, r) {
  const inWord = (i > 0 && isKanji(run[i - 1])) || (i + 1 < run.length && isKanji(run[i + 1]));
  if (inWord && r.on[0]) return r.on[0];
  const tail = run.slice(i + 1).match(/^[ぁ-ゟ]+/)?.[0] ?? '';
  for (const k of r.kun) for (let cut = 1; cut < k.length; cut++) if (tail.startsWith(k.slice(cut))) return k.slice(0, cut);
  return r.kun[0] ?? r.on[0];
}

/**
 * 日语文本（假名 + 汉字）-> 音素。
 * @param readings { word(w), longest, kanji(k) } —— 词典访问接口（见 speechText.js）
 */
function japanesePhonemes(run, start, readings) {
  const kana = [];
  // 词的读音平摊到它读到的每个字上
  const spread = (reading, i, len) => {
    const chars = [...reading];
    chars.forEach((k, n) => kana.push([k, start + i + Math.floor((n * len) / chars.length)]));
  };
  let i = 0;
  while (i < run.length) {
    if (!isKanji(run[i])) { kana.push([run[i], start + i]); i++; continue; }
    let len = Math.min(readings.longest, run.length - i);
    let reading;
    for (; len > 0; len--) { reading = readings.word(run.slice(i, i + len)); if (reading) break; }
    if (reading) { spread(reading, i, len); i += len; continue; }
    const own = readings.kanji(run[i] === '々' && i > 0 ? run[i - 1] : run[i]);
    const said = own && ownReading(run, i, own);
    if (said) spread(said, i, 1);
    i++;
  }
  return kanaPhonemes(kana);
}

module.exports = { JUKUJIKUN, hira, isKana, isKanji, japanesePhonemes };
