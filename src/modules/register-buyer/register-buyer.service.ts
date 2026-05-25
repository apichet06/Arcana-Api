import bcrypt from "bcrypt";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError } from "../../shared/errors/ApiError.js";
import { UserMessages } from "../../shared/messages/user.messages.js";
import type { AddAddressInput, AddressDTO, AuthResult, FacebookUserInfo, GoogleUserInfo, ProfileDTO, RegisterBuyerInput, RegisterBuyerDTO } from "./type.js";

export async function registerBuyer(input: RegisterBuyerInput): Promise<RegisterBuyerDTO> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const hashedPassword = await bcrypt.hash(input.u_password, 10);

        const userData = {
            u_username: input.u_username,
            u_email: input.u_email,
            u_password: hashedPassword,
            u_birthday: input.u_birthday ?? null,
            u_gender: input.u_gender ?? null,
            u_provider: input.u_provider,
            u_email_verified: 0,
            u_create_at: new Date(),
        };

        const [userRes] = await conn.query<ResultSetHeader>("INSERT INTO Users SET ?", [userData]);
        const u_id = userRes.insertId;

        const locationData = {
            u_id,
            locb_recipient_name: input.locb_recipient_name,
            locb_phone: input.locb_phone,
            locb_address: input.locb_address,
            provinces_id: input.provinces_id,
            districts_id: input.districts_id,
            subdistricts_id: input.subdistricts_id,
            zip_code: input.zip_code,
            is_default: input.is_default ? 1 : 0,
        };

        await conn.query<ResultSetHeader>("INSERT INTO Locations_buyer SET ?", [locationData]);

        await conn.commit();

        const [rows] = await conn.query<(RowDataPacket & RegisterBuyerDTO)[]>(
            "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_id = ?",
            [u_id]
        );

        if (!rows[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการบันทึกข้อมูล");
        return rows[0];
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, UserMessages.repeatEmail);
        throw err;
    } finally {
        conn.release();
    }
}

