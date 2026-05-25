import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./chat.service.js";

// ── Buyer ──────────────────────────────────────────────────────────────────

export const getOrCreateConversation = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const stId = Number(req.body?.st_id) || 1;
    const conv = await service.getOrCreateConversation(userId, stId);
    res.json({ data: conv });
});

export const getMessages = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const messages = await service.getMessages(conv_id, userId);
    res.json({ data: messages });
});

export const sendMessage = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const { body, message_type } = req.body ?? {};
    if (!body?.trim()) throw new ApiError(400, "กรุณาระบุข้อความ");
    const message = await service.sendMessage(conv_id, userId, body.trim(), message_type ?? 'text');
    res.status(201).json({ data: message });
});

// ── Admin ──────────────────────────────────────────────────────────────────

export const adminListConversations = asyncHandler(async (req, res) => {
    const storeId = req.storeId;

    if (!storeId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conversations = await service.adminGetConversations(storeId);
    res.json({ data: conversations });
});

export const adminGetMessages = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    if (!storeId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const messages = await service.adminGetMessages(conv_id, storeId);
    res.json({ data: messages });
});

export const adminMarkAsRead = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    const empId = req.empId;
    if (!storeId || !empId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    await service.adminMarkAsRead(conv_id, storeId, empId);
    res.json({ success: true });
});

export const adminSendMessage = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    const empId = req.empId;
    if (!storeId || !empId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const { body, message_type } = req.body ?? {};
    if (!body?.trim()) throw new ApiError(400, "กรุณาระบุข้อความ");
    const message = await service.adminSendMessage(conv_id, storeId, empId, body.trim(), message_type ?? 'text');
    res.status(201).json({ data: message });
});
