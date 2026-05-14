
import { pool } from "../../db/pool.js";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { mapPriorityToType, type NotificationDTO, type NotificationInput } from "./type.js";

import { getIO } from "../../socket/socket.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";

export async function ListNotification(st_id: number): Promise<NotificationDTO[]> {
    const [res] = await pool.query<RowDataPacket[] & NotificationDTO[]>(`SELECT * FROM Notifications WHERE target_id = ? ORDER BY noti_id DESC `, [st_id]
    )
    return res
    // return res.map(row => ({
    //     ...row,
    //     priority: mapPriorityToType(row.priority)
    // })) as NotificationDTO[]
}

export async function getEmpBySTId(st_id: number): Promise<number[]> {
    const [res] = await pool.query<RowDataPacket[]>(`SELECT e_id FROM Employees WHERE st_id = ?`, [st_id])
    return res.map((row) => row.e_id)
}

export async function UpdateAsRead(noti_id: number): Promise<void> {
    const [res] = await pool.query<ResultSetHeader>(
        `UPDATE Notifications SET is_read = 1, read_at = ? WHERE noti_id = ?`,
        [new Date(), noti_id]
    );
    if (res.affectedRows === 0) throw new ApiError(404, CommonMessages.notFound);
}

export async function UpdateAllRead(st_id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
        `UPDATE Notifications SET is_read = 1, read_at = ? WHERE target_id = ? AND is_read = 0`,
        [new Date(), st_id]
    );
}


export async function CreateNotification(input: NotificationInput): Promise<void> {
    const conn = await pool.getConnection();
    let notification: Record<string, unknown>;
    try {
        await conn.beginTransaction();
        const MasterData = {
            target_type: input.target_type,
            target_id: input.target_id,
            type: input.type,
            title: input.title,
            message: input.message,
            action_url: input.action_url,
            ref_type: input.ref_type,
            ref_id: input.ref_id,
            priority: input.priority ?? "NORMAL",
        }
        const [result] = await conn.query<ResultSetHeader>("INSERT INTO Notifications SET ?", MasterData);

        await conn.commit();

        notification = {
            noti_id: result.insertId,
            ...MasterData,
            is_read: 0,
            read_at: null,
            created_at: new Date(),
        };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    const roomName = `${input.target_type}_${input.target_id}`;
    getIO().to(roomName).emit("notification:new", notification);
}