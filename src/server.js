'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const {
  applyPreview,
  getStateSnapshot,
  makePreview,
  normalizeOptions,
  openBrowser,
} = require('./recovery');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function parseArgs(argv) {
  const out = {
    codexHome: process.env.CODEX_HOME,
    port: 8765,
    open: true,
    token: process.env.CODEX_SIDEBAR_RECOVERY_TOKEN,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--codex-home') {
      out.codexHome = argv[i + 1];
      i += 1;
    } else if (arg === '--port') {
      out.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--no-open') {
      out.open = false;
    } else if (arg === '--token') {
      out.token = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }

  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error('无效的 --port 参数。');
  }
  return out;
}

function usage() {
  return `用法:
  codex-sidebar-recovery [--codex-home <path>] [--port <number>] [--no-open]

启动一个只监听 127.0.0.1 的本地恢复面板。工具不会上传任何数据。
`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大。');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(text);
}

function safeStaticPath(publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, 'index.html')) return null;
  return file;
}

function createServer({ codexHome, publicDir, token }) {
  const previews = new Map();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        if (url.searchParams.get('token') !== token) {
          sendJson(res, 403, { error: 'Token 缺失或无效。' });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          sendJson(res, 200, getStateSnapshot(codexHome));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preview') {
          const body = await readBody(req);
          const preview = makePreview(codexHome, body.selection || {}, normalizeOptions(body.options || {}));
          const planId = crypto.randomBytes(12).toString('hex');
          previews.set(planId, preview);
          sendJson(res, 200, { planId, preview });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/apply') {
          const body = await readBody(req);
          const preview = previews.get(String(body.planId || ''));
          if (!preview) {
            sendJson(res, 400, { error: '预览已过期或不存在，请重新点击“预览”。' });
            return;
          }
          previews.delete(String(body.planId));
          const report = applyPreview(codexHome, preview);
          sendJson(res, 200, { report });
          return;
        }
        sendJson(res, 404, { error: '未知 API 路由。' });
        return;
      }

      const file = safeStaticPath(publicDir, url.pathname);
      if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        sendText(res, 404, '未找到');
        return;
      }
      const ext = path.extname(file);
      const content = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(content);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

function startServer(options) {
  const token = options.token || crypto.randomBytes(18).toString('hex');
  const publicDir = path.resolve(__dirname, '..', 'public');
  const server = createServer({
    codexHome: options.codexHome,
    publicDir,
    token,
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      const url = `http://127.0.0.1:${port}/?token=${token}`;
      if (options.log !== false) {
    console.log(`Codex 侧边栏恢复工具已启动：${url}`);
    console.log('按 Ctrl+C 停止服务。');
      }
      if (options.open) openBrowser(url);
      resolve({ server, url, token, port });
    });
  });
}

module.exports = {
  parseArgs,
  startServer,
  usage,
};
