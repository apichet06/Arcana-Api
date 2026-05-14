
import { Router } from "express";
import * as controller from "./notification.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const NotiRouter = Router();

NotiRouter.use(Auth);
NotiRouter.get("/:st_id", controller.list)
NotiRouter.patch("/:noti_id/read", controller.markAsRead)
NotiRouter.patch("/store/:st_id/read-all", controller.markAllAsRead)
