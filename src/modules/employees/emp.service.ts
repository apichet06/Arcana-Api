import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { CreateEmpInput, CreateLocationInput, CreateStoreInput, empDTO, UpdateEmpInput } from "./emp.type.js";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";


async function MaxId(): Promise<number> {
    try {
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT MAX(CAST(RIGHT(e_usercode, 3) AS UNSIGNED)) AS max_suffix FROM employees`);
        const maxId = rows[0]?.max_suffix;
        return maxId || 0;
    } catch (err) {
        throw err;
    }

}

async function generateUserCode(): Promise<string> {
    try {
        const maxId = await MaxId();
        const newId = maxId + 1;
        return `EMP${newId.toString().padStart(3, '0')}`;
    } catch (err) {
        throw err;
    }
}
export async function findByEmpLogin(e_email: string): Promise<empDTO | null> {
    const [rows] = await pool.query<(empDTO & RowDataPacket)[]>(
        `SELECT a.*, b.st_company_name ,b.st_image FROM Employees a 
        INNER JOIN Store b ON a.st_id = b.st_id
        WHERE a.e_email = ?`, [e_email]);
    return rows[0] || null;
}

export async function listEmps(st_id: number): Promise<empDTO[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & empDTO[]>(`SELECT * FROM Employees WHERE st_id = ? order by e_id asc`, [st_id]);
    return rows;
}

export async function CreateEmpAdmins(input: CreateEmpInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [res] = await conn.query<ResultSetHeader>(`INSERT INTO Employees SET ?`, [input]);
        await conn.commit();
        return res.insertId;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    }
}


export async function UpdateEmpAdmins(e_id: number, input: Partial<UpdateEmpInput>): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query<ResultSetHeader>(`UPDATE Employees SET ? WHERE e_id = ?`, [input, e_id]);
        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function DeleteEmpAdmins(e_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.query<ResultSetHeader>(`DELETE FROM Employees WHERE e_id = ?`, [e_id]);

        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        await conn.commit();
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


export async function createEmp(inputStore: CreateStoreInput, inputEmp: CreateEmpInput, inputLocation: CreateLocationInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const e_usercode = await generateUserCode();

        const Store = {
            st_company_name: inputStore.st_company_name,
            st_idcard: inputStore.st_idcard,
            bank_name: inputStore.bank_name,
            account_number: inputStore.account_number,
            omise_recipient_id: inputStore.omise_recipient_id,
            st_email: inputStore.st_email,
            st_isAccept: inputStore.st_isAccept,
            created_at: inputStore.created_at,
            st_phone: inputStore.st_phone,
            st_image: inputStore.st_image,
            e_id: inputStore.e_id,
        }

        const [resStore] = await conn.query<ResultSetHeader>(`INSERT INTO Store SET ? `, [Store]);
        const st_id = resStore.insertId;
        const emp = {
            e_usercode,
            e_title: inputEmp.e_title,
            e_firstname: inputEmp.e_firstname,
            e_lastname: inputEmp.e_lastname,
            e_password: inputEmp.e_password,
            e_email: inputEmp.e_email,
            e_phone: inputEmp.e_phone,
            e_isActive: inputEmp.e_isActive,
            e_status: inputEmp.e_status,
            st_id: st_id
        };

        const [res] = await conn.query<ResultSetHeader>(`INSERT INTO Employees SET ?`, emp);
        const e_id = res.insertId;

        const Locations = {
            loc_name: inputLocation.loc_name,
            loc_address: inputLocation.loc_address,
            loc_postcode: inputLocation.loc_postcode,
            st_id: st_id,
            e_id: e_id,
            Subdistricts_id: inputLocation.Subdistricts_id,
            Districts_id: inputLocation.Districts_id,
            Provinces_id: inputLocation.Provinces_id
        }
        await conn.query(`INSERT INTO Locations  SET ? `, [Locations]);
        await conn.commit();
        return e_id;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    }
}


