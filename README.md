# Genesis

<img src="src-tauri/icons-genesis/icon.png" alt="icon" width="128"/>

A lightweight desktop application for bookmarking and viewing YouTube transcripts.

## Features

- **Channel Search:** Browse uploads by entering a YouTube handle (e.g., @MrBeast).
- **Playlist Search:** Browse playlists by entering a YouTube playlist URL.
- **Video Search:** Browse a single video by entering a YouTube video URL.

- **Bookmark videos:** Save videos to your library for quick access.
- **Search your bookmarks:** Filter through your bookmarked videos (uses FTS5).
- **View transcripts:** View transcripts of videos in your library.

- **AI Summarization:** Get AI-powered summaries of video transcripts using either:
  - **Local AI (Ollama):** Run LLMs locally on your machine for privacy
  - **Cloud AI (VeniceAI):** Use cloud-based AI for summarization
- **Bulk summarize:** Summarize all videos in your library at once
- **Custom prompts:** Customize the AI prompt for different summary styles

**Note:** Database is stored in AppData\Roaming\genesisapp\genesis_data.db for Windows and ~/.local/share/genesisapp/genesis_data.db for Linux.

## Setup and Installation

### Prerequisites
- Node.js (v18+)
- Rust toolchain (1.70+)
- YouTube API Key

### AI Providers Setup

#### Option 1: Local AI (Ollama)
1. Download and install [Ollama](https://ollama.com)
2. Kinesis will automatically detect Ollama and can even install it for you
3. Select your preferred model (default: llama3.2)
4. Configure custom prompts in settings

#### Option 2: Cloud AI (VeniceAI)
1. Get an API key from [Venice.ai](https://venice.ai)
2. Enter your API key in Kinesis settings
3. Choose Venice as your summarization provider

### Development
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Launch the application in development mode:
   ```bash
   npx tauri dev
   ```
   Or for specific branding:
   ```bash
   npm run tauri:dev:genesis  # Genesis branding
   npm run tauri:dev:kinesis  # Kinesis branding
   ```

### Building for Production
To generate a production executable for your platform:
```bash
npx tauri build
```

Or for specific branding:
```bash
npm run tauri:build:genesis
npm run tauri:build:kinesis
```

## Tech Stack
- Frontend: React, TypeScript, Tailwind CSS, Lucide Icons, Vite.
- Backend: Tauri (Rust), Reqwest, Serde.
- AI: Ollama (local), VeniceAI (cloud).
