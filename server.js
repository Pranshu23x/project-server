// server.js - Complete Vercel-Compatible Server with Calendar
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import 'dotenv/config';
import { google } from 'googleapis';

const app = express();

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Environment variables
const API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}/oauth2callback`
  : 'http://localhost:3000/oauth2callback';

// Store tokens (in production, use database)
const userTokens = new Map();

// OAuth2 setup
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// ============ HELPER FUNCTIONS ============

// Parse natural language with Gemini
async function parseScheduleRequest(userQuery) {
  try {
    const prompt = `Extract event details from: "${userQuery}"
    
    Return ONLY JSON with this structure:
    {
      "summary": "string (event title, default: 'Meeting')",
      "startDateTime": "string (ISO 8601, e.g., 2025-01-15T14:00:00)",
      "endDateTime": "string (ISO 8601, assume 1 hour if not specified)",
      "attendees": ["email1@example.com", "email2@example.com"]
    }
    
    Rules:
    - If time not specified, assume in 1 hour from now
    - If date not specified, use today
    - If "tomorrow" mentioned, use tomorrow
    - If "next week" mentioned, use next Monday at 9 AM
    - Current time: ${new Date().toISOString()}`;
    
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`,
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
    
    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    
  } catch (error) {
    console.error('❌ Error parsing schedule request:', error);
    throw error;
  }
}

// ============ ENDPOINTS ============

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Tab AI Server with Calendar is running',
    endpoints: {
      ask: '/ask-gemini',
      auth: '/auth/url',
      schedule: '/schedule-event'
    },
    timestamp: new Date().toISOString(),
    deployment: process.env.VERCEL ? 'Vercel' : 'Local'
  });
});

// 1. Get OAuth URL
app.post('/auth/url', (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        error: 'User ID required',
        example: 'Send {"userId": "unique_user_id_123"}' 
      });
    }
    
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
      userId,
      redirectUri: GOOGLE_REDIRECT_URI
    });
    
  } catch (error) {
    console.error('❌ Auth URL error:', error);
    res.status(500).json({ 
      error: 'Failed to generate auth URL',
      details: error.message 
    });
  }
});

