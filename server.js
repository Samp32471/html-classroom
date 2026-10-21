import 'dotenv/config'; // must stay first so .env is loaded before anything reads process.env
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcrypt';

// __filename / __dirname do not exist in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEACHER_PIN_HASH = process.env.TEACHER_PIN_HASH;
if (!TEACHER_PIN_HASH) {
  console.error('FATAL: TEACHER_PIN_HASH is not set.');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const MAX_JOIN_ATTEMPTS = 5;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------------------------------------------------------------------------
// Debug helpers: prove WHICH file is running and WHICH requests reach it
// (remove these three lines once everything works)
// ---------------------------------------------------------------------------
console.log('RUNNING FILE:', __filename);
app.use((req, res, next) => { console.log('REQ', req.method, req.url); next(); });
app.get('/api/ping', (req, res) => res.json({ ok: true, file: __filename }));

// Only JSON parser here. NO express.static yet.
app.use(express.json({ limit: '200kb' }));

function makeDefaultWorkspace() {
  return [
    { id: 'index.html', name: 'index.html', type: 'file', parentId: null, language: 'html',
      content: `<!DOCTYPE html>\n<html>\n<head>\n  <title>Hello</title>\n</head>\n<body>\n  <h1>Hello, class!</h1>\n</body>\n</html>` },
    { id: 'app.jsx', name: 'app.jsx', type: 'file', parentId: null, language: 'react',
      content: `function App() {\n  return <h1>Hello React!</h1>;\n}\nReactDOM.createRoot(document.getElementById("root")).render(<App />);` },
    { id: 'server.js', name: 'server.js', type: 'file', parentId: null, language: 'node',
      content: `console.log("Hello from Node!");` },
  ];
}

const rooms = new Map();
// One-time-per-connection tokens that allow a teacher's browser to open /terminal
const terminalTokens = new Map(); // token -> socket.id

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  let joinAttempts = 0;

  socket.on('join-room', async ({ roomId, name, role, pin } = {}) => {
    joinAttempts++;
    if (joinAttempts > MAX_JOIN_ATTEMPTS) {
      socket.emit('join-error', { message: 'Too many attempts.' });
      socket.disconnect(true);
      return;
    }
    const requestedRole = role === 'teacher' ? 'teacher' : 'student';

    if (requestedRole === 'teacher') {
      if (!pin || typeof pin !== 'string') {
        socket.emit('join-error', { message: 'Teacher PIN is required.' });
        return;
      }
      let pinValid = false;
      try {
        pinValid = await bcrypt.compare(pin, TEACHER_PIN_HASH);
      } catch (err) {
        socket.emit('join-error', { message: 'Authentication failed.' });
        return;
      }
      if (!pinValid) {
        socket.emit('join-error', { message: 'Incorrect teacher PIN.' });
        return;
      }
    }

    if (!roomId || typeof roomId !== 'string' || roomId.length > 100) {
      socket.emit('join-error', { message: 'Invalid room code.' });
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.name = (typeof name === 'string' && name ? name : 'Anonymous').slice(0, 50);
    socket.role = requestedRole;

    // Terminal access: only a PIN-verified teacher socket gets a token
    if (socket.terminalToken) { terminalTokens.delete(socket.terminalToken); socket.terminalToken = null; }
    if (requestedRole === 'teacher') {
      socket.terminalToken = crypto.randomBytes(24).toString('hex');
      terminalTokens.set(socket.terminalToken, socket.id);
      socket.emit('terminal-token', socket.terminalToken);
    }

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { workspace: makeDefaultWorkspace(), users: new Map(), notes: null });
    }
    const room = rooms.get(roomId);
    room.users.set(socket.id, { name: socket.name, role: socket.role });

    socket.emit('init', { workspace: room.workspace });
    io.to(roomId).emit('users', Array.from(room.users.values()));
    if (room.notes) socket.emit('notes-shared', room.notes);
  });

  socket.on('workspace-change', ({ roomId, workspace } = {}) => {
    if (socket.roomId !== roomId) return;
    if (!Array.isArray(workspace) || workspace.length > 200) return;
    const room = rooms.get(roomId);
    if (room) {
      room.workspace = workspace;
      socket.to(roomId).emit('workspace-update', workspace);
    }
  });

  socket.on('share-notes', ({ roomId, tab, open } = {}) => {
    if (socket.role !== 'teacher') {
      socket.emit('error-msg', 'Only the teacher can share notes.');
      return;
    }
    if (socket.roomId !== roomId) return;
    if (!['html', 'react', 'node'].includes(tab)) return;
    const room = rooms.get(roomId);
    if (room) room.notes = { tab, open: !!open };
    socket.to(roomId).emit('notes-shared', { tab, open: !!open });
  });

  socket.on('disconnect', () => {
    if (socket.terminalToken) terminalTokens.delete(socket.terminalToken);
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.users.delete(socket.id);
      io.to(roomId).emit('users', Array.from(room.users.values()));
      if (room.users.size === 0) {
        setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && r.users.size === 0) rooms.delete(roomId);
        }, 3600000);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// API routes BEFORE static
