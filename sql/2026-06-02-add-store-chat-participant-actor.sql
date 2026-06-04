ALTER TABLE Conversation_participants
    MODIFY actor_type ENUM('user', 'employee', 'admin', 'store') NULL;

UPDATE Conversation_participants cp
INNER JOIN Conversations c ON c.conv_id = cp.conv_id
SET cp.actor_type = 'store'
WHERE cp.actor_type = ''
  AND c.channel = 'support';
