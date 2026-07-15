# 多格式音频转换器 (FLAC / WAV / MP3)

一个支持 FLAC、WAV、MP3 之间批量互转的单页 Web 应用——覆盖全部 9 种输入→输出组合。基于 Express 5 + 原生 JavaScript 前端，底层调用 ffmpeg 完成转码。

> [English version](README.md)

## 功能

- **多格式批量转换** — FLAC / WAV / MP3 任意方向互转（共 9 种组合）
- **同格式流拷贝** — 相同格式转码走 `-codec:a copy` 无损直通通道
- **拖拽上传** — 支持拖拽文件到页面或点击选择；重复文件（同名+同大小+同修改时间）自动跳过
- **文件头校验** — 通过魔数识别 `fLaC`(FLAC)、`RIFF....WAVE`(WAV)、`ID3`/MPEG sync(MP3) 签名，防止扩展名伪造
- **实时进度** — 上传进度（0–50%）+ 转码进度（50–100%）双阶段展示，基于 SSE 推送
- **下载链接** — 下载时自动还原原始文件名（去除 UUID 段）
- **并发控制** — 同时最多运行 2 个 ffmpeg 进程，超出排队等待（上限 10 个）
- **自动清理** — 临时文件 30 分钟后自动删除，任务数据 60 分钟后过期
- **优雅关闭** — 收到 `SIGTERM`/`SIGINT` 时终止所有活跃 ffmpeg 进程，然后安全关闭 HTTP 服务

## 技术栈

| 层       | 技术                                                     |
| -------- | -------------------------------------------------------- |
| 后端     | Node.js + Express 5                                      |
| 前端     | 原生 JavaScript（无框架）                                |
| 转码引擎 | ffmpeg（通过 `@ffmpeg-installer/ffmpeg` 提供二进制文件） |
| 文件上传 | multer 2                                                 |
| 文件校验 | file-type（读取文件头魔数）                              |
| 并发队列 | p-queue                                                  |
| 实时通信 | Server-Sent Events (SSE)                                 |
| 限流     | express-rate-limit                                       |

## 快速开始

### 环境要求

