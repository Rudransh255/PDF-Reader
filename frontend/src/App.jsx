import { useState } from "react";

function App() {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");

  const sendMessage = async () => {
    const response = await fetch("http://127.0.0.1:8000/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: message,
      }),
    });

    const data = await response.json();

    setReply(data.reply);
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>RAG Chatbot</h1>

      <input
        type="text"
        placeholder="Ask something..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        style={{
          padding: "10px",
          width: "300px",
        }}
      />

      <button
        onClick={sendMessage}
        style={{
          marginLeft: "10px",
          padding: "10px",
        }}
      >
        Send
      </button>

      <p>
        <strong>AI:</strong> {reply}
      </p>
    </div>
  );
}

export default App;