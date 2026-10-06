@echo off
cd /d "%~dp0"
echo Open http://localhost:8080
start "" http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1
