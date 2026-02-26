import mysql from 'mysql2/promise';
import { env } from "../config/env.js";


export const pool = mysql.createPool({
    host: env.DB_HOST,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    port: env.DB_PORT,
    connectionLimit: 10,
});
