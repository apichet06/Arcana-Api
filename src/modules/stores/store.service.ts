
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import {
    mapDocumetType,
    mapStatusToAction,
    mapStatusToType,
    type BankDTO, type CreateStoreRegisterInput, type StoreDetailDTO, type StoreDocumentBackend, type StoreDTO,
    type StoreLogDTO,
    type StoreShopDTO, type StoreTaxProfileDTO, type UpdateStoreInput
} from "./store.type.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/index.js";
import type { empDTO } from "../employees/emp.type.js";
import * as notiService from "../notifications/notification.service.js";
import type { NotificationInput } from "../notifications/type.js";

async function isPlatformStore(st_id: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT is_platform_store FROM Store WHERE st_id = ? LIMIT 1`,
        [st_id],
    );
    const value = rows[0]?.is_platform_store;

    return value === true || value === 1 || value === "1";
}


export async function listStores(): Promise<StoreDTO[]> {

    const [rows] = await pool.query<(RowDataPacket[]) & StoreDTO[]>(`
        SELECT a.*, b.bk_name FROM Store a LEFT JOIN Bank b ON a.bk_id = b.bk_id order by a.st_id asc`);
    return rows;
}

export async function getlistStoreShop(): Promise<StoreShopDTO[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreShopDTO[]>(`SELECT st_id, st_company_name, st_phone, st_image, st_email  FROM Store`);
    return rows;
}

export async function getlistSroreShopById(st_id: number) {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreShopDTO[]>(`SELECT st_id, st_company_name, st_phone, st_image, st_email  FROM Store WHERE st_id = ?`, [st_id]);
    return rows[0] || null;
}

export async function getStoreById(st_id: number): Promise<StoreDetailDTO | null> {
    // 1. ตรวจว่ามีร้านนี้จริงก่อน — ถ้าไม่มี return null เลย ไม่ต้อง query ต่อ


    const [storeRows] = await pool.query<RowDataPacket[] & StoreDTO[]>(
        `SELECT a.*, b.bk_name
         FROM Store a
         LEFT JOIN Bank b ON a.bk_id = b.bk_id
         WHERE a.st_id = ?`,
        [st_id],
    )

    const store = storeRows[0]
    if (!store) return null

    // 2. Query ที่เหลือพร้อมกัน — Promise.all เร็วกว่า await ทีละตัว
    const [[taxRows], [documentRows]] = await Promise.all([
        pool.query<RowDataPacket[] & StoreTaxProfileDTO[]>(
            `SELECT a.*,
                    b.name_in_thai AS province_name,
                    c.name_in_thai AS district_name,
                    d.name_in_thai AS subdistrict_name
             FROM Store_Tax_Profile a
             LEFT JOIN Provinces    b ON b.id = a.tax_province_id
             LEFT JOIN Districts    c ON c.id = a.tax_district_id
             LEFT JOIN Subdistricts d ON d.id = a.tax_subdistrict_id
             WHERE a.st_id = ?
             LIMIT 1`,
            [st_id],
        ),
        pool.query<RowDataPacket[] & StoreDocumentBackend[]>(
            `SELECT doc_id, doc_type, file_name, file_path, file_mime, file_size
             FROM Store_Documents
             WHERE st_id = ?
             ORDER BY doc_type ASC, doc_id ASC`,
            [st_id],
        ),
    ])

    return {
        store,
        tax: taxRows[0] ?? null,
        documents: documentRows,
    }
}



export async function getStoreByCompanyName(st_data: string): Promise<StoreDTO | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreDTO[]>(`
        SELECT st_id, st_company_name, bank_account_number,
         st_email, created_at, st_phone, st_image FROM Store
          WHERE st_company_name = ? Or st_email = ? `, [st_data, st_data]);
    return rows[0] || null;
}

export async function getStoreByEmail(st_email: string): Promise<StoreDTO | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & StoreDTO[]>(
        `SELECT st_id, st_company_name, st_email FROM Store WHERE st_email = ?`, [st_email]);
    return rows[0] || null;
}

export async function getEmployeeByEmail(e_email: string): Promise<String | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & String[]>(`
        SELECT e_email FROM Employees WHERE e_email = ?`, [e_email]);
    return rows[0] || null;
}


export async function generateMaxStoreId(): Promise<string> {
    try {
        const year = new Date().getFullYear();
        const [result] = await pool.query<RowDataPacket[]>('SELECT MAX(st_number) as maxId FROM Store');
        const currentMaxId = result[0]?.maxId;

        let idNumber: number;
        if (!currentMaxId) {
            idNumber = 10001; // ยังไม่มี store เริ่มที่ 10001
        } else {
            idNumber = parseInt(currentMaxId.slice(8)) + 1;
        }
        return `ST-${year}-${idNumber.toString().padStart(5, '0')}`;
    } catch (error) {
        throw error;
    }
}

export async function getDocumentById(doc_id: number): Promise<{ file_path: string } | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT file_path FROM Store_Documents WHERE doc_id = ?`, [doc_id]);
    return (rows[0] as { file_path: string }) || null;
}

