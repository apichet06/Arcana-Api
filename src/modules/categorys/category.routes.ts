import { Router } from "express";
import * as controller from "./category.controller.js";

export const categoryRouters = Router();

categoryRouters.get("/", controller.list)
categoryRouters.post("/", controller.create)
categoryRouters.put("/:cl_id", controller.update)
categoryRouters.delete("/:c_id", controller.deleteCategory)