# Abbey Match Caller

A web-based interface for calling matches to stream and managing stations via the start.gg API. This application serves as a dedicated dashboard for Tournament Organizers (TOs) and players.

## Features

- **Auto Watch Engine**: Automatically monitors start.gg for new sets and can call pending sets to free stations in phase order.
- **Stream Queuing**: Dedicated queues for Main Stream and Sidestream. Build the queue, reorder matches, and click "CALL" to assign them to the stream on start.gg.
- **Discord Integration**: Pings players in a Discord channel when their match is called. Supports linking attendees to Discord IDs via a start.gg CSV upload for `@mentions`.
- **Player Hub**: A dedicated interface for players to check in to their matches and report scores directly from their mobile devices.
- **Auto-DQs**: Configurable timers that automatically disqualify players who fail to show up for their called matches.

## Requirements

To use Abbey Match Caller, you will need:
- A **start.gg API Token** (You can generate one in your start.gg Developer Settings).
- A **Discord Webhook URL** (if you want to enable Discord match announcements).

## Development

This project uses [Vite](https://vitejs.dev/) as its build tool and local dev server.

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start the local server**
   ```bash
   npm run dev
   ```
   This will start a local server at `http://localhost:5173`. Open that URL in your browser.

## Deployment

This project is automatically deployed to [GitHub Pages](https://pages.github.com/).

The live application is available at: [https://reallarsbars.github.io/abbeytools/](https://reallarsbars.github.io/abbeytools/)

To deploy updates, simply push your changes to the repository. The GitHub Pages integration will automatically build and publish the site.

Alternatively, you can manually build the project by running:
```bash
npm run build
```
This will generate a `dist` folder containing the compiled static files, which can be hosted on any web server.

## Usage Guide

1. Open the application in your browser.
2. Click on **Setup & Configuration** at the top.
3. Enter your **start.gg API Token** and the **Tournament Slug** (e.g., `abbey`).
4. *(Optional)* Provide a **Discord Webhook URL** if you want match call pings sent to your server.
5. *(Optional)* Upload an **Attendee CSV** from start.gg to enable Discord account linking for `@mentions`.
6. Use the **Call Sets**, **Auto Watch**, **Stream**, and **Player Hub** tabs to manage the tournament!

## Technologies Used

- Vanilla JavaScript
- HTML5 / Vanilla CSS
- [Vite](https://vitejs.dev/)
- [start.gg GraphQL API](https://developer.start.gg/docs/intro/)