- Node.js ≥ 18
- **仅支持 Windows**（ffmpeg 路径硬编码为 `C:/ffmpeg/`，详见[设计说明](#ffmpeg-路径处理)）
- 首次运行可能需要管理员权限创建 `C:/ffmpeg/` 目录

### 安装与启动

```bash
# 克隆仓库
git clone <repo-url>
cd flac-to-mp3-converter

# 安装依赖
npm install

# 启动服务（默认监听 3000 端口）
npm start
```

启动后访问 `http://localhost:3000`。

首次启动时会自动将 ffmpeg 二进制文件拷贝到 `C:/ffmpeg/ffmpeg.exe`，并自动创建 `uploads/` 和 `outputs/` 目录。

### 自定义端口

```bash
PORT=8080 npm start
```

### 单文件可执行程序 (Windows)

构建一个独立的 `.exe` 文件（约 253 MB），内含 Node.js 运行时、ffmpeg 和应用本身——目标机器无需安装任何依赖：

```bash
npm run build
```

输出位置：`dist/mp3-converter.exe`

该可执行文件基于 Node.js SEA（Single Executable Application）技术。双击或从终端运行即可——无需安装 Node.js 或 ffmpeg。首次运行时会自动将 ffmpeg 提取到 `C:/ffmpeg/ffmpeg.exe`。

> **注意**：防病毒软件可能因二进制打包机制对该 exe 报毒，此为误报。

## API

### POST /api/convert

上传音频文件（FLAC / WAV / MP3）并开始转换。

- **Content-Type**: `multipart/form-data`
- **字段名**: `files`（可传多个文件）
- **字段名**: `targetFormat` — `mp3`、`wav` 或 `flac`（必填，所有上传文件共享同一目标格式）
- **限制**: 单个文件最大 500MB，单次最多 10 个文件，仅接受 `.flac` / `.wav` / `.mp3` 扩展名
- **限流**: `/api/` 路径 15 分钟内最多 30 次请求

**成功响应** (200):

```json
{
  "taskIds": ["uuid-1", "uuid-2"]
}
```

**错误响应**:

| 状态码 | 说明                              |
| ------ | --------------------------------- |
| 400    | 文件格式无效 / 非有效音频文件     |
| 413    | 单个文件超过 500MB                |
| 429    | 请求过于频繁 / 队列已满（上限10） |
| 507    | 服务器磁盘空间不足（< 1 GB）      |

### GET /api/progress/:taskId

SSE 端点，监听单个任务的转换进度。连接保持打开，每 500ms 推送一次。**12 分钟**超时（注意：与批量端点不同）。

**事件类型**:

| 事件         | 说明                           |
| ------------ | ------------------------------ |
| `progress`   | 进度更新，`{ percent: 0-100 }` |
| `complete`   | 转换完成，`{ downloadUrl }`    |
| `task-error` | 转换失败 / 任务过期            |

### GET /api/batch-progress?ids=id1,id2,id3

SSE 端点，批量监听多个任务的转换进度。每 1000ms 轮询一次。发送 `progress`、`complete`、`task-error` 三种事件——每个事件带 `taskId` 字段用于区分。所有任务完成后自动关闭连接。**30 分钟**超时。

示例：

```bash
curl -N "http://localhost:3000/api/batch-progress?ids=task1-uuid,task2-uuid"
```

### GET /downloads/:filename

下载转换后的文件。文件名中的 UUID 段会被自动去除，下载时恢复为原始文件名。

> **下载链接有效期**：只要服务器在运行且文件未超过 30 分钟即可下载。服务重启后所有之前的下载链接失效。

## 浏览器兼容性

Chrome、Firefox、Edge、Safari（现代版本）。需要支持 EventSource (SSE)、拖拽 API、`fetch` 和 `FormData`。

## 项目结构

```
flac-to-mp3-converter/
├── server.js                # 入口：Express 配置、中间件、清理定时器
├── build-sea.js             # SEA 单文件可执行程序构建脚本
├── routes/
│   ├── convert.js           # POST /api/convert — 上传、魔数验证、ffmpeg 队列
│   └── progress.js          # SSE 端点 — 单任务 & 批量进度推送
├── public/
│   ├── index.html           # 前端页面（中文）
│   ├── js/
│   │   └── app.js           # 上传、SSE 监听、格式选择器、打赏弹窗
│   └── css/
│       └── style.css        # 深色主题，响应式适配（≤520px）
├── uploads/                 # 上传临时目录（gitignore，自动创建）
├── outputs/                 # 转码输出目录（gitignore，自动创建）
├── dist/                    # SEA 构建输出（gitignore）
├── package.json
├── README.md
├── README.zh.md
└── CHANGELOG.md
```

## 配置

所有可调参数集中在 `server.js` 顶部的 `CONFIG` 对象中。在启动服务前编辑该文件修改参数。

| 参数                         | 默认值  | 说明                 |
| ---------------------------- | ------- | -------------------- |
| `PORT`                       | 3000    | 服务端口             |
| `MAX_FILE_SIZE`              | 500 MB  | 单文件大小上限       |
| `MP3_BITRATE`                | `320k`  | MP3 输出比特率       |
| `MAX_CONCURRENT_CONVERSIONS` | 2       | 并行转码数           |
| `MAX_QUEUE_SIZE`             | 10      | 队列容量上限         |
| `MAX_FILES_PER_REQUEST`      | 10      | 单次请求最大文件数   |
| `PROGRESS_TIMEOUT_MS`        | 30 分钟 | SSE 进度超时（批量） |
| `FILE_MAX_AGE_MS`            | 30 分钟 | 临时文件保留时间     |
| `CLEANUP_INTERVAL_MS`        | 10 分钟 | 清理任务执行间隔     |

## 设计说明

### ffmpeg 路径处理

Windows 下 `child_process.spawn` 无法正确处理含空格的路径，因此启动时将 `@ffmpeg-installer/ffmpeg` 提供的 ffmpeg 二进制文件拷贝到 `C:/ffmpeg/ffmpeg.exe`（无空格路径）。这是当前版本仅支持 Windows 的原因。

> **macOS/Linux 用户**：修改 `routes/convert.js` 中的 `FFMPEG_DIR`，并使用系统安装的 ffmpeg 替代 `@ffmpeg-installer/ffmpeg`。

### 转码器选择逻辑

`routes/convert.js` 中的 `buildFfmpegArgs()` 根据输入→输出格式选择编码器对：

- **不同格式**：使用对应编码器——`libmp3lame` (MP3)、`pcm_s16le` (WAV)、`flac` (FLAC)
- **相同格式**：使用 `-codec:a copy` 流拷贝（无需重新编码，无损直通）

### 并发模型

使用 `p-queue` 限制同时运行的 ffmpeg 进程数为 2，避免 CPU 和内存过载。队列容量为 10，超出返回 HTTP 429。队列容量检查是原子性的（JavaScript 单线程保证检查与插入之间没有 `await`）。

### 内存状态

任务状态存储在内存中的 `Map` 对象内，通过 Express 的 `app.locals` 在路由间共享。这意味着：

- 服务重启后所有进行中和已完成的任务信息会丢失
- 已完成任务的下载链接仅在服务运行期间有效

### 安全措施

- **无 shell 注入**：通过 `child_process.spawn` 传参数数组调用 ffmpeg（无 shell 中间层）
- **魔数验证**：所有文件通过文件头签名验证后才开始排队（`Promise.allSettled` 确保所有文件通过后再入队）
- **扩展名过滤**：后端通过 multer 过滤 `.flac`/`.wav`/`.mp3` 扩展名
- **路径遍历防护**：下载路由使用 `path.basename()` 约束文件名
- **限流**：`/api/` 路径 15 分钟内最多 30 次请求
- **安全头**：内联中间件设置 CORS、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、Permissions-Policy
- **磁盘空间检查**：`fs.statfsSync` 确认剩余空间 ≥1GB 后才接受上传

### 优雅关闭

收到 `SIGTERM`/`SIGINT` 时：

1. 调用 `routes/convert.js` 暴露的 `shutdown()` 方法
2. 遍历 `activeProcesses` Set，终止所有运行中的 ffmpeg 进程
3. HTTP 服务关闭，10 秒超时后强制退出

## 常见问题排查

| 问题                   | 可能原因                      | 解决方法                                  |
| ---------------------- | ----------------------------- | ----------------------------------------- |
| 启动时 ffmpeg 拷贝失败 | 对 `C:\ffmpeg\` 无写入权限    | 以管理员身份运行终端，或手动创建该目录    |
| 端口 3000 已被占用     | 其他服务正在使用该端口        | 使用 `PORT=8080 npm start` 或终止占用进程 |
| "Task expired" 错误    | 服务已重启 / 任务超过 60 分钟 | 重新上传文件                              |
| 上传中途失败           | 文件超过 500 MB 限制          | 拆分文件或调整 `MAX_FILE_SIZE`            |
| "请求过于频繁" (429)   | API 请求过于频繁              | 等待约 15 分钟后再试                      |
| 下载的 MP3 没有元数据  | ffmpeg `map_metadata` 限制    | 部分元数据（封面图片）无法原样复制到 MP3  |
| 杀毒软件报 exe 为病毒  | SEA 打包的二进制嵌套机制      | 此为误报，添加排除规则即可                |

## 常见问题 (FAQ)

**问：服务重启后我的文件去哪了？**  
答：所有任务状态和下载链接都存储在内存中——重启服务会清空它们。文件本身 30 分钟后从磁盘删除。请及时下载。

**问：为什么一次只能转换 2 个文件？**  
答：这是为了防止 CPU 和内存过载。你可以一次上传最多 10 个文件，它们会在队列中依次处理。

**问：可以更改输出比特率或格式吗？**  
答：比特率可在 `CONFIG` 对象的 `MP3_BITRATE` 中调整。输出格式在界面上选择（MP3 / WAV / FLAC 三选一）。

**问：这个应用能在 Linux 或 macOS 上运行吗？**  
答：不能直接运行——ffmpeg 路径硬编码为 `C:/ffmpeg/`。迁移指南见[设计说明](#ffmpeg-路径处理)。

**问：`donate-qr.png` 图片放在哪里？**  
答：放在项目根目录。运行时文件名会被随机混淆以防止盗链。

**问：我的使用行为会被追踪吗？**  
答：应用使用 Google Analytics、百度统计和 Plausible 进行匿名使用统计。不会发送任何音频文件或个人数据。

## License

ISC