export async function getlistLogstore(st_id: number): Promise<StoreLogDTO[]> {
    const [rows] = await pool.query<RowDataPacket[] & StoreLogDTO[]>(
        `SELECT  * From Store_Logs WHERE st_id = ? Order by stl_timestamp desc`, [st_id]);
    return rows;
}




export async function requestDocument(st_id: number, eData: empDTO, note: string, doc_types: string[]): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();


        const docLabel = doc_types.map(mapDocumetType).join(', ');
        const logData = {
            st_id,
            stl_type: mapStatusToType("REQUEST"),
            stl_actor: eData.e_status + ' ' + eData.e_firstname,
            stl_action: mapStatusToAction("REQUEST_MORE"),
            stl_node: note + " - เอกสารที่ต้องขอเพิ่มได้แก่ " + docLabel,
            stl_timestamp: new Date(),
        }

        await conn.query<ResultSetHeader>(
            `INSERT INTO Store_Logs SET ?`,
            [logData]
        )
        await conn.query<ResultSetHeader>(`UPDATE Store SET st_note = ?,st_status = ? , updated_at = ?
              WHERE st_id = ?`, [note + " - เอกสารที่ต้องขอเพิ่มได้แก่ " + docLabel, "REQUEST", new Date(), st_id])


        const notiData: NotificationInput = {
            target_type: "STORE",
            target_id: st_id,
            type: "REQUEST_MORE",
            title: "เอกสารประกอบ",
            message: 'ขอเอกสารเพิ่มเติมได้แก่' + docLabel,
            action_url: "/dashboard/myShop",
            ref_type: "STORE",
            ref_id: st_id,
            priority: "HIGH"
        }

        await notiService.CreateNotification(notiData)

        await conn.commit();

    } catch {
        await conn.rollback();
    } finally {
        conn.release();
    }
}


export async function updateStoreStatus(st_id: number, input: { st_status: string, note: string }, eData: empDTO): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const { st_status, note } = input;

        const [res] = await conn.query<ResultSetHeader>(`UPDATE Store SET st_status = ? ,st_note = ?, updated_at = ? WHERE st_id = ?`, [st_status, note, new Date(), st_id]);

        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        await conn.commit();

        const logData = {
            st_id,
            stl_type: mapStatusToType(st_status),
            stl_actor: eData.e_status + ' ' + eData.e_firstname,
            stl_action: mapStatusToAction(st_status),
            stl_node: note ?? null,
            stl_timestamp: new Date(),
        }

        await conn.query<ResultSetHeader>(
            `INSERT INTO Store_Logs SET ?`,
            [logData]
        )
        const notiData: NotificationInput = {
            target_type: "STORE",
            target_id: st_id,
            type: "STATUS_STORE",
            title: "อัปเดทสถานะร้าน",
            message: mapStatusToAction(st_status) + ' ' + note,
            action_url: "/dashboard/myShop",
            ref_type: "STORE",
            ref_id: st_id,
            priority: "HIGH"
        }

        await notiService.CreateNotification(notiData)

    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

export async function DeleteDocumentFile(doc_id: number) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(`DELETE FROM Store_Documents WHERE doc_id = ?`, [doc_id]);
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}


