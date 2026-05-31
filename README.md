# FLAC → MP3 Converter

一个将 FLAC 无损音频批量转换为 MP3 的单页 Web 应用。基于 Express 5 + 原生 JavaScript 前端，底层调用 ffmpeg 完成转码。

## 功能

- **批量转换** — 一次最多上传 10 个 FLAC 文件，逐个转码
- **拖拽上传** — 支持拖拽文件到页面或点击选择
- **文件头校验** — 通过魔数（`fLaC`）验证文件是否为真正的 FLAC 格式，防止扩展名伪造
- **实时进度** — 上传进度 + 转码进度双阶段展示，基于 SSE（Server-Sent Events）推送
- **下载链接** — 转换完成后直接提供 MP3 下载
- **并发控制** — 同时最多运行 2 个 ffmpeg 进程，超出排队等待
- **自动清理** — 临时文件 30 分钟后自动删除，任务数据 60 分钟后过期

## 技术栈

| 层       | 技术                                                    |
| -------- | ------------------------------------------------------- |
| 后端     | Node.js + Express 5                                     |
| 前端     | 原生 JavaScript（无框架）                                |
| 转码引擎 | ffmpeg（通过 `@ffmpeg-installer/ffmpeg` 提供二进制文件） |
| 文件上传 | multer 2                                                |
| 文件校验 | file-type（读取文件头魔数）                               |
| 并发队列 | p-queue                                                 |
| 实时通信 | Server-Sent Events (SSE)                                |

## 快速开始

### 环境要求

- Node.js ≥ 18
- Windows（ffmpeg 路径硬编码为 `C:/ffmpeg/`，详见[设计说明](#设计说明)）

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

首次启动时会自动将 ffmpeg 二进制文件拷贝到 `C:/ffmpeg/ffmpeg.exe`。

### 自定义端口

```bash
PORT=8080 npm start
```

## API

### POST /api/convert

上传 FLAC 文件并开始转换。

- **Content-Type**: `multipart/form-data`
- **字段名**: `files`（可传多个）
- **限制**: 单个文件最大 500MB，单次最多 10 个文件，仅接受 `.flac` 扩展名

**成功响应** (200):

```json
{
  "taskIds": ["uuid-1", "uuid-2"]
}
```

**错误响应**:

| 状态码 | 说明                       |
| ------ | -------------------------- |
| 400    | 文件格式无效 / 非 FLAC 文件 |
| 413    | 单个文件超过 500MB         |
| 429    | 队列已满（上限 10 个任务）  |
| 507    | 服务器磁盘空间不足          |

### GET /api/progress/:taskId

SSE 端点，监听单个任务的转换进度。

**事件类型**:

| 事件       | 说明                          |
| ---------- | ----------------------------- |
| `progress` | 进度更新，`{ percent: 0-100 }` |
| `complete` | 转换完成，`{ downloadUrl }`    |
| `task-error` | 转换失败 / 任务过期         |

### GET /api/batch-progress?ids=id1,id2,id3

SSE 端点，批量监听多个任务的转换进度。每个事件多一个 `taskId` 字段用于区分。

### GET /downloads/:filename

下载转换后的 MP3 文件。文件名中的 UUID 部分会被自动去除，下载时恢复为原始文件名。

## 项目结构

```
flac-to-mp3-converter/
├── server.js                # 入口：Express 配置、中间件、清理定时器
├── routes/
│   ├── convert.js           # POST /api/convert — 上传、校验、转码队列
│   └── progress.js          # SSE 端点 — 单任务 & 批量进度推送
├── public/
│   ├── index.html           # 前端页面
│   ├── js/
│   │   └── app.js           # 上传、SSE 监听、打赏弹窗逻辑
│   └── css/
│       └── style.css        # 深色主题样式
├── uploads/                 # 上传临时目录（gitignore）
├── outputs/                 # 转码输出目录（gitignore）
├── package.json
└── README.md
```

## 配置

所有可调参数集中在 `server.js` 顶部的 `CONFIG` 对象：

| 参数                        | 默认值      | 说明                   |
| --------------------------- | ----------- | ---------------------- |
| `PORT`                      | 3000        | 服务端口               |
| `MAX_FILE_SIZE`             | 500 MB      | 单文件大小上限         |
| `MP3_BITRATE`               | `320k`      | MP3 输出比特率         |
| `MAX_CONCURRENT_CONVERSIONS` | 2           | 并行转码数             |
| `MAX_QUEUE_SIZE`            | 10          | 队列容量上限           |
| `MAX_FILES_PER_REQUEST`     | 10          | 单次请求最大文件数     |
| `PROGRESS_TIMEOUT_MS`       | 30 分钟     | SSE 进度超时           |
| `FILE_MAX_AGE_MS`           | 30 分钟     | 临时文件保留时间       |
| `CLEANUP_INTERVAL_MS`       | 10 分钟     | 清理任务执行间隔       |

## 设计说明

### ffmpeg 路径处理

Windows 下 `child_process.exec` 无法正确处理含空格的路径，因此启动时将 `@ffmpeg-installer/ffmpeg` 提供的 ffmpeg 二进制文件拷贝到 `C:/ffmpeg/ffmpeg.exe`（无空格路径）。这是当前版本仅支持 Windows 的原因。

### 并发模型

使用 `p-queue` 限制同时运行的 ffmpeg 进程数为 2，避免 CPU 和内存过载。队列容量为 10，超出返回 HTTP 429。

### 内存状态

任务状态存储在内存中的 `Map` 对象内，通过 Express 的 `app.locals` 在路由间共享。这意味着：
- 服务重启后所有进行中和已完成的任务信息会丢失
- 已完成任务的下载链接仅在服务运行期间有效

### 未使用的依赖

`package.json` 中的 `fluent-ffmpeg` 和 `ffmpeg-static` 实际未被使用。由于同样的空格路径问题，代码改用 `child_process.exec` 直接调用 ffmpeg。

## License

ISC
