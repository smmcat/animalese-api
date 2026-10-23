# Animalese Generator API

动森 Animalese 风格语音生成 API（中文 / 英文 / 日语）。
合成方案移植自 [Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion)（AGPL-3.0）：
整音节语音库（~407 个普通话音节，TTS 录音经 Praat PSOLA 拉平音高）+ 词典级文本分析 +
语调曲线变速播放，语句清晰流畅，远优于逐字母拼接方案。

> 原理：文本经各语种词典转为 IPA 音节，映射到语音库中最近的音节切片，
> 按语调/声调曲线变速播放并在时间轴上交叠混音。**不是 AI TTS 推理，是拼接合成**。
> 音频处理全部在 Node 内完成，无 Python / FFmpeg 运行时依赖。

## 环境要求

- Node.js >= 18
- 依赖仅 3 个：`express` / `cors` / `dotenv`

## 项目结构

```
dongsheng/
├── package.json
├── .env.example            # 环境变量示例
├── src/
│   ├── app.js              # Express 服务入口：路由、校验、静态托管、定时清理
│   ├── speechEngine.js     # 离线合成引擎（Coopanion web/speech.js 的 VoiceClock + 语调曲线移植）
│   ├── wav.js              # 纯 Node WAV 解码/编码/DSP
│   └── speech/             # Coopanion src/speech/ 的中/英/日部分移植
│       ├── speechText.js   # 统一入口：文本 -> 语音单元（词典懒加载）
│       ├── japanese.js     # 日语：词级读音词典 + 假名拍解析（含熟字训表）
│       ├── lang.js         # 英文拼写规则（CMU 词典查不到时的兜底）
│       ├── rules.js        # eSpeak 风格拼写规则引擎
│       ├── ipa.js          # IPA 音素 -> 音节
│       └── syllable.js     # 音节 -> 语音库最近邻键
├── assets/speech/
│   ├── zh.wav              # 语音库（44.1kHz 单声道，由 Coopanion zh.ogg 转换）
│   ├── zh.json             # 语音库清单：音节 -> [起始秒, 时长秒]，hz=364 库基频
│   └── dict/               # 词典：zh.json(汉字→音节+声调) en.tsv.gz(CMU) ja-ipadic/ja-unihan.tsv.gz
└── outputs/                # 生成的 wav（对外静态目录，自动过期清理）
```

## 快速开始

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
npm start
```

服务默认监听 `3000` 端口，启动时加载语音库（407 个音节单元），缺失会直接启动失败。

## 接口

### POST /generate

请求体：

```json
{
  "text": "输入文字，支持中、英、日混排",
  "speed": 1.0,
  "pitch": 1.0
}
```

| 字段  | 类型   | 必填 | 默认 | 说明                                       |
| ----- | ------ | ---- | ---- | ------------------------------------------ |
| text  | string | 是   | -    | 最大 200 字符（可用 MAX_TEXT_LENGTH 调整） |
| speed | number | 否   | 1.0  | 语速倍率 0.5–2.0（音节密度 4.5–18 个/秒，1.0≈9/s 自然语速） |
| pitch | number | 否   | 1.0  | 音调倍率 0.5–2.0（基频 200–800Hz）         |

成功响应 `200`：

```json
{
  "id": "1792763065206-524c2d2d",
  "url": "/static/outputs/animalese-1792763065206-524c2d2d.wav",
  "fullUrl": "http://localhost:3000/static/outputs/animalese-1792763065206-524c2d2d.wav",
  "durationMs": 1041,
  "events": 11
}
```

`fullUrl` 即为可直接公网访问的音频链接（部署时通过 `PUBLIC_BASE_URL` 指定域名前缀）。

错误响应（标准 HTTP 状态码）：

| 状态码 | code                   | 场景                        |
| ------ | ---------------------- | --------------------------- |
| 400    | EMPTY_TEXT             | 空文本                      |
| 400    | TEXT_TOO_LONG          | 超过 200 字                 |
| 400    | INVALID_SPEED / PITCH  | 参数越界                    |
| 400    | NO_SPEAKABLE_CHARACTERS| 过滤后无可发音字符          |
| 400    | INVALID_JSON           | 请求体不是合法 JSON         |
| 500    | ASSET_MISSING          | 素材缺失（启动时已校验）    |
| 500    | SYNTHESIS_FAILED       | 合成失败                    |

### GET /health

```json
{ "status": "ok", "assets": 407, "uptime": 6.5 }
```

## 调用示例

### curl

```bash
# 中文
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"text":"你好世界，今天天气怎么样？","speed":1.0,"pitch":1.0}'

