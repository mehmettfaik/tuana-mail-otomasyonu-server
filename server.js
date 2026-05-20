import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.js';
import contactsRoutes from './routes/contacts.js';
import emailRoutes from './routes/email.js';
import trackRoutes from './routes/track.js';
import emailAutomationRoutes from './routes/emailAutomation.js';

const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Health check — Render monitoring & keep-alive ping
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/track', trackRoutes);
app.use('/api/email-automation', emailAutomationRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
