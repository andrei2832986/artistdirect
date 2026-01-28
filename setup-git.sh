#!/bin/bash
# Script pentru inițializarea Git și pregătirea pentru GitHub

echo "🚀 Inițializare Git pentru ArtistDirect..."

# Verifică dacă Git este deja inițializat
if [ -d ".git" ]; then
    echo "⚠️  Git este deja inițializat."
else
    git init
    echo "✅ Git inițializat"
fi

# Adaugă toate fișierele
git add .

# Commit inițial
git commit -m "Initial commit - ArtistDirect platform"

echo ""
echo "✅ Proiectul este pregătit pentru GitHub!"
echo ""
echo "📝 Următorii pași:"
echo "1. Creează un repository nou pe GitHub"
echo "2. Rulează: git remote add origin https://github.com/yourusername/artistdirect.git"
echo "3. Rulează: git branch -M main"
echo "4. Rulează: git push -u origin main"
echo ""


