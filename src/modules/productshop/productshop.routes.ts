import { Router } from "express";
import * as controller from "./productshop.controller.js";

export const productShopRouter = Router()

productShopRouter.get("/:lg_code", controller.listProductShop)
productShopRouter.get("/:lg_code/:p_id", controller.getProductShopById) 