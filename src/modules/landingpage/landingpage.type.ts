export type LandingpageDTO = {
    lp_id: number;
    lp_description: string;
    lp_title: string;
    lp_imag_url: string;
    create_at: string;
    update_at: string;
    e_id: number;
    p_id: number;
    lg_code: string;
}

export type LandingpageInput = {
    lp_title: string;
    lp_description: string;
    lp_imag_url: string;
    e_id: number;
    p_id: number;
    lg_code: string;
}

export type LandingpageUpdateInput = {
    lp_id: number;
    lp_title: string;
    lp_description: string;
    lp_imag_url: string;
    e_id: number;
    update_at: string;
    lg_code: string;
}