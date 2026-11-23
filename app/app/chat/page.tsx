import ChatInterface from "@/components/chat/ChatInterface";

export default function ChatPage() {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <ChatInterface />
    </div>
  );
}
