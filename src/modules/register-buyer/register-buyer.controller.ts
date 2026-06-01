import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./register-buyer.service.js";
import { UserMessages } from "../../shared/messages/user.messages.js";
import { AuthMessages } from "../../shared/messages/auth.messages.js";
import type { RegisterBuyerDTO } from "./type.js";

const ACCESS_TOKEN_EXPIRES_IN = "30m";

function signAccessToken(user: RegisterBuyerDTO): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, AuthMessages.secret);

    // access token อายุสั้น ถ้าหมดอายุ frontend จะใช้ refresh cookie ขอ token ใหม่อัตโนมัติ
    return jwt.sign(
        { userId: user.u_id, userEmail: user.u_email, username: user.u_username },
        secret,
        { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(";").map((item) => item.trim());
    const target = cookies.find((item) => item.startsWith(`${name}=`));
    if (!target) return null;
    return decodeURIComponent(target.slice(name.length + 1));
}

function shouldUseCrossSiteCookie(req: Request): boolean {
    const origin = req.get("origin");
    if (!origin) return process.env.NODE_ENV === "production";

    try {
        const originUrl = new URL(origin);
        const requestProtocol = req.protocol;
        const requestHost = req.get("host") ?? "";

        // dev ของเราอาจเป็น https://localhost:3000 -> http://localhost:5000
        // browser มองว่า cross-site เพราะ scheme ต่างกัน จึงต้องใช้ SameSite=None; Secure
        return originUrl.protocol.replace(":", "") !== requestProtocol || originUrl.host !== requestHost;
    } catch {
        return process.env.NODE_ENV === "production";
    }
}

function refreshCookieOptions(req: Request) {
    const crossSite = shouldUseCrossSiteCookie(req);
    return {
        httpOnly: true,
        secure: crossSite || process.env.NODE_ENV === "production",
        sameSite: crossSite ? "none" as const : "lax" as const,
        path: "/api/auth",
    };
}

function setRefreshCookie(req: Request, res: Response, refreshToken: string) {
    // refresh token เก็บใน httpOnly cookie เพื่อไม่ให้ JavaScript อ่าน token อายุยาวตัวนี้ได้
    res.cookie(service.refreshTokenConfig.cookieName, refreshToken, {
        ...refreshCookieOptions(req),
        maxAge: service.refreshTokenConfig.maxAgeMs,
    });
}

function clearRefreshCookie(req: Request, res: Response) {
    res.clearCookie(service.refreshTokenConfig.cookieName, {
        ...refreshCookieOptions(req),
    });
}

async function sendAuthResponse(
    req: Request,
    res: Response,
    status: number,
    user: RegisterBuyerDTO
) {
    const refreshToken = await service.createRefreshTokenSession({
        u_id: user.u_id,
        user_agent: req.get("user-agent") ?? null,
        ip_address: req.ip ?? null,
    });
    setRefreshCookie(req, res, refreshToken);
    res.status(status).json({ token: signAccessToken(user), user });
}

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

    await sendAuthResponse(req, res, 201, user);
});

export const login = asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) throw new ApiError(400, "จำเป็นต้องระบุ email และ password");

    const user = await service.loginBuyer(email, password);

    await sendAuthResponse(req, res, 200, user);
});

export const facebookLogin = asyncHandler(async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) throw new ApiError(400, "จำเป็นต้องระบุ access_token");

    const { user, isNew } = await service.facebookAuth(access_token);

    await sendAuthResponse(req, res, isNew ? 201 : 200, user);
});

export const refresh = asyncHandler(async (req, res) => {
    const refreshToken = parseCookie(req.headers.cookie, service.refreshTokenConfig.cookieName);
    if (!refreshToken) throw new ApiError(401, "ไม่พบ refresh token กรุณาเข้าสู่ระบบใหม่");

    // หมุน refresh token ทุกครั้งที่ใช้ เพื่อลดความเสี่ยงถ้า token เก่าหลุดออกไป
    const result = await service.rotateRefreshToken(refreshToken, {
        user_agent: req.get("user-agent") ?? null,
        ip_address: req.ip ?? null,
    });
    setRefreshCookie(req, res, result.refreshToken);
    res.status(200).json({ token: signAccessToken(result.user), user: result.user });
});

export const logout = asyncHandler(async (req, res) => {
    const refreshToken = parseCookie(req.headers.cookie, service.refreshTokenConfig.cookieName);
    if (refreshToken) await service.revokeRefreshToken(refreshToken);
    clearRefreshCookie(req, res);
    res.status(200).json({ message: "ออกจากระบบเรียบร้อยแล้ว" });
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

    await sendAuthResponse(req, res, isNew ? 201 : 200, user);
});
