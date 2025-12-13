// server.js - UPDATED WITH GOOGLE CALENDAR INTEGRATION
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import 'dotenv/config';
import { google } from 'googleapis';

const app = express();

// CORS configuration - allow all origins for Chrome extension
app.use(cors({
  origin: '*',
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const API_KEY = process.env.GOOGLE_API_KEY;

// --- NEW: Google Calendar Configuration ---
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const userTokens = new Map(); // Simple in-memory token storage

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Tab AI Server is running',
    endpoints: {
      ask: '/ask-gemini',
      schedule: '/schedule-event',
      auth: '/auth/url'
    },
    timestamp: new Date().toISOString()
  });
});

// --- NEW: Authentication URL endpoint ---
app.post('/auth/url', (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        error: 'Missing required field: userId' 
      });
    }
    
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state: userId
    });
    
    res.json({ 
      authUrl,
      userId,
      message: 'Open this URL in browser to authenticate'
    });
    
  } catch (err) {
    console.error('❌ Auth URL error:', err);
    res.status(500).json({ 
      error: err.message,
      details: 'Failed to generate auth URL'
    });
  }
});

// --- NEW: OAuth callback endpoint ---
app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    const userId = req.query.state;
    
    if (!code || !userId) {
      return res.status(400).send('Missing code or user ID');
    }
    
    const { tokens } = await oAuth2Client.getToken(code);
    userTokens.set(userId, tokens);
    
    console.log(`✅ OAuth2 tokens received for user: ${userId}`);
    
    // HTML page that communicates back to extension
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Successful</title>
        <script>
          window.opener.postMessage({
            type: 'oauth-callback',
            success: true,
            userId: '${userId}'
          }, '*');
          window.close();
        </script>
      </head>
      <body>
        <p>Authentication successful! You can close this window.</p>
      </body>
      </html>
    `);
    
  } catch (err) {
    console.error('❌ OAuth callback error:', err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <body>
        <p>Authentication failed. Please try again.</p>
        <script>
          window.opener.postMessage({
            type: 'oauth-callback',
            success: false,
            error: '${err.message}'
          }, '*');
        </script>
      </body>
      </html>
    `);
  }
});

// --- NEW: Helper to parse natural language with Gemini ---
async function parseScheduleRequest(userQuery) {
  const prompt = `
  Extract event details from: "${userQuery}"
  
  Return ONLY JSON with this structure:
  {
    "summary": "string (event title)",
    "startDateTime": "string (ISO 8601, e.g., 2025-01-15T14:00:00)",
    "endDateTime": "string (ISO 8601, assume 1 hour if not specified)",
    "attendees": ["email1@example.com", "email2@example.com"]
  }
  
  Rules:
  - If time not specified, assume in 1 hour
  - If date not specified, use today
  - If "tomorrow" mentioned, use tomorrow
  - Default summary: "Meeting"
  `;
  
  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 200,
    }
  };
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );
  
  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Gemini parsing error: ${response.status} - ${errorData}`);
  }
  
  const data = await response.json();
  const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  
  // Extract JSON from response
  const jsonMatch = answer.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
}

// --- NEW: Schedule event endpoint ---
app.post('/schedule-event', async (req, res) => {
  try {
    const { userQuery, userId } = req.body;
    
    console.log('📅 Received schedule request:');
    console.log('Query:', userQuery);
    console.log('User ID:', userId);
    
    // Validate inputs
    if (!userQuery || !userId) {
      return res.status(400).json({ 
        error: 'Missing required fields: userQuery and userId' 
      });
    }
    
    // Check authentication
    const tokens = userTokens.get(userId);
    if (!tokens) {
      return res.status(401).json({ 
        error: 'User not authenticated',
        action: 'Call /auth/url first to get authentication URL'
      });
    }
    
    // Set up authenticated client
    const userAuth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    userAuth.setCredentials(tokens);
    
    // Parse natural language query
    console.log('🤖 Parsing schedule request with Gemini...');
    const eventDetails = await parseScheduleRequest(userQuery);
    console.log('📝 Parsed details:', eventDetails);
    
    // Create calendar event
    const calendar = google.calendar({ version: 'v3', auth: userAuth });
    
    const event = {
      summary: eventDetails.summary || 'Meeting',
      start: {
        dateTime: eventDetails.startDateTime || new Date(Date.now() + 3600000).toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: eventDetails.endDateTime || 
                 new Date(new Date(eventDetails.startDateTime || Date.now() + 3600000).getTime() + 3600000).toISOString(),
        timeZone: 'UTC',
      },
      attendees: eventDetails.attendees ? eventDetails.attendees.map(email => ({ email })) : [],
    };
    
    console.log('📨 Creating calendar event...');
    const calendarResponse = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });
    
    console.log('✅ Event created:', calendarResponse.data.htmlLink);
    
    res.json({ 
      success: true,
      message: `Event "${event.summary}" scheduled successfully!`,
      eventLink: calendarResponse.data.htmlLink,
      eventId: calendarResponse.data.id,
      summary: event.summary,
      startTime: event.start.dateTime,
      endTime: event.end.dateTime
    });
    
  } catch (err) {
    console.error('❌ Schedule error:', err);
    
    // Handle expired tokens
    if (err.message.includes('invalid_grant') || err.message.includes('token expired')) {
      userTokens.delete(req.body.userId);
      return res.status(401).json({ 
        error: 'Authentication expired',
        action: 'Re-authenticate via /auth/url'
      });
    }
    
    res.status(500).json({ 
      error: err.message,
      details: 'Failed to schedule event'
    });
  }
});

// Main endpoint for Gemini queries (ORIGINAL - UNCHANGED)
app.post('/ask-gemini', async (req, res) => {
  try {
    // Extract request data
    const { question, tabsContext, maxTokens = 150, temperature = 0.5 } = req.body;
    
    console.log('📥 Received Gemini request:');
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
  console.log('🚀 Tab AI Server with Calendar started');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🔑 Gemini API Key: ${API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`👤 Google Client ID: ${process.env.GOOGLE_CLIENT_ID ? '✅ Configured' : '❌ Missing'}`);
  console.log(`📍 Endpoints:`);
  console.log(`   - http://localhost:${PORT}/ask-gemini`);
  console.log(`   - http://localhost:${PORT}/auth/url`);
  console.log(`   - http://localhost:${PORT}/schedule-event`);
  console.log(`   - http://localhost:${PORT}/oauth2callback`);
});

export default app;
