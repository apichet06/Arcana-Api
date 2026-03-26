import type { RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { LandingpageDTO } from "./landingpage.type.js"

export async function List(e_id: number, log_code: string): Promise<LandingpageDTO[]> {
    const [res] = await pool.query<LandingpageDTO[] & RowDataPacket[]>(`SELECT a.*,c.p_name From LandingPages a
                  INNER JOIN Products b
                  ON a.p_id = b.p_id
                  INNER JOIN ProductLangs c 
                  ON c.p_id = b.p_id
				   WHERE c.lg_code =  ? and a.e_id = ? AND a.lg_code = ?
                  ORDER BY a.lp_id DESC`, [log_code, e_id, log_code]);

    return res;
}
