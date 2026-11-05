// 由 node relay/chat5r.test.mjs --write-fixtures 產生，不要手改：內容必須等於中繼的 capabilityBody() 輸出（relay/chat5r.test.mjs 逐位元組比對）
export const RELAY_CAPABILITY_ENABLED = "{\"v\":1,\"chat\":{\"enabled\":true,\"wire\":[2],\"maxCiphertextBytes\":2048,\"features\":[\"mailbox\",\"commit\",\"sender-limit\",\"dm-pairs\",\"save-500\",\"member-list\"]},\"ttlSec\":600}"
export const RELAY_CAPABILITY_DISABLED = "{\"v\":1,\"chat\":{\"enabled\":false,\"wire\":[2],\"maxCiphertextBytes\":2048,\"features\":[\"mailbox\",\"commit\",\"sender-limit\",\"dm-pairs\",\"save-500\",\"member-list\"]},\"ttlSec\":600}"