# 英文（CMU 发音词典）
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"text":"hello world, how are you?"}'

# 日语（词级读音词典，含假名拍解析）
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは、元気ですか？","speed":1.2,"pitch":1.1}'

# 中英日混排 + 数字
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -d '{"text":"你好 hello こんにちは！2026年"}'

# 下载生成的音频
curl -o out.wav "http://localhost:3000/static/outputs/<返回的文件名>.wav"
```

### JavaScript (fetch)

```js
const resp = await fetch('http://localhost:3000/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '你好 hello こんにちは！', speed: 1.2, pitch: 1.0 }),
});
const data = await resp.json();
if (resp.ok) {
  new Audio(data.fullUrl).play(); // data.fullUrl 可直接给 <audio> 使用
} else {
  console.error(data.error);
}
```

## 环境变量（.env）

| 变量               | 默认 | 说明                                   |
| ------------------ | ---- | -------------------------------------- |
| PORT               | 3000 | 服务端口                               |
| MAX_TEXT_LENGTH    | 200  | 单条文本最大字符数                     |
| PUBLIC_BASE_URL    | 空   | fullUrl 的公网前缀，如 `http://182.92.130.139:3060` |
| OUTPUT_TTL_MINUTES | 60   | 生成音频保留时长，过期自动清理         |

## 服务器部署提示

1. 设置 `.env` 中 `PUBLIC_BASE_URL=http://你的域名或IP:端口`（**记得带端口**），`fullUrl` 即为公网链接。
2. 用 Nginx 反代时保持默认即可（`trust proxy` 已开启）；如需更高吞吐，可在 Nginx 中为
   `/static/outputs/` 单独配置 `alias` 直读 `outputs/` 目录。
3. 建议 `pm2 start src/app.js --name animalese-api` 常驻运行。

## 并发与防滥用设计

- 语音库与词典加载后只读；每次渲染在独立时间轴缓冲区上进行，无共享可变状态；
- 输出文件名 = 时间戳 + 随机字节，先写临时文件再原子改名；
- 同一文本生成结果确定（随机微扰以文本哈希为种子），可安全做缓存；
- 单条文本限 200 字、JSON body 限 16kb；过期音频每 10 分钟自动清理。

## 与原版 Coopanion 的差异

- 原版为浏览器实时播放（WebAudio），本项目离线渲染完整 WAV；去掉了「落后丢弃弱读字」的实时逻辑，整句完整渲染；
- 语音库由 Opus 的 zh.ogg 一次性转为 44.1kHz WAV（构建期 ffmpeg，运行时零依赖）；
- 仅保留中/英/日三个语种（韩语、俄语、法德西意葡规则未移植）；
- `speed`/`pitch` 为 API 参数：speed 映射音节密度（unitsPerSecond），pitch 映射嗓音基频。

## 许可说明

语音库素材（zh.wav/zh.json）、词典（CMUDICT / IPADIC / Unihan）与文本分析逻辑来自
Coopanion（AGPL-3.0-or-later）。以网络服务形式提供本项目时，请遵守 AGPL 的源代码公开义务，
并保留上游许可声明（CMUDICT / IPADIC / UNICODE 许可见 Coopanion 仓库对应文件）。
