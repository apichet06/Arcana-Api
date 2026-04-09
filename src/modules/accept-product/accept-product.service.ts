import { type ResultSetHeader, type RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { AccepetProduct } from "./accept-product.type.js";

export async function AcceptProduct(id: number, data: AccepetProduct): Promise<void> {
    try {

        const [res] = await pool.query<ResultSetHeader>(`UPDATE Products SET ? WHERE p_id = ?`, [data, id])
        if (res.affectedRows === 0)
            res.affectedRows

    } catch (error) {
        throw error;
    }

}

export async function CountAcceptProduct(): Promise<number> {
    try {
        const [rows] = await pool.query<RowDataPacket[]>(
            `SELECT COUNT(*) as count FROM Products WHERE p_isAccept = false`
        );

        return rows[0]!.count ?? 0;
    } catch (error) {
        throw error;
    }
}