export async function facebookAuth(accessToken: string): Promise<AuthResult> {
    const res = await fetch(
        `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${accessToken}`
    );
    if (!res.ok) throw new ApiError(401, "access_token ไม่ถูกต้องหรือหมดอายุ");

    const fbUser = (await res.json()) as FacebookUserInfo;

    const [existing] = await pool.query<(RowDataPacket & RegisterBuyerDTO)[]>(
        fbUser.email
            ? "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_email = ? OR u_provider_id = ? LIMIT 1"
            : "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_provider_id = ? LIMIT 1",
        fbUser.email ? [fbUser.email, fbUser.id] : [fbUser.id]
    );

    if (existing[0]) {
        await pool.query("UPDATE Users SET u_last_login = ? WHERE u_id = ?", [new Date(), existing[0].u_id]);
        return { user: existing[0], isNew: false };
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const userData = {
            u_username: fbUser.name,
            u_email: fbUser.email ?? null,
            u_password: null,
            u_provider: "FACEBOOK",
            u_provider_id: fbUser.id,
            u_avatar: fbUser.picture?.data?.url ?? null,
            u_email_verified: fbUser.email ? 1 : 0,
            u_create_at: new Date(),
            u_last_login: new Date(),
        };

        const [result] = await conn.query<ResultSetHeader>("INSERT INTO Users SET ?", [userData]);
        await conn.commit();

        const [newRows] = await conn.query<(RowDataPacket & RegisterBuyerDTO)[]>(
            "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_id = ?",
            [result.insertId]
        );

        if (!newRows[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการบันทึกข้อมูล");
        return { user: newRows[0], isNew: true };
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, UserMessages.repeatEmail);
        throw err;
    } finally {
        conn.release();
    }
}

export async function loginBuyer(email: string, password: string): Promise<RegisterBuyerDTO> {
    const [rows] = await pool.query<(RowDataPacket & RegisterBuyerDTO & { u_password: string | null; u_provider: string })[]>(
        "SELECT u_id, u_username, u_email, u_avatar, u_password, u_provider, u_create_at FROM Users WHERE u_email = ? LIMIT 1",
        [email]
    );

    const user = rows[0];
    if (!user) throw new ApiError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    if (user.u_provider !== "LOCAL" || !user.u_password) throw new ApiError(401, "บัญชีนี้ใช้การเข้าสู่ระบบด้วย " + user.u_provider);

    const match = await bcrypt.compare(password, user.u_password);
    if (!match) throw new ApiError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");

    await pool.query("UPDATE Users SET u_last_login = ? WHERE u_id = ?", [new Date(), user.u_id]);

    return { u_id: user.u_id, u_username: user.u_username, u_email: user.u_email, u_avatar: user.u_avatar, u_create_at: user.u_create_at };
}

// ─── Profile ────────────────────────────────────────────────────────────────

/** ดึงข้อมูล profile ของ user ที่ล็อกอินอยู่ */
export async function getMyProfile(u_id: number): Promise<ProfileDTO> {
    const [rows] = await pool.query<(RowDataPacket & ProfileDTO)[]>(
        `SELECT u_id, u_username, u_email, u_avatar,
                u_birthday, u_gender, u_provider, u_create_at
         FROM Users WHERE u_id = ? LIMIT 1`,
        [u_id]
    );
    const user = rows[0];
    if (!user) throw new ApiError(404, "ไม่พบข้อมูลผู้ใช้");
    return user;
}

/** อัปเดต username / birthday / gender — email และ provider ห้ามเปลี่ยน */
export async function updateMyProfile(
    u_id: number,
    data: { u_username: string; u_birthday?: string | null; u_gender?: string | null }
): Promise<ProfileDTO> {
    await pool.query(
        "UPDATE Users SET u_username = ?, u_birthday = ?, u_gender = ? WHERE u_id = ?",
        [data.u_username, data.u_birthday ?? null, data.u_gender ?? null, u_id]
    );
    return getMyProfile(u_id);
}

// ─── Addresses ──────────────────────────────────────────────────────────────

/** ดึงรายการที่อยู่จัดส่งทั้งหมดของ user พร้อมชื่อจังหวัด/อำเภอ/ตำบล */
export async function getMyAddresses(u_id: number): Promise<AddressDTO[]> {
    // แยก raw type เพราะ MySQL คืน is_default เป็น 0/1 (number) ไม่ใช่ boolean
    type RawRow = RowDataPacket & Omit<AddressDTO, "is_default"> & { is_default: number };
    const [rows] = await pool.query<RawRow[]>(
        `SELECT
            lb.locb_id,
            lb.locb_recipient_name,
            lb.locb_phone,
            lb.locb_address,
            lb.provinces_id,
            lb.districts_id,
            lb.subdistricts_id,
            lb.zip_code,
            lb.is_default,
            p.name_in_thai  AS province_name,
            d.name_in_thai  AS district_name,
            s.name_in_thai  AS subdistrict_name
         FROM Locations_buyer lb
         LEFT JOIN Provinces    p ON p.id = lb.provinces_id
         LEFT JOIN Districts    d ON d.id = lb.districts_id
         LEFT JOIN Subdistricts s ON s.id = lb.subdistricts_id
         WHERE lb.u_id = ?
         ORDER BY lb.is_default DESC, lb.locb_id ASC`,
        [u_id]
    );
    return rows.map((r) => ({ ...r, is_default: r.is_default === 1 }));
}

/** เพิ่มที่อยู่ใหม่ — ถ้า is_default=true จะ reset ที่อยู่อื่นก่อน */
export async function addMyAddress(u_id: number, data: AddAddressInput): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (data.is_default) {
            // reset ที่อยู่อื่นทั้งหมดก่อนตั้งอันใหม่เป็น default
            await conn.query("UPDATE Locations_buyer SET is_default = 0 WHERE u_id = ?", [u_id]);
        }
        await conn.query("INSERT INTO Locations_buyer SET ?", [{
            u_id,
            ...data,
            is_default: data.is_default ? 1 : 0,
        }]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** ตั้งที่อยู่นี้เป็นที่อยู่หลัก (ตรวจสอบว่าเป็นของ user คนนี้ก่อน) */
export async function setDefaultAddress(u_id: number, locb_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<RowDataPacket[]>(
            "SELECT locb_id FROM Locations_buyer WHERE locb_id = ? AND u_id = ? LIMIT 1",
            [locb_id, u_id]
        );
        if (!rows[0]) throw new ApiError(404, "ไม่พบที่อยู่นี้");
        await conn.query("UPDATE Locations_buyer SET is_default = 0 WHERE u_id = ?", [u_id]);
        await conn.query("UPDATE Locations_buyer SET is_default = 1 WHERE locb_id = ?", [locb_id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** อัปเดตข้อมูลที่อยู่ — ตรวจสอบว่าเป็นของ user คนนี้ก่อน */
export async function updateMyAddress(
    u_id: number,
    locb_id: number,
    data: AddAddressInput
): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<RowDataPacket[]>(
            "SELECT locb_id FROM Locations_buyer WHERE locb_id = ? AND u_id = ? LIMIT 1",
            [locb_id, u_id]
        );
        if (!rows[0]) throw new ApiError(404, "ไม่พบที่อยู่นี้");

        if (data.is_default) {
            await conn.query("UPDATE Locations_buyer SET is_default = 0 WHERE u_id = ?", [u_id]);
        }
        await conn.query(
            `UPDATE Locations_buyer
             SET locb_recipient_name = ?, locb_phone = ?, locb_address = ?,
                 provinces_id = ?, districts_id = ?, subdistricts_id = ?,
                 zip_code = ?, is_default = ?
             WHERE locb_id = ?`,
            [
                data.locb_recipient_name, data.locb_phone, data.locb_address,
                data.provinces_id, data.districts_id, data.subdistricts_id,
                data.zip_code, data.is_default ? 1 : 0,
                locb_id,
            ]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** ลบที่อยู่ — ไม่อนุญาตลบที่อยู่หลัก */
export async function deleteAddress(u_id: number, locb_id: number): Promise<void> {
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT locb_id, is_default FROM Locations_buyer WHERE locb_id = ? AND u_id = ? LIMIT 1",
        [locb_id, u_id]
    );
    const addr = rows[0];
    if (!addr) throw new ApiError(404, "ไม่พบที่อยู่นี้");
    if (addr.is_default) throw new ApiError(400, "ไม่สามารถลบที่อยู่หลักได้ กรุณาตั้งที่อยู่อื่นเป็นหลักก่อน");
    await pool.query("DELETE FROM Locations_buyer WHERE locb_id = ?", [locb_id]);
}

// ─── Google / Facebook OAuth ─────────────────────────────────────────────────

export async function googleAuth(accessToken: string): Promise<AuthResult> {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) throw new ApiError(401, "access_token ไม่ถูกต้องหรือหมดอายุ");

    const gUser = (await res.json()) as GoogleUserInfo;

    const [existing] = await pool.query<(RowDataPacket & RegisterBuyerDTO)[]>(
        "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_email = ? OR u_provider_id = ? LIMIT 1",
        [gUser.email, gUser.id]
    );

    if (existing[0]) {
        await pool.query("UPDATE Users SET u_last_login = ? WHERE u_id = ?", [new Date(), existing[0].u_id]);
        return { user: existing[0], isNew: false };
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const userData = {
            u_username: gUser.name,
            u_email: gUser.email,
            u_password: null,
            u_provider: "GOOGLE",
            u_provider_id: gUser.id,
            u_avatar: gUser.picture,
            u_email_verified: 1,
            u_create_at: new Date(),
            u_last_login: new Date(),
        };

        const [result] = await conn.query<ResultSetHeader>("INSERT INTO Users SET ?", [userData]);
        await conn.commit();

        const [newRows] = await conn.query<(RowDataPacket & RegisterBuyerDTO)[]>(
            "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_id = ?",
            [result.insertId]
        );

        if (!newRows[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการบันทึกข้อมูล");
        return { user: newRows[0], isNew: true };
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, UserMessages.repeatEmail);
        throw err;
    } finally {
        conn.release();
    }
}
