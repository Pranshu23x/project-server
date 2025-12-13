// server.js - Complete Chrome Extension + Google Calendar Server
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import 'dotenv/config';
import { google } from 'googleapis';

const app = express();

// CORS configuration for Chrome extension
app.use(cors({
  origin: 'http://localhost:3000', // Only your server origin
  credentials: true,
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Environment variables
const API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '431860449641-u3jcgvq16lc0r1tqgkpbv6s0m8tb7c5a.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

// Store user tokens (in production, use a database)
const userTokens = new Map();

// OAuth2 setup
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Tab AI Server is running',
    endpoints: {
      auth: '/auth/url',
      schedule: '/schedule-event',
      ask: '/ask-gemini'
    },
    chromeExtension: true 
  });
});

// 1. Get OAuth URL for authentication
app.post('/auth/url', (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        error: 'User ID required',
        suggestion: 'Generate a unique user ID in your extension and send it here' 
      });
    }
    
    // Generate OAuth URL
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state: userId,
      include_granted_scopes: true
    });
    
    console.log(`🔗 Generated auth URL for user: ${userId}`);
    
    res.json({ 
      success: true,
      authUrl,
      userId 
    });
    
  } catch (error) {
    console.error('❌ Error generating auth URL:', error);
    res.status(500).json({ 
      error: 'Failed to generate authentication URL',
      details: error.message 
    });
  }
});

