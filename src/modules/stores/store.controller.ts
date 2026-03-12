import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as store from "./store.service.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import * as fs from "fs";
import * as pathfile from "path";


export const list = asyncHandler(async (req, res) => {
    const data = await store.listStores();
    res.status(200).json({ data });
});

export const getById = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const data = await store.getStoreById(Number(st_id));
    if (!data) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const { st_company_name, st_idcard, account_number, omise_recipient_id, st_email, st_isAccept, created_at, st_phone, bk_id } = req.body;

    const file = req.file;
    let st_imagePath = null;
    const empId = Number(req.empId);
    const exits = await store.getStoreByCompanyName(st_company_name);
    if (exits) {
        if (file) {
            fs.unlinkSync(file.path);
        }
        return res.status(400).json({ message: CommonMessages.isExits });
    }

    if (file) {
        const path = await fileUploadImage(file, `store_${Date.now()}`, 'store');
        if (path) {
            st_imagePath = path.replace(/\\/g, '/');
        }
    }

    const input = { st_company_name, st_idcard, account_number, omise_recipient_id, st_email, st_isAccept, created_at, st_phone, st_image: st_imagePath, e_id: empId, bk_id };
    const id = await store.CreateStore(input);
    res.status(201).json({ message: CommonMessages.insertSuccess, id });
});

export const update = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const { st_company_name, st_idcard, account_number, omise_recipient_id, st_email, st_isAccept, created_at, st_phone, bk_id } = req.body;
    const empId = Number(req.empId);
    const file = req.file;
    const oldImage = await store.getStoreById(Number(st_id)).then(store => store?.st_image);
    let imagePath = oldImage; // เริ่มต้นด้วยภาพเก่า
    if (file) {
        if (oldImage) {
            const fullOldImagePath = pathfile.join(process.cwd(), 'uploads', oldImage);
            try {
                await fs.unlinkSync(fullOldImagePath);
            } catch (err: any) {
                console.log("ลบรูปเก่าไม่ได้ (อาจไม่มีไฟล์):", err.message);
            }
        }

        const path = await fileUploadImage(file, `store_${Date.now()}`, 'store');
        if (path) {
            imagePath = path.replace(/\\/g, '/');
        }
    }


    const input = { st_company_name, st_idcard, account_number, omise_recipient_id, st_email, st_isAccept, created_at, st_phone, st_image: imagePath, e_id: empId, bk_id };
    await store.updateStore(Number(st_id), input);
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteStore = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const data = await store.getStoreById(Number(st_id));
    console.log("ข้อมูลร้านค้าที่จะลบ:", data);
    if (!data) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    const oldImage = data.st_image;
    if (oldImage) {
        const fullOldImagePath = pathfile.join(process.cwd(), 'public', oldImage);
        try {
            await fs.unlinkSync(fullOldImagePath);
        } catch (err: any) {
            console.log("ลบรูปเก่าไม่ได้ (อาจไม่มีไฟล์):", err.message);
        }
    }

    await store.deleteStore(Number(st_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});

export const listBanks = asyncHandler(async (_req, res) => {
    const data = await store.listBanks();
    res.status(200).json({ data });
});