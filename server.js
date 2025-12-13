// server.js - Complete Tab AI Server with Calendar Integration
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
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Environment variables
const API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Redirect URI - automatically detects deployment environment
const getRedirectUri = () => {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/oauth2callback`;
  }
  return `http://localhost:${process.env.PORT || 3000}/oauth2callback`;
};

// Store tokens (WARNING: In-memory storage - use Redis/Database for production)
const userTokens = new Map();

// OAuth2 configuration
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Create OAuth client
const getOAuthClient = () => {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
};

// ============ HELPER FUNCTIONS ============

// Parse natural language date/time with Gemini
async function parseScheduleRequest(userQuery) {
  try {
    const now = new Date();
    const prompt = `Extract event details from this natural language request: "${userQuery}"

Current date/time: ${now.toISOString()}

Return ONLY a valid JSON object with this exact structure (no markdown, no extra text):
{
  "summary": "event title",
  "startDateTime": "YYYY-MM-DDTHH:mm:ss",
  "endDateTime": "YYYY-MM-DDTHH:mm:ss",
  "attendees": ["email1@example.com"]
}

Rules:
- summary: Extract the event title/purpose. Default to "Meeting" if unclear.
- startDateTime: Parse date/time in ISO format. If time not specified, use next available hour (9 AM - 5 PM working hours).
- endDateTime: If duration not specified, add 1 hour to start time.
- attendees: Extract email addresses. Empty array if none mentioned.
- "tomorrow" = ${new Date(now.getTime() + 24*60*60*1000).toISOString().split('T')[0]}
- "next week" = next Monday at 9 AM
- If only time given (e.g., "3 PM"), use today's date

Examples:
"Team meeting tomorrow at 3 PM" → tomorrow at 15:00 for 1 hour
"Call with john@example.com next Monday" → next Monday at 9 AM for 1 hour
"Lunch at noon" → today at 12:00 for 1 hour`;

    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 400,
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

    // Extract JSON from response (handles markdown formatting)
    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    
    console.log('📝 Parsed event details:', parsed);
    return parsed;

  } catch (error) {
    console.error('❌ Error parsing schedule request:', error);
    throw new Error(`Failed to parse request: ${error.message}`);
  }
}

// ============ ENDPOINTS ============

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Tab AI Server with Calendar is running',
    environment: {
      deployment: process.env.VERCEL ? 'Vercel' : 'Local',
      redirectUri: getRedirectUri()
    },
    config: {
      geminiApi: API_KEY ? '✅ Configured' : '❌ Missing GOOGLE_API_KEY',
      oauthClientId: GOOGLE_CLIENT_ID ? '✅ Configured' : '❌ Missing GOOGLE_CLIENT_ID',
      oauthSecret: GOOGLE_CLIENT_SECRET ? '✅ Configured' : '❌ Missing GOOGLE_CLIENT_SECRET'
    },
    endpoints: {
      gemini: 'POST /ask-gemini',
      authUrl: 'POST /auth/url',
      authCallback: 'GET /oauth2callback',
      scheduleEvent: 'POST /schedule-event',
      authStatus: 'GET /auth/status/:userId'
    },
    timestamp: new Date().toISOString()
  });
});

// ============ CALENDAR ENDPOINTS ============

// 1. Get OAuth authorization URL
app.post('/auth/url', (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        error: 'Missing userId',
        example: { userId: 'unique_user_123' }
      });
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ 
        error: 'OAuth not configured',
        message: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment variables'
      });
    }

    const oAuth2Client = getOAuthClient();
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
      redirectUri: getRedirectUri(),
      message: 'Open this URL in a browser to authenticate'
    });

  } catch (error) {
    console.error('❌ Auth URL generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate auth URL',
      details: error.message 
    });
  }
});

