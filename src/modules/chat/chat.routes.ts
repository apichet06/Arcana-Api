import { Router } from "express";
import * as controller from "./chat.controller.js";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const chatRouter = Router();

// Buyer routes
chatRouter.post("/conversations", BuyerAuth, controller.getOrCreateConversation);
chatRouter.get("/conversations/:conv_id/messages", BuyerAuth, controller.getMessages);
chatRouter.post("/conversations/:conv_id/messages", BuyerAuth, controller.sendMessage);

// Admin routes (employee JWT)
chatRouter.get("/admin/conversations", Auth, controller.adminListConversations);
chatRouter.get("/admin/conversations/:conv_id/messages", Auth, controller.adminGetMessages);
chatRouter.patch("/admin/conversations/:conv_id/read", Auth, controller.adminMarkAsRead);
chatRouter.post("/admin/conversations/:conv_id/messages", Auth, controller.adminSendMessage);
