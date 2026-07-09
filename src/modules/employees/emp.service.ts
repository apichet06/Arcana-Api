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
        `SELECT a.*, b.st_company_name, b.st_image, b.is_platform_store FROM Employees a 
        INNER JOIN Store b ON a.st_id = b.st_id
        WHERE a.e_email = ?`, [e_email]);
    return rows[0] || null;
}

async function ensurePasswordResetTable(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Employee_Password_Reset_Tokens (
            prt_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            e_id INT NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            request_ip VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL,
            PRIMARY KEY (prt_id),
            UNIQUE KEY uq_employee_password_reset_token_hash (token_hash),
            KEY idx_employee_password_reset_e_id (e_id),
            KEY idx_employee_password_reset_expires_at (expires_at)
        )
    `);
}

export async function findPasswordResetEmployeeByEmail(e_email: string): Promise<Pick<empDTO, "e_id" | "e_firstname" | "e_lastname" | "e_email" | "e_isActive"> | null> {
    const [rows] = await pool.query<(Pick<empDTO, "e_id" | "e_firstname" | "e_lastname" | "e_email" | "e_isActive"> & RowDataPacket)[]>(
        `SELECT e_id, e_firstname, e_lastname, e_email, e_isActive
         FROM Employees
         WHERE e_email = ?
         LIMIT 1`,
        [e_email],
    );
    return rows[0] || null;
}

export async function createPasswordResetToken(input: {
    e_id: number;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    userAgent?: string | null;
}): Promise<void> {
    await ensurePasswordResetTable();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            `UPDATE Employee_Password_Reset_Tokens
             SET used_at = ?
             WHERE e_id = ? AND used_at IS NULL`,
            [new Date(), input.e_id],
        );
        await conn.query(
            `INSERT INTO Employee_Password_Reset_Tokens
             (e_id, token_hash, expires_at, request_ip, user_agent)
             VALUES (?, ?, ?, ?, ?)`,
            [
                input.e_id,
                input.tokenHash,
                input.expiresAt,
                input.requestIp ?? null,
                input.userAgent ? input.userAgent.slice(0, 255) : null,
            ],
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function resetPasswordWithToken(tokenHash: string, hashedPassword: string): Promise<void> {
    await ensurePasswordResetTable();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<(RowDataPacket & {
            prt_id: number;
            e_id: number;
            expires_at: Date;
            used_at: Date | null;
        })[]>(
            `SELECT prt_id, e_id, expires_at, used_at
             FROM Employee_Password_Reset_Tokens
             WHERE token_hash = ?
             LIMIT 1
             FOR UPDATE`,
            [tokenHash],
        );
        const resetToken = rows[0];
        if (!resetToken || resetToken.used_at || new Date(resetToken.expires_at).getTime() <= Date.now()) {
            throw new ApiError(400, "ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว");
        }

        const [employeeResult] = await conn.query<ResultSetHeader>(
            `UPDATE Employees SET e_password = ? WHERE e_id = ?`,
            [hashedPassword, resetToken.e_id],
        );
        if (employeeResult.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        await conn.query(
            `UPDATE Employee_Password_Reset_Tokens
             SET used_at = ?
             WHERE e_id = ? AND used_at IS NULL`,
            [new Date(), resetToken.e_id],
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function findByEmpId(e_id: number): Promise<empDTO | null> {
    const [rows] = await pool.query<(empDTO & RowDataPacket)[]>(
        `SELECT * FROM Employees WHERE  e_id = ?`, [e_id]);
    return rows[0] || null;
}

async function countActiveOwners(st_id: number, excludeEmpId?: number): Promise<number> {
    const params: (number | string)[] = [st_id, "Owner"];
    let sql = `SELECT COUNT(*) AS total FROM Employees WHERE st_id = ? AND e_status = ? AND e_isActive = 1`;

    if (excludeEmpId) {
        sql += ` AND e_id <> ?`;
        params.push(excludeEmpId);
    }

    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return Number(rows[0]?.total ?? 0);
}

async function assertStoreKeepsActiveOwner(st_id: number, excludeEmpId?: number): Promise<void> {
    const ownerCount = await countActiveOwners(st_id, excludeEmpId);
    if (ownerCount < 1) {
        throw new ApiError(400, "ร้านต้องมี Owner ที่ใช้งานได้อย่างน้อย 1 คน");
    }
}

function toActiveBoolean(value: unknown): boolean {
    return value === true || value === 1 || value === "1" || value === "true";
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
        const [currentRows] = await conn.query<(empDTO & RowDataPacket)[]>(`SELECT * FROM Employees WHERE e_id = ? LIMIT 1`, [e_id]);
        const current = currentRows[0];
        if (!current) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        const nextStatus = input.e_status ?? current.e_status;
        const nextIsActive = input.e_isActive ?? current.e_isActive;
        const willStopBeingActiveOwner = current.e_status === "Owner" && (nextStatus !== "Owner" || !toActiveBoolean(nextIsActive));

        if (willStopBeingActiveOwner) {
            const ownerCount = await countActiveOwners(current.st_id, e_id);
            if (ownerCount < 1) {
                throw new ApiError(400, "ร้านต้องมี Owner ที่ใช้งานได้อย่างน้อย 1 คน");
            }
        }

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

export async function updatePassword(e_id: number, e_password: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query<ResultSetHeader>(
            `UPDATE Employees SET e_password = ? WHERE e_id = ?`,
            [e_password, e_id]
        );

        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function DeleteEmpAdmins(e_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [currentRows] = await conn.query<(empDTO & RowDataPacket)[]>(`SELECT * FROM Employees WHERE e_id = ? LIMIT 1`, [e_id]);
        const current = currentRows[0];
        if (!current) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        if (current.e_status === "Owner" && toActiveBoolean(current.e_isActive)) {
            await assertStoreKeepsActiveOwner(current.st_id, e_id);
        }

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
            created_at: inputStore.created_at,
            st_phone: inputStore.st_phone,
            st_image: inputStore.st_image,
            e_id: inputStore.e_id,
        }

        const [resStore] = await conn.query<ResultSetHeader>(`INSERT INTO Store SET ? `, [Store]);
        const st_id = resStore.insertId;
        const emp = {
            e_usercode,
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


