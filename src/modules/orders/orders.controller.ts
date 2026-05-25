import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./orders.service.js";

export const createOrder = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const { locb_id, co_code, shipping_sc_id } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!locb_id) throw new ApiError(400, "จำเป็นต้องระบุ locb_id (ที่อยู่จัดส่ง)");

    // co_code เป็น optional: ถ้าไม่ส่งมา checkout จะสร้าง order แบบไม่ใช้คูปอง
    const order = await service.createOrder({
        u_id,
        locb_id,
        co_code: co_code ? String(co_code).trim() : null,
        shipping_sc_id: shipping_sc_id ? Number(shipping_sc_id) : null,
    });
    res.status(201).json({ data: order });
});

export const getShippingOptions = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const locb_id = Number(req.query.locb_id);

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!locb_id || isNaN(locb_id)) throw new ApiError(400, "จำเป็นต้องระบุ locb_id (ที่อยู่จัดส่ง)");

    const data = await service.getCheckoutShippingOptions({ u_id, locb_id });
    res.status(200).json({ data });
});

export const getOrders = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");

    const orders = await service.getOrders(u_id);
    res.status(200).json({ data: orders });
});

export const getOrderById = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");

    const order = await service.getOrderById(or_id, u_id);
    if (!order) throw new ApiError(404, "ไม่พบ order");

    res.status(200).json({ data: order });
});