export async function UploadDocumetDATA(documents: StoreDocumentBackend[], stId: number, eData: empDTO) {
    const conn = await pool.getConnection();
    try {
        if (documents && documents.length > 0) {
            const documentValues: any[] = [];

            for (const doc of documents) {
                if (doc.files && doc.files.length > 0) {
                    doc.files.forEach((f: any) => {
                        documentValues.push([
                            stId,
                            null,
                            doc.doc_type,
                            f.original_name,
                            f.file_path,
                            f.mime_type,
                            f.size,
                            1,
                        ]);
                    });
                }
            }

            if (documentValues.length > 0) {
                await conn.query(
                    `INSERT INTO Store_Documents (st_id, tax_id, doc_type, file_name, file_path, file_mime, file_size, is_active)
             VALUES ?`, [documentValues]);
            }
        }
        const docLabel = documents.map(d => mapDocumetType(d.doc_type)).join(', ')
        const logData = {
            st_id: stId,
            stl_type: mapStatusToType("UPLOAD"),
            stl_actor: eData.e_status + ' ' + eData.e_firstname,
            stl_action: mapStatusToAction("UPLOAD"),
            stl_node: "ส่ง - " + docLabel,
            stl_timestamp: new Date(),
        }

        await conn.query<ResultSetHeader>(
            `INSERT INTO Store_Logs SET ?`,
            [logData]
        )

        await conn.query<ResultSetHeader>(`UPDATE Store SET st_status = ? , updated_at = ? WHERE st_id = ?`, ["UPLOAD", new Date(), stId]);

        const notiData: NotificationInput = {
            target_type: "STORE",
            target_id: 1,
            type: "NEW_STORE",
            title: "เอกสารประกอบ",
            message: "ส่งเอกสาร รอตรวจสอบ ได้แก่ " + docLabel,
            action_url: "/dashboard/store/dataStore/?st_id=" + stId,
            ref_type: "STORE",
            ref_id: stId,
        }
        await notiService.CreateNotification(notiData)


        await conn.commit();
    } catch (error) {
        conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

export async function updateStoreTaxProfile(st_id: number, input: StoreTaxProfileDTO): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        await conn.query(`UPDATE Store_Tax_Profile SET ? WHERE st_id = ?`, [input, st_id]);
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}




export async function createStoreRegister(input: CreateStoreRegisterInput, eData?: empDTO): Promise<number> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const st_id = input.st_id; // ได้มาจาก token
        const createdByPlatformStore = await isPlatformStore(st_id);


        // ===== 1. Insert ตาราง stores (ตารางหลัก) =====
        const maxId = await generateMaxStoreId();
        const storeData = {
            st_number: maxId,
            st_company_name: input.st_company_name,
            bank_account_number: input.bank_account_number,
            st_email: input.st_email,
            st_phone: input.st_phone,
            st_image: input.st_image,
            bk_id: input.bk_id,
            st_status: createdByPlatformStore ? "ACTIVE" : "PENDING",
            is_platform_store: input.is_platform_store ?? false,
        };


        const [storeRes] = await conn.query<ResultSetHeader>(`INSERT INTO Store SET ?`, storeData);
        const stId = storeRes.insertId;


        // ===== 2. Insert ตาราง store_locations =====
        if (input.locations.length > 0) {
            let warehouseCount = 1
            const locationValues = input.locations.map((loc) => {
                const locName = loc.is_default ? "คลังหลัก" : `คลังย่อย ${warehouseCount++}`

                return [
                    stId,
                    locName,
                    loc.loc_address,
                    loc.loc_province_id,
                    loc.loc_district_id,
                    loc.loc_subdistrict_id,
                    loc.loc_zip_code,
                    loc.is_default,
                ]
            })

            await conn.query(
                `INSERT INTO Locations  (st_id, loc_name, loc_address, Provinces_id, Districts_id, Subdistricts_id, zip_code, is_default)VALUES ?`,
                [locationValues]
            );
        }

        const e_isActive = true; // กำหนดค่าเริ่มต้นให้พนักงานที่ถูกสร้างมาพร้อมกับร้านเป็น active

        // ===== 3. Insert ตาราง store_employees =====
        if (input.employees.length > 0) {
            const employeeValues = input.employees.map((emp) => [
                stId,
                emp.e_firstname,
                emp.e_lastname,
                emp.e_email,
                emp.e_phone,
                emp.e_status,
                e_isActive,
                emp.e_password
            ]);


            await conn.query(
                `INSERT INTO Employees 
                 (st_id, e_firstname, e_lastname, e_email, e_phone, e_status, e_isActive,e_password) 
                 VALUES ?`,
                [employeeValues]
            );
        }

        const owner = input.employees.find(e => e.e_status === 'Owner')
        const logData = {
            st_id: stId,
            stl_type: mapStatusToType(createdByPlatformStore ? "ACTIVE" : "PENDING"),
            stl_actor: createdByPlatformStore
                ? `${eData?.e_status ?? 'Admin'} ${eData?.e_firstname ?? 'Arcana'}`
                : `${owner?.e_status ?? ''} ${owner?.e_firstname ?? ''}`.trim(),
            stl_action: mapStatusToAction(createdByPlatformStore ? "ACTIVE" : "PENDING"),
            stl_node: createdByPlatformStore ? "Admin Arcana Create Store" : "Owner Create Store",
            stl_timestamp: new Date(),
        }
        await conn.query<ResultSetHeader>(`INSERT INTO Store_Logs SET ?`, [logData])

        // ===== 4. Insert ตาราง store_documents + store_document_files =====
        if (input.documents && input.documents.length > 0) {
            const documentValues: any[] = [];

            for (const doc of input.documents) {
                if (doc.files && doc.files.length > 0) {
                    doc.files.forEach((f: any) => {
                        documentValues.push([
                            stId,
                            null,              // tax_id ถ้ายังไม่ได้ใช้
                            doc.doc_type,
                            f.original_name,   // file_name
                            f.file_path,       // file_path
                            f.mime_type,       // file_mime
                            f.size,            // file_size
                            1,                 // is_active
                        ]);
                    });
                }
            }

            if (documentValues.length > 0) {
                await conn.query(
                    `INSERT INTO Store_Documents (st_id, tax_id, doc_type, file_name, file_path, file_mime, file_size, is_active)
             VALUES ?`, [documentValues]);
            }
        }

        // ===== 5. Store_Tax_Profile (ถ้ามีข้อมูลภาษี) =====

        const taxProfileData = {
            st_id: stId,
            legal_name: input.legal_name,
            is_vat_registered: input.is_vat_registered,
            branch_type: input.branch_type,
            branch_code: input.branch_code,
            tax_id_number: input.tax_id_number,
            tax_address: input.tax_address,
            tax_province_id: input.tax_province_id,
            tax_district_id: input.tax_district_id,
            tax_subdistrict_id: input.tax_subdistrict_id,
            tax_zip_code: input.tax_zip_code,
            tax_seller_type: input.tax_seller_type,
        };

        const notiEmp = await notiService.getEmpBySTId(stId)

        // if (notiEmp.length > 0) {
        const notiData: NotificationInput = {
            target_type: "STORE",
            target_id: stId,
            type: "NEW_STORE",
            title: "ลงทะเบียนผู้ฝากขาย",
            message: "ลงทะเบียนผู้ฝากขายสำเร็จ",
            action_url: "/dashboard/myShop/",
            ref_type: "STORE",
            ref_id: stId
        }
        await notiService.CreateNotification(notiData)
        // }

        // console.log("Inserting tax profile with data:", taxProfileData);

        await conn.query(`INSERT INTO Store_Tax_Profile SET ?`, taxProfileData);

        // ===== Commit =====
        await conn.commit();
        return stId;
    } catch (err) {
        // ===== Rollback =====
        await conn.rollback();

        if (isDupError(err)) {
            console.log(`Duplicate entry error: ${err}`);
            throw new ApiError(409, CommonMessages.isExits);
        }
        console.error(`Error creating store register: ${err}`);
        throw err;
    } finally {
        // ===== คืน connection กลับ pool =====
        conn.release();
    }
}