// 2. OAuth callback handler
app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    const userId = req.query.state;
    const error = req.query.error;

    // Handle user denial
    if (error) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Authentication Cancelled</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { background: white; padding: 40px; border-radius: 10px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .icon { font-size: 48px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">⚠️</div>
            <h2>Authentication Cancelled</h2>
            <p>You denied calendar access. The extension won't be able to schedule events.</p>
            <p>This window will close automatically.</p>
          </div>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
        </html>
      `);
    }

    if (!code) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>❌ Missing Authorization Code</h2>
          <p>No code received from Google.</p>
        </body>
        </html>
      `);
    }

    if (!userId) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>❌ Missing User ID</h2>
          <p>No user ID in state parameter.</p>
        </body>
        </html>
      `);
    }

    console.log(`🔄 Exchanging code for tokens (user: ${userId})...`);

    const oAuth2Client = getOAuthClient();
    const { tokens } = await oAuth2Client.getToken(code);

    // Store tokens (WARNING: Use Redis/Database for production)
    userTokens.set(userId, tokens);

    console.log(`✅ Tokens stored for user: ${userId}`);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Authentication Successful</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
          .container { background: rgba(255,255,255,0.95); color: #333; padding: 40px; border-radius: 15px; max-width: 500px; margin: 0 auto; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
          .success { color: #4CAF50; font-size: 64px; margin: 20px 0; animation: checkmark 0.5s ease; }
          @keyframes checkmark { from { transform: scale(0); } to { transform: scale(1); } }
          h2 { color: #333; margin: 20px 0; }
          p { color: #666; line-height: 1.6; }
          .countdown { font-weight: bold; color: #667eea; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="success">✓</div>
          <h2>Authentication Successful!</h2>
          <p>Your calendar is now connected to the AI assistant.</p>
          <p>You can now schedule events using natural language.</p>
          <p class="countdown">This window will close in <span id="timer">2</span> seconds...</p>
        </div>
        <script>
          let countdown = 2;
          const timer = document.getElementById('timer');
          const interval = setInterval(() => {
            countdown--;
            timer.textContent = countdown;
            if (countdown <= 0) {
              clearInterval(interval);
              window.close();
            }
          }, 1000);

          // Notify parent window (Chrome extension)
          if (window.opener) {
            window.opener.postMessage({
              type: 'oauth-callback',
              success: true,
              userId: '${userId}',
              timestamp: new Date().toISOString()
            }, '*');
          }
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('❌ OAuth callback error:', error);

    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Authentication Failed</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
          .container { background: white; padding: 40px; border-radius: 10px; max-width: 500px; margin: 0 auto; }
          .error { color: #d32f2f; font-size: 48px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="error">✗</div>
          <h2>Authentication Failed</h2>
          <p>${error.message}</p>
          <p>Please try again or contact support.</p>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage({
              type: 'oauth-callback',
              success: false,
              error: '${error.message.replace(/'/g, "\\'")}'
            }, '*');
          }
          setTimeout(() => window.close(), 5000);
        </script>
      </body>
      </html>
    `);
  }
});

// 3. Schedule calendar event
app.post('/schedule-event', async (req, res) => {
  try {
    const { userQuery, userId } = req.body;

    console.log('📅 Schedule event request:', { userQuery, userId });

    // Validation
    if (!userQuery) {
      return res.status(400).json({ 
        error: 'Missing userQuery',
        example: { userQuery: 'Schedule team meeting tomorrow at 3 PM', userId: 'user123' }
      });
    }

    if (!userId) {
      return res.status(400).json({ 
        error: 'Missing userId',
        message: 'Authenticate first using /auth/url'
      });
    }

    if (!API_KEY) {
      return res.status(500).json({ 
        error: 'Gemini API not configured',
        message: 'Set GOOGLE_API_KEY in environment variables'
      });
    }

    // Check authentication
    const tokens = userTokens.get(userId);
    if (!tokens) {
      return res.status(401).json({ 
        error: 'User not authenticated',
        action: 'authenticate',
        authEndpoint: '/auth/url',
        message: 'Please authenticate with Google Calendar first'
      });
    }

    // Parse natural language request
    console.log('🤖 Parsing request with Gemini...');
    const eventDetails = await parseScheduleRequest(userQuery);

    if (!eventDetails.summary || !eventDetails.startDateTime) {
      throw new Error('Could not extract event details from query');
    }

    // Set up authenticated Google Calendar client
    const userAuth = getOAuthClient();
    userAuth.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: userAuth });

    // Prepare calendar event
    const event = {
      summary: eventDetails.summary,
      description: `Created by AI Assistant\nOriginal request: "${userQuery}"`,
      start: {
        dateTime: eventDetails.startDateTime,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      end: {
        dateTime: eventDetails.endDateTime,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      attendees: eventDetails.attendees?.map(email => ({ email })) || [],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 10 },
        ],
      },
    };

    console.log('📨 Creating calendar event...');

    // Create the event
    const calendarResponse = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      sendUpdates: eventDetails.attendees?.length > 0 ? 'all' : 'none',
    });

    console.log('✅ Event created:', calendarResponse.data.htmlLink);

    // Format response
    res.json({
      success: true,
      message: `✅ Event "${event.summary}" scheduled successfully!`,
      event: {
        id: calendarResponse.data.id,
        link: calendarResponse.data.htmlLink,
        summary: event.summary,
        start: event.start.dateTime,
        end: event.end.dateTime,
        attendees: event.attendees,
        timeZone: event.start.timeZone
      },
      parsedDetails: eventDetails,
      originalQuery: userQuery,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Schedule event error:', error);

    // Handle specific errors
    if (error.message.includes('invalid_grant') || 
        error.message.includes('token expired') ||
        error.message.includes('invalid_token')) {
      userTokens.delete(req.body.userId);
      return res.status(401).json({ 
        error: 'Authentication expired',
        action: 'reauthenticate',
        message: 'Your authentication expired. Please authenticate again.',
        authEndpoint: '/auth/url'
      });
    }

    if (error.message.includes('insufficient permission') ||
        error.message.includes('Calendar API has not been used')) {
      return res.status(403).json({ 
        error: 'Calendar access denied',
        message: 'Please ensure Calendar API is enabled in Google Cloud Console',
        action: 'Enable Calendar API and re-authenticate'
      });
    }

    res.status(500).json({ 
      error: 'Failed to schedule event',
      details: error.message,
      suggestion: 'Try: "Schedule meeting tomorrow at 3 PM" or "Team call next Monday at 10 AM"'
    });
  }
});

// 4. Check authentication status
app.get('/auth/status/:userId', (req, res) => {
  const { userId } = req.params;
  const isAuthenticated = userTokens.has(userId);

  res.json({
    authenticated: isAuthenticated,
    userId,
    hasCalendarAccess: isAuthenticated,
    redirectUri: getRedirectUri(),
    timestamp: new Date().toISOString()
  });
});

// ============ GEMINI ENDPOINT ============

// Main endpoint for Gemini queries
app.post('/ask-gemini', async (req, res) => {
  try {
    const { question, tabsContext, maxTokens = 150, temperature = 0.5 } = req.body;
    
    console.log('📥 Gemini request:', {
      question: question?.substring(0, 100) + (question?.length > 100 ? '...' : ''),
      contextLength: tabsContext?.length || 0
    });
    
    if (!question) {
      return res.status(400).json({ 
        error: 'Missing required field: question',
        example: { question: 'What is AI?', tabsContext: 'optional context' }
      });
    }
    
    if (!API_KEY) {
      return res.status(500).json({ 
        error: 'Google API key not configured',
        message: 'Set GOOGLE_API_KEY in environment variables'
      });
    }
    
    // Build the prompt for Gemini
    const fullPrompt = `${question}\n\nContext:\n${tabsContext || 'No context provided'}`;
    
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
    
    // Extract the answer
    let answer = '';
    
    if (data.candidates && data.candidates.length > 0) {
      const candidate = data.candidates[0];
      
      if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        answer = candidate.content.parts[0].text || '';
      }
    }
    
    if (!answer || answer.trim().length === 0) {
      console.warn('⚠️ Empty answer from Gemini');
      throw new Error('Gemini returned empty response');
    }
    
    console.log('✅ Answer generated successfully');
    
    res.json({ 
      answer: answer.trim(),
      timestamp: new Date().toISOString(),
      tokensUsed: data.usageMetadata?.totalTokenCount || 0
    });
    
  } catch (err) {
    console.error('❌ Gemini endpoint error:', err);
    
    res.status(500).json({ 
      error: err.message,
      details: 'Failed to process request. Check server logs for details.'
    });
  }
});

// ============ ERROR HANDLING ============

app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString()
  });
});

// ============ SERVER STARTUP ============

const PORT = process.env.PORT || 3000;

// Only start server if not in Vercel serverless environment
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('🚀 Tab AI Server with Calendar started');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.VERCEL ? 'Vercel' : 'Local'}`);
    console.log(`🔑 Gemini API: ${API_KEY ? '✅' : '❌'}`);
    console.log(`👤 OAuth Client ID: ${GOOGLE_CLIENT_ID ? '✅' : '❌'}`);
    console.log(`🔐 OAuth Secret: ${GOOGLE_CLIENT_SECRET ? '✅' : '❌'}`);
    console.log(`📍 Redirect URI: ${getRedirectUri()}`);
    console.log('');
    console.log('📋 Available Endpoints:');
    console.log(`   GET  /                       - Health check`);
    console.log(`   POST /ask-gemini             - Ask Gemini AI`);
    console.log(`   POST /auth/url               - Get OAuth URL`);
    console.log(`   GET  /oauth2callback         - OAuth callback`);
    console.log(`   POST /schedule-event         - Schedule calendar event`);
    console.log(`   GET  /auth/status/:userId    - Check authentication`);
    console.log('');
    console.log('⚠️  WARNING: Using in-memory token storage');
    console.log('   For production, use Redis or a database');
  });
}

// Export for Vercel serverless
export default app;
