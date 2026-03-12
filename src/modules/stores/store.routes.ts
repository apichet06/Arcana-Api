import { Router } from "express";
import multer from "multer";
import * as controller from "./store.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const storeRouter = Router();

const upload = multer({ dest: "public/uploads/" });

storeRouter.use(Auth);
storeRouter.get("/", controller.list);
storeRouter.post("/", upload.single("st_image"), controller.create);
storeRouter.get("/banks", controller.listBanks);
storeRouter.get("/:st_id", controller.getById);
storeRouter.put("/:st_id", upload.single("st_image"), controller.update);
storeRouter.delete("/:st_id", controller.deleteStore);
