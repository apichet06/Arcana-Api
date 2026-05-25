import { Router } from "express";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import * as controller from "./orders.controller.js";

export const orderRouter = Router();

orderRouter.post("/", BuyerAuth, controller.createOrder);
orderRouter.get("/shipping-options", BuyerAuth, controller.getShippingOptions);
orderRouter.get("/", BuyerAuth, controller.getOrders);
orderRouter.get("/:or_id", BuyerAuth, controller.getOrderById);
