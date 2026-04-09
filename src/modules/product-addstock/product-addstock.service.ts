import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import type { AddStockProduct, InventoryLogResponse, ReduceStoskProduct, StockProductResponse } from "./product-addstock.type.js";
import { ApiError } from "../../shared/errors/ApiError.js";

export async function list(st_id: number, log_code: string): Promise<StockProductResponse[]> {

    const [rows] = await pool.query<(RowDataPacket[]) & StockProductResponse[]>(`
        SELECT a.*,
            (SELECT GROUP_CONCAT(g.poi_value ORDER BY f.poi_id SEPARATOR '/')
                FROM VariantOptionItems f
                JOIN ProductOptionItems g ON g.poi_id = f.poi_id
                WHERE f.pv_id = a.pv_id
            ) AS poi_values,
            c.ul_name,
            c.lg_code,
            d.on_hand, 
            d.reserved_qty,
            d.loc_id,
            g.name_in_thai as province,
            d.inv_id
        FROM ProductVariants a
        INNER JOIN Units b ON a.unit_id = b.u_id
        INNER JOIN UnitLangs c ON b.u_id = c.u_id
        INNER JOIN Inventorys d ON a.pv_id = d.pv_id
        INNER JOIN Locations f ON f.loc_id = d.loc_id
        INNER JOIN Provinces g ON f.Provinces_id = g.id
            WHERE c.lg_code = ? AND a.st_id = ?
            ORDER BY a.pv_id DESC`, [log_code, st_id]);
    return rows;

}

async function InventoryRow(conn: PoolConnection, pv_id: number, loc_id: number): Promise<RowDataPacket[]> {
    const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT *  FROM Inventorys WHERE pv_id = ? AND loc_id = ?`, [pv_id, loc_id]
    );
    return rows;
}

export async function addStock(data: AddStockProduct): Promise<number> {
    const conn = await pool.getConnection();
    try {
        const { pv_id, loc_id, addOn_hand, e_id, st_id } = data;

        await conn.beginTransaction();

        const [updateRows] = await conn.query<ResultSetHeader>(
            `UPDATE Inventorys
             SET on_hand = on_hand + ?
             WHERE pv_id = ? AND loc_id = ?`,
            [addOn_hand, pv_id, loc_id]
        );

        if (updateRows.affectedRows === 0) {
            throw new ApiError(404, "ไม่พบสินค้าในคลัง");
        }

        const inventoryRows = await InventoryRow(conn, pv_id, loc_id);

        const inv_id = inventoryRows[0]?.inv_id;
        if (!inv_id) {
            throw new ApiError(404, "ไมพบ Inventory ID");
        }

        await conn.query(
            `INSERT INTO InventoryLog(on_hand, ivnl_status, pv_id, inv_id, e_id, st_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [addOn_hand, "เพิ่ม", pv_id, inv_id, e_id, st_id]
        );

        await conn.commit();
        return updateRows.affectedRows;
    } catch (err) {
        await conn.rollback();
        console.error(`Error add stock: ${err}`);
        throw err;
    } finally {
        conn.release();
    }
}

export async function reduceStock(data: ReduceStoskProduct): Promise<number> {
    const conn = await pool.getConnection();
    try {
        const { pv_id, loc_id, reduceOn_hand, e_id, st_id } = data;

        await conn.beginTransaction();

        const [updateRows] = await conn.query<ResultSetHeader>(
            `UPDATE Inventorys
             SET on_hand = on_hand - ?
             WHERE pv_id = ? AND loc_id = ? AND on_hand >= ?`,
            [reduceOn_hand, pv_id, loc_id, reduceOn_hand]
        );

        if (updateRows.affectedRows === 0) {
            throw new ApiError(400, "สินค้าไม่เพียงพอสำหรับลดจำนวน");
        }

        const inventoryRows = await InventoryRow(conn, pv_id, loc_id);

        const inv_id = inventoryRows[0]?.inv_id;
        if (!inv_id) {
            throw new ApiError(404, "ไม่พบ Inventory ID");
        }

        await conn.query(
            `INSERT INTO InventoryLog (on_hand, ivnl_status, pv_id, inv_id, e_id, st_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [reduceOn_hand, "ลด", pv_id, inv_id, e_id, st_id]
        );

        await conn.commit();
        return updateRows.affectedRows;
    } catch (err) {
        await conn.rollback();
        console.error(`Error reduce stock: ${err}`);
        throw err;
    } finally {
        conn.release();
    }
}


export async function ListInventoryLog(st_id: number, inv_id: number): Promise<InventoryLogResponse[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & InventoryLogResponse[]>(`
                    SELECT a.*,(SELECT GROUP_CONCAT(g.poi_value ORDER BY f.poi_id SEPARATOR '/')
                            FROM VariantOptionItems f
                            JOIN ProductOptionItems g ON g.poi_id = f.poi_id
                            WHERE f.pv_id = a.pv_id
                        ) AS poi_values,c.e_firstname,b.pv_sku FROM InventoryLog a 
                        INNER JOIN ProductVariants b 
                        ON a.pv_id = b.pv_id
                        INNER JOIN Employees c 
                        ON c.e_id = a.e_id
                        WHERE a.st_id = ? AND a.inv_id = ?
                        ORDER BY a.create_at DESC`, [st_id, inv_id]);
    return rows;

}

