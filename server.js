// server.js
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import 'dotenv/config'
const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GOOGLE_API_KEY;

app.post('/ask-gemini', async (req, res) => {
  const { prompt } = req.body;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prompt)
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
