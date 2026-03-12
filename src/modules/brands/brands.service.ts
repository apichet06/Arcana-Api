import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { BrandsDTO, CreateBrandsInput } from "./brands.type.js";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";

import { CommonMessages } from "../../shared/messages/common.messages.js";

export async function listBrands(): Promise<BrandsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & BrandsDTO)[]>(`
        SELECT b_id, b_name,e_create_at FROM Brands ORDER BY b_id desc
    `);
    return rows;
}

export async function createBrand(input: CreateBrandsInput): Promise<number> {
    try {

        const data = { b_name: input.b_name, e_id: input.e_id } = input;
        const [res] = await pool.query<ResultSetHeader>("INSERT INTO Brands SET ?", data);
        return res.insertId;
    } catch (err) {
        if (isDupError(err)) {
            throw new ApiError(409, CommonMessages.isExits);
        }
        throw err;
    }

}


export async function updateBrand(b_id: number, input: Partial<BrandsDTO>): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query("UPDATE Brands SET b_name = ? WHERE b_id = ?", [input.b_name, b_id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function deleteBrand(b_id: number): Promise<void> {
    try {
        const [res] = await pool.query<ResultSetHeader>(
            "DELETE FROM Brands WHERE b_id = ?", [b_id]
        );
        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
    } catch (err: any) {
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    }
}