# ArtistDirect 🎵

Platformă elegantă pentru conectarea directă cu artiști muzicali pentru evenimente și nunți, fără intermediari.

## 🚀 Caracteristici

- **Profiluri de artiști** - Artiștii își pot crea profiluri complete cu fotografii, videoclipuri YouTube, servicii și descrieri
- **Căutare și filtrare** - Explorează artiști după județ și gen muzical
- **Sistem de rating** - Utilizatorii pot evalua artiștii cu 1-5 stele
- **Social media integration** - Linkuri către WhatsApp, Facebook, Instagram, TikTok și Gmail
- **Galerie foto** - Artiștii pot încărca până la 30 de fotografii
- **Videoclipuri YouTube** - Embed pentru până la 5 videoclipuri YouTube
- **Servicii** - Artiștii pot adăuga servicii cu titlu și detalii

## 📋 Cerințe

- Node.js >= 18.0.0
- PostgreSQL (local sau Supabase)
- Cont Google pentru OAuth

## 🛠️ Instalare Locală

1. **Clonează repository-ul**
```bash
git clone https://github.com/yourusername/artistdirect.git
cd artistdirect
```

2. **Instalează dependențele**
```bash
npm install
```

3. **Configurează variabilele de mediu**
```bash
cp .env.example .env
```

Editează `.env` și adaugă valorile tale:
- Credențiale baza de date
- Google OAuth Client ID și Secret
- Session secret (generează un string aleatoriu)

4. **Configurează baza de date**

Rulează scriptul de migrare SQL din `database_migration.sql` în PostgreSQL.

5. **Pornește aplicația**
```bash
npm run dev
```

Aplicația va rula pe `http://localhost:8000`

## 🌐 Deployment pe Render + Supabase

### Setup Supabase

1. **Creează un proiect pe [Supabase](https://supabase.com)**

2. **Obține credențialele de conexiune**
   - Mergi la Project Settings → Database
   - Copiază connection string sau folosește valorile individuale:
     - Host: `db.your-project.supabase.co`
     - Database: `postgres`
     - User: `postgres`
     - Password: (din Supabase dashboard)
     - Port: `5432`

3. **Rulează migrarea bazei de date**
   - Deschide SQL Editor în Supabase
   - Rulează scriptul `database_migration.sql`

### Setup Render

1. **Creează un cont pe [Render](https://render.com)**

2. **Creează un Web Service**
   - Conectează repository-ul GitHub
   - Selectează branch-ul principal
   - Build Command: `npm install`
   - Start Command: `npm start`

3. **Configurează Environment Variables în Render**
   ```
   DB_USER=postgres
   DB_HOST=db.your-project.supabase.co
   DB_PASSWORD=your-supabase-password
   DB_NAME=postgres
   DB_PORT=5432
   SESSION_SECRET=your-random-secret-key
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   NODE_ENV=production
   OAUTH_CALLBACK_URL=https://your-app.onrender.com/auth/google/callback
   PORT=10000
   ```

4. **Actualizează Google OAuth**
   - Mergi la [Google Cloud Console](https://console.cloud.google.com)
   - Adaugă URL-ul de callback de la Render în Authorized redirect URIs:
     - `https://your-app.onrender.com/auth/google/callback`

5. **Deploy**
   - Render va deploya automat când faci push pe GitHub

## 📁 Structura Proiectului

```
profiles_app/
├── app.js                 # Aplicația principală Express
├── package.json          # Dependencies și scripts
├── .env.example          # Template pentru variabile de mediu
├── .gitignore            # Fișiere ignorate de Git
├── database_migration.sql # Script de migrare baza de date
├── public/              # Fișiere statice
│   ├── style.css        # Stiluri CSS
│   ├── uploads/         # Upload-uri utilizatori
│   └── logo.png         # Logo aplicație
├── views/               # Template-uri EJS
│   ├── landing.ejs      # Pagina principală
│   ├── explore.ejs      # Pagina de explorare
│   ├── profile.ejs      # Pagina de profil
│   └── footer.ejs      # Footer
└── README.md           # Acest fișier
```

## 🔐 Securitate

- **Nu commita niciodată** fișierul `.env` în Git
- Folosește variabile de mediu pentru toate credențialele
- Generează un session secret puternic pentru producție
- Activează HTTPS în producție (Render o face automat)

## 📝 Note

- Upload-urile sunt stocate local în `public/uploads/`
- Pentru producție, consideră folosirea unui serviciu de storage (AWS S3, Cloudinary, etc.)
- Session-urile sunt stocate în memorie (pentru producție, consideră Redis sau PostgreSQL session store)

## 🤝 Contribuții

Contribuțiile sunt binevenite! Te rugăm să deschizi un issue sau pull request.

## 📄 Licență

ISC

