
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { BankDTO, CreateStoreInput, StoreDTO, StoreShopDTO, UpdateStoreInput } from "./store.type.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/index.js";

export async function listStores(): Promise<StoreDTO[]> {

    const [rows] = await pool.query<(RowDataPacket[]) & StoreDTO[]>(`SELECT  
        a.*, b.bk_name
        FROM Store a LEFT JOIN Bank b ON a.bk_id = b.bk_id order by a.st_id asc`);
    return rows;
}

export async function getlistStoreShop(): Promise<StoreShopDTO[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreShopDTO[]>(`SELECT st_id, st_company_name, st_phone, st_image, st_email, st_isAccept FROM Store`);
    return rows;
}

export async function getlistSroreShopById(st_id: number) {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreShopDTO[]>(`SELECT st_id, st_company_name, st_phone, st_image, st_email, st_isAccept FROM Store WHERE st_id = ?`, [st_id]);
    return rows[0] || null;

}

export async function getStoreById(st_id: number): Promise<StoreDTO | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreDTO[]>(`SELECT  
        a.*, b.bk_name
        FROM Store a LEFT JOIN Bank b ON a.bk_id = b.bk_id WHERE a.st_id = ?`, [st_id]);
    return rows[0] || null;
}
export async function getStoreByCompanyName(st_company_name: string): Promise<StoreDTO | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreDTO[]>(`SELECT st_id, st_company_name, st_idcard, account_number, omise_recipient_id, st_email, st_isAccept, created_at, st_phone, st_image, e_id, bk_id FROM Store WHERE st_company_name = ?`, [st_company_name]);
    return rows[0] || null;
}

export async function CreateStore(input: CreateStoreInput): Promise<number> {
    try {
        const data = {
            st_company_name: input.st_company_name,
            st_idcard: input.st_idcard,
            account_number: input.account_number,
            omise_recipient_id: input.omise_recipient_id,
            st_email: input.st_email,
            st_isAccept: input.st_isAccept,
            created_at: input.created_at,
            st_phone: input.st_phone,
            st_image: input.st_image,
            e_id: input.e_id,
            bk_id: input.bk_id
        } = input;
        const [res] = await pool.query<ResultSetHeader>(`INSERT INTO Store  SET ?`, data);
        return res.insertId;


    } catch (err) {
        if (isDupError(err)) {
            console.log(`Duplicate entry error: ${err}`);
            throw new ApiError(409, CommonMessages.isExits);
        }
        console.error(`Error creating store: ${err}`);
        throw err;
    }
}

export async function updateStore(st_id: number, input: UpdateStoreInput): Promise<void> {
    try {

        const data = {
            st_company_name: input.st_company_name,
            st_idcard: input.st_idcard,
            account_number: input.account_number,
            omise_recipient_id: input.omise_recipient_id,
            st_email: input.st_email,
            st_isAccept: input.st_isAccept,
            created_at: input.created_at,
            st_phone: input.st_phone,
            st_image: input.st_image,
            e_id: input.e_id,
            bk_id: input.bk_id
        } = input;
        const [res] = await pool.query<ResultSetHeader>(`UPDATE Store SET ? WHERE st_id = ?`, [data, st_id]);
        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
    } catch (err) {
        if (isDupError(err)) {
            throw new ApiError(409, CommonMessages.isExits);
        }
        throw err;
    }
}

export async function deleteStore(st_id: number): Promise<void> {
    try {
        const [res] = await pool.query<ResultSetHeader>(`DELETE FROM Store WHERE st_id = ?`, [st_id]);

        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        return;
    } catch (err) {
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    }
}

export async function listBanks(): Promise<BankDTO[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & BankDTO[]>(`SELECT bk_id, bk_name FROM Bank order by bk_id asc`);
    return rows;
}