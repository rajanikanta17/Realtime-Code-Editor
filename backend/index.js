
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import dotenv from 'dotenv';
import connectDB from "./config/database.js";
import Room from "./models/Room.js";

// Configure environment variables
dotenv.config();

const app = express();

// Connect to MongoDB
connectDB();

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? false 
      : ["http://localhost:3000", "http://localhost:5173"],
    methods: ["GET", "POST"]
  },
});

// Keep in-memory users for real-time tracking
const activeRooms = new Map(); // roomId -> Set of userNames

// Cleanup empty rooms periodically
const cleanupEmptyRooms = () => {
  for (const [roomId, users] of activeRooms.entries()) {
    if (users.size === 0) {
      activeRooms.delete(roomId);
      console.log(`🧹 Cleaned up empty room: ${roomId}`);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupEmptyRooms, 5 * 60 * 1000);

io.on("connection", (socket) => {
  console.log("User Connected", socket.id);

  let currentRoom = null;
  let currentUser = null;

  socket.on("join", async ({ roomId, userName }) => {
    try {
      // Leave previous room if exists
      if (currentRoom) {
        socket.leave(currentRoom);
        if (activeRooms.has(currentRoom)) {
          activeRooms.get(currentRoom).delete(currentUser);
          io.to(currentRoom).emit("userJoined", Array.from(activeRooms.get(currentRoom)));
          
          // Update database for previous room
          try {
            await Room.findOneAndUpdate(
              { roomId: currentRoom },
              { activeUsers: Array.from(activeRooms.get(currentRoom)) }
            );
          } catch (dbError) {
            console.error("Error updating previous room:", dbError);
          }
        }
      }

      currentRoom = roomId;
      currentUser = userName;
      socket.join(roomId);

      // Initialize active users for this room
      if (!activeRooms.has(roomId)) {
        activeRooms.set(roomId, new Set());
      }
      activeRooms.get(roomId).add(userName);

      // Find or create room in MongoDB
      let room = await Room.findOne({ roomId });
      
      if (!room) {
        room = new Room({
          roomId,
          code: "",
          language: "javascript",
          activeUsers: Array.from(activeRooms.get(roomId))
        });
        await room.save();
        console.log(`✅ Created new room: ${roomId}`);
      } else {
        // Update active users in database
        room.activeUsers = Array.from(activeRooms.get(roomId));
        await room.save();
        console.log(`✅ User joined existing room: ${roomId}`);
      }

      // Send existing code and language to the new user
      socket.emit("codeUpdate", room.code);
      socket.emit("languageUpdate", room.language);

      // Notify all users in room about updated user list
      io.to(roomId).emit("userJoined", Array.from(activeRooms.get(roomId)));

      console.log(`👤 User ${userName} joined room ${roomId}`);

    } catch (error) {
      console.error("❌ Error joining room:", error);
      socket.emit("error", "Failed to join room");
      
      // Fallback to old behavior if database fails
      if (!activeRooms.has(roomId)) {
        activeRooms.set(roomId, new Set());
      }
      activeRooms.get(roomId).add(userName);
      io.to(roomId).emit("userJoined", Array.from(activeRooms.get(roomId)));
    }
  });

  socket.on("codeChange", async ({ roomId, code }) => {
    try {
      // Update code in MongoDB
      const updatedRoom = await Room.findOneAndUpdate(
        { roomId },
        { 
          code,
          lastModified: new Date()
        },
        { upsert: true, new: true }
      );

      console.log(`💾 Code saved for room ${roomId} (${code.length} characters)`);

    } catch (error) {
      console.error("❌ Error saving code:", error);
    }

    // Always broadcast to other users (even if database fails)
    socket.to(roomId).emit("codeUpdate", code);
  });

  socket.on("languageChange", async ({ roomId, language }) => {
    try {
      // Update language in MongoDB
      await Room.findOneAndUpdate(
        { roomId },
        { 
          language,
          lastModified: new Date()
        },
        { upsert: true, new: true }
      );

      console.log(`🔧 Language changed to ${language} in room ${roomId}`);

    } catch (error) {
      console.error("❌ Error updating language:", error);
    }

    // Always broadcast to all users (even if database fails)
    io.to(roomId).emit("languageUpdate", language);
  });

  socket.on("leaveRoom", async () => {
    if (currentRoom && currentUser) {
      try {
        // Remove from active users
        if (activeRooms.has(currentRoom)) {
          activeRooms.get(currentRoom).delete(currentUser);
          
          // Update database
          await Room.findOneAndUpdate(
            { roomId: currentRoom },
            { activeUsers: Array.from(activeRooms.get(currentRoom)) }
          );

          io.to(currentRoom).emit("userJoined", Array.from(activeRooms.get(currentRoom)));
        }

        socket.leave(currentRoom);
        console.log(`👋 User ${currentUser} left room ${currentRoom}`);

        currentRoom = null;
        currentUser = null;

      } catch (error) {
        console.error("❌ Error leaving room:", error);
      }
    }
  });

  socket.on("typing", ({ roomId, userName }) => {
    socket.to(roomId).emit("userTyping", userName);
  });

  socket.on("disconnect", async () => {
    if (currentRoom && currentUser) {
      try {
        // Remove from active users
        if (activeRooms.has(currentRoom)) {
          activeRooms.get(currentRoom).delete(currentUser);
          
          // Update database
          await Room.findOneAndUpdate(
            { roomId: currentRoom },
            { activeUsers: Array.from(activeRooms.get(currentRoom)) }
          );

          io.to(currentRoom).emit("userJoined", Array.from(activeRooms.get(currentRoom)));
        }

        console.log(`🔌 User ${currentUser} disconnected from room ${currentRoom}`);

      } catch (error) {
        console.error("❌ Error handling disconnect:", error);
      }
    }
    console.log("🔌 User Disconnected:", socket.id);
  });
});

const port = process.env.PORT || 5000;
const __dirname = path.resolve();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "/frontend/dist")));

// API endpoint to get room info
app.get("/api/room/:roomId", async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }
    res.json({
      roomId: room.roomId,
      language: room.language,
      lastModified: room.lastModified,
      activeUsers: room.activeUsers,
      codeLength: room.code.length
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    activeRooms: activeRooms.size
  });
});

// Serve frontend for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "dist", "index.html"));
});

server.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
  console.log(`📊 MongoDB integration: ${process.env.MONGODB_URI ? 'Custom URI' : 'Local (localhost:27017)'}`);
  console.log(`🌐 CORS enabled for: ${process.env.NODE_ENV === 'production' ? 'production' : 'development'}`);
});
