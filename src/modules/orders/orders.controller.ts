import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type { OrderStatusCode } from "./order-status.service.js";
import * as service from "./orders.service.js";

function getRequestLanguage(value: unknown): string {
    return typeof value === "string" && ["th", "en", "ja"].includes(value) ? value : "th";
}

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

export const checkoutOrder = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const {
        locb_id,
        co_code,
        shipping_sc_id,
        payment_method,
        omise_token,
        omise_source,
        saved_payment_method_id,
        save_card,
    } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!locb_id) throw new ApiError(400, "จำเป็นต้องระบุ locb_id (ที่อยู่จัดส่ง)");

    const data = await service.checkoutOrder({
        u_id,
        locb_id: Number(locb_id),
        co_code: co_code ? String(co_code).trim() : null,
        shipping_sc_id: shipping_sc_id ? Number(shipping_sc_id) : null,
        payment_method: payment_method === "promptpay" ? "promptpay" : "card",
        ...(omise_token ? { omise_token: String(omise_token) } : {}),
        ...(omise_source ? { omise_source: String(omise_source) } : {}),
        ...(saved_payment_method_id ? { saved_payment_method_id: Number(saved_payment_method_id) } : {}),
        ...(save_card ? { save_card: true } : {}),
    });

    res.status(201).json({ data });
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
    const lg_code = getRequestLanguage(req.query.lg_code);
    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");

    const orders = await service.getOrders(u_id, lg_code);
    res.status(200).json({ data: orders });
});

export const adminGetOrders = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const orders = await service.adminGetOrders(st_id);
    res.status(200).json({ data: orders });
});

export const adminGetOrderSummary = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const summary = await service.adminGetOrderSummary(st_id);
    res.status(200).json({ data: summary });
});

export const adminGetSalesReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesReport(st_id, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetSalesByProductReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesByProductReport(st_id, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetSalesByCategoryReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesByCategoryReport(st_id, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetSalesByBuyerReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesByBuyerReport(st_id, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetSalesByVendorReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesByVendorReport(st_id, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetPendingPayoutReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");

    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetPendingPayoutReport(st_id, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetPayoutSetting = asyncHandler(async (_req, res) => {
    const setting = await service.adminGetPayoutSetting();
    res.status(200).json({ data: setting });
});

export const adminUpdatePayoutSetting = asyncHandler(async (req, res) => {
    const payout_cycle_days = Number(req.body?.payout_cycle_days);
    const setting = await service.adminUpdatePayoutSetting(payout_cycle_days);
    res.status(200).json({ data: setting, message: "อัปเดตรอบจ่ายสำเร็จ" });
});

export const adminGetOrderById = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);

    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");

    const order = await service.adminGetOrderById(or_id, st_id);
    if (!order) throw new ApiError(404, "ไม่พบ order");

    res.status(200).json({ data: order });
});

export const adminApproveRefund = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");

    const order = await service.approveRefundRequest(or_id, st_id, note);
    res.status(200).json({ data: order, message: "อนุมัติคืนเงินสำเร็จ" });
});

export const adminUpdateStatus = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const statusCode = String(req.body?.status_code ?? "");
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    const allowedStatusCodes = ["PROCESSING", "PACKED", "READY_TO_SHIP"];

    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");
    if (!allowedStatusCodes.includes(statusCode)) throw new ApiError(400, "สถานะที่ต้องการเปลี่ยนไม่ถูกต้อง");

    const order = await service.adminUpdateOrderStatus(or_id, st_id, statusCode as OrderStatusCode, note);
    const message =
        statusCode === "READY_TO_SHIP"
            ? "พร้อมส่งออกแล้ว ระบบสร้าง shipment ให้เรียบร้อย และยังสามารถแก้ไขเลขพัสดุได้"
            : "เปลี่ยนสถานะคำสั่งซื้อสำเร็จ";
    res.status(200).json({ data: order, message });
});

export const adminUpdateTracking = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const trackingNo = typeof req.body?.tracking_no === "string" ? req.body.tracking_no : "";

    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");

    const order = await service.adminUpdateOrderTracking(or_id, st_id, trackingNo);
    res.status(200).json({ data: order, message: "บันทึกเลขพัสดุสำเร็จ" });
});

export const adminCreateShipment = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);

    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");

    const order = await service.adminCreateOrderShipment(or_id, st_id);
    res.status(200).json({
        data: order,
        message: "พร้อมส่งออกแล้ว ระบบสร้าง shipment ให้เรียบร้อย และยังสามารถแก้ไขเลขพัสดุได้",
    });
});

export const adminRejectRefund = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    if (!st_id) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");

    const order = await service.rejectRefundRequest(or_id, st_id, note);
    res.status(200).json({ data: order, message: "ปฏิเสธคำขอคืนเงินแล้ว" });
});

export const getOrderById = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");

    const order = await service.getOrderById(or_id, u_id, lg_code);
    if (!order) throw new ApiError(404, "ไม่พบ order");

    res.status(200).json({ data: order });
});

export const cancelOrder = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");
    if (reason.length < 5) throw new ApiError(400, "กรุณาระบุเหตุผลในการยกเลิกคำสั่งซื้อ");

    const order = await service.cancelOrder(or_id, u_id, reason, lg_code);
    res.status(200).json({ data: order, message: "ยกเลิกคำสั่งซื้อสำเร็จ" });
});

export const requestRefund = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "or_id ไม่ถูกต้อง");
    if (reason.length < 5) throw new ApiError(400, "กรุณาระบุเหตุผลในการขอคืนเงิน");

    const order = await service.requestRefund(or_id, u_id, reason, lg_code);
    res.status(201).json({ data: order, message: "ส่งคำขอคืนเงินแล้ว" });
});
