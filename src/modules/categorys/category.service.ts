
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { CategoryDTO, CreateCategoryInput } from "./category.type.js";
import { pool } from "../../db/pool.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { ApiError, isDupError } from "../../shared/errors/ApiError.js";
import { translateCategoryNameGimini } from "../../shared/translate/translate_gimini.js";



export async function listCategorys(): Promise<CategoryDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & CategoryDTO)[]>(`
    SELECT
      a.c_id, a.c_sort_order, a.e_id, a.ctl_id,
      b.cl_name, b.lg_code,
      c.ctl_name, c.ctl_description,
      d.e_usercode
    FROM Categorys a
    INNER JOIN CategoryLangs b ON a.c_id = b.c_id
    INNER JOIN Catalog c ON a.ctl_id = c.ctl_id
    INNER JOIN Employees d ON a.e_id = d.e_id
    ORDER BY a.c_id ASC
  `);

    return rows;
}

export async function createCategory(input: CreateCategoryInput): Promise<number> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // 1) แปลภาษาให้ครบ 3 ภาษา
        const t = await translateCategoryNameGimini(input.cl_name);
        const [rows] = await conn.query<any[]>(
            "SELECT COALESCE(MAX(c_sort_order), 0) as maxSort FROM Categorys FOR UPDATE"
        );

        const nextSort = rows[0].maxSort + 1;
        // 2) Insert master (Categorys)
        const masterData = {
            c_sort_order: nextSort,
            e_id: input.e_id,
            ctl_id: input.ctl_id,
        };

        const [masterRes] = await conn.query<ResultSetHeader>(
            "INSERT INTO Categorys SET ?",
            masterData
        );

        const c_id = masterRes.insertId;

        // 3) Insert translations (CategoryLangs) 3 แถว
        // แนะนำทำ UNIQUE (c_id, lg_code) ใน DB กันซ้ำ
        const langRows = [
            [c_id, "th", t.th],
            [c_id, "en", t.en],
            [c_id, "ja", t.ja],
        ];

        await conn.query(`INSERT INTO CategoryLangs (c_id, lg_code, cl_name) VALUES ? `, [langRows]);
        await conn.commit();
        return c_id;
    } catch (err: any) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}
