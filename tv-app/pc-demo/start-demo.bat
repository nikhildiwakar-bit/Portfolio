@echo off
cd /d %~dp0
python demo.py
if errorlevel 1 (
  echo.
  echo Python nahi mila. https://www.python.org/downloads/ se install karein ^(Add to PATH tick karein^).
)
pause
