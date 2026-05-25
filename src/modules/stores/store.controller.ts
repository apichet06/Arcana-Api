import bcrypt from 'bcrypt';
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as store from "./store.service.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { cleanupSavedFiles, fileUploadImage, safeUnlink } from "../../shared/middlewares/fileUploadImage.js";
import * as fs from "fs";
import * as pathfile from "path";
import { findByEmpId } from '../employees/emp.service.js';
import type { empDTO } from '../employees/emp.type.js';


export const list = asyncHandler(async (req, res) => {
    const data = await store.listStores();
    res.status(200).json({ data });
});

export const listShop = asyncHandler(async (req, res) => {
    const data = await store.getlistStoreShop();
    res.status(200).json({ data });
});

export const listShopById = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const data = await store.getlistSroreShopById(Number(st_id));
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

export const existsCompanyName = asyncHandler(async (req, res) => {
    const { st_company_name } = req.params;

    const data = await store.getStoreByCompanyName(String(st_company_name));
    if (data) return res.status(200).json({ available: false, message: `${CommonMessages.isExits} ${st_company_name} กรุณาเปลี่ยนชื่อใหม่` });
    res.status(200).json({ available: true, message: "ชื่อร้านค้านี้ยังไม่มีในระบบ สามารถใช้งานได้" });
})
export const existsEmailStore = asyncHandler(async (req, res) => {
    const { st_email } = req.params;
    const data = await store.getStoreByEmail(String(st_email));
    if (data) return res.status(200).json({ available: false, message: `${CommonMessages.isExits} ${st_email} กรุณาเปลี่ยนอีเมลใหม่` });
    res.status(200).json({ available: true, message: "อีเมลนี้ยังไม่มีในระบบ สามารถใช้งานได้" });
})
export const existsEmailEmployee = asyncHandler(async (req, res) => {
    const { e_email } = req.params;
    const data = await store.getEmployeeByEmail(String(e_email));
    if (data) return res.status(200).json({ available: false, message: `${CommonMessages.isExits} ${e_email} กรุณาเปลี่ยนอีเมลใหม่` });
    res.status(200).json({ available: true, message: "อีเมลนี้ยังไม่มีในระบบ สามารถใช้งานได้" });
})

export const getLogstore = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const data = await store.getlistLogstore(Number(st_id));
    res.status(200).json({ data });
})


export const requestDocument = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const { note, doc_types } = req.body;

    const eId = Number(req.empId);
    const eData = await findByEmpId(Number(eId));

    await store.requestDocument(Number(st_id), eData as empDTO, note, doc_types);
    return res.status(201).json({ message: CommonMessages.insertSuccess });
})

export const updateTaxProfile = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const {
        legal_name,
        is_vat_registered,
        branch_type,
        branch_code,
        tax_address,
        tax_id_number,
        tax_province_id,
        tax_district_id,
        tax_subdistrict_id,
        tax_zip_code,
        tax_seller_type,
    } = req.body;

    const input = {
        legal_name,
        is_vat_registered,
        branch_type,
        branch_code,
        tax_address,
        tax_id_number,
        tax_province_id,
        tax_district_id,
        tax_subdistrict_id,
        tax_zip_code,
        tax_seller_type,
    };


    await store.updateStoreTaxProfile(Number(st_id), input);
    return res.status(200).json({ message: CommonMessages.updateSuccess });
})

export const UpdateStatusStore = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const { st_status, note } = req.body;

    const eId = Number(req.empId);
    const eData = await findByEmpId(Number(eId));
    const input = { st_status, note }
    await store.updateStoreStatus(Number(st_id), input, eData as empDTO);
    return res.status(201).json({ message: CommonMessages.updateSuccess });


})

export const DeleteDocumentFile = asyncHandler(async (req, res) => {
    const { doc_id } = req.params;
    const data = await store.getDocumentById(Number(doc_id));
    if (!data) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    if (data.file_path) {
        const fullOldImagePath = pathfile.join(process.cwd(), 'public', data.file_path);
        try {
            fs.unlinkSync(fullOldImagePath);
        } catch (err: any) {
            console.log("ลบรูปเก่าไม่ได้ (อาจไม่มีไฟล์):", err.message);
        }
    }
    await store.DeleteDocumentFile(Number(doc_id));
    return res.status(200).json({ message: CommonMessages.deleteSuccess });
})



