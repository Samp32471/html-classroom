const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, name }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.name = name || 'Anonymous';

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        code: `<!DOCTYPE html>\n<html>\n<head>\n  <title>Hello</title>\n</head>\n<body>\n  <h1>Hello, class!</h1>\n</body>\n</html>`,
        users: new Map(),
      });
    }

    const room = rooms.get(roomId);
    room.users.set(socket.id, socket.name);
    socket.emit('init', { code: room.code });
    io.to(roomId).emit('users', Array.from(room.users.values()));
  });

  socket.on('code-change', ({ roomId, code }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.code = code;
      socket.to(roomId).emit('code-update', code);
    }
  });

  socket.on('disconnect', () => {
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Classroom running at http://localhost:${PORT}`);
});
