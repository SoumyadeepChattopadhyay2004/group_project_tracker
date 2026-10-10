# Group Project Tracker (full-stack)
Node.js backend (zero framework, JSON-file database) + single-page frontend. Data is shared by all members.

## Run
    npm install
    cp .env.example .env     # edit values (optional: app works in dev mode without Gmail/SMS)
    npm start                # http://localhost:3000
Requires Node 18+. Data is stored in `data/` (db.json + uploads/). Back this folder up.

## How it works
- **Roles:** everyone signs up as a member. The first person to press "I am the leader" in the Team tab becomes leader (only while no leader exists). After that only the leader can transfer leadership or remove members.
- **Everyone sees all updates:** the app polls every 5 s; the Activity tab and dashboard calendar show all team events. Private evidence is hidden from other members (leader can see it).
- **Read receipts:** opening Chat marks messages as seen; "Seen by" is shown per message and in the Activity tab. Evidence shows "Viewed by".
- **Notifications:** Announce a meeting -> each member gets Gmail; if Gmail fails or is not configured, SMS (Twilio) is sent to that member. Without credentials, messages are logged in the server console (dev mode) and the status is shown in the UI.
- **Checks:** server-side validation of all inputs, role checks, duplicate checks, file signature + 300 KB limit + SHA-256, date limits, login rate limit, scrypt password hashing, signed tokens.

## Permanent storage (required on Render free plan)
Set `DATABASE_URL` to a PostgreSQL connection string (e.g. a free Neon database). Users, tasks, chat and evidence files are then stored in the database and survive restarts/redeploys. Without it the app uses local files in `data/`, which Render erases.

## Limitations
- JSON-file storage suits small teams; swap for PostgreSQL for larger use. Use HTTPS (reverse proxy) in production and set a strong APP_SECRET.
- Live Gmail/SMS need your credentials and could not be tested without them.
