
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import "dotenv/config";

const app = express();
const httpServer = createServer(app);

const PORT = Number(process.env.PORT) || 3001;

const allowedOrigins = (
  process.env.CLIENT_URL || "http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

app.get("/", (_req, res) => {
  res.status(200).send("Signaling server is running");
});

io.engine.on("connection_error", (err) => {
  console.error("Socket.IO connection error:", {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  console.log("Transport:", socket.conn.transport.name);

  socket.on("join-room", async (rawRoomId: string) => {
    const roomId = rawRoomId?.trim();

    if (!roomId) {
      socket.emit("join-error", "Room ID is required");
      return;
    }

    const currentRoom = [...socket.rooms].find(
      (room) => room !== socket.id
    );

    if (currentRoom && currentRoom !== roomId) {
      socket.emit("join-error", "Leave your current room first");
      return;
    }

    const room = io.sockets.adapter.rooms.get(roomId);

    if (room && room.size >= 2 && !room.has(socket.id)) {
      socket.emit("room-full");
      return;
    }

    const peerId = [...(room ?? [])].find(
      (id) => id !== socket.id
    );

    await socket.join(roomId);

    socket.emit("joined-room", { roomId, peerId });

    if (peerId) {
      io.to(peerId).emit("user-joined", {
        peerId: socket.id,
      });
    }

    console.log(`${socket.id} joined room ${roomId}`);
  });

  socket.on("offer", ({ target, offer }) => {
    if (typeof target !== "string" || !offer) return;

    io.to(target).emit("offer", {
      from: socket.id,
      offer,
    });
  });

  socket.on("answer", ({ target, answer }) => {
    if (typeof target !== "string" || !answer) return;

    io.to(target).emit("answer", {
      from: socket.id,
      answer,
    });
  });

  socket.on("ice-candidate", ({ target, candidate }) => {
    if (typeof target !== "string" || !candidate) return;

    io.to(target).emit("ice-candidate", {
      from: socket.id,
      candidate,
    });
  });

  socket.on("leave-room", async (roomId: string) => {
    if (typeof roomId !== "string") return;
    if (!socket.rooms.has(roomId)) return;

    socket.to(roomId).emit("user-left", {
      peerId: socket.id,
    });

    await socket.leave(roomId);

    console.log(`${socket.id} left room ${roomId}`);
  });

  socket.on("disconnecting", (reason) => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit("user-left", {
          peerId: socket.id,
        });
      }
    }

    console.log("Disconnecting:", socket.id, reason);
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected:", socket.id, reason);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Signaling server running on port ${PORT}`);
});