// 2. OAuth callback endpoint (Google redirects here)
app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    const userId = req.query.state;
    
    if (!code) {
      return res.status(400).send(`
        <html><body><h2>Missing authorization code</h2></body></html>
      `);
    }
    
    if (!userId) {
      return res.status(400).send(`
        <html><body><h2>Missing user ID</h2></body></html>
      `);
    }
    
    console.log(`🔄 Exchanging code for tokens for user: ${userId}`);
    
    // Exchange code for tokens
    const { tokens } = await oAuth2Client.getToken(code);
    
    // Store tokens
    userTokens.set(userId, tokens);
    
    console.log(`✅ Tokens received for user: ${userId}`);
    
    // HTML that sends message back to extension and closes
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Successful</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .success-box {
            background: white;
            color: #333;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            max-width: 400px;
            margin: 0 auto;
          }
          .checkmark {
            font-size: 60px;
            color: #4CAF50;
          }
        </style>
      </head>
      <body>
        <div class="success-box">
          <div class="checkmark">✓</div>
          <h2>Authentication Successful!</h2>
          <p>You can now schedule events with your AI assistant.</p>
          <p>This window will close automatically...</p>
        </div>
        <script>
          // Send success message to extension
          window.opener.postMessage({
            type: 'oauth-callback',
            success: true,
            userId: '${userId}',
            timestamp: new Date().toISOString()
          }, '*');
          
          // Close window after 2 seconds
          setTimeout(() => {
            window.close();
          }, 2000);
        </script>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h2 style="color: #d32f2f;">Authentication Failed</h2>
        <p>${error.message}</p>
        <script>
          window.opener.postMessage({
            type: 'oauth-callback',
            success: false,
            error: '${error.message.replace(/'/g, "\\'")}'
          }, '*');
        </script>
      </body>
      </html>
    `);
  }
});

// 3. Helper function to parse natural language with Gemini
async function parseScheduleRequest(userQuery) {
  try {
    console.log('🤖 Parsing schedule request:', userQuery);
    
    const prompt = `
    Extract event details from this query: "${userQuery}"
    
    Return ONLY a JSON object with this structure:
    {
      "summary": "string (event title, default: 'New Meeting')",
      "startDateTime": "string (ISO 8601, like 2025-01-15T14:00:00)",
      "endDateTime": "string (ISO 8601, default: start + 1 hour)",
      "attendees": ["email1@example.com", "email2@example.com"]
    }
    
    Current time: ${new Date().toISOString()}
    Rules:
    - If time not specified, assume in 1 hour
    - If only date specified, assume 9 AM
    - If "tomorrow" mentioned, use tomorrow's date
    - If "next week" mentioned, use next Monday at 9 AM
    `;
    
    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 300,
      }
    };
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    
    // Extract JSON from response
    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    
    console.log('📝 Parsed event details:', parsed);
    return parsed;
    
  } catch (error) {
    console.error('❌ Error parsing schedule request:', error);
    throw error;
  }
}

// 4. Schedule event endpoint
app.post('/schedule-event', async (req, res) => {
  try {
    const { userQuery, userId } = req.body;
    
    if (!userQuery) {
      return res.status(400).json({ 
        error: 'Missing userQuery',
        example: 'Schedule team meeting tomorrow at 2 PM for 1 hour with john@example.com' 
      });
    }
    
    if (!userId) {
      return res.status(400).json({ 
        error: 'Missing userId',
        action: 'Call /auth/url first to get authentication URL' 
      });
    }
    
    console.log(`📅 Processing schedule request from user: ${userId}`);
    console.log(`💬 Query: "${userQuery}"`);
    
    // Check authentication
    const tokens = userTokens.get(userId);
    if (!tokens) {
      return res.status(401).json({ 
        error: 'User not authenticated',
        action: 'authenticate',
        endpoint: '/auth/url' 
      });
    }
    
    // Set up authenticated client
    const userAuth = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
    userAuth.setCredentials(tokens);
    
    // Parse natural language query
    const eventDetails = await parseScheduleRequest(userQuery);
    
    // Create calendar event
    const calendar = google.calendar({ version: 'v3', auth: userAuth });
    
    const event = {
      summary: eventDetails.summary || 'New Meeting',
      description: `Created via AI Assistant. Original query: "${userQuery}"`,
      start: {
        dateTime: eventDetails.startDateTime || new Date(Date.now() + 3600000).toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      end: {
        dateTime: eventDetails.endDateTime || 
                 new Date(new Date(eventDetails.startDateTime || Date.now() + 3600000).getTime() + 3600000).toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      attendees: eventDetails.attendees ? eventDetails.attendees.map(email => ({ email })) : [],
      reminders: {
        useDefault: true,
      },
    };
    
    console.log('📨 Creating calendar event:', event.summary);
    
    const calendarResponse = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      sendUpdates: 'all',
    });
    
    console.log('✅ Event created:', calendarResponse.data.htmlLink);
    
    res.json({
      success: true,
      message: `✅ "${event.summary}" scheduled successfully!`,
      event: {
        id: calendarResponse.data.id,
        link: calendarResponse.data.htmlLink,
        summary: event.summary,
        start: event.start.dateTime,
        end: event.end.dateTime,
      },
      query: userQuery
    });
    
  } catch (error) {
    console.error('❌ Schedule event error:', error);
    
    // Handle expired tokens
    if (error.message.includes('invalid_grant') || error.message.includes('token expired')) {
      userTokens.delete(req.body.userId);
      return res.status(401).json({ 
        error: 'Authentication expired',
        action: 'reauthenticate',
        endpoint: '/auth/url' 
      });
    }
    
    // Handle missing permissions
    if (error.message.includes('insufficient permissions')) {
      return res.status(403).json({ 
        error: 'Calendar access permission required',
        action: 'Re-authenticate and grant calendar access' 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to schedule event',
      details: error.message,
      suggestion: 'Try being more specific: "Schedule meeting tomorrow at 3 PM for 1 hour"' 
    });
  }
});

// 5. Keep your original Gemini endpoint (slightly modified)
app.post('/ask-gemini', async (req, res) => {
  try {
    const { question, tabsContext, maxTokens = 150, temperature = 0.5 } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Missing question' });
    }
    
    if (!API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }
    
    const fullPrompt = `${question}\n\nContext:\n${tabsContext || 'No context provided'}`;
    
    const requestBody = {
      contents: [{
        parts: [{ text: fullPrompt }]
      }],
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens,
        topP: 0.8,
        topK: 40
      }
    };
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );
    
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorData}`);
    }
    
    const data = await response.json();
    let answer = '';
    
    if (data.candidates && data.candidates.length > 0) {
      const candidate = data.candidates[0];
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        answer = candidate.content.parts[0].text || '';
      }
    }
    
    if (!answer.trim()) {
      throw new Error('Gemini returned empty response');
    }
    
    res.json({ 
      answer: answer.trim(),
      tokensUsed: data.usageMetadata?.totalTokenCount || 0
    });
    
  } catch (err) {
    console.error('❌ Gemini error:', err);
    res.status(500).json({ 
      error: err.message,
      suggestion: 'Check your API key and network connection'
    });
  }
});

// 6. Check authentication status
app.get('/auth/status/:userId', (req, res) => {
  const { userId } = req.params;
  const isAuthenticated = userTokens.has(userId);
  
  res.json({
    authenticated: isAuthenticated,
    userId,
    hasCalendarAccess: isAuthenticated
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('❌ Unhandled server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Chrome Extension Server Started');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔑 Gemini API: ${API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`👤 OAuth Client: ${GOOGLE_CLIENT_ID ? '✅ Loaded' : '❌ Missing'}`);
  console.log('');
  console.log('📋 Available Endpoints:');
  console.log(`   POST http://localhost:${PORT}/auth/url     - Get OAuth URL`);
  console.log(`   GET  http://localhost:${PORT}/oauth2callback - OAuth callback`);
  console.log(`   POST http://localhost:${PORT}/schedule-event - Schedule events`);
  console.log(`   POST http://localhost:${PORT}/ask-gemini    - Ask Gemini questions`);
  console.log(`   GET  http://localhost:${PORT}/auth/status/:userId - Check auth status`);
  console.log('');
  console.log('💡 Next steps:');
  console.log('   1. Set up your .env file');
  console.log('   2. Test with: curl http://localhost:3000/');
  console.log('   3. Start your Chrome extension');
});
