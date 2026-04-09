import { Router } from "express";
import * as controller from "./category.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const categoryRouters = Router();



categoryRouters.get("/", controller.list)
categoryRouters.use(Auth)
categoryRouters.post("/", controller.create)
categoryRouters.put("/:cl_id", controller.update)
categoryRouters.delete("/:c_id", controller.deleteCategory)