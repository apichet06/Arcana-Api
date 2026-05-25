export type ConvChannel = 'live_chat' | 'support'
export type ConvStatus = 'open' | 'closed' | 'resolved'
export type ActorType = 'user' | 'admin'
export type RoleInConv = 'buyer' | 'support'
export type SenderType = 'user' | 'employee' | 'bot'
export type MessageType = 'text' | 'image' | 'file'

export type ConversationDTO = {
    conv_id: number
    channel: ConvChannel
    subject: string | null
    status: ConvStatus
    st_id: number
    created_at: Date
    updated_at: Date
}

export type ConversationWithBuyerDTO = ConversationDTO & {
    buyer_id: number
    buyer_username: string
    last_message: string | null
    last_message_at: Date | null
    unread_count: number
}

export type MessageDTO = {
    msg_id: number
    conv_id: number
    sender_type: SenderType
    sender_id: number | null
    message_type: MessageType
    body: string
    created_at: Date
    edited_at: Date | null
    deleted_at: Date | null
}
