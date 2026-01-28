# Script PowerShell pentru inițializarea Git și pregătirea pentru GitHub

Write-Host "🚀 Inițializare Git pentru ArtistDirect..." -ForegroundColor Green

# Verifică dacă Git este deja inițializat
if (Test-Path ".git") {
    Write-Host "⚠️  Git este deja inițializat." -ForegroundColor Yellow
} else {
    git init
    Write-Host "✅ Git inițializat" -ForegroundColor Green
}

# Adaugă toate fișierele
Write-Host "📦 Adăugare fișiere..." -ForegroundColor Cyan
git add .

# Commit inițial
git commit -m "Initial commit - ArtistDirect platform"

Write-Host ""
Write-Host "✅ Proiectul este pregătit pentru GitHub!" -ForegroundColor Green
Write-Host ""
Write-Host "📝 Următorii pași:" -ForegroundColor Cyan
Write-Host "1. Creează un repository nou pe GitHub"
Write-Host "2. Rulează: git remote add origin https://github.com/yourusername/artistdirect.git"
Write-Host "3. Rulează: git branch -M main"
Write-Host "4. Rulează: git push -u origin main"
Write-Host ""