// 2. OAuth callback (Google redirects here)
app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    const userId = req.query.state;
    
    if (!code) {
      return res.status(400).send(`
        <html><body>
          <h2>Missing authorization code</h2>
          <p>No code received from Google.</p>
        </body></html>
      `);
    }
    
    if (!userId) {
      return res.status(400).send(`
        <html><body>
          <h2>Missing user ID</h2>
          <p>No user ID found in state parameter.</p>
        </body></html>
      `);
    }
    
    console.log(`🔄 Exchanging code for tokens for user: ${userId}`);
    
    const { tokens } = await oAuth2Client.getToken(code);
    userTokens.set(userId, tokens);
    
    console.log(`✅ Tokens received for user: ${userId}`);
    
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
            background: #f5f5f5;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 500px;
            margin: 0 auto;
          }
          .success {
            color: #4CAF50;
            font-size: 48px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">✓</div>
          <h2>Authentication Successful!</h2>
          <p>You can now schedule events with your AI assistant.</p>
          <p>This window will close automatically.</p>
        </div>
        <script>
          // Send message to opener (Chrome extension)
          if (window.opener) {
            window.opener.postMessage({
              type: 'oauth-callback',
              success: true,
              userId: '${userId}',
              timestamp: new Date().toISOString()
            }, '*');
          }
          
          // Close after 1 second
          setTimeout(() => {
            window.close();
          }, 1000);
        </script>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial; padding: 50px; text-align: center;">
        <h2 style="color: #d32f2f;">Authentication Failed</h2>
        <p>${error.message}</p>
        <script>
          if (window.opener) {
            window.opener.postMessage({
              type: 'oauth-callback',
              success: false,
              error: 'Authentication failed: ${error.message.replace(/'/g, "\\'")}'
            }, '*');
          }
        </script>
      </body>
      </html>
    `);
  }
});

// 3. Schedule event endpoint
app.post('/schedule-event', async (req, res) => {
  try {
    const { userQuery, userId } = req.body;
    
    console.log('📅 Schedule request:', { userQuery, userId });
    
    if (!userQuery) {
      return res.status(400).json({ 
        error: 'Missing userQuery',
        example: 'Schedule team meeting tomorrow at 3 PM' 
      });
    }
    
    if (!userId) {
      return res.status(400).json({ 
        error: 'Missing userId',
        action: 'Call /auth/url first to authenticate' 
      });
    }
    
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
    
    // Parse natural language
    console.log('🤖 Parsing with Gemini...');
    const eventDetails = await parseScheduleRequest(userQuery);
    console.log('📝 Parsed details:', eventDetails);
    
    // Create calendar event
    const calendar = google.calendar({ version: 'v3', auth: userAuth });
    
    const event = {
      summary: eventDetails.summary || 'Meeting',
      description: `Created via AI Assistant. Original query: "${userQuery}"`,
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
      reminders: {
        useDefault: true,
      },
    };
    
    console.log('📨 Creating event:', event.summary);
    
    const calendarResponse = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      sendUpdates: 'none',
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
      rawQuery: userQuery
    });
    
  } catch (error) {
    console.error('❌ Schedule event error:', error);
    
    // Handle token errors
    if (error.message.includes('invalid_grant') || error.message.includes('token expired')) {
      userTokens.delete(req.body.userId);
      return res.status(401).json({ 
        error: 'Authentication expired',
        action: 'reauthenticate',
        endpoint: '/auth/url' 
      });
    }
    
    // Handle calendar permission errors
    if (error.message.includes('insufficient permission')) {
      return res.status(403).json({ 
        error: 'Calendar access required',
        action: 'Re-authenticate and grant calendar permissions' 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to schedule event',
      details: error.message,
      suggestion: 'Try: "Schedule meeting tomorrow at 3 PM for 1 hour"' 
    });
  }
});

// 4. Original Gemini endpoint
app.post('/ask-gemini', async (req, res) => {
  try {
    const { question, tabsContext, maxTokens = 150, temperature = 0.5 } = req.body;
    
    console.log('📥 Gemini request:', { 
      question: question?.substring(0, 100) + (question?.length > 100 ? '...' : ''),
      contextLength: tabsContext?.length || 0 
    });
    
    if (!question) {
      return res.status(400).json({ 
        error: 'Missing question' 
      });
    }
    
    if (!API_KEY) {
      return res.status(500).json({ 
        error: 'Gemini API key not configured' 
      });
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );
    
    if (!response.ok) {
      const errorData = await response.text();
      console.error('❌ Gemini API error:', errorData);
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
      timestamp: new Date().toISOString(),
      tokensUsed: data.usageMetadata?.totalTokenCount || 0
    });
    
  } catch (err) {
    console.error('❌ Gemini endpoint error:', err);
    res.status(500).json({ 
      error: err.message,
      details: 'Failed to process Gemini request'
    });
  }
});

// 5. Check authentication status
app.get('/auth/status/:userId', (req, res) => {
  const { userId } = req.params;
  const isAuthenticated = userTokens.has(userId);
  
  res.json({
    authenticated: isAuthenticated,
    userId,
    hasCalendarAccess: isAuthenticated,
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('❌ Unhandled server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString()
  });
});

// Server startup - Vercel compatible
const PORT = process.env.PORT || 3000;

// Only start listening if NOT in Vercel serverless environment
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log('🚀 Tab AI Server with Calendar started');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.VERCEL ? 'Vercel' : 'Local'}`);
    console.log(`🔑 Gemini API: ${API_KEY ? '✅' : '❌'}`);
    console.log(`👤 OAuth Client: ${GOOGLE_CLIENT_ID ? '✅' : '❌'}`);
    console.log('');
    console.log('📋 Available Endpoints:');
    console.log(`   POST /auth/url     - Get OAuth URL`);
    console.log(`   GET  /oauth2callback - OAuth callback`);
    console.log(`   POST /schedule-event - Schedule events`);
    console.log(`   POST /ask-gemini    - Ask Gemini`);
    console.log(`   GET  /auth/status/:userId - Check auth`);
  });
}

// Export for Vercel serverless
export default app;