// export async function CreateStore(input: CreateStoreInput): Promise<number> {
//     try {

//         const data = {
//             st_company_name: input.st_company_name,
//             bank_account_number: input.bank_account_number,
//             st_email: input.st_email,
//             st_phone: input.st_phone,
//             st_image: input.st_image,
//             e_id: input.e_id,
//             bk_id: input.bk_id
//         } = input;


//         const [res] = await pool.query<ResultSetHeader>(`INSERT INTO Store  SET ?`, data);
//         return res.insertId;


//     } catch (err) {
//         if (isDupError(err)) {
//             console.log(`Duplicate entry error: ${err}`);
//             throw new ApiError(409, CommonMessages.isExits);
//         }
//         console.error(`Error creating store: ${err}`);
//         throw err;
//     }
// }

export async function updateStore(st_id: number, input: UpdateStoreInput): Promise<void> {
    try {

        const data: {
            st_company_name: string;
            bank_account_number: string;
            st_email: string;
            st_phone: string;
            st_image: string | undefined;
            bk_id: number;
            omise_recipient_id?: string | null;
        } = {
            st_company_name: input.st_company_name,
            bank_account_number: input.bank_account_number,
            st_email: input.st_email,
            st_phone: input.st_phone,
            st_image: input.st_image,
            bk_id: input.bk_id
        };
        if (input.omise_recipient_id !== undefined) {
            data.omise_recipient_id = input.omise_recipient_id;
        }
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
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        await conn.query<ResultSetHeader>(`DELETE FROM Locations WHERE st_id = ?`, [st_id]);

        await conn.query<ResultSetHeader>(`DELETE FROM Store_Tax_Profile WHERE st_id = ?`, [st_id]);

        await conn.query<ResultSetHeader>(`DELETE FROM Store_Documents WHERE st_id = ?`, [st_id]);

        await conn.query<ResultSetHeader>(`DELETE FROM Store_Logs WHERE st_id = ?`, [st_id]);

        await conn.query<ResultSetHeader>(`DELETE FROM Employees WHERE st_id = ?`, [st_id]);

        const [res] = await conn.query<ResultSetHeader>(`DELETE FROM Store WHERE st_id = ?`, [st_id]);

        if (res.affectedRows === 0) {
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

export async function listBanks(): Promise<BankDTO[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & BankDTO[]>(`SELECT bk_id, bk_name FROM Bank order by bk_id asc`);
    return rows;
}

