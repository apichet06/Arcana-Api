import express from "express";
import cors from "cors";
import helmet from "helmet";


import { requestLogger } from "./shared/middlewares/requestLogger.js";
import { notFound } from "./shared/middlewares/notFound.js";
import { errorHandler } from "./shared/errors/errorHandler.js";

import { healthRoutes } from "./modules/health/health.routes.js";
import { usersRouters } from "./modules/users/users.routes.js";
import { catalogRouters } from "./modules/catalogs/catalog.routes.js";
import { categoryRouters } from "./modules/categorys/category.routes.js";

export function createApp() {
    const app = express();

    app.use(helmet());
    app.use(cors());
    app.use(express.json({ limit: "10mb" }));
    app.use(express.urlencoded({ extended: true, limit: "10mb" }));
    app.use(requestLogger);

    app.use("/api", healthRoutes);
    app.use("/api/users", usersRouters);
    app.use("/api/catalogs", catalogRouters);
    app.use("/api/categorys", categoryRouters);


    app.use(notFound);
    app.use(errorHandler);

    return app;
}