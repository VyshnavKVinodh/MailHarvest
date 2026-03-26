@echo off
echo ==========================================
echo       MailHarvest - Email Scraper
echo ==========================================
echo.
echo Installing dependencies...
call npm install
echo.
echo Starting server on http://localhost:3000
echo.
node server.js
pause
