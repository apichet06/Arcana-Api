export type RegisterBuyerInput = {
    u_username: string;
    u_email: string;
    u_password: string;
    u_birthday?: string | null;
    u_gender?: string | null;
    u_provider: string;
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    provinces_id: number;
    districts_id: number;
    subdistricts_id: number;
    zip_code: string;
    is_default: boolean;
};

export type RegisterBuyerDTO = {
    u_id: number;
    u_username: string;
    u_email: string;
    u_avatar: string | null;
    u_create_at: string;
};

export type GoogleUserInfo = {
    id: string;
    email: string;
    name: string;
    picture: string;
};

export type FacebookUserInfo = {
    id: string;
    name: string;
    email?: string;
    picture?: { data: { url: string } };
};

export type AuthResult = {
    user: RegisterBuyerDTO;
    isNew: boolean;
};

export type RefreshTokenSessionInput = {
    u_id: number;
    user_agent?: string | null;
    ip_address?: string | null;
};

export type ProfileDTO = {
    u_id: number;
    u_username: string;
    u_email: string;
    u_avatar: string | null;
    u_birthday: string | null;
    u_gender: string | null;
    u_provider: string;
    u_create_at: string;
};

export type AddressDTO = {
    locb_id: number;
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    provinces_id: number;
    districts_id: number;
    subdistricts_id: number;
    zip_code: string;
    province_name: string;
    district_name: string;
    subdistrict_name: string;
    is_default: boolean;
};

export type AddAddressInput = {
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    provinces_id: number;
    districts_id: number;
    subdistricts_id: number;
    zip_code: string;
    is_default: boolean;
};
