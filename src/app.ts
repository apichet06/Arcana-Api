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
import BrandRouter from "./modules/brands/brands.routes.js";
import { unitRouters } from "./modules/units/units.routes.js";
import { ProductTagRouter } from "./modules/productTags/productTags.routes.js";
import { AddressRouter } from "./modules/address/address.routes.js";
import { storeRouter } from "./modules/stores/store.routes.js";
import path from "path";
import { LocationRouter } from "./modules/locations/location.routes.js";
import { EmpRouter } from "./modules/employees/emp.routes.js";

export function createApp() {
    const app = express();

    app.use(helmet());
    app.use(cors());
    app.use(express.json({ limit: "10mb" }));
    app.use(express.urlencoded({ extended: true, limit: "10mb" }));
    app.use(requestLogger);

    app.use("/api", healthRoutes);
    app.use("/api/uploads",
        express.static(path.join(process.cwd(), "public/uploads"), {
            setHeaders: (res) => {
                res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Cache-Control", "public, max-age=86400");
            },
        })
    );
    app.use("/api/users", usersRouters);
    app.use("/api/catalogs", catalogRouters);
    app.use("/api/categorys", categoryRouters);
    app.use("/api/brands", BrandRouter);
    app.use("/api/units", unitRouters);
    app.use("/api/productTags", ProductTagRouter);
    app.use("/api/address", AddressRouter);
    app.use("/api/stores", storeRouter);
    app.use("/api/locations", LocationRouter);
    app.use("/api/employee", EmpRouter)


    app.use(notFound);
    app.use(errorHandler);

    return app;
}