// ---------------------------------------------------------------------------
let isol8Engine = null;
let isol8Ready = false;
let isol8Error = 'not started yet';
let isol8Init = null;

// Safe to call repeatedly: it retries on each Run until Docker is available
function initIsol8() {
  if (isol8Ready) return Promise.resolve();
  if (isol8Init) return isol8Init;
  isol8Init = (async () => {
    try {
      const { DockerIsol8 } = await import('@isol8/core');
      const engine = new DockerIsol8({ network: 'none', timeoutMs: 5000 });
      await engine.start();
      isol8Engine = engine;
      isol8Ready = true;
      isol8Error = null;
      console.log('isol8 sandbox engine started.');
    } catch (err) {
      isol8Error = err && err.message ? err.message : String(err);
      console.warn('isol8 sandbox engine unavailable:', isol8Error);
    } finally {
      isol8Init = null;
    }
  })();
  return isol8Init;
}
initIsol8();

app.post('/api/run-node', async (req, res) => {
  console.log('[run-node] request received');
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'No code provided' });
  }
  if (code.length > 100000) {
    return res.status(400).json({ error: 'Code too large (max 100KB)' });
  }
  if (!isol8Ready || !isol8Engine) await initIsol8(); // retry, e.g. Docker was started after the server
  if (!isol8Ready || !isol8Engine) {
    return res.status(503).json({
      error: 'Sandbox unavailable',
      details: 'Docker is not running or @isol8/core failed to start. Reason: ' + isol8Error,
    });
  }
  try {
    const result = await isol8Engine.execute({ code, runtime: 'node', timeoutMs: 5000 });
    res.json({
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      success: result.exitCode === 0,
      exitCode: result.exitCode,
    });
  } catch (err) {
    res.status(500).json({ error: 'Execution failed', details: err.message });
  }
});

// Any other /api/* request gets JSON (never the HTML "Cannot POST" page)
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` });
});

// Static AFTER API
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Terminal
// Gives a real shell on this machine, so it requires a teacher token
// (issued only after the teacher PIN is verified).
// ---------------------------------------------------------------------------
let pty = null;
let ptyWorks = false;
try {
  const ptyModule = await import('@lydell/node-pty'); // top-level await (ESM)
  pty = ptyModule.default ?? ptyModule;
  const testShell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const testPty = pty.spawn(testShell, [], {
    name: 'xterm-color', cols: 80, rows: 24,
    cwd: process.env.HOME || process.cwd(), env: process.env,
  });
  testPty.kill();
  ptyWorks = true;
  console.log('node-pty loaded and tested successfully.');
} catch (err) {
  ptyWorks = false;
  console.warn('node-pty not working:', err.message);
}

const wss = new WebSocketServer({ server, path: '/terminal' });

wss.on('connection', (ws, req) => {
  let token = '';
  try { token = new URL(req.url, 'http://localhost').searchParams.get('token') || ''; } catch (e) {}
  if (!terminalTokens.has(token)) {
    ws.send('\r\nTerminal is available to the teacher only.\r\n');
    ws.close();
    return;
  }
  if (!ptyWorks) {
    ws.send('\r\nTerminal unavailable on this server.\r\n');
    ws.close();
    return;
  }
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color', cols: 80, rows: 24,
      cwd: process.env.HOME || process.cwd(), env: process.env,
    });
  } catch (err) {
    ws.send(`\r\nFailed to spawn shell: ${err.message}\r\n`);
    ws.close();
    return;
  }
  ptyProcess.onData((data) => { try { ws.send(data); } catch (e) {} });
  ws.on('message', (msg) => {
    const str = msg.toString();
    if (str.startsWith('{')) {
      try {
        const cmd = JSON.parse(str);
        if (cmd.type === 'resize' && cmd.cols && cmd.rows) {
          ptyProcess.resize(cmd.cols, cmd.rows);
          return;
        }
      } catch (e) {}
    }
    try { ptyProcess.write(str); } catch (e) {}
  });
  ws.on('close', () => { try { ptyProcess.kill(); } catch (e) {} });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`FATAL: port ${PORT} is already in use by another process.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Classroom running at http://localhost:${PORT}`);
});