// server.js
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import 'dotenv/config';

const app = express();

// CORS configuration - allow all origins for Chrome extension
app.use(cors({
  origin: '*',
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const API_KEY = process.env.GOOGLE_API_KEY;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Tab AI Server is running',
    timestamp: new Date().toISOString()
  });
});

// Main endpoint for Gemini queries
app.post('/ask-gemini', async (req, res) => {
  try {
    // Extract request data
    const { question, tabsContext, maxTokens = 150, temperature = 0.5 } = req.body;
    
    console.log('📥 Received request:');
    console.log('Question:', question);
    console.log('Tabs context length:', tabsContext?.length || 0);
    
    // Validate inputs
    if (!question) {
      return res.status(400).json({ 
        error: 'Missing required field: question' 
      });
    }
    
    if (!API_KEY) {
      return res.status(500).json({ 
        error: 'Google API key not configured' 
      });
    }
    
    // Build the prompt for Gemini
    const fullPrompt = `${question}\n\nContext:\n${tabsContext || 'No context provided'}`;
    
    // Correct Gemini API request format
    const requestBody = {
      contents: [{
        parts: [{
          text: fullPrompt
        }]
      }],
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens,
        topP: 0.8,
        topK: 40
      }
    };
    
    console.log('🌐 Calling Gemini API...');
    
    // Call Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );
    
    console.log('📡 Gemini response status:', response.status);
    
    if (!response.ok) {
      const errorData = await response.text();
      console.error('❌ Gemini API error:', errorData);
      throw new Error(`Gemini API error: ${response.status} - ${errorData}`);
    }
    
    const data = await response.json();
    console.log('📦 Gemini raw response:', JSON.stringify(data, null, 2));
    
    // Extract the answer from Gemini's response
    let answer = '';
    
    if (data.candidates && data.candidates.length > 0) {
      const candidate = data.candidates[0];
      
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        answer = candidate.content.parts[0].text || '';
      }
    }
    
    // Check if we got a valid answer
    if (!answer || answer.trim().length === 0) {
      console.warn('⚠️ Empty answer from Gemini');
      throw new Error('Gemini returned empty response');
    }
    
    console.log('✅ Extracted answer:', answer);
    
    // Return the formatted response
    res.json({ 
      answer: answer.trim(),
      timestamp: new Date().toISOString(),
      tokensUsed: data.usageMetadata?.totalTokenCount || 0
    });
    
  } catch (err) {
    console.error('❌ Server error:', err);
    
    res.status(500).json({ 
      error: err.message,
      details: 'Failed to process request. Check server logs for details.'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('🚀 Tab AI Server started');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🔑 API Key configured: ${API_KEY ? '✅ Yes' : '❌ No'}`);
  console.log(`📍 Endpoint: http://localhost:${PORT}/ask-gemini`);
});

export default app;
