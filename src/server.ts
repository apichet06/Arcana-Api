import { env } from "./config/env.js";
import { createApp } from "./app.js";

process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
});

const app = createApp();

app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API running on http://localhost:${env.PORT}`);
});
