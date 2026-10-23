/**
 * speechEngine.js —— 基于 Coopanion 语音库的离线合成引擎。
 *
 * 素材与文本分析移植自 Coopanion (Pal-AI-Lab/Coopanion, AGPL-3.0)：
 *   - 语音库：assets/speech/zh.wav + zh.json 清单，每个无声调普通话音节一个
 *     「音高拉平」的单元（平均 ~115ms），由 TTS 录音经 Praat PSOLA 处理生成，
 *     因此听感比逐字母拼接清晰连贯得多；
 *   - 音高只由播放速率控制：升调则变短，正是动森村民说话的效果；
 *   - 语调曲线（web/speech.js 的 play() 移植）：句首抬升、句中缓降、
 *     疑问句尾上扬、感叹句首提高并加重、重音 +1 半音、中文按声调走向滑动；
 *   - 节奏（VoiceClock 移植为离线版）：音节起始间隔 1/ups 秒，允许前后单元
 *     交叠（这是连贯感的关键），标点处留 VOICE_GAP 静音。
 *
 * 与原版差异：原版是浏览器实时播放（WebAudio），这里离线渲染成完整 WAV；
 * 因此去掉了「落后太多丢弃弱读字」的实时逻辑——API 场景应完整渲染整句。
 *
 * 并发安全：语音库与词典加载后为只读；每次渲染在独立的时间轴缓冲区上进行。
 */

'use strict';

const { readFileSync } = require('fs');
const path = require('path');
const crypto = require('crypto');

const wav = require('./wav');
const { SpeechText } = require('./speech/speechText');

const SR = wav.TARGET_SAMPLE_RATE;

const SPEECH_DIR = path.join(__dirname, '..', 'assets', 'speech');
const BANK_WAV = path.join(SPEECH_DIR, 'zh.wav');
const BANK_MANIFEST = path.join(SPEECH_DIR, 'zh.json');
const DICT_DIR = path.join(SPEECH_DIR, 'dict');

/** 默认嗓音基频 400Hz（原仓库默认值；库录音为 364Hz，约 1.1 倍速播放） */
const DEFAULT_PITCH_HZ = 400;
/** 每秒最多启动的音节数（原仓库默认 13 面向实时打字场景；离线整句朗读 9/s 接近零交叠的自然语速） */
const DEFAULT_UNITS_PER_SECOND = 9;
/** 各声调的半音滑动轨迹，经 TONE_AMOUNT 缩放；5 为轻声（原仓库 TONES） */
const TONES = { 1: [0.8, 0.8], 2: [-0.6, 1.6], 3: [-1, -1.8, -0.6], 4: [1.6, -1.2], 5: [-0.8, -0.8] };
const TONE_AMOUNT = 0.35;
const STRESS_ST = 1;
const GAIN = 0.45;

/** 标点后的静音时长（秒），连续标点累加（原仓库 VOICE_GAP） */
const VOICE_GAP = {
  ',': 0.14, '，': 0.14, '、': 0.14, ';': 0.2, '；': 0.2, ':': 0.2, '：': 0.2,
  '.': 0.45, '。': 0.45, '!': 0.5, '！': 0.5, '?': 0.5, '？': 0.5, '…': 0.3, '~': 0.1, '～': 0.1,
};

// ---------------------------------------------------------------------------
// 语音库（只读，启动时加载）
// ---------------------------------------------------------------------------

let bank = null; // { hz, samples: Float32Array, units: Map<string, [startSec, lenSec]> }
let speechText = null;

function preloadAssets() {
  const manifest = JSON.parse(readFileSync(BANK_MANIFEST, 'utf8'));
  const { sampleRate, samples } = wav.decodeWav(readFileSync(BANK_WAV));
  if (sampleRate !== SR) {
    throw new Error(`bank sample rate ${sampleRate} != ${SR}，请重新转换 assets/speech/zh.wav`);
  }
  bank = { hz: manifest.hz, samples, units: new Map(Object.entries(manifest.units)) };
  speechText = new SpeechText(DICT_DIR, BANK_MANIFEST);
  return bank.units.size;
}

// ---------------------------------------------------------------------------
// VoiceClock 离线移植（web/speech.js）：只保留时间轴摆放，不做实时丢弃
// ---------------------------------------------------------------------------

class OfflineVoiceClock {
  constructor() {
    this.last = -Infinity;
    this.end = 0;
    this.free = 0;
    this.gap = 0;
  }
  /** 标点出现：下一个单元不早于语音结束 + 累计静音之后开始 */
  mark(ch) {
    this.gap += VOICE_GAP[ch] ?? 0;
    this.free = this.end + this.gap;
  }
  /** 一个单元的起始秒数；起始间隔至少 1/ups，允许交叠 */
  place(unitsPerSecond) {
    const t = Math.max(this.last + 1 / unitsPerSecond, this.free);
    this.last = t;
    return t;
  }
  /** 单元实际入列后更新语音结束时刻 */
  commit(t, len) {
    this.end = Math.max(this.end, t + len);
    this.gap = 0;
  }
}

