import { useState } from "react";

function App() {
  const [file, setFile] = useState(null);
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");

  const uploadPdf = async () => {
    if (!file) {
      alert("Select a PDF first");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("http://127.0.0.1:8000/upload", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    setUploadStatus(
      `Uploaded successfully (${data.characters} characters)`
    );
  };

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
    console.log(data);

    if (data.reply) {
  setReply(data.reply);
} else {
  console.log("Backend returned:", data);
  setReply("No reply received");
}
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>PDF Reader AI</h1>

      <hr />

      <h2>Upload PDF</h2>

      <input
        type="file"
        accept=".pdf"
        onChange={(e) => setFile(e.target.files[0])}
      />

      <button
        onClick={uploadPdf}
        style={{ marginLeft: "10px" }}
      >
        Upload
      </button>

      <p>{uploadStatus}</p>

      <hr />

      <h2>Ask Questions</h2>

      <input
        type="text"
        placeholder="Ask about the PDF..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        style={{
          width: "400px",
          padding: "10px",
        }}
      />

      <button
        onClick={sendMessage}
        style={{
          marginLeft: "10px",
          padding: "10px",
        }}
      >
        Ask
      </button>

      <div style={{ marginTop: "20px" }}>
        <strong>Answer:</strong>
        <p>{reply}</p>
      </div>
    </div>
  );
}

export default App;