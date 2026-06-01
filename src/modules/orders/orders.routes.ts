import { Router } from "express";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./orders.controller.js";

export const orderRouter = Router();

orderRouter.post("/checkout", BuyerAuth, controller.checkoutOrder);
orderRouter.post("/", BuyerAuth, controller.createOrder);
orderRouter.get("/shipping-options", BuyerAuth, controller.getShippingOptions);
orderRouter.get("/admin/summary", Auth, controller.adminGetOrderSummary);
orderRouter.patch("/admin/:or_id/status", Auth, controller.adminUpdateStatus);
orderRouter.patch("/admin/:or_id/tracking", Auth, controller.adminUpdateTracking);
orderRouter.post("/admin/:or_id/shipment", Auth, controller.adminCreateShipment);
orderRouter.patch("/admin/:or_id/refund/approve", Auth, controller.adminApproveRefund);
orderRouter.patch("/admin/:or_id/refund/reject", Auth, controller.adminRejectRefund);
orderRouter.get("/admin/:or_id", Auth, controller.adminGetOrderById);
orderRouter.get("/admin", Auth, controller.adminGetOrders);
orderRouter.get("/", BuyerAuth, controller.getOrders);
orderRouter.patch("/:or_id/cancel", BuyerAuth, controller.cancelOrder);
orderRouter.post("/:or_id/refund-request", BuyerAuth, controller.requestRefund);
orderRouter.get("/:or_id", BuyerAuth, controller.getOrderById);
