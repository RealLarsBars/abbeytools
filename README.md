# Abbey Match Caller

A web-based interface for calling matches to stream and managing stations via the start.gg API.

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

This project is configured for easy deployment on [Netlify](https://www.netlify.com/).

To deploy:
1. Push this repository to GitHub/GitLab/Bitbucket.
2. Log into Netlify and click "Add new site" -> "Import an existing project".
3. Select your repository.
4. Netlify will automatically detect the settings in `netlify.toml` (Build command: `npm run build`, Publish directory: `dist`).
5. Click "Deploy site".

Alternatively, you can manually build the project by running:
```bash
npm run build
```
This will generate a `dist` folder containing the compiled static files, which can be hosted on any web server.
