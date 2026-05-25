import jwt from "jsonwebtoken";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./register-buyer.service.js";
import { UserMessages } from "../../shared/messages/user.messages.js";
import { AuthMessages } from "../../shared/messages/auth.messages.js";

export const register = asyncHandler(async (req, res) => {
    const {
        u_username,
        u_email,
        u_password,
        u_birthday,
        u_gender,
        u_provider,
        locb_recipient_name,
        locb_phone,
        locb_address,
        provinces_id,
        districts_id,
        subdistricts_id,
        zip_code,
        is_default,
    } = req.body ?? {};

    if (!u_username || !u_email || !u_password) {
        throw new ApiError(400, UserMessages.requiredFields);
    }

    if (!locb_recipient_name || !locb_phone || !locb_address || !provinces_id || !districts_id || !subdistricts_id || !zip_code) {
        throw new ApiError(400, "จำเป็นต้องระบุข้อมูลที่อยู่จัดส่ง");
    }

    const user = await service.registerBuyer({
        u_username,
        u_email,
        u_password,
        u_birthday: u_birthday ?? null,
        u_gender: u_gender ?? null,
        u_provider: u_provider ?? "LOCAL",
        locb_recipient_name,
        locb_phone,
        locb_address,
        provinces_id,
        districts_id,
        subdistricts_id,
        zip_code,
        is_default: is_default ?? false,
    });

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, AuthMessages.secret);

    const token = jwt.sign(
        { userId: user.u_id, userEmail: user.u_email, username: user.u_username },
        secret,
        { expiresIn: "20h" }
    );

    res.status(201).json({ token, user });
});

export const login = asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) throw new ApiError(400, "จำเป็นต้องระบุ email และ password");

    const user = await service.loginBuyer(email, password);

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, AuthMessages.secret);

    const token = jwt.sign(
        { userId: user.u_id, userEmail: user.u_email, username: user.u_username },
        secret,
        { expiresIn: "20h" }
    );

    res.status(200).json({ token, user });
});

export const facebookLogin = asyncHandler(async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) throw new ApiError(400, "จำเป็นต้องระบุ access_token");

    const { user, isNew } = await service.facebookAuth(access_token);

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, AuthMessages.secret);

    const token = jwt.sign(
        { userId: user.u_id, userEmail: user.u_email, username: user.u_username },
        secret,
        { expiresIn: "20h" }
    );

    res.status(isNew ? 201 : 200).json({ token, user });
});

// ─── Profile ────────────────────────────────────────────────────────────────

export const getMe = asyncHandler(async (req, res) => {
    const data = await service.getMyProfile(req.userId!);
    res.status(200).json({ data });
});

export const updateMe = asyncHandler(async (req, res) => {
    const { u_username, u_birthday, u_gender } = req.body ?? {};
    if (!u_username) throw new ApiError(400, "กรุณากรอกชื่อผู้ใช้");

    const data = await service.updateMyProfile(req.userId!, {
        u_username,
        u_birthday: u_birthday ?? null,
        u_gender: u_gender ?? null,
    });
    res.status(200).json({ data });
});

// ─── Addresses ──────────────────────────────────────────────────────────────

export const getAddresses = asyncHandler(async (req, res) => {
    const data = await service.getMyAddresses(req.userId!);
    res.status(200).json({ data });
});

export const addAddress = asyncHandler(async (req, res) => {
    const { locb_recipient_name, locb_phone, locb_address, provinces_id, districts_id, subdistricts_id, zip_code, is_default } = req.body ?? {};

    if (!locb_recipient_name || !locb_phone || !locb_address || !provinces_id || !districts_id || !subdistricts_id || !zip_code) {
        throw new ApiError(400, "กรุณากรอกข้อมูลที่อยู่ให้ครบถ้วน");
    }

    await service.addMyAddress(req.userId!, {
        locb_recipient_name,
        locb_phone,
        locb_address,
        provinces_id: Number(provinces_id),
        districts_id: Number(districts_id),
        subdistricts_id: Number(subdistricts_id),
        zip_code,
        is_default: Boolean(is_default),
    });
    res.status(201).json({ message: "เพิ่มที่อยู่เรียบร้อยแล้ว" });
});

export const updateAddress = asyncHandler(async (req, res) => {
    const locb_id = Number(req.params.id);
    const { locb_recipient_name, locb_phone, locb_address, provinces_id, districts_id, subdistricts_id, zip_code, is_default } = req.body ?? {};

    if (!locb_recipient_name || !locb_phone || !locb_address || !provinces_id || !districts_id || !subdistricts_id || !zip_code) {
        throw new ApiError(400, "กรุณากรอกข้อมูลที่อยู่ให้ครบถ้วน");
    }

    await service.updateMyAddress(req.userId!, locb_id, {
        locb_recipient_name,
        locb_phone,
        locb_address,
        provinces_id: Number(provinces_id),
        districts_id: Number(districts_id),
        subdistricts_id: Number(subdistricts_id),
        zip_code,
        is_default: Boolean(is_default),
    });
    res.status(200).json({ message: "อัปเดตที่อยู่เรียบร้อยแล้ว" });
});

export const setDefaultAddress = asyncHandler(async (req, res) => {
    const locb_id = Number(req.params.id);
    await service.setDefaultAddress(req.userId!, locb_id);
    res.status(200).json({ message: "ตั้งเป็นที่อยู่หลักเรียบร้อยแล้ว" });
});

export const deleteAddress = asyncHandler(async (req, res) => {
    const locb_id = Number(req.params.id);
    await service.deleteAddress(req.userId!, locb_id);
    res.status(200).json({ message: "ลบที่อยู่เรียบร้อยแล้ว" });
});

// ─── OAuth ───────────────────────────────────────────────────────────────────

export const googleLogin = asyncHandler(async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) throw new ApiError(400, "จำเป็นต้องระบุ access_token");

    const { user, isNew } = await service.googleAuth(access_token);

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, AuthMessages.secret);

    const token = jwt.sign(
        { userId: user.u_id, userEmail: user.u_email, username: user.u_username },
        secret,
        { expiresIn: "20h" }
    );

    res.status(isNew ? 201 : 200).json({ token, user });
});