export const CreateDocumentFormEdit = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const { documents_meta } = req.body;
    const savedPaths: string[] = [];

    const eId = Number(req.empId);
    const eData = await findByEmpId(Number(eId));

    const files = req.files as {
        st_image?: Express.Multer.File[];
        doc_VAT_CERT?: Express.Multer.File[];
        doc_COMPANY_CERT?: Express.Multer.File[];
        doc_ID_CARD?: Express.Multer.File[];
        doc_OTHER?: Express.Multer.File[];
    };
    const documenteMeta = JSON.parse(documents_meta ?? "[]");
    const documents = await Promise.all(
        documenteMeta.map(async (meta: { doc_type: string }) => {
            const fieldKey = `doc_${meta.doc_type}` as keyof typeof files;
            const docFiles = files?.[fieldKey] ?? [];

            const uploadedFiles = await Promise.all(
                docFiles.map(async (file, idx) => {
                    //  แปลง encoding ของชื่อไฟล์จาก latin1 → utf8
                    const fixedOriginalName = Buffer.from(file.originalname, "latin1").toString("utf8");

                    const movedPath = await fileUploadImage(file, `${meta.doc_type}_${Date.now()}_${idx}`, "documents");

                    savedPaths.push(movedPath);

                    return {
                        file_path: movedPath,
                        original_name: fixedOriginalName,  //   ใช้ตัวที่แก้แล้ว
                        mime_type: file.mimetype,
                        size: file.size,
                    };
                })
            );

            return {
                doc_type: meta.doc_type,
                files: uploadedFiles,
            };
        })
    );


    await store.UploadDocumetDATA(documents, Number(st_id), eData as empDTO);

    return res.status(201).json({ message: CommonMessages.insertSuccess });
})

export const createRegister = asyncHandler(async (req, res) => {
    const savedPaths: string[] = [];

    try {
        const files = req.files as {
            st_image?: Express.Multer.File[];
            doc_VAT_CERT?: Express.Multer.File[];
            doc_COMPANY_CERT?: Express.Multer.File[];
            doc_ID_CARD?: Express.Multer.File[];
            doc_OTHER?: Express.Multer.File[];
        };

        const locations = JSON.parse(req.body.locations ?? "[]");
        const employees = JSON.parse(req.body.employees ?? "[]");
        const documentsMeta = JSON.parse(req.body.documents_meta ?? "[]");

        // const exists_company_name = await store.getStoreByCompanyName(req.body.st_company_name);
        // if (exists_company_name) return res.status(400).json({ message: `${CommonMessages.isExits} ${req.body.st_company_name} กรุณาเปลี่ยนชื่อใหม่` });

        // const exists_email = await store.getStoreByCompanyName(req.body.st_email);
        // if (exists_email) return res.status(400).json({ message: `${CommonMessages.isExits} {req.body.st_email} กรุณาเปลี่ยนอีเมลใหม่` });

        // const exists_EmployeeEmail = await store.getEmployeeByEmail(employees[0]?.e_email);
        // if (exists_EmployeeEmail) return res.status(400).json({ message: `${CommonMessages.isExits} ${employees[0]?.e_email} กรุณาเปลี่ยนอีเมลใหม่` });

        let stImagePath: string | null = null;
        const stImageFile = files?.st_image?.[0];

        if (stImageFile) {
            const movedPath = await fileUploadImage(stImageFile, `store_${Date.now()}`, "store");

            stImagePath = movedPath;
            savedPaths.push(movedPath);
        }

        const documents = await Promise.all(
            documentsMeta.map(async (meta: { doc_type: string }) => {
                const fieldKey = `doc_${meta.doc_type}` as keyof typeof files;
                const docFiles = files?.[fieldKey] ?? [];

                const uploadedFiles = await Promise.all(
                    docFiles.map(async (file, idx) => {
                        //  แปลง encoding ของชื่อไฟล์จาก latin1 → utf8
                        const fixedOriginalName = Buffer.from(file.originalname, "latin1").toString("utf8");

                        const movedPath = await fileUploadImage(file, `${meta.doc_type}_${Date.now()}_${idx}`, "documents");

                        savedPaths.push(movedPath);

                        return {
                            file_path: movedPath,
                            original_name: fixedOriginalName,  //   ใช้ตัวที่แก้แล้ว
                            mime_type: file.mimetype,
                            size: file.size,
                        };
                    })
                );

                return {
                    doc_type: meta.doc_type,
                    files: uploadedFiles,
                };
            })
        );

        const empId = Number(req.empId);
        const stId = Number(req.storeId);
        const eData = empId ? await findByEmpId(empId) as empDTO : undefined;

        const password = "arcana@!234";
        const hashedPassword = await bcrypt.hash(password, 10);
        const employeesWithPassword = employees.map((emp: any) => ({
            ...emp,
            e_password: hashedPassword,
        }));

        const input = {
            st_company_name: req.body.st_company_name,
            st_email: req.body.st_email,
            st_phone: req.body.st_phone,
            st_image: stImagePath,
            bk_id: Number(req.body.bk_id),
            bank_account_number: req.body.bank_account_number,
            tax_seller_type: req.body.tax_seller_type,
            st_idcard: req.body.st_idcard,
            st_status: req.body.st_status,

            legal_name: req.body.legal_name,
            tax_id_number: req.body.tax_id_number,
            is_vat_registered: req.body.is_vat_registered === "true",
            branch_type: req.body.branch_type || null,
            branch_code: req.body.branch_code || null,
            tax_address: req.body.tax_address,
            tax_province_id: Number(req.body.tax_province_id),
            tax_district_id: Number(req.body.tax_district_id),
            tax_subdistrict_id: Number(req.body.tax_subdistrict_id),
            tax_zip_code: req.body.tax_zip_code,
            locations,
            employees: employeesWithPassword,
            documents,
            st_id: stId,
        };

        const id = await store.createStoreRegister(input, eData);

        return res.status(201).json({ message: CommonMessages.insertSuccess, id, });
    } catch (error) {
        cleanupSavedFiles(savedPaths);
        throw error;
    }
});


// export const create = asyncHandler(async (req, res) => {
//     const { st_company_name, st_email, st_phone, bank_account_number, bk_id } = req.body;

//     const file = req.file;
//     let st_imagePath = null;
//     const empId = Number(req.empId);
//     const exits = await store.getStoreByCompanyName(st_company_name);
//     if (exits) {
//         if (file) {
//             fs.unlinkSync(file.path);
//         }
//         return res.status(400).json({ message: CommonMessages.isExits });
//     }

//     if (file) {
//         const path = await fileUploadImage(file, `store_${Date.now()}`, 'store');
//         if (path) {
//             st_imagePath = path.replace(/\\/g, '/');
//         }
//     }

//     const input = { st_company_name, st_email, bank_account_number, st_phone, st_image: st_imagePath, e_id: empId, bk_id };


//     const id = await store.CreateStore(input);
//     res.status(201).json({ message: CommonMessages.insertSuccess, id });
// });

export const update = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const { st_company_name, bank_account_number, st_email, st_phone, bk_id } = req.body;
    const empId = Number(req.empId);
    const file = req.file;
    const oldImage = await store.getStoreById(Number(st_id)).then(store => store?.store.st_image);
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


    const input = { st_company_name, bank_account_number, st_email, st_phone, st_image: imagePath, bk_id };
    await store.updateStore(Number(st_id), input);
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteStore = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const data = await store.getStoreById(Number(st_id));

    if (!data) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    const oldImage = data.store.st_image;
    if (oldImage) {
        const fullOldImagePath = pathfile.join(process.cwd(), 'public', oldImage);
        try {
            fs.unlinkSync(fullOldImagePath);
        } catch (err: any) {
            console.log("ลบรูปร้านไม่ได้ (อาจไม่มีไฟล์):", err.message);
        }
    }

    for (const doc of data.documents) {
        const docPath = (doc as any).file_path;
        if (docPath) {
            try {
                fs.unlinkSync(pathfile.join(process.cwd(), 'public', docPath));
            } catch (err: any) {
                console.log("ลบไฟล์เอกสารไม่ได้ (อาจไม่มีไฟล์):", err.message);
            }
        }
    }

    await store.deleteStore(Number(st_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});

export const listBanks = asyncHandler(async (_req, res) => {
    const data = await store.listBanks();
    res.status(200).json({ data });
});

