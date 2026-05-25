import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { pool } from "../../db/pool.js"
import { ApiError } from "../../shared/errors/ApiError.js"
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js"
import type { CreateReviewInput, ReviewDTO, ReviewSummary } from "./reviews.type.js"

// ดึงรีวิวทั้งหมดของ pv_id พร้อม pagination
export async function getReviews(
    pv_id: number,
    page: number,
    limit: number
): Promise<{ reviews: ReviewDTO[]; summary: ReviewSummary; total: number }> {
    const offset = (page - 1) * limit

    // ดึงรีวิวพร้อม username, avatar และรวมรูปภาพด้วย GROUP_CONCAT
    const [rows] = await pool.query<(RowDataPacket & {
        ed_id: number; pv_id: number; oi_id: number; u_id: number
        u_username: string; u_avatar: string | null
        massages: string; delivery_score: number; product_score: number
        create_at: string; images: string | null
    })[]>(
        `SELECT
            ed.ed_id, ed.pv_id, ed.oi_id, ed.u_id,
            u.u_username, u.u_avatar,
            ed.massages, ed.delivery_score, ed.product_score, ed.create_at,
            GROUP_CONCAT(edi.url_image ORDER BY edi.edi_id SEPARATOR ',') AS images
        FROM Estimate_delivery ed
        JOIN Users u ON u.u_id = ed.u_id
        LEFT JOIN Estimate_delivery_image edi ON edi.ed_id = ed.ed_id
        WHERE ed.pv_id = ?
        GROUP BY ed.ed_id
        ORDER BY ed.create_at DESC
        LIMIT ? OFFSET ?`,
        [pv_id, limit, offset]
    )

    // นับยอดรวมและคำนวณคะแนนเฉลี่ย
    const [summaryRows] = await pool.query<(RowDataPacket & ReviewSummary)[]>(
        `SELECT
            COUNT(*) AS total,
            ROUND(AVG(product_score), 1) AS avg_product_score,
            ROUND(AVG(delivery_score), 1) AS avg_delivery_score
        FROM Estimate_delivery
        WHERE pv_id = ?`,
        [pv_id]
    )

    const summary = summaryRows[0] ?? { total: 0, avg_product_score: 0, avg_delivery_score: 0 }

    const reviews: ReviewDTO[] = rows.map(r => ({
        ...r,
        // แปลง GROUP_CONCAT string เป็น array (กรองค่าว่างออก)
        images: r.images ? r.images.split(",").filter(Boolean) : [],
    }))

    return { reviews, summary, total: summary.total }
}

// สร้างรีวิวใหม่ (ต้องซื้อสินค้านั้นจริงๆ)
export async function createReview(input: CreateReviewInput): Promise<void> {
    // ตรวจว่า oi_id นั้นเป็นของ user นี้และมี pv_id ตรงกัน
    const [orderCheck] = await pool.query<RowDataPacket[]>(
        `SELECT oi.oi_id
         FROM Order_items oi
         JOIN Orders o ON o.or_id = oi.or_id
         WHERE oi.oi_id = ? AND oi.pv_id = ? AND o.u_id = ? AND o.status = 'delivered'
         LIMIT 1`,
        [input.oi_id, input.pv_id, input.u_id]
    )

    if (!orderCheck[0]) throw new ApiError(403, "ต้องรับสินค้าเรียบร้อยก่อนจึงจะรีวิวได้")

    // ป้องกันรีวิวซ้ำในรายการสั่งซื้อเดิม
    const [dupCheck] = await pool.query<RowDataPacket[]>(
        "SELECT ed_id FROM Estimate_delivery WHERE oi_id = ? LIMIT 1",
        [input.oi_id]
    )

    if (dupCheck[0]) throw new ApiError(409, "คุณรีวิวรายการนี้ไปแล้ว")

    const conn = await pool.getConnection()
    try {
        await conn.beginTransaction()

        const [result] = await conn.query<ResultSetHeader>(
            "INSERT INTO Estimate_delivery SET ?",
            [{
                u_id: input.u_id,
                pv_id: input.pv_id,
                oi_id: input.oi_id,
                massages: input.massages,
                delivery_score: input.delivery_score,
                product_score: input.product_score,
                create_at: new Date(),
            }]
        )

        const ed_id = result.insertId

        // อัปโหลดรูปและบันทึก path ลง Estimate_delivery_image
        for (let i = 0; i < input.imageFiles.length; i++) {
            const file = input.imageFiles[i]!
            const url = await fileUploadImage(file, `review_${ed_id}_${i}`, "reviews")
            await conn.query("INSERT INTO Estimate_delivery_image SET ?", [{ ed_id, url_image: url }])
        }

        await conn.commit()
    } catch (err) {
        await conn.rollback()
        throw err
    } finally {
        conn.release()
    }
}

// ตรวจว่า user นี้มีสิทธิ์รีวิว pv_id นี้มั้ย
// คืน list oi_id ที่ยังไม่เคยรีวิว
export async function getReviewableItems(u_id: number, pv_id: number) {
    const [rows] = await pool.query<(RowDataPacket & { oi_id: number })[]>(
        `SELECT oi.oi_id
         FROM Order_items oi
         JOIN Orders o ON o.or_id = oi.or_id
         WHERE oi.pv_id = ? AND o.u_id = ? AND o.status = 'delivered'
           AND oi.oi_id NOT IN (
               SELECT oi_id FROM Estimate_delivery WHERE oi_id IS NOT NULL
           )
         LIMIT 5`,
        [pv_id, u_id]
    )

    return rows.map(r => r.oi_id)
}
