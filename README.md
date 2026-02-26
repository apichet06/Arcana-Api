my-api/
├─ src/
│  ├─ app.ts
│  ├─ server.ts
│  ├─ config/
│  │  └─ env.ts
│  ├─ shared/
│  │  ├─ errors/
│  │  │  ├─ ApiError.ts
│  │  │  └─ errorHandler.ts
│  │  ├─ middlewares/
│  │  │  ├─ notFound.ts
│  │  │  └─ requestLogger.ts
│  │  └─ utils/
│  │     └─ asyncHandler.ts
│  ├─ db/
│  │  └─ pool.ts
│  └─ modules/
│     ├─ health/
│     │  ├─ health.controller.ts
│     │  ├─ health.routes.ts
│     │  └─ health.service.ts
│     └─ users/
│        ├─ users.controller.ts
│        ├─ users.routes.ts
│        ├─ users.service.ts
│        └─ users.types.ts
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ README.md
