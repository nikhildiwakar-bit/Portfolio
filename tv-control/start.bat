@echo off
cd /d %~dp0
if not exist tvs.json copy tvs.example.json tvs.json
pip install -r requirements.txt
python app.py
pause
