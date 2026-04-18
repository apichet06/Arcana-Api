
export type StoreDTO = {
    st_id: number;
    st_company_name: string;
    st_idcard: string;
    account_number: string;
    omise_recipient_id: string;
    st_email: string;
    st_isAccept: string;
    created_at: string;
    st_phone: string;
    st_image: string;
    e_id: number;
    bk_id: number;
    bk_name: string;
}

export type CreateStoreInput = {
    st_company_name: string;
    st_idcard: string;
    account_number: string;
    omise_recipient_id: string;
    st_email: string;
    st_isAccept: string;
    created_at: string;
    st_phone: string;
    st_image: string | null;
    e_id: number;
    bk_id: number;
}

export type UpdateStoreInput = {
    st_company_name: string;
    st_idcard: string;
    account_number: string;
    omise_recipient_id: string;
    st_email: string;
    st_isAccept: string;
    created_at: string;
    st_phone: string;
    st_image: string | undefined;
    e_id: number;
    bk_id: number;
}


export type BankDTO = {
    bk_id: number;
    bk_name: string;
}


export type StoreShopDTO = {
    st_id: number;
    st_company_name: string;
    st_phone: string;
    st_image: string;
    st_email: string;
    st_isAccept: string;
}