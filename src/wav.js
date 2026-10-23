/**
 * wav.js —— 纯 Node.js 的 WAV 解码 / 编码 / DSP 工具。
 *
 * 不依赖任何第三方音频库，也不调用 Python / FFmpeg 子进程，
 * 所有处理（重采样变调、静音裁剪、增益、淡入淡出、交叉拼接）
 * 都在 Float32 单声道采样数组上完成。
 *
 * DSP 流程的参数（静音阈值、裁剪窗口、交叉淡化时长等）
 * 移植自原仓库 chinese_animalese.py 中的 pydub 实现。
 */

'use strict';

const TARGET_SAMPLE_RATE = 44100; // 与原仓库输出一致：44.1kHz 单声道

/**
 * 解码 WAV Buffer -> { sampleRate, samples: Float32Array(mono, -1..1) }
 * 支持 PCM 8/16/24/32bit 整型与 IEEE float32，立体声自动混合为单声道。
 */
function decodeWav(buffer) {
  if (buffer.length < 44 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV file: missing RIFF/WAVE header');
  }

  let offset = 12;
  let fmt = null;
  let dataChunk = null;

  // 逐块遍历，跳过 JUNK/LIST 等无关 chunk（原仓库素材带 JUNK 头）
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(bodyStart),
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (id === 'data') {
      dataChunk = { start: bodyStart, size };
    }
    offset = bodyStart + size + (size % 2); // chunk 按 2 字节对齐
  }

  if (!fmt || !dataChunk) throw new Error('Invalid WAV file: missing fmt or data chunk');

  const { audioFormat, channels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataChunk.size / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let mixed = 0;
    for (let ch = 0; ch < channels; ch++) {
      const p = dataChunk.start + (i * channels + ch) * bytesPerSample;
      mixed += readSample(buffer, p, audioFormat, bitsPerSample);
    }
    samples[i] = mixed / channels;
  }
  return { sampleRate, samples };
}

function readSample(buffer, pos, audioFormat, bits) {
  if (audioFormat === 3 && bits === 32) return buffer.readFloatLE(pos); // IEEE float
  if (audioFormat !== 1) throw new Error(`Unsupported WAV format: ${audioFormat}`);
  switch (bits) {
    case 8: return (buffer.readUInt8(pos) - 128) / 128;
    case 16: return buffer.readInt16LE(pos) / 32768;
    case 24: {
      const v = buffer.readIntLE(pos, 3);
      return v / 8388608;
    }
    case 32: return buffer.readInt32LE(pos) / 2147483648;
    default: throw new Error(`Unsupported WAV bit depth: ${bits}`);
  }
}

/** 编码 Float32 单声道采样 -> 16bit PCM WAV Buffer（44 字节标准头） */
function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);          // fmt chunk 大小
  buffer.writeUInt16LE(1, 20);           // PCM
  buffer.writeUInt16LE(1, 22);           // 单声道
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byteRate
  buffer.writeUInt16LE(2, 32);           // blockAlign
  buffer.writeUInt16LE(16, 34);          // bitDepth
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buffer;
}

/** 均方根分贝（dBFS），静音返回 -Infinity */
function dbfs(samples) {
  if (!samples.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** 最大峰值分贝 */
function maxDbfs(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** 线性增益（dB） */
function applyGain(samples, gainDb) {
  const factor = Math.pow(10, gainDb / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * factor;
  return out;
}

/**
 * 静音裁剪 —— 移植自原仓库 _trim_silence()：
 *   min_silence_len=12ms, silence_thresh=max(seg.dBFS-22, -52), seek_step=2ms, padding=4ms
 */
function trimSilence(samples, sampleRate, paddingMs = 4) {
  const segDbfs = dbfs(samples);
  if (segDbfs === -Infinity) return samples;

  const windowSize = Math.max(1, Math.round(sampleRate * 0.002)); // 2ms 窗
  const windowCount = Math.ceil(samples.length / windowSize);
  const silenceThresh = Math.max(segDbfs - 22, -52);
  const minSilenceWindows = Math.round(12 / 2); // 12ms 最小静音长度

  // 标记每个窗是否为非静音
  const loud = new Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    loud[w] = rms > 0 && 20 * Math.log10(rms) > silenceThresh;
  }

  // 找出首尾非静音窗（中间小于 12ms 的静音间隙被吞掉）
  let first = -1;
  let last = -1;
  for (let w = 0; w < windowCount; w++) {
    if (!loud[w]) continue;
    if (first === -1) first = w;
    // 向后看：若之后连续 minSilenceWindows 个窗都静音，则认为这里结束
    let silentRun = 0;
    let look = w + 1;
    while (look < windowCount && !loud[look]) { silentRun++; look++; }
    if (look >= windowCount || silentRun >= minSilenceWindows) last = w;
  }
  if (first === -1) return samples;

  const pad = Math.round(sampleRate * paddingMs / 1000);
  const start = Math.max(0, first * windowSize - pad);
  const end = Math.min(samples.length, (last + 1) * windowSize + pad);
  return samples.slice(start, end);
}

/**
 * 按八度变调 —— 移植自原仓库 _shift_by_octaves()：
 * 直接按 factor=2^octaves 改变播放速率（线性插值重采样），
 * 音调与时长同时变化，正是 Animalese 的经典效果。
 */
function shiftByOctaves(samples, octaves) {
  const factor = Math.pow(2, octaves);
  const newLength = Math.max(1, Math.round(samples.length / factor));
  const out = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * factor;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(idx, samples.length - 1)];
    const b = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 淡入淡出 —— 对应原仓库 fade_in/fade_out（fade_ms 上限为片段长度的 1/3） */
function applyFades(samples, sampleRate, fadeMs) {
  const fadeSamples = Math.min(
    Math.round(sampleRate * fadeMs / 1000),
    Math.floor(samples.length / 3)
  );
  if (fadeSamples <= 0) return samples;
  const out = new Float32Array(samples);
  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples;
    out[i] *= t;
    out[samples.length - 1 - i] *= t;
  }
  return out;
}

/**
 * 交叉淡化拼接 —— 对应原仓库 _append_fragment()：
 *   crossfade = min(5ms, len(output), len(fragment))
 */
function appendWithCrossfade(a, b, sampleRate) {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  const cross = Math.min(Math.round(sampleRate * 5 / 1000), a.length, b.length);
  const out = new Float32Array(a.length + b.length - cross);
  out.set(a.subarray(0, a.length - cross), 0);
  for (let i = 0; i < cross; i++) {
    const t = i / cross;
    out[a.length - cross + i] = a[a.length - cross + i] * (1 - t) + b[i] * t;
  }
  out.set(b.subarray(cross), a.length);
  return out;
}

/** 生成指定毫秒数的静音 */
function silence(durationMs, sampleRate) {
  return new Float32Array(Math.max(1, Math.round(sampleRate * durationMs / 1000)));
}

module.exports = {
  TARGET_SAMPLE_RATE,
  decodeWav,
  encodeWav,
  dbfs,
  maxDbfs,
  applyGain,
  trimSilence,
  shiftByOctaves,
  applyFades,
  appendWithCrossfade,
  silence,
};
