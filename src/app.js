/**
 * app.js —— Animalese Generator API 服务入口。
 *
 * POST /generate  生成音频 -> 存到 outputs/ -> 返回可公网访问的静态链接
 * GET  /health    健康检查
 * GET  /static/outputs/<file>.wav  生成的音频文件（express.static）
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const { render, preloadAssets } = require('./speechEngine');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_TEXT_LENGTH = parseInt(process.env.MAX_TEXT_LENGTH || '200', 10);
const OUTPUT_TTL_MINUTES = parseInt(process.env.OUTPUT_TTL_MINUTES || '60', 10);
const OUTPUT_DIR = path.join(__dirname, '..', 'outputs');

// ---------------------------------------------------------------------------
// 启动前：预热素材，缺失素材直接启动失败（对应「素材缺失」错误处理）
// ---------------------------------------------------------------------------

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let assetCount;
try {
  assetCount = preloadAssets();
} catch (err) {
  console.error(`[fatal] 素材加载失败，请检查 assets/sounds 目录: ${err.message}`);
  process.exit(1);
}
console.log(`[init] 已加载 ${assetCount} 个音频素材`);

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // 部署在 Nginx 反代后时 fullUrl 仍取到公网协议/域名
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// 生成的音频对外提供静态访问（公网链接 = 服务器域名 + /static/outputs/xxx.wav）
app.use(
  '/static/outputs',
  express.static(OUTPUT_DIR, {
    immutable: true,
    maxAge: '1h',
    setHeaders(res) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  })
);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', assets: assetCount, uptime: process.uptime() });
});

/** 简单输入校验（替代 zod，保持零额外依赖） */
function validateBody(body) {
  if (!body || typeof body !== 'object') {
    return { code: 'INVALID_JSON', message: 'request body must be a JSON object' };
  }
  const { text, speed = 1.0, pitch = 1.0 } = body;

  if (typeof text !== 'string' || !text.trim()) {
    return { code: 'EMPTY_TEXT', message: 'text is required and must not be empty' };
  }
  if ([...text].length > MAX_TEXT_LENGTH) {
    return { code: 'TEXT_TOO_LONG', message: `text exceeds max length of ${MAX_TEXT_LENGTH} characters` };
  }
  if (typeof speed !== 'number' || !(speed >= 0.5 && speed <= 2.0)) {
    return { code: 'INVALID_SPEED', message: 'speed must be a number between 0.5 and 2.0' };
  }
  if (typeof pitch !== 'number' || !(pitch >= 0.5 && pitch <= 2.0)) {
    return { code: 'INVALID_PITCH', message: 'pitch must be a number between 0.5 and 2.0' };
  }
  return null;
}

app.post('/generate', (req, res) => {
  const invalid = validateBody(req.body);
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }

  const { text, speed = 1.0, pitch = 1.0 } = req.body;

  let result;
  try {
    result = render(text.trim(), { speed, pitch });
  } catch (err) {
    if (/did not contain any speakable characters|no audio was generated/.test(err.message)) {
      return res.status(400).json({
        error: { code: 'NO_SPEAKABLE_CHARACTERS', message: 'text did not contain any speakable characters' },
      });
    }
    if (/Missing audio asset/.test(err.message)) {
      return res.status(500).json({
        error: { code: 'ASSET_MISSING', message: err.message },
      });
    }
    console.error('[render]', err);
    return res.status(500).json({
      error: { code: 'SYNTHESIS_FAILED', message: 'failed to synthesize audio' },
    });
  }

  // 并发安全：每个请求独立内存合成；文件名 时间戳+随机数 保证唯一；
  // 先写临时文件再原子改名，避免客户端读到写了一半的文件。
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const filename = `animalese-${id}.wav`;
  const finalPath = path.join(OUTPUT_DIR, filename);
  const tempPath = path.join(OUTPUT_DIR, `.${filename}.tmp`);

  try {
    fs.writeFileSync(tempPath, result.buffer);
    fs.renameSync(tempPath, finalPath);
  } catch (err) {
    console.error('[io]', err);
    return res.status(500).json({
      error: { code: 'WRITE_FAILED', message: 'failed to save generated audio' },
    });
  }

  const url = `/static/outputs/${filename}`;
  // PUBLIC_BASE_URL 可强制指定公网前缀；否则按请求来源推断
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  return res.json({
    id,
    url,                 // 相对路径
    fullUrl: base + url, // 可直接公网访问的完整链接
    durationMs: result.durationMs,
    events: result.eventCount,
  });
});

// 统一 404 / 错误处理
app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'route not found' } });
});
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'malformed JSON body' } });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'internal server error' } });
});

// ---------------------------------------------------------------------------
// 过期音频清理：默认每 10 分钟删除 60 分钟前生成的文件，防止磁盘涨爆
// ---------------------------------------------------------------------------

function sweepOutputs() {
  const cutoff = Date.now() - OUTPUT_TTL_MINUTES * 60 * 1000;
  let removed = 0;
  for (const file of fs.readdirSync(OUTPUT_DIR)) {
    if (!file.endsWith('.wav')) continue;
    const filePath = path.join(OUTPUT_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch { /* 文件可能被并发删除，忽略 */ }
  }
  if (removed) console.log(`[sweep] 清理过期音频 ${removed} 个`);
}

setInterval(sweepOutputs, 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`[start] Animalese API listening on port ${PORT}`);
});
