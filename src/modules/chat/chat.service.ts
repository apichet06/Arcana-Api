import { pool } from "../../db/pool.js";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { ConversationDTO, ConversationWithBuyerDTO, MessageDTO } from "./chat.type.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { getIO } from "../../socket/socket.js";

// ── Buyer ──────────────────────────────────────────────────────────────────

export async function getOrCreateConversation(
    userId: number,
    stId: number = 1
): Promise<ConversationDTO> {
    const conn = await pool.getConnection();
    try {
        const [existing] = await conn.query<(RowDataPacket & ConversationDTO)[]>(
            `SELECT c.* FROM Conversations c
             INNER JOIN Conversation_participants cp ON cp.conv_id = c.conv_id
             WHERE cp.actor_type = 'user' AND cp.actor_id = ? AND c.st_id = ? AND c.status = 'open'
             LIMIT 1`,
            [userId, stId]
        );

        if (existing[0]) return existing[0];

        await conn.beginTransaction();

        const [convResult] = await conn.query<ResultSetHeader>(
            `INSERT INTO Conversations (channel, st_id, status, created_at, updated_at)
             VALUES ('live_chat', ?, 'open', NOW(), NOW())`,
            [stId]
        );
        const conv_id = convResult.insertId;

        await conn.query(
            `INSERT INTO Conversation_participants (actor_type, actor_id, role_in_conv, joined_at, conv_id)
             VALUES ('user', ?, 'customer', NOW(), ?)`,
            [userId, conv_id]
        );

        await conn.commit();

        const [newConv] = await conn.query<(RowDataPacket & ConversationDTO)[]>(
            `SELECT * FROM Conversations WHERE conv_id = ?`,
            [conv_id]
        );

        return newConv[0]!;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function getMessages(conv_id: number, userId: number): Promise<MessageDTO[]> {
    const [participants] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'user' AND actor_id = ?`,
        [conv_id, userId]
    );
    if (!participants[0]) throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `SELECT * FROM messages WHERE conv_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
        [conv_id]
    );
    return rows;
}

export async function sendMessage(
    conv_id: number,
    userId: number,
    body: string,
    message_type: string = 'text'
): Promise<MessageDTO> {
    const [participants] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'user' AND actor_id = ?`,
        [conv_id, userId]
    );
    if (!participants[0]) throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO messages (conv_id, sender_type, sender_id, message_type, body, created_at)
         VALUES (?, 'user', ?, ?, ?, NOW())`,
        [conv_id, userId, message_type, body]
    );

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `SELECT * FROM messages WHERE msg_id = ?`,
        [result.insertId]
    );

    const message = rows[0]!;

    // notify conversation room + store room for admin
    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    const stId = convRows[0]?.st_id ?? 1;

    try {
        const io = getIO();
        io.to(`CONV_${conv_id}`).emit('new_message', message);
        io.to(`STORE_${stId}`).emit('chat:new_message', { conv_id, message });
    } catch { /* no-op */ }

    await pool.query(`UPDATE Conversations SET updated_at = NOW() WHERE conv_id = ?`, [conv_id]);

    return message;
}

// ── Admin ──────────────────────────────────────────────────────────────────

export async function adminGetConversations(storeId: number): Promise<ConversationWithBuyerDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & ConversationWithBuyerDTO)[]>(
        `SELECT
            c.conv_id, c.channel, c.subject, c.status, c.st_id, c.created_at, c.updated_at,
            u.u_id AS buyer_id,
            u.u_username AS buyer_username,
            (
                SELECT m.body FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message,
            (
                SELECT m.created_at FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_at,
            (
                SELECT COUNT(*) FROM messages m
                WHERE m.conv_id = c.conv_id AND m.sender_type = 'user' AND m.deleted_at IS NULL
                  AND m.msg_id > IFNULL(
                      (SELECT cp2.last_read_msg_id FROM Conversation_participants cp2
                       WHERE cp2.conv_id = c.conv_id AND cp2.actor_type = 'employee' LIMIT 1),
                      0
                  )
            ) AS unread_count
         FROM Conversations c
         INNER JOIN Conversation_participants cp ON cp.conv_id = c.conv_id AND cp.actor_type = 'user'
         INNER JOIN Users u ON u.u_id = cp.actor_id
         WHERE c.st_id = ?
         ORDER BY c.updated_at DESC`,
        [storeId]
    );
    return rows;
}

export async function adminGetMessages(conv_id: number, storeId: number): Promise<MessageDTO[]> {
    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    if (!convRows[0] || convRows[0].st_id !== storeId)
        throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `SELECT * FROM messages WHERE conv_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
        [conv_id]
    );
    return rows;
}

export async function adminMarkAsRead(conv_id: number, storeId: number, empId: number): Promise<void> {
    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    if (!convRows[0] || convRows[0].st_id !== storeId)
        throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    // หา msg_id ล่าสุดในห้องนี้
    const [lastMsg] = await pool.query<(RowDataPacket & { max_id: number | null })[]>(
        `SELECT MAX(msg_id) AS max_id FROM messages WHERE conv_id = ? AND deleted_at IS NULL`,
        [conv_id]
    );
    const lastMsgId = lastMsg[0]?.max_id ?? 0;
    if (!lastMsgId) return;

    // upsert แถว admin ใน Conversation_participants
    const [existing] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'employee' AND actor_id = ?`,
        [conv_id, empId]
    );

    if (existing[0]) {
        await pool.query(
            `UPDATE Conversation_participants SET last_read_msg_id = ? WHERE conv_id = ? AND actor_type = 'employee' AND actor_id = ?`,
            [lastMsgId, conv_id, empId]
        );
    } else {
        await pool.query(
            `INSERT INTO Conversation_participants (actor_type, actor_id, role_in_conv, joined_at, last_read_msg_id, conv_id)
             VALUES ('employee', ?, 'agent', NOW(), ?, ?)`,
            [empId, lastMsgId, conv_id]
        );
    }
}

export async function adminSendMessage(
    conv_id: number,
    storeId: number,
    empId: number,
    body: string,
    message_type: string = 'text'
): Promise<MessageDTO> {
    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    if (!convRows[0] || convRows[0].st_id !== storeId)
        throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO messages (conv_id, sender_type, sender_id, message_type, body, created_at)
         VALUES (?, 'employee', ?, ?, ?, NOW())`,
        [conv_id, empId, message_type, body]
    );

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `SELECT * FROM messages WHERE msg_id = ?`,
        [result.insertId]
    );

    const message = rows[0]!;

    try {
        getIO().to(`CONV_${conv_id}`).emit('new_message', message);
    } catch { /* no-op */ }

    await pool.query(`UPDATE Conversations SET updated_at = NOW() WHERE conv_id = ?`, [conv_id]);

    return message;
}
