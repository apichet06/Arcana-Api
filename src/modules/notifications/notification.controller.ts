import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as notification from "./notification.service.js";


export const list = asyncHandler(async (_req, res) => {
    const { st_id } = _req.params
    const data = await notification.ListNotification(Number(st_id));
    res.status(200).json({ data });
})

export const markAsRead = asyncHandler(async (_req, res) => {
    const { noti_id } = _req.params
    const data = await notification.UpdateAsRead(Number(noti_id));
    res.status(200).json({ data });
})
export const markAllAsRead = asyncHandler(async (_req, res) => {
    const { st_id } = _req.params
    const data = await notification.UpdateAllRead(Number(st_id));
    res.status(200).json({ data });

})