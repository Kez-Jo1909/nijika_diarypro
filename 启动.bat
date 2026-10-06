@echo off
cd /d "%~dp0"
echo Open http://localhost:8080
start "" http://localhost:8080
python serve.py
