import type { RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { InventoryStoreDTO, LandignPageNamgeDTO, ProductImageDTO, ProductOptionGroupDTO, ProductShopByIdResponse, ProductShopDetailDTO, ProductShopDTO, ProductTagDTO, ProductVariantDTO } from "./productshop.type.js";

export async function getProductShop(lg_code: string): Promise<ProductShopDTO[]> {
    const conn = await pool.getConnection();

    try {
        const [rows] = await conn.query<(RowDataPacket & ProductShopDTO)[]>(
            ` 
         SELECT 
                a.p_id,
                a.p_isActive,
                b.p_name AS name,
                b.p_title AS title,
                c.ip_image_url,
                MIN(d.pv_price) AS min_price,
                MAX(d.pv_price) AS max_price,
                MAX(COALESCE(d.discount, 0)) AS discount,
                a.c_id,
                e.ctl_id,
                e.ctl_name,
                f.b_id,
                f.b_name,
                CASE 
                    WHEN MIN(d.pv_price) = MAX(d.pv_price) THEN 0
                    ELSE 1
                END AS has_price_range
            FROM Products a
            INNER JOIN ProductLangs b 
                ON a.p_id = b.p_id
            LEFT JOIN ImageProduct c 
                ON c.ip_id = (
                    SELECT ip_id
                    FROM ImageProduct
                    WHERE p_id = a.p_id
                    ORDER BY ip_id ASC
                    LIMIT 1
                )
            INNER JOIN ProductVariants d 
                ON d.p_id = a.p_id
			INNER JOIN Catalog e 
                ON e.ctl_id = a.ctl_id
            INNER JOIN Brands f 
                ON f.b_id = a.b_id
            WHERE b.lg_code = ?
            GROUP BY 
                a.p_id,
                a.p_isActive,
                b.p_name,
                b.p_title,
                c.ip_image_url,
                a.c_id
            `,
            [lg_code]
        );

        if (rows.length === 0) {
            return [];
        }

        const productIds = rows.map((row) => row.p_id);

        const [tagRows] = await conn.query<RowDataPacket[]>(
            `
            SELECT 
                e.p_id,
                e.ptag_id,
                f.ptag_name
            FROM ProductTagMaps e
            INNER JOIN ProductTagLangs f
                ON f.ptag_id = e.ptag_id
            WHERE f.lg_code = ?
              AND e.p_id IN (?)
            `,
            [lg_code, productIds]
        );

        const tagMap = new Map<number, { ptag_id: number; ptag_name: string }[]>();

        for (const tag of tagRows) {
            if (!tagMap.has(tag.p_id)) {
                tagMap.set(tag.p_id, []);
            }

            tagMap.get(tag.p_id)!.push({
                ptag_id: tag.ptag_id,
                ptag_name: tag.ptag_name,
            });
        }

        const result: ProductShopDTO[] = rows.map((row) => ({
            ...row,
            tags: tagMap.get(row.p_id) ?? [],
        }));

        return result;
    } finally {
        conn.release();
    }
}



export async function getProductShopById(
    p_id: number,
    lg_code: string
): Promise<ProductShopByIdResponse | null> {
    const conn = await pool.getConnection();

    try {
        const [rows] = await conn.query<(RowDataPacket & ProductShopDetailDTO)[]>(
            `
      SELECT
          a.p_id,
          a.p_isActive,
          a.st_id,
          b.p_name AS name,
          b.p_title AS title,
          a.c_id,
          e.ctl_id,
          e.ctl_name,
          f.b_id,
          f.b_name,
          b.p_description,
          g.ps_name,
          i.cl_name,
          j.st_company_name,
          j.st_image,
          MIN(d.pv_price) AS min_price,
          MAX(d.pv_price) AS max_price,
          MAX(COALESCE(d.discount, 0)) AS discount,
          CASE
              WHEN MIN(d.pv_price) = MAX(d.pv_price) THEN 0
              ELSE 1
          END AS has_price_range
      FROM Products a
      INNER JOIN ProductLangs b
          ON a.p_id = b.p_id
      INNER JOIN ProductVariants d
          ON d.p_id = a.p_id
      INNER JOIN Catalog e
          ON e.ctl_id = a.ctl_id
      INNER JOIN Brands f
          ON f.b_id = a.b_id
      INNER JOIN ProductStatus g
          ON g.ps_id = a.ps_id
	  INNER JOIN Categorys h 
          ON h.c_id = a.c_id
	  INNER JOIN CategoryLangs i 
          ON i.c_id = h.c_id
	  INNER JOIN Store j 
          ON j.st_id = a.st_id
      WHERE a.p_id = ? AND b.lg_code = ? AND i.lg_code = ?
      GROUP BY
          a.p_id,
          a.p_isActive,
          b.p_name,
          b.p_title,
          a.c_id,
          e.ctl_id,
          e.ctl_name,
          f.b_id,
          f.b_name
      `,
            [p_id, lg_code, lg_code]
        );

        if (!rows.length) {
            return null;
        }

        const [imageRows] = await conn.query<(RowDataPacket & ProductImageDTO)[]>(
            `
      SELECT
          ip_id,
          ip_image_url,
          is_primary
      FROM ImageProduct
      WHERE p_id = ?
      ORDER BY
          CASE WHEN is_primary = 1 THEN 0 ELSE 1 END,
          ip_id ASC
      `,
            [p_id]
        );

        const [variantRows] = await conn.query<(RowDataPacket & ProductVariantDTO)[]>(
            `
      SELECT
          pv.pv_id,
          pv.pv_sku,
          pv.pv_cost,
          pv.pv_price,
          pv.discount,
          pv.is_default,
          pv.image_url,
          pv.weight_g,
          pv.length_cm,
          pv.width_cm,
          pv.height_cm,
          pv.unit_id,
          ul.ul_name AS unit_name,
          COALESCE(inv.on_hand, 0) AS on_hand,
          COALESCE(inv.reserved_qty, 0) AS reserved_qty,
          GROUP_CONCAT(
              CONCAT(ot.otype_name, ': ', poi.poi_value)
              ORDER BY po.otype_id, poi.poi_id
              SEPARATOR ' | '
          ) AS variant_label
      FROM ProductVariants pv
      LEFT JOIN VariantOptionItems voi
          ON voi.pv_id = pv.pv_id
      LEFT JOIN ProductOptionItems poi
          ON poi.poi_id = voi.poi_id
      LEFT JOIN ProductOptions po
          ON po.potn_id = poi.potn_id
      LEFT JOIN OptionTypes ot
          ON ot.otype_id = po.otype_id
      LEFT JOIN Inventorys inv
          ON inv.pv_id = pv.pv_id
      LEFT JOIN UnitLangs ul
          ON ul.u_id = pv.unit_id
         AND ul.lg_code = ?
      WHERE pv.p_id = ?
      GROUP BY
          pv.pv_id,
          pv.pv_sku,
          pv.pv_cost,
          pv.pv_price,
          pv.discount,
          pv.is_default,
          pv.image_url,
          pv.weight_g,
          pv.length_cm,
          pv.width_cm,
          pv.height_cm,
          pv.unit_id,
          ul.ul_name,
          inv.on_hand,
          inv.reserved_qty
      ORDER BY pv.pv_id ASC
      `,
            [lg_code, p_id]
        );

        const [optionRows] = await conn.query<
            (RowDataPacket & {
                potn_id: number;
                otype_id: number;
                otype_code: string;
                otype_name: string;
                poi_id: number;
                poi_value: string;
            })[]
        >(
            `
      SELECT
          po.potn_id,
          po.otype_id,
          ot.otype_code,
          ot.otype_name,
          poi.poi_id,
          poi.poi_value
      FROM ProductOptions po
      INNER JOIN OptionTypes ot
          ON ot.otype_id = po.otype_id
      INNER JOIN ProductOptionItems poi
          ON poi.potn_id = po.potn_id
      WHERE po.p_id = ?
      ORDER BY po.otype_id, poi.poi_id
      `,
            [p_id]
        );

        const [tagRows] = await conn.query<(RowDataPacket & ProductTagDTO)[]>(
            `
      SELECT
          e.ptag_id,
          f.ptag_name
      FROM ProductTagMaps e
      INNER JOIN ProductTagLangs f
          ON f.ptag_id = e.ptag_id
      WHERE f.lg_code = ?
        AND e.p_id = ?
      `,
            [lg_code, p_id]
        );

        const [InvertoryStoreRows] = await conn.query<(RowDataPacket & InventoryStoreDTO)[]>(
            ` 
        SELECT name_in_thai as InventoryStoreProvince FROM Store a 
        INNER JOIN Locations b 
        ON a.st_id = b.st_id
        INNER JOIN Provinces c 
        ON b.Provinces_id = c.id
        Where a.st_id = ?
      `,
            [rows[0]!.st_id]
        );

        const [landingPage] = await conn.query<(RowDataPacket & LandignPageNamgeDTO)[]>(
            `
            SELECT lp_id,lp_title,lp_imag_url,lp_slug, p_id,lg_code,st_id From LandingPages 
            WHERE st_id = ? AND lg_code = ? AND  p_id = ?
            `,
            [rows[0]!.st_id, lg_code, p_id]
        );

        const groupedOptions: ProductOptionGroupDTO[] = Object.values(
            optionRows.reduce((acc, row) => {
                if (!acc[row.otype_id]) {
                    acc[row.otype_id] = {
                        potn_id: row.potn_id,
                        otype_id: row.otype_id,
                        otype_code: row.otype_code,
                        otype_name: row.otype_name,
                        items: [],
                    };
                }

                acc[row.otype_id]!.items.push({
                    poi_id: row.poi_id,
                    poi_value: row.poi_value,
                });

                return acc;
            }, {} as Record<number, ProductOptionGroupDTO>)
        );

        const productRow = rows[0] as ProductShopDetailDTO;

        const product: ProductShopDetailDTO = {
            ...productRow,
            thumbnail: imageRows[0]?.ip_image_url || null,
            tags: tagRows.map((tag) => ({
                ptag_id: tag.ptag_id,
                ptag_name: tag.ptag_name,

            })),
        };


        return {
            product,
            images: imageRows,
            variants: variantRows,
            options: groupedOptions,
            InventoryStore: InvertoryStoreRows,
            landingPage: landingPage
        };
    } catch (error) {
        console.error("Error fetching product shop by ID:", error);
        throw error;
    } finally {
        conn.release();
    }
}