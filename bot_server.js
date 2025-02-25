// Removed dotenv config
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const VisaBotModule = require('./bot_visa_module');

// Initialize Express and Visa Bot Module
const app = express();
const visaBot = new VisaBotModule();
const PORT = process.env.PORT || 7001;

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
});
app.use('/webhook', limiter);

// Logging and parsing middleware
app.use(morgan('dev'));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Webhook endpoints
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  visaBot.log.info('Webhook verification request received', { mode, token });

  if (mode === 'subscribe' && token === visaBot.WHATSAPP_CONFIG.verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Verification failed' });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    visaBot.log.info('Webhook event received', { type: body.object });

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          // Attempt to capture WhatsApp display name if provided
          if (change.value?.contacts && change.value.contacts.length > 0) {
            const userWhatsAppName = change.value.contacts[0].profile?.name || '';
            const userWaId = change.value.contacts[0].wa_id || '';
            // Store the display name separately if we already know the user's phone
            if (userWaId) {
              visaBot.saveUserName(userWaId, userWhatsAppName);
            }
          }

          if (change.value?.messages) {
            for (const message of change.value.messages) {
              // Process only text messages
              if (message.text?.body && message.from) {
                try {
                  // Pass the WhatsApp "from" as userId and the text body
                  const response = await visaBot.handleIncomingMessage(
                    message.from,
                    message.text.body
                  );
                  if (response) {
                    await visaBot.sendWhatsAppMessage(message.from, response);
                  }
                } catch (error) {
                  visaBot.log.error('Message processing error:', error);
                  await visaBot.sendWhatsAppMessage(
                    message.from,
                    "I'm having some trouble right now. Could we try again in a moment?"
                  );
                }
              }
            }
          }
        }
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    visaBot.log.error('Webhook error:', error);
    res.status(200).json({
      status: 'error',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const status = visaBot.getHealthStatus();
  visaBot.log.info('Health check requested', status);
  res.status(200).json(status);
});

// Root route for Railway health checks
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'online',
    service: 'WhatsApp Visa Search Bot',
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Error handlers
process.on('unhandledRejection', (error) => {
  visaBot.log.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  visaBot.log.error('Uncaught exception:', error);
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') return;

  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  visaBot.log.info('Received SIGTERM signal. Starting graceful shutdown...');

  try {
    // Wait for pending requests to complete (max 10 seconds)
    const shutdownTimeout = setTimeout(() => {
      visaBot.log.warn('Shutdown timeout reached. Forcing exit...');
      process.exit(1);
    }, 10000);

    // Close server
    server.close(() => {
      clearTimeout(shutdownTimeout);
      visaBot.log.info('Server closed successfully');
      process.exit(0);
    });
  } catch (error) {
    visaBot.log.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Initialize server
const server = app.listen(PORT, () => {
  visaBot.log.info(`
🚀 WhatsApp Visa Search Bot
============================
Server running on port: ${PORT}
Environment: ${process.env.NODE_ENV || 'development'}
WhatsApp Phone ID: ${visaBot.WHATSAPP_CONFIG.phoneNumberId}
System Status: Online
============================
  `);
});