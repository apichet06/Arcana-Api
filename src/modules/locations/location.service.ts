import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { CreateLocationInput, LocationsDTO, UpdateLocationInput } from "./location.type.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";

import { CommonMessages } from "../../shared/messages/common.messages.js";

export async function ListLocations(): Promise<LocationsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & LocationsDTO)[]>(
        `SELECT  * FROM Locations  
        ORDER BY loc_id DESC`
    );
    return rows;
}

export async function getLocationById(st_id: number): Promise<LocationsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & LocationsDTO)[]>(
        `SELECT a.*, b.st_company_name, c.name_in_thai as province_name, d.name_in_thai as district_name, e.name_in_thai as subdistrict_name
        FROM Locations a 
        INNER JOIN Store b ON a.st_id = b.st_id
        INNER JOIN Provinces c ON a.Provinces_id = c.id
        INNER JOIN Districts d ON a.Districts_id = d.id
        INNER JOIN Subdistricts e ON a.Subdistricts_id = e.id
        WHERE a.st_id = ?`,
        [st_id]
    );
    return rows;
}

export async function CreateLocation(input: CreateLocationInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        if (input.is_default) {
            await conn.query("UPDATE Locations SET is_default = 0 WHERE st_id = ?", [input.st_id]);
        }

        let loc_name: string;
        if (input.is_default) {
            loc_name = "คลังหลัก";
        } else {
            const [countRows] = await conn.query<RowDataPacket[]>(
                "SELECT COUNT(*) as count FROM Locations WHERE st_id = ? AND is_default = 0",
                [input.st_id]
            );
            const count = (countRows[0] as any).count as number;
            loc_name = `คลังย่อย ${count + 1}`;
        }

        const [result] = await conn.query<ResultSetHeader>(
            "INSERT INTO Locations SET ?",
            [{ ...input, loc_name }]
        );
        await conn.commit();
        return result.insertId;

    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) {
            throw new ApiError(409, CommonMessages.isExits);
        }
        throw err;
    } finally {
        conn.release();
    }
}

export async function UpdateLocation(loc_id: number, input: Partial<UpdateLocationInput>): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const updateData: any = { ...input };

        if (input.is_default) {
            // หา old default ก่อน reset
            const [oldDefaultRows] = await conn.query<RowDataPacket[]>(
                "SELECT loc_id FROM Locations WHERE st_id = ? AND is_default = 1 AND loc_id != ?",
                [input.st_id, loc_id]
            );

            // นับจำนวนคลังย่อยที่มีอยู่ (ไม่นับตัวที่กำลัง promote)
            const [countRows] = await conn.query<RowDataPacket[]>(
                "SELECT COUNT(*) as count FROM Locations WHERE st_id = ? AND is_default = 0 AND loc_id != ?",
                [input.st_id, loc_id]
            );
            const count = (countRows[0] as any).count as number;

            await conn.query("UPDATE Locations SET is_default = 0 WHERE st_id = ?", [input.st_id]);

            // rename old default → คลังย่อย N
            if (oldDefaultRows.length > 0) {
                await conn.query(
                    "UPDATE Locations SET loc_name = ? WHERE loc_id = ?",
                    [`คลังย่อย ${count + 1}`, oldDefaultRows[0]!.loc_id]
                );
            }

            updateData.loc_name = "คลังหลัก";
        }

        const [result] = await conn.query<ResultSetHeader>(
            "UPDATE Locations SET ? WHERE loc_id = ?",
            [updateData, loc_id]
        );
        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) {
            throw new ApiError(409, CommonMessages.isExits);
        }
        throw err;
    } finally {
        conn.release();
    }
}

type LocationRow = RowDataPacket & {
    loc_id: number;
    st_id: number;
    is_default: number;
};


export async function DeleteLocation(loc_id: number): Promise<void> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();
        // 1) ดึงข้อมูล location ที่จะลบก่อน
        const [rows] = await conn.query<LocationRow[]>(`SELECT loc_id, st_id, is_default FROM Locations WHERE loc_id = ?`, [loc_id]);
        if (rows.length === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        const target = rows[0]!;
        // 2) ลบ location
        const [result] = await conn.query<ResultSetHeader>(`DELETE FROM Locations WHERE loc_id = ?`, [loc_id]);

        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        // 3) ถ้าตัวที่ลบเป็นที่อยู่หลัก ให้หาอันใหม่ในร้านเดียวกัน
        if (target.is_default === 1) {
            const [remaining] = await conn.query<LocationRow[]>(`SELECT loc_id FROM Locations WHERE st_id = ? ORDER BY loc_id ASC LIMIT 1`, [target.st_id]);

            // 4) ถ้ายังมี location เหลืออยู่ ค่อยตั้งเป็น default
            if (remaining.length > 0) {
                await conn.query(`UPDATE Locations  SET is_default = 1 WHERE loc_id = ?`, [remaining[0]!.loc_id]);
            }
        }

        await conn.commit();
        return;
    } catch (err) {
        await conn.rollback();
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    } finally {
        conn.release();
    }
}