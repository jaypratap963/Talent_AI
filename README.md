# 🎙️ TalentAI — Real-Time AI Interview App

A production-ready Angular application that simulates a human-like technical interview using OpenAI GPT and the Web Speech API.

---

## 🏗️ Architecture Overview

```
src/app/
├── models/
│   └── interview.models.ts       # All TypeScript interfaces
├── services/
│   ├── ai.service.ts             # OpenAI API integration + prompt engineering
│   ├── speech.service.ts         # STT (mic → text) + TTS (text → voice)
│   ├── interview.service.ts      # Central state manager (session, history)
│   └── resume-parser.service.ts  # PDF text extraction via PDF.js
└── components/
    ├── resume-upload/            # Upload screen (drag/drop PDF)
    ├── interview/                # Main interview screen
    └── chat-window/              # Chat message renderer
```

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start development server
```bash
ng serve
# Open http://localhost:4200
```

---

## 🔑 Usage

### Option A — Real AI Mode (OpenAI API)
1. Get an API key from https://platform.openai.com
2. Upload your resume (PDF or TXT)
3. Enter your OpenAI API key (stored in memory only — never persisted)
4. Click **Begin Interview**

### Option B — Demo Mode (No API key needed)
1. Upload your resume (PDF or TXT)
2. Toggle **Demo Mode**
3. Click **Begin Interview**
   - Pre-written questions will be used

---

## 🎙️ Voice Features

| Feature | Browser Support |
|---|---|
| Speech-to-Text | Chrome, Edge (not Firefox/Safari) |
| Text-to-Speech | All modern browsers |

- **Mic button**: Click to start/stop voice input
- **AI speaks**: Every question is read aloud automatically
- **Stop speaking**: Click 🔇 to mute AI voice

---

## 🧠 AI Behavior (Prompt Engineering)

The AI interviewer **Alex** is tuned to:
- Ask ONE question at a time
- Follow up on weak or vague answers
- Mix technical + behavioral (STAR) + situational questions
- Acknowledge strong answers briefly
- Close the interview naturally after 8–10 questions
- Generate a scored evaluation at the end

---

## 📊 Evaluation System

At the end of each interview, the AI provides:
- **Overall Score** (0–100)
- **Technical Score**
- **Communication Score**
- **Confidence Score**
- **Strengths** (3 bullet points)
- **Areas to Improve** (3 bullet points)
- **Interviewer Summary** paragraph

---

## 🔒 Privacy

- Your API key is **never stored** — it lives in JavaScript memory only and disappears on page refresh
- Your resume text stays in your browser session
- No data is sent to any server except OpenAI's API

---

## 🛠️ Moving to a Backend Later

All API calls are isolated in `ai.service.ts`. To add a backend:

1. Create a backend endpoint (e.g. `POST /api/chat`)
2. Replace the `fetch` call in `AiService.callOpenAI()` with a call to your backend
3. Move the API key to your server environment

---

## 📦 Dependencies

| Package | Purpose |
|---|---|
| `@angular/core` v18 | Framework |
| `pdfjs-dist` | PDF parsing (via CDN) |
| Web Speech API | Browser-native STT/TTS |
| OpenAI REST API | AI responses (via fetch) |

---

## 🎨 Design System

- **Font Display**: Syne (geometric, bold)
- **Font Body**: DM Sans (clean, readable)
- **Theme**: Dark with electric cyan-blue accent (`#63b3ed`)
- **Tokens**: CSS custom properties in `styles.scss`
