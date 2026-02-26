import { Router } from "express";
import * as controller from "./category.controller.js";

export const categoryRouters = Router();

categoryRouters.get("/", controller.list)
categoryRouters.post("/", controller.create)