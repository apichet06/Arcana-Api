import { Server } from "socket.io";
import type { Server as HttpServer } from "http";

let io: Server | null = null;

const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://arcanabackoffice.dev.system-samt.com",
    "https://arcana-shop.dev.system-samt.com",
];

export function initSocket(httpServer: HttpServer) {
    io = new Server(httpServer, {
        cors: {
            origin: allowedOrigins,
            methods: ["GET", "POST"],
            credentials: true,
        },
    });

    io.on("connection", (socket) => {
        console.log("socket connected:", socket.id);

        socket.on("join_user", (userId: number) => {
            socket.join(`USER_${userId}`);
            console.log(`USER_${userId} joined`);
        });

        socket.on("join_store", (storeId: number) => {
            socket.join(`STORE_${storeId}`);
            console.log(`STORE_${storeId} joined`);
        });

        socket.on("disconnect", () => {
            console.log("socket disconnected:", socket.id);
        });
    });

    return io;
}

export function getIO() {
    if (!io) {
        throw new Error("Socket.IO not initialized");
    }
    return io;
}