import * as emp from "./emp.service.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import jwt from "jsonwebtoken";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import bcrypt from "bcrypt";
import { AuthMessages } from "../../shared/messages/auth.messages.js";
import { ApiError } from "../../shared/errors/ApiError.js";

export const list = asyncHandler(async (_req, res) => {
    const { st_id } = _req.params;
    const data = await emp.listEmps(Number(st_id));
    res.status(200).json({ data });
});


export const login = asyncHandler(async (req, res) => {

    const { email, password } = req.body;
    const employee = await emp.findByEmpLogin(email);
    if (!employee) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    const isMatch = await bcrypt.compare(password, employee.e_password);
    if (!isMatch) {
        return res.status(400).json({ message: AuthMessages.invalidPassword });
    }
    if (!employee.e_isActive) {
        return res.status(403).json({ message: AuthMessages.resign });
    }
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        throw new Error("JWT_SECRET is not defined(ไม่ได้ถูกกำหนดไว้)");
    }

    const token = jwt.sign({
        empId: employee.e_id,
        empEmail: employee.e_email,
        empStatus: employee.e_status,
        empFirstname: employee.e_firstname,
        storeId: employee.st_id,
        empFullname: `${employee.e_firstname} ${employee.e_lastname}`,
    }, jwtSecret, { expiresIn: '20h' })

    const { e_password, e_phone, e_upd_name, e_add_name, e_add_datetime, ...data } = employee;
    res.status(200).json({ token, data: data });
})


export const createFullAdmin = asyncHandler(async (req, res) => {
    const { e_firstname, e_lastname, e_email, e_phone, e_isActive, e_add_name, e_status, st_id } = req.body;
    const password = "arcana@!234";
    const hashePassword = await bcrypt.hash(password, 10);
    const employee = { e_firstname, e_lastname, e_password: hashePassword, e_email, e_phone, e_isActive, e_add_name, e_status, st_id };
    await emp.CreateEmpAdmins(employee);
    res.status(201).json({ message: CommonMessages.insertSuccess });

})

export const updatefullAdmin = asyncHandler(async (req, res) => {
    const { e_id } = req.params;
    const { e_firstname, e_lastname, e_email, e_phone, e_isActive, e_upd_name, e_status, st_id } = req.body;
    const employee = { e_firstname, e_lastname, e_email, e_phone, e_isActive, e_upd_name, e_status, st_id };
    await emp.UpdateEmpAdmins(Number(e_id), employee);
    res.status(200).json({ message: CommonMessages.updateSuccess });

})

export const changePassword = asyncHandler(async (req, res) => {
    const { e_id } = req.params;
    const { PasswordOld, PasswordNew } = req.body ?? {};
    const employeeId = Number(e_id);

    if (!employeeId || !PasswordOld || !PasswordNew) {
        throw new ApiError(400, "ข้อมูลไม่ครบถ้วน");
    }

    if (Number(req.empId) !== employeeId) {
        throw new ApiError(403, "ไม่มีสิทธิ์เปลี่ยนรหัสผ่านของผู้ใช้นี้");
    }

    const employee = await emp.findByEmpId(employeeId);
    if (!employee) {
        throw new ApiError(404, CommonMessages.notFound);
    }

    const isMatch = await bcrypt.compare(PasswordOld, employee.e_password);
    if (!isMatch) {
        throw new ApiError(400, AuthMessages.passwordNotMatch);
    }

    const hashedPassword = await bcrypt.hash(PasswordNew, 10);
    await emp.updatePassword(employeeId, hashedPassword);

    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteFullAdmin = asyncHandler(async (req, res) => {
    const { e_id } = req.params;
    await emp.DeleteEmpAdmins(Number(e_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});


export const create = asyncHandler(async (req, res) => {
    const { e_firstname, e_lastname, e_password, e_email, e_phone, e_isActive, e_add_name, e_isAccept, e_status, st_id } = req.body;
    const { st_company_name, _company_name, st_idcard, bank_name, account_number, omise_recipient_id, st_email, created_at, st_phone } = req.body;
    const { loc_name, loc_address, loc_postcode, Subdistricts_id, Districts_id, Provinces_id } = req.body;
    const empId = Number(req.empId);
    const files = req.files as { [key: string]: Express.Multer.File[] };
    // let e_image = null;
    let st_image = null;


    // store image
    if (files?.st_image?.[0]) {
        const file = files.st_image[0];
        const path = await fileUploadImage(file, `store_${Date.now()}`, 'store');
        if (path) {
            st_image = path.replace(/\\/g, '/');
        }
    }

    const employee = { e_firstname, e_lastname, e_password, e_email, e_phone, e_isActive, e_add_name, e_isAccept, e_status, st_id };
    const store = { st_company_name, _company_name, st_idcard, bank_name, account_number, omise_recipient_id, st_email, created_at, st_phone, st_image, e_id: empId };
    const location = { loc_name, loc_address, loc_postcode, Subdistricts_id, Districts_id, Provinces_id };


    await emp.createEmp(store, employee, location);
    res.status(201).json({ message: CommonMessages.insertSuccess });
});


