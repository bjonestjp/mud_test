# Deploy To Vercel

Use this for a free, HTTPS-hosted playtest build that can be opened from a phone.

## 1. Push The Repo

Push this folder to a GitHub repository. Keep `.env.local` out of git.

## 2. Import In Vercel

1. Open Vercel.
2. Create a new project.
3. Import the GitHub repository.
4. Vercel should use:

```text
Build Command: npm run build
Output Directory: dist
```

The same values are also set in `vercel.json`.

## 3. Add Environment Variables

Add these in **Project Settings -> Environment Variables** for Production and Preview:

```text
VITE_SUPABASE_URL=https://jcadppmctjxqrggxivok.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

Vite only exposes variables with the `VITE_` prefix.

## 4. Deploy

Trigger a production deployment. The hosted URL should look like:

```text
https://your-project.vercel.app
```

## 5. Test

1. Open the Vercel URL on your phone.
2. Sign in with an already confirmed Supabase user.
3. Use the locate button.
4. Place a pin.
5. Check that the pin appears on another signed-in device.

Browser GPS requires HTTPS, so the Vercel URL is better for testing than local development.

## Notes

- No server is deployed. Vercel serves the static frontend; Supabase handles auth and data.
- If you later re-enable magic links, email confirmation, or OAuth, add the Vercel URL in Supabase Auth URL settings.
- If the deployed app shows demo mode, the Vercel environment variables are missing or the project needs a redeploy after adding them.
