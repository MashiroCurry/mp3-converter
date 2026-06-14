const { Router } = require('express');

const router = Router();

// Track active SSE connections to prevent resource exhaustion
const activeSSEConnections = new Set();
const MAX_SSE_CONNECTIONS = 50;

// NOTE: /batch-progress must be defined BEFORE /progress/:taskId
// otherwise Express matches /batch-progress against :taskId first.

function onSSEConnect(req, res) {
  if (activeSSEConnections.size >= MAX_SSE_CONNECTIONS) {
    res.status(429).json({ error: 'SSE 连接过多，请稍后再试' });
    return false;
  }
  activeSSEConnections.add(res);
  res.on('close', () => { activeSSEConnections.delete(res); });
  return true;
}

// GET /api/batch-progress?ids=id1,id2,id3
router.get('/batch-progress', (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean);
  if (ids.length === 0) {
    return res.status(400).json({ error: '缺少 ids 参数' });
  }

  if (!onSSEConnect(req, res)) return;

  const tasks = req.app.locals.tasks;
  const existing = ids.filter(id => tasks.has(id));
  if (existing.length === 0) {
    return res.status(404).json({ error: '所有任务不存在或已过期' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Disable socket timeout for long-lived SSE connection
  req.socket.setTimeout(0);

  // Send initial state for all tasks
  for (const id of existing) {
    const task = tasks.get(id);
    res.write(`event: progress\ndata: ${JSON.stringify({ taskId: id, percent: task.percent })}\n\n`);
  }

  const sentClosed = new Set();   // tasks that already got complete/error
  const lastPercents = {};        // track last-sent percent per task

  const interval = setInterval(() => {
    if (res.destroyed) {
      clearInterval(interval);
      clearTimeout(timeout);
      return;
    }

    let hadActivity = false;

    for (const id of existing) {
      if (sentClosed.has(id)) continue;

      if (!tasks.has(id)) {
        res.write(`event: task-error\ndata: ${JSON.stringify({ taskId: id, message: '任务已过期' })}\n\n`);
        sentClosed.add(id);
        hadActivity = true;
        continue;
      }

      const task = tasks.get(id);

      if (task.status === 'done') {
        res.write(`event: complete\ndata: ${JSON.stringify({ taskId: id, downloadUrl: task.downloadUrl })}\n\n`);
        sentClosed.add(id);
        hadActivity = true;
      } else if (task.status === 'cancelled') {
        res.write(`event: task-error\ndata: ${JSON.stringify({ taskId: id, message: '已取消' })}\n\n`);
        sentClosed.add(id);
        hadActivity = true;
      } else if (task.status === 'error') {
        res.write(`event: task-error\ndata: ${JSON.stringify({ taskId: id, message: task.errorMessage || '转换失败' })}\n\n`);
        sentClosed.add(id);
        hadActivity = true;
      } else if (task.percent !== (lastPercents[id] || 0)) {
        lastPercents[id] = task.percent;
        res.write(`event: progress\ndata: ${JSON.stringify({ taskId: id, percent: task.percent })}\n\n`);
        hadActivity = true;
      }
    }

    if (sentClosed.size >= existing.length) {
      clearInterval(interval);
      clearTimeout(timeout);
      res.end();
      return;
    }

    // Send keepalive heartbeat if no activity this cycle
    if (!hadActivity) {
      res.write(': keepalive\n\n');
    }
  }, 1000);

  const timeout = setTimeout(() => {
    for (const id of existing) {
      if (!sentClosed.has(id)) {
        res.write(`event: task-error\ndata: ${JSON.stringify({ taskId: id, message: '转换超时，请重试' })}\n\n`);
        sentClosed.add(id);
      }
    }
    clearInterval(interval);
    res.end();
  }, req.app.locals.CONFIG.PROGRESS_TIMEOUT_MS);

  req.on('close', () => {
    clearInterval(interval);
    clearTimeout(timeout);
  });
});

router.get('/progress/:taskId', (req, res) => {
  if (!onSSEConnect(req, res)) return;

  const { taskId } = req.params;
  const tasks = req.app.locals.tasks;

  const task = tasks.get(taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  req.socket.setTimeout(0);

  res.write(`event: progress\ndata: ${JSON.stringify({ percent: task.percent })}\n\n`);

  let lastPercent = task.percent;

  const interval = setInterval(() => {
    if (!tasks.has(taskId)) {
      res.write(`event: task-error\ndata: ${JSON.stringify({ message: '任务已过期' })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }

    if (task.status === 'done') {
      res.write(`event: complete\ndata: ${JSON.stringify({ downloadUrl: task.downloadUrl })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }

    if (task.status === 'cancelled') {
      res.write(`event: task-error\ndata: ${JSON.stringify({ message: '已取消' })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }

    if (task.status === 'error') {
      res.write(`event: task-error\ndata: ${JSON.stringify({ message: task.errorMessage || '转换失败' })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }

    if (task.percent !== lastPercent) {
      lastPercent = task.percent;
      res.write(`event: progress\ndata: ${JSON.stringify({ percent: task.percent })}\n\n`);
    } else {
      res.write(': keepalive\n\n');
    }
  }, 500);

  const timeout = setTimeout(() => {
    res.write(`event: task-error\ndata: ${JSON.stringify({ message: '转换超时，请重试' })}\n\n`);
    clearInterval(interval);
    res.end();
  }, req.app.locals.CONFIG.PROGRESS_TIMEOUT_MS);

  req.on('close', () => {
    clearInterval(interval);
    clearTimeout(timeout);
  });
});

module.exports = router;