/** 确定性 PRNG（与文本内容绑定，同一文本多次生成结果一致） */
function createRng(text) {
  const digest = crypto.createHash('sha256').update(`coopanion${text}`, 'utf8').digest();
  let state = Number(digest.readBigUInt64BE(0) & 0xffffffffn) >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 变速播放一个库单元（web/speech.js play() 的离线版）。
 * @param unit    语音单元
 * @param hz      目标基频
 * @param random  确定性随机源
 * @returns {Float32Array} 渲染好的片段
 */
function renderUnit(unit, hz, random) {
  const [off, len] = bank.units.get(unit.key);
  const rate = hz / bank.hz;

  // 语调线：句首抬升、随位置缓降、疑问句尾上扬、感叹加重（原仓库公式）
  const q = /[?？]/.test(unit.end);
  const ex = /[!！]/.test(unit.end);
  const last = unit.pos === unit.of - 1;
  let st = (unit.pos === 0 ? 0.8 : 0) - 0.06 * unit.pos + (random() - 0.5) * 0.4 + (ex ? 1 : 0) + (unit.stress ? STRESS_ST : 0);
  let bend = 0;
  if (q && unit.pos === unit.of - 2) st += 1.5;
  if (q && last) { st += 2; bend = 3; }
  if (/…/.test(unit.end) && last) st -= 0.8;

  // 8 点速率曲线：基础速率 × (语调 + 声调轨迹 + 句尾弯曲)
  const tone = unit.tone ? TONES[unit.tone] : [0, 0];
  const curve = new Float32Array(8);
  for (let k = 0; k < 8; k++) {
    const p = k / 7;
    const x = p * (tone.length - 1);
    const a = Math.floor(x);
    const b = Math.min(tone.length - 1, a + 1);
    const ts = (tone[a] + (tone[b] - tone[a]) * (x - a)) * TONE_AMOUNT;
    curve[k] = rate * Math.pow(2, (st + ts + bend * p) / 12);
  }

  // 时长 = len / rate（与原版 setValueCurveAtTime 的区间一致）
  const duration = len / rate;
  const outLen = Math.max(1, Math.round(duration * SR));
  const out = new Float32Array(outLen);
  const startSample = Math.round(off * SR);
  const maxSample = Math.min(bank.samples.length - 1, Math.round((off + len) * SR));
  const gain = GAIN * (ex ? 1.26 : 1);

  let phase = 0; // 在库片段内的位置（秒）
  for (let n = 0; n < outLen; n++) {
    const p = n / outLen; // 0..1
    const ci = p * 7;
    const a = Math.floor(ci);
    const b = Math.min(7, a + 1);
    const r = curve[a] + (curve[b] - curve[a]) * (ci - a);
    const idx = Math.min(maxSample, startSample + Math.floor(phase * SR));
    out[n] = bank.samples[idx] * gain;
    phase += r / SR;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主合成入口
// ---------------------------------------------------------------------------

/**
 * 合成文本为 WAV Buffer。
 * @param {string} text
 * @param {object} options
 *   pitch: 0.5–2.0 音调倍率（默认 1.0；映射为基频 200–800Hz）
 *   speed: 0.5–2.0 语速倍率（默认 1.0；映射为音节密度 6.5–26/s）
 * @returns {{ buffer: Buffer, durationMs: number, eventCount: number }}
 */
function render(text, options = {}) {
  const pitch = options.pitch ?? 1.0;
  const speed = options.speed ?? 1.0;
  const hz = DEFAULT_PITCH_HZ * pitch;
  const ups = DEFAULT_UNITS_PER_SECOND * speed;

  const units = speechText.units(text);
  if (!units.length) {
    throw new Error('text did not contain any speakable characters');
  }

  // 按字符下标归组单元（原仓库 byAt）
  const byAt = new Map();
  for (const u of units) {
    if (!byAt.has(u.at)) byAt.set(u.at, []);
    byAt.get(u.at).push(u);
  }

  // 离线时间轴：逐字符走一遍，标点累积静音，单元按节奏摆放
  const random = createRng(text);
  const clock = new OfflineVoiceClock();
  const placements = []; // { samples: Float32Array, atSec: number }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (VOICE_GAP[ch] !== undefined) clock.mark(ch);
    for (const u of byAt.get(i) ?? []) {
      if (!bank.units.has(u.key)) continue;
      const fragment = renderUnit(u, hz, random);
      const t = clock.place(ups);
      clock.commit(t, fragment.length / SR);
      placements.push({ samples: fragment, atSec: t });
    }
  }

  if (!placements.length) throw new Error('no audio was generated');

  // 混音到一条时间轴（相邻单元允许交叠，连贯感的来源）
  const totalSec = Math.max(...placements.map((p) => p.atSec + p.samples.length / SR));
  const output = new Float32Array(Math.ceil(totalSec * SR) + 1);
  for (const { samples, atSec } of placements) {
    const start = Math.round(atSec * SR);
    for (let n = 0; n < samples.length; n++) output[start + n] += samples[n];
  }

  // 峰值压限到 -1dBFS
  const peak = wav.maxDbfs(output);
  if (peak > -1.0) {
    const limited = wav.applyGain(output, -1.0 - peak);
    return {
      buffer: wav.encodeWav(limited, SR),
      durationMs: Math.round((limited.length / SR) * 1000),
      eventCount: units.length,
    };
  }
  return {
    buffer: wav.encodeWav(output, SR),
    durationMs: Math.round((output.length / SR) * 1000),
    eventCount: units.length,
  };
}

module.exports = { render, preloadAssets